/**
 * Synthesis step for the investigation workflow.
 *
 * Combines evidence from metrics, logs, infra, and changes (optional) phases
 * into a root cause analysis report with severity validation.
 */

import { createStep } from "@mastra/core/workflows";
import { z } from "zod";
import type { WorkflowConfig } from "../investigation.js";
import { EvidenceOutputSchema, SynthesisOutputSchema } from "../schemas.js";
import { buildTimeline, validateSeverity } from "../helpers.js";
import { debug } from "../tool-utils.js";
import { safeJsonParse } from "../../agents/shared/processors.js";
import { createSynthesisAgent } from "../../agents/synthesis.js";
import { wrapUntrusted } from "../../agents/shared/prompt-helpers.js";
import { formatPatterns } from "../../agents/shared/patterns.js";

/**
 * Build a synthesis step that combines evidence and runs quality validation.
 * Exported for testing.
 */
export function buildSynthesisStep(config: WorkflowConfig) {
  return createStep({
    id: "synthesis",
    description: "Synthesize root cause from all evidence phases",
    inputSchema: z.object({
      "metrics-evidence": EvidenceOutputSchema,
      "logs-evidence": EvidenceOutputSchema.optional(),
      "infra-evidence": EvidenceOutputSchema.optional(),
      "changes-evidence": EvidenceOutputSchema.optional(),
    }),
    outputSchema: SynthesisOutputSchema,
    execute: async ({ inputData }) => {
      debug("SYNTHESIS step entered, keys:", Object.keys(inputData));
      debug("SYNTHESIS inputData:", JSON.stringify(inputData).slice(0, 500));
      const metricsFindings = inputData["metrics-evidence"];
      const logsFindings = inputData["logs-evidence"] ?? { summary: "Log analysis not run", observations: [] };
      const infraFindings = inputData["infra-evidence"] ?? { summary: "Infrastructure analysis not run", observations: [] };
      const changesFindings = inputData["changes-evidence"];

      // Extract timeRange pass-through from any evidence output (all carry the same value)
      const timeRange = metricsFindings.timeRange ?? logsFindings?.timeRange ?? infraFindings?.timeRange ?? changesFindings?.timeRange;
      debug("SYNTHESIS findings:", { metrics: !!metricsFindings, logs: !!logsFindings, infra: !!infraFindings, changes: !!changesFindings });

      // Build timeline from structured observations
      const metricsForTimeline = {
        observations: ((metricsFindings.observations ?? []) as any[]).map((o: any) => ({
          metric: o.metric ?? "",
          currentValue: o.currentValue ?? o.current ?? "",
          baselineValue: o.baselineValue ?? o.baseline ?? "",
          timestamp: o.timestamp ?? o.time ?? "",
          severity: o.severity ?? "normal",
        })),
        anomalyWindow: "",
        summary: metricsFindings.summary,
      };
      const logsForTimeline = {
        observations: ((logsFindings.observations ?? []) as any[]).map((o: any) => ({
          pattern: o.pattern ?? "",
          count: o.count ?? "",
          firstSeen: o.firstSeen ?? "",
          lastSeen: o.lastSeen ?? "",
          sample: o.sample ?? "",
          sampleLines: o.sampleLines ?? [],
        })),
        summary: logsFindings.summary,
      };
      const infraForTimeline = {
        observations: ((infraFindings.observations ?? []) as any[]).map((o: any) => ({
          resource: o.resource ?? "",
          status: o.status ?? "",
          detail: o.detail ?? "",
          timestamp: o.timestamp ?? o.time ?? "",
        })),
        summary: infraFindings.summary,
      };

      const timeline = buildTimeline(metricsForTimeline, logsForTimeline, infraForTimeline);

      config.onPhase?.("Synthesizing root cause");
      config.onIteration?.("synthesis", 5, 6, "Synthesizing root cause");

      const agent = createSynthesisAgent({ model: config.model });

      const promptParts = [
        "Synthesize a root cause analysis from the following evidence:",
        `\nMetrics: ${wrapUntrusted("evidence_metrics", JSON.stringify({ summary: metricsFindings.summary, observations: metricsFindings.observations }))}`,
        `\nLogs: ${wrapUntrusted("evidence_logs", JSON.stringify({ summary: logsFindings.summary, observations: logsFindings.observations }))}`,
        `\nInfra: ${wrapUntrusted("evidence_infra", JSON.stringify({ summary: infraFindings.summary, observations: infraFindings.observations }))}`,
      ];
      if (changesFindings?.observations?.length) {
        promptParts.push(
          `\nRecent Changes: ${wrapUntrusted("evidence_changes", JSON.stringify({ summary: changesFindings.summary, observations: changesFindings.observations }))}`,
          "\nIMPORTANT: If a deployment or code change occurred shortly before the incident, this is a strong root cause signal. Highlight it prominently.",
        );
      }
      if (timeline) promptParts.push(`\nTimeline:\n${timeline}`);

      // Evidence quality feedback — tell synthesis what's thin
      const metricsCount = (metricsFindings.observations?.length ?? 0);
      const logsCount = (logsFindings.observations?.length ?? 0);
      const qualityWarnings: string[] = [];
      if (metricsCount < 2) qualityWarnings.push(`WARNING: Only ${metricsCount} metric observations provided. Extract maximum detail from what exists.`);
      if (logsCount > 0) {
        const sampleLineCount = (logsFindings.observations as any[])
          .reduce((sum: number, o: any) => sum + (o.sampleLines?.length ?? 0), 0);
        if (sampleLineCount < 3) {
          qualityWarnings.push(`WARNING: Only ${sampleLineCount} log sample lines provided. Copy ALL available sampleLines into evidence.logs verbatim.`);
        }
      }
      if (qualityWarnings.length > 0) {
        promptParts.push(`\n⚠️ EVIDENCE QUALITY WARNINGS:\n${qualityWarnings.join("\n")}\nDo NOT leave evidence arrays empty when observations exist above. Extract and cite every piece of evidence available.`);
      }

      // Learned patterns: synthesis sees them so it can recognize recurrences
      // and calibrate confidence. The target service is always at services[0]
      // by adapter contract (see MastraInvestigationAdapter.investigate).
      const targetService = config.services[0]?.name;
      if (config.getSimilarPatterns && targetService) {
        try {
          const patterns = config.getSimilarPatterns(targetService, 5);
          const formatted = formatPatterns(targetService, patterns);
          if (formatted) {
            promptParts.push(
              `\n${wrapUntrusted("learned_patterns", formatted)}`,
              "If the current symptom + root cause overlap with one of the patterns above, name the pattern id explicitly in `summary` and bump confidence by one tier (low→medium, medium→high). If they do NOT match, ignore the patterns — do not force a fit.",
            );
          }
        } catch { /* no patterns available — graceful degradation */ }
      }

      const prompt = promptParts.filter(Boolean).join("\n");

      let agentResult: { text: string; usage?: any } = { text: "" };
      try {
        agentResult = await agent.generate(prompt);
        if (agentResult.usage && config.onTokenUsage) {
          config.onTokenUsage({
            inputTokens: agentResult.usage.inputTokens ?? 0,
            outputTokens: agentResult.usage.outputTokens ?? 0,
          });
        }
      } catch {
        // Fall through to defaults
      }

      let severity: "low" | "medium" | "high" | "critical" = "medium";
      let summary = "Investigation complete";
      let impact = { duration: "Unknown", description: "" };
      let rootCause = "Unable to determine";
      let trigger = "Unknown";
      let contributingFactors: string[] = [];
      let timelineEvents: Array<{ time: string; event: string }> = [];
      let evidence = { metrics: [] as string[], logs: [] as string[], infra: [] as string[], changes: [] as string[] };
      // Collect tool calls from evidence phases for deep links
      const evidenceToolCalls: Record<string, Array<{ tool: string; args: string; resultChars: number }>> = {};
      for (const [key, findings] of [["metrics", metricsFindings], ["logs", logsFindings], ["infra", infraFindings], ["changes", changesFindings]] as const) {
        if (findings?.toolCalls?.length) {
          evidenceToolCalls[key] = findings.toolCalls;
        }
      }
      let dashboardLinks: string[] = [];
      let recommendedActions: string[] = [];
      let confidence: "low" | "medium" | "high" = "low";
      let confidenceScore = 0.5;

      const extractorInstructions = 'You are a root cause analysis summarizer. Given investigation evidence, produce a JSON summary. Return ONLY valid JSON: {"severity": "low"|"medium"|"high"|"critical", "summary": "string", "impact": {"duration": "string", "description": "string"}, "rootCause": "string", "trigger": "string", "contributingFactors": ["string"], "timeline": [{"time": "string", "event": "string"}], "evidence": {"metrics": ["string"], "logs": ["string"], "infra": ["string"]}, "dashboardLinks": ["string"], "recommendedActions": ["string"], "confidence": "low"|"medium"|"high", "confidenceScore": number}';

      // Helper: create a one-shot extractor agent for synthesis fallbacks
      const runExtractor = async (input: string): Promise<string> => {
        const { Agent: ExtractAgent } = await import("@mastra/core/agent");
        const extractor = new ExtractAgent({
          name: "synthesis-extractor",
          id: "synthesis-extractor",
          instructions: extractorInstructions,
          model: config.model as any,
        });
        const extraction = await extractor.generate(input);
        return extraction.text ?? "";
      };

      let synthesisText = agentResult.text;
      if (!synthesisText?.trim()) {
        debug("SYNTHESIS: empty text, re-prompting with extractor");
        try { synthesisText = await runExtractor(prompt); } catch { /* keep empty */ }
      }
      let synthesisParsed = safeJsonParse(synthesisText);

      // If parsed but rootCause is missing/vague, re-extract from the full text
      const isIncomplete = synthesisParsed && (
        !synthesisParsed.rootCause ||
        /^unable to determine$/i.test(synthesisParsed.rootCause?.trim?.() ?? "")
      );
      if (isIncomplete && synthesisText && synthesisText.length > 200) {
        debug("SYNTHESIS: rootCause missing/vague, re-extracting from", synthesisText.length, "chars");
        try {
          const reParsed = safeJsonParse(await runExtractor(synthesisText.slice(0, 12000)));
          if (reParsed?.rootCause && !/^unable to determine$/i.test(reParsed.rootCause.trim())) {
            synthesisParsed = reParsed;
          }
        } catch { /* keep original */ }
      }

      if (synthesisParsed) {
        severity = synthesisParsed.severity ?? severity;
        summary = synthesisParsed.summary ?? summary;
        if (synthesisParsed.impact) impact = synthesisParsed.impact;
        rootCause = synthesisParsed.rootCause ?? rootCause;
        trigger = synthesisParsed.trigger ?? trigger;
        contributingFactors = synthesisParsed.contributingFactors ?? contributingFactors;
        timelineEvents = synthesisParsed.timeline ?? timelineEvents;
        if (synthesisParsed.evidence) evidence = synthesisParsed.evidence;
        dashboardLinks = synthesisParsed.dashboardLinks ?? dashboardLinks;
        recommendedActions = synthesisParsed.recommendedActions ?? recommendedActions;
        confidence = synthesisParsed.confidence ?? confidence;
        confidenceScore = synthesisParsed.confidenceScore ?? confidenceScore;
      }

      // Deterministic severity validation
      const correctedSeverity = validateSeverity(
        { severity, summary, rootCause },
        metricsForTimeline,
        logsForTimeline,
        infraForTimeline,
      );
      if (correctedSeverity) severity = correctedSeverity;

      return {
        severity,
        summary,
        impact,
        rootCause,
        trigger,
        contributingFactors,
        timeline: timelineEvents,
        evidence,
        evidenceToolCalls: Object.keys(evidenceToolCalls).length > 0 ? evidenceToolCalls : undefined,
        dashboardLinks,
        recommendedActions,
        confidence,
        confidenceScore,
        timeRange,
      };
    },
  });
}
