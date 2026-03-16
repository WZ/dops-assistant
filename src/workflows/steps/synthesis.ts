/**
 * Synthesis step for the investigation workflow.
 *
 * Combines evidence from metrics, logs, and infra phases into a root cause
 * analysis report with severity validation.
 */

import { createStep } from "@mastra/core/workflows";
import { z } from "zod";
import type { WorkflowConfig } from "../investigation.js";
import { EvidenceOutputSchema, SynthesisOutputSchema } from "../schemas.js";
import { buildTimeline, validateSeverity } from "../helpers.js";
import { debug } from "../tool-utils.js";
import { safeJsonParse } from "../../agents/shared/processors.js";
import { createSynthesisAgent } from "../../agents/synthesis.js";

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
      "logs-evidence": EvidenceOutputSchema,
      "infra-evidence": EvidenceOutputSchema,
    }),
    outputSchema: SynthesisOutputSchema,
    execute: async ({ inputData }) => {
      debug("SYNTHESIS step entered, keys:", Object.keys(inputData));
      debug("SYNTHESIS inputData:", JSON.stringify(inputData).slice(0, 500));
      const metricsFindings = inputData["metrics-evidence"];
      const logsFindings = inputData["logs-evidence"];
      const infraFindings = inputData["infra-evidence"];
      debug("SYNTHESIS findings:", { metrics: !!metricsFindings, logs: !!logsFindings, infra: !!infraFindings });

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

      const prompt = [
        "Synthesize a root cause analysis from the following evidence:",
        `\nMetrics: ${JSON.stringify({ summary: metricsFindings.summary, observations: metricsFindings.observations })}`,
        `\nLogs: ${JSON.stringify({ summary: logsFindings.summary, observations: logsFindings.observations })}`,
        `\nInfra: ${JSON.stringify({ summary: infraFindings.summary, observations: infraFindings.observations })}`,
        timeline ? `\nTimeline:\n${timeline}` : "",
      ].filter(Boolean).join("\n");

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
      let evidence = { metrics: [] as string[], logs: [] as string[], infra: [] as string[] };
      let dashboardLinks: string[] = [];
      let recommendedActions: string[] = [];
      let confidence: "low" | "medium" | "high" = "low";
      let confidenceScore = 0.5;

      let synthesisText = agentResult.text;
      if (!synthesisText?.trim()) {
        // Synthesis agent has no tools so agentResult.text should normally be populated.
        // As a fallback, re-prompt with the same content using a fresh extractor agent.
        debug("SYNTHESIS: empty text, re-prompting with extractor agent");
        const { Agent: ExtractAgent } = await import("@mastra/core/agent");
        const extractor = new ExtractAgent({
          name: "synthesis-extractor",
          id: "synthesis-extractor",
          instructions: 'You are a root cause analysis summarizer. Given investigation evidence, produce a JSON summary. Return ONLY valid JSON: {"severity": "low"|"medium"|"high"|"critical", "summary": "string", "impact": {"duration": "string", "description": "string"}, "rootCause": "string", "trigger": "string", "contributingFactors": ["string"], "timeline": [{"time": "string", "event": "string"}], "evidence": {"metrics": ["string"], "logs": ["string"], "infra": ["string"]}, "dashboardLinks": ["string"], "recommendedActions": ["string"], "confidence": "low"|"medium"|"high", "confidenceScore": number}',
          model: config.model as any,
        });
        try {
          const extraction = await extractor.generate(prompt);
          synthesisText = extraction.text ?? "";
        } catch { /* keep empty */ }
      }
      const synthesisParsed = safeJsonParse(synthesisText);
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
        dashboardLinks,
        recommendedActions,
        confidence,
        confidenceScore,
      };
    },
  });
}
