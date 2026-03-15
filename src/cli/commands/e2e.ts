// src/cli/commands/e2e.ts
import type { IChatAgent, IInvestigationAgent } from "../../types/agent-interfaces.js";
import type { ServiceConfig } from "../../config/schema.js";
import type { E2eOutput, E2eStepResult } from "../types.js";
import { evaluateAssertions } from "../assertions.js";
import { runChat } from "./chat.js";
import { runInvestigate, resolveService } from "./investigate.js";

export type ScenarioStep = {
  command: "investigate" | "chat";
  args: Record<string, string>;
  assert: Record<string, unknown>;
};

export type ScenarioFile = {
  name: string;
  steps: ScenarioStep[];
};

type E2eAgents = {
  chatAgent: IChatAgent;
  investigationAgent: IInvestigationAgent;
};

type E2eOptions = {
  verbose: boolean;
  history: boolean;
};

async function executeStep(
  step: ScenarioStep,
  agents: E2eAgents,
  services: ServiceConfig[],
  opts: E2eOptions,
): Promise<{ output: Record<string, unknown>; isFatal: boolean }> {
  if (step.command === "investigate") {
    const serviceName = step.args.service;
    if (!serviceName) throw new Error("investigate step requires args.service");
    const service = resolveService(serviceName, services);
    if (!service) throw new Error(`unknown service: ${serviceName}`);
    const result = await runInvestigate(agents.investigationAgent, service, {
      verbose: opts.verbose,
      history: opts.history,
      userMessage: `investigate ${serviceName}`,
    });
    return { output: result as unknown as Record<string, unknown>, isFatal: false };
  }

  if (step.command === "chat") {
    const message = step.args.message;
    if (!message) throw new Error("chat step requires args.message");
    const result = await runChat(agents.chatAgent, message, { verbose: opts.verbose });
    return { output: result as unknown as Record<string, unknown>, isFatal: false };
  }

  throw new Error(`unknown step command: ${step.command}`);
}

export async function runE2e(
  scenario: ScenarioFile,
  agents: E2eAgents,
  services: ServiceConfig[],
  opts: E2eOptions,
  scenarioFile?: string,
): Promise<E2eOutput> {
  const start = performance.now();
  const stepResults: E2eStepResult[] = [];
  let skipRemaining = false;
  let skipReason = "";

  for (const step of scenario.steps) {
    if (skipRemaining) {
      stepResults.push({
        name: `${step.command} ${step.args.service ?? step.args.message ?? ""}`.trim(),
        status: "skipped",
        durationMs: 0,
        error: skipReason,
      });
      continue;
    }

    const stepStart = performance.now();
    const stepName = `${step.command} ${step.args.service ?? step.args.message ?? ""}`.trim();

    try {
      const { output } = await executeStep(step, agents, services, opts);
      const assertions = evaluateAssertions(output, step.assert);
      const allPassed = assertions.every((a) => a.pass);

      stepResults.push({
        name: stepName,
        status: allPassed ? "pass" : "fail",
        durationMs: Math.round(performance.now() - stepStart),
        error: null,
        assertions,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const isMcpError = errorMsg.toLowerCase().includes("mcp") || errorMsg.toLowerCase().includes("connection");

      stepResults.push({
        name: stepName,
        status: "fail",
        durationMs: Math.round(performance.now() - stepStart),
        error: errorMsg,
        assertions: [],
      });

      if (isMcpError) {
        skipRemaining = true;
        skipReason = `skipped: ${errorMsg} in previous step`;
      }
    }
  }

  const overallPass = stepResults.every((s) => s.status === "pass");

  return {
    command: "e2e",
    scenario: scenarioFile ?? scenario.name,
    status: overallPass ? "pass" : "fail",
    durationMs: Math.round(performance.now() - start),
    steps: stepResults,
  };
}
