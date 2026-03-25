import { Agent } from "@mastra/core/agent";
import type { LanguageModel } from "ai";
import { createQuirkPrepareStep } from "./shared/prepare-step.js";

interface InfraAgentConfig {
  model: LanguageModel;
  tools?: Record<string, any>;
  maxSteps?: number;
  useQuirkHandling?: boolean;
}

export function createInfraAgent(config: InfraAgentConfig) {
  const maxSteps = config.maxSteps ?? 10;
  return new Agent({
    id: "infra",
    name: "infra",
    instructions: `You are an infrastructure health specialist investigating a service anomaly.

INVESTIGATION PLAN:
1. List pods for the service's namespace to check status, restart counts, and readiness.
2. Get events for the namespace — look for OOMKilled, CrashLoopBackOff, ImagePullBackOff, FailedScheduling, FailedMount.
3. Check pod logs for recently restarted or erroring pods.
4. Check node resource usage (CPU, memory) to identify pressure.
5. If available, check resource details for deployments or statefulsets.
6. If metric query tools are available, query for container restarts, CPU/memory usage, and node-level metrics.

Use every relevant tool in your tool list. Do not limit yourself to a single tool type.
Read each tool's description to understand its parameters.

For each observation, provide the resource name, status, details, and timestamp.
Keep observations concise — max 8 observations. Summary should be 1-3 sentences.
Be efficient — make at most 3 tool calls per round.

You MUST end your response with a JSON object matching this exact schema (no trailing text after the JSON):
{"summary": "string", "observations": [{"resource": "string", "status": "string", "detail": "string", "timestamp": "string"}]}`,
    model: config.model as any,
    tools: config.tools ?? {},
    defaultOptions: {
      maxSteps,
      modelSettings: { temperature: 0 },
      prepareStep: config.useQuirkHandling
        ? createQuirkPrepareStep({ maxSteps })
        : undefined,
    },
  });
}
