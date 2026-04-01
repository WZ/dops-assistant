/**
 * Anomaly detection step for the investigation workflow.
 *
 * For user-reported issues, skips full anomaly detection (matches legacy
 * behavior) and just passes through the context with default severity.
 * For proactive mode, runs the anomaly detector agent.
 */

import { createStep } from "@mastra/core/workflows";
import { generateText } from "ai";
import type { WorkflowConfig } from "../investigation.js";
import { PrefetchOutputSchema, AnomalyOutputSchema } from "../schemas.js";
import { getToolsByRole } from "../../mcp/provider.js";
import { wrapToolsWithCallbacks, debug } from "../tool-utils.js";
import { getTimeContext } from "../../agents/shared/time-context.js";
import { TOOL_RESULT_TRUNCATION_LIMIT, DEFAULT_TIME_RANGE_MS } from "../../constants.js";
import { safeJsonParse } from "../../agents/shared/processors.js";
import { createAnomalyDetectorAgent } from "../../agents/anomaly-detector.js";
import { extractTimeRange, resolveTimeRangeToAbsolute } from "../helpers.js";

/**
 * Build an anomaly detection step using the anomaly detector agent.
 */
export function buildAnomalyStep(config: WorkflowConfig) {
  return createStep({
    id: "anomaly-detection",
    description: "Detect anomalies from metrics and dashboards",
    inputSchema: PrefetchOutputSchema,
    outputSchema: AnomalyOutputSchema,
    execute: async ({ inputData }) => {
      debug("ANOMALY step entered, keys:", Object.keys(inputData));
      config.onPhase?.("Detecting anomalies");

      // For user-reported issues, skip full anomaly detection (matches legacy behavior).
      // The user already told us what's wrong — just extract the time range and pass through.
      // Running the anomaly agent wastes iterations on broad unfocused queries.
      const isUserReported = !!inputData.userMessage?.trim();

      let isAnomaly = true;
      let severity: "low" | "medium" | "high" | "critical" = "high";
      let summary = inputData.userMessage;

      if (!isUserReported) {
        // Proactive mode: run anomaly detection agent
        const rawTools = await getToolsByRole(config.providers, "metrics").catch(() => ({}));
        const tools = wrapToolsWithCallbacks(rawTools, config.onToolCall);

        const agent = createAnomalyDetectorAgent({
          model: config.model,
          tools,
          useQuirkHandling: config.useQuirkHandling,
        });

        const prompt = [
          getTimeContext(),
          inputData.datasourceHints,
          inputData.dashboardContext,
          `User message: ${inputData.userMessage}`,
          inputData.serviceName ? `Service: ${inputData.serviceName}` : "",
        ].filter(Boolean).join("\n");

        let agentResult: { text: string } = { text: "" };
        const anomalyToolData: string[] = [];
        let anomalyIterationCount = 0;
        try {
          agentResult = await agent.generate(prompt, {
            onStepFinish: (step: any) => {
              try {
                debug("ANOMALY onStepFinish, toolResults sample:", JSON.stringify(step.toolResults?.[0] ?? {}).slice(0, 300));
                anomalyIterationCount++;
                config.onIteration?.("anomaly", anomalyIterationCount, 10, `Step ${anomalyIterationCount}`);
                if (step.toolResults?.length) {
                  for (const tr of step.toolResults) {
                    const payload = tr.payload ?? tr;
                    const toolName = payload.toolName ?? payload.name ?? tr.toolName ?? "unknown";
                    const nestedContent = payload.result?.content?.[0]?.text;
                    const rawResult = nestedContent ?? payload.result ?? tr.result ?? tr.output ?? "";
                    const resultStr = typeof rawResult === "string" ? rawResult : JSON.stringify(rawResult);
                    const truncated = resultStr.length > TOOL_RESULT_TRUNCATION_LIMIT ? resultStr.slice(0, TOOL_RESULT_TRUNCATION_LIMIT) + "..." : resultStr;
                    anomalyToolData.push(`Tool: ${toolName}\nResult: ${truncated}`);
                  }
                }
                if (step.text) anomalyToolData.push(`Model: ${step.text}`);
                if (step.usage && config.onTokenUsage) {
                  config.onTokenUsage({
                    inputTokens: step.usage.inputTokens ?? 0,
                    outputTokens: step.usage.outputTokens ?? 0,
                  });
                }
              } catch (err) {
                debug("ANOMALY onStepFinish error:", err);
              }
            },
          });
        } catch (err) {
          debug("ANOMALY agent.generate error:", err);
        }

        let textToParse = agentResult.text;
        if (!textToParse?.trim() && anomalyToolData.length > 0) {
          debug("ANOMALY: empty text, extracting from", anomalyToolData.length, "captured tool results");
          const { Agent: ExtractAgent } = await import("@mastra/core/agent");
          const extractor = new ExtractAgent({
            name: "anomaly-extractor",
            id: "anomaly-extractor",
            instructions: 'Extract structured data from investigation results. Return ONLY valid JSON: {"isAnomaly": boolean, "severity": "low"|"medium"|"high"|"critical", "summary": "string", "affectedServices": ["string"]}',
            model: config.model as any,
          });
          try {
            const extraction = await extractor.generate(anomalyToolData.join("\n\n"));
            textToParse = extraction.text ?? "";
          } catch { /* keep empty */ }
        }
        debug("ANOMALY text to parse (first 500):", textToParse?.slice(0, 500));

        const anomalyParsed = safeJsonParse(textToParse);
        debug("ANOMALY parsed:", anomalyParsed ? "OK" : "FAILED");
        if (anomalyParsed) {
          isAnomaly = anomalyParsed.isAnomaly ?? true;
          severity = anomalyParsed.severity ?? "medium";
          summary = anomalyParsed.summary ?? inputData.userMessage;
        }
      } else {
        debug("ANOMALY: user-reported issue, skipping agent — extracting time range via LLM");
      }

      // ── LLM-based time range extraction ─────────────────────────────────
      // Runs for ALL investigations (userMessage is always present).
      // Fallback chain: LLM → regex (resolved to absolute UTC) → 8h default (absolute UTC).
      let timeRangeFrom: string | undefined;
      let timeRangeTo: string | undefined;

      try {
        const timeContext = getTimeContext();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10_000);

        let timeText = "";
        try {
          const result = await generateText({
            model: config.model,
            system: `You are a time range extractor. Given a user message about a system issue and the current time context, extract the time window the user is asking about.

${timeContext}

Return ONLY valid JSON: {"from": "RFC3339_UTC", "to": "RFC3339_UTC", "matchedText": "the time phrase you matched", "confidence": 0.0-1.0}

CRITICAL — timezone handling:
The user speaks in LOCAL TIME (see timezone in the time context above). You MUST convert local times to UTC before outputting.
For example, if the timezone is America/Los_Angeles (UTC-7) and the user says "around 4PM", that means 16:00 local = 23:00 UTC.
If the timezone is America/New_York (UTC-4) and the user says "around 4PM", that means 16:00 local = 20:00 UTC.
ALWAYS apply the UTC offset from the time context when converting user-stated times.

Rules:
- "around 4PM" → ±1h around 4PM LOCAL TIME, converted to UTC. If local is UTC-7: from=22:00Z, to=00:00Z next day
- "yesterday afternoon" → yesterday 12:00-18:00 LOCAL, converted to UTC
- "this morning" → today 06:00-12:00 LOCAL, converted to UTC
- "Monday night" → most recent Monday 18:00-23:59 LOCAL, converted to UTC
- "last night" → yesterday 21:00 LOCAL to today 06:00 LOCAL, converted to UTC
- If no time reference found, use the current time to compute 8 hours ago as "from" and now as "to", return with confidence 0.0
- For vague times ("around", "about"), use a ±1 hour window around the stated time
- For day-only references ("last Friday"), use the full day (00:00-23:59 LOCAL, converted to UTC)`,
            prompt: inputData.userMessage,
            temperature: 0,
            abortSignal: controller.signal,
          });
          timeText = result.text;
          if (result.usage && config.onTokenUsage) {
            config.onTokenUsage({
              inputTokens: result.usage.inputTokens ?? 0,
              outputTokens: result.usage.outputTokens ?? 0,
            });
          }
        } finally {
          clearTimeout(timeout);
        }

        const parsed = safeJsonParse(timeText);
        if (parsed?.from && parsed?.to) {
          const fromDate = new Date(parsed.from);
          const toDate = new Date(parsed.to);
          const now = Date.now();
          const thirtyDaysAgo = now - 30 * 86_400_000;

          // Validate: both must be valid dates, from <= to, not in future, not > 30d ago
          if (
            !isNaN(fromDate.getTime()) && !isNaN(toDate.getTime()) &&
            fromDate.getTime() <= toDate.getTime() &&
            toDate.getTime() <= now + 60_000 && // allow 1 min clock skew
            fromDate.getTime() >= thirtyDaysAgo
          ) {
            timeRangeFrom = fromDate.toISOString();
            timeRangeTo = toDate.toISOString();
            debug("ANOMALY: LLM time extraction succeeded:", { from: timeRangeFrom, to: timeRangeTo, matchedText: parsed.matchedText, confidence: parsed.confidence });
          } else {
            debug("ANOMALY: LLM returned invalid date range, falling back to regex", { from: parsed.from, to: parsed.to });
          }
        } else {
          debug("ANOMALY: LLM time parse failed, falling back to regex");
        }
      } catch (err) {
        debug("ANOMALY: LLM time extraction error, falling back to regex:", err);
      }

      // Fallback: resolve regex output to absolute UTC
      if (!timeRangeFrom || !timeRangeTo) {
        try {
          const regexRange = extractTimeRange(inputData.userMessage);
          const absolute = resolveTimeRangeToAbsolute(regexRange);
          timeRangeFrom = absolute.from;
          timeRangeTo = absolute.to;
          debug("ANOMALY: using regex fallback (absolute):", { from: timeRangeFrom, to: timeRangeTo });
        } catch (err) {
          // Ultimate fallback: 8h window from now
          timeRangeTo = new Date().toISOString();
          timeRangeFrom = new Date(Date.now() - DEFAULT_TIME_RANGE_MS).toISOString();
          debug("ANOMALY: regex fallback failed, using 8h default:", err);
        }
      }

      const prefetchContext = {
        datasourceHints: inputData.datasourceHints,
        dashboardContext: inputData.dashboardContext,
        panelQueryHints: inputData.panelQueryHints,
        logLabelHints: inputData.logLabelHints,
        workingLogSelectors: inputData.workingLogSelectors,
      };

      return {
        isAnomaly,
        severity,
        summary,
        affectedServices: inputData.serviceName ? [inputData.serviceName] : [],
        timeRangeFrom,
        timeRangeTo,
        prefetchContext,
        userMessage: inputData.userMessage,
        serviceName: inputData.serviceName,
        skillContext: inputData.skillContext,
      };
    },
  });
}
