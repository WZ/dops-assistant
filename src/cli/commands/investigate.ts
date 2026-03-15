import type { IInvestigationAgent } from "../../types/agent-interfaces.js";
import type { ServiceConfig } from "../../config/schema.js";
import type { InvestigateOutput, TokenSummary } from "../types.js";
import { createToolCollector } from "../tool-collector.js";

export type InvestigateOptions = {
  verbose: boolean;
  history: boolean;
  userMessage: string;
};

export function resolveService(name: string, services: ServiceConfig[]): ServiceConfig | undefined {
  const lower = name.toLowerCase();
  return services.find((s) => s.name.toLowerCase() === lower);
}

export async function runInvestigate(
  agent: IInvestigationAgent,
  service: ServiceConfig,
  opts: InvestigateOptions,
): Promise<InvestigateOutput> {
  const start = performance.now();
  const collector = createToolCollector(opts.verbose);
  let tokens: TokenSummary | null = null;

  const onTokenUsage = (usage: { inputTokens: number; outputTokens: number }) => {
    if (!tokens) tokens = { input: 0, output: 0, total: 0 };
    tokens.input += usage.inputTokens;
    tokens.output += usage.outputTokens;
    tokens.total += usage.inputTokens + usage.outputTokens;
  };

  try {
    const report = await agent.investigate(
      service,
      undefined, // initialAnomaly
      undefined, // correlationId
      onTokenUsage,
      opts.userMessage,
      collector.callback,
      undefined, // onPhase
      undefined, // onIteration
      undefined, // skillContext
    );

    return {
      command: "investigate",
      service: service.name,
      status: "success",
      durationMs: Math.round(performance.now() - start),
      tokens,
      toolCalls: collector.getRecords(),
      history: opts.history,
      result: report,
      error: null,
    };
  } catch (err) {
    return {
      command: "investigate",
      service: service.name,
      status: "error",
      durationMs: Math.round(performance.now() - start),
      tokens,
      toolCalls: collector.getRecords(),
      history: opts.history,
      result: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
