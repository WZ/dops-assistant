// src/cli/index.tsx
import { resolve, basename } from "node:path";
import { parseArgs } from "./parse-args.js";
import type { ScenarioFile } from "./commands/e2e.js";

const parsed = parseArgs(process.argv.slice(2));
const isInteractive = parsed.command === "interactive";

// Set LOG_LEVEL BEFORE any dynamic imports (pino reads it at module load).
// Keep silent for all modes — pino defaults to stdout which would corrupt
// JSON output. The JSON output itself provides all diagnostic information.
const explicitLogLevel = process.env.LOG_LEVEL;
if (!explicitLogLevel) {
  process.env.LOG_LEVEL = "silent";
}

// Dynamic imports — must come after LOG_LEVEL is set
const { config: dotenv } = await import("dotenv");
const dotenvPath = process.env.DOTENV_PATH ?? resolve(process.cwd(), "dev/.env");
dotenv({ path: dotenvPath });

const { loadConfig } = await import("../config/loader.js");
const { createMcpProvider } = await import("../mcp/provider.js");
const { writeOutput } = await import("./output.js");

const config = loadConfig(parsed.flags.config);

// Wire config-driven service aliases before any intent routing
if (config.serviceAliases && Object.keys(config.serviceAliases).length > 0) {
  const { setServiceAliases } = await import("../agents/intent.js");
  setServiceAliases(config.serviceAliases);
}

const providers = config.providers.map(createMcpProvider);

// ── Dispatch ──────────────────────────────────────────────────────────────────

async function dispatch(): Promise<void> {
  if (isInteractive) {
    const { runInteractive } = await import("./commands/interactive.js");
    return runInteractive(config, providers);
  }

  if (parsed.command === "mcp-check") {
    const { runMcpCheck } = await import("./commands/mcp-check.js");
    const result = await runMcpCheck(providers);
    const exitCode = result.status === "success" ? 0 : 1;
    return writeOutput(result, exitCode);
  }

  if (parsed.command === "investigate") {
    const serviceName = parsed.args[0];
    if (!serviceName) {
      return writeOutput(
        { command: "investigate", status: "error", error: "usage: dops investigate <service>" },
        2,
      );
    }

    const { createMastraAdapters } = await import("../server/agents.js");
    const { runInvestigate, resolveService } = await import("./commands/investigate.js");

    const service = resolveService(serviceName, config.services);
    if (!service) {
      return writeOutput(
        { command: "investigate", service: serviceName, status: "error", error: `unknown service: ${serviceName}` },
        1,
      );
    }

    const { investigationAgent } = await createMastraAdapters({
      config,
      providers,
      noHistory: !parsed.flags.history,
    });
    const result = await runInvestigate(investigationAgent, service, {
      verbose: parsed.flags.verbose,
      history: parsed.flags.history,
      userMessage: `investigate ${serviceName}`,
    });
    const exitCode = result.status === "success" ? 0 : 1;
    return writeOutput(result, exitCode);
  }

  if (parsed.command === "chat") {
    const message = parsed.args[0];
    if (!message) {
      return writeOutput(
        { command: "chat", status: "error", error: "usage: dops chat \"<message>\"" },
        2,
      );
    }

    const { createMastraAdapters } = await import("../server/agents.js");
    const { runChat } = await import("./commands/chat.js");

    const { chatAgent } = await createMastraAdapters({
      config,
      providers,
      noHistory: !parsed.flags.history,
    });
    const result = await runChat(chatAgent, message, { verbose: parsed.flags.verbose });
    const exitCode = result.status === "success" ? 0 : 1;
    return writeOutput(result, exitCode);
  }

  if (parsed.command === "discover") {
    const { createMastraAdapters } = await import("../server/agents.js");
    const { ServiceRegistryStore } = await import("../services/registry.js");
    const { getServicesFilePath } = await import("../config/loader.js");
    const { runDiscover } = await import("./commands/discover.js");
    const { SkillStore } = await import("../skills/store.js");
    const { resolveDiscoverySkills } = await import("../server/discovery-skill-selection.js");

    const servicesPath = getServicesFilePath(parsed.flags.config);
    const registryStore = new ServiceRegistryStore(servicesPath);
    const { discoverAgent } = await createMastraAdapters({ config, providers, registryStore });

    if (!discoverAgent) {
      return writeOutput({ command: "discover", status: "error", error: "No MCP providers configured" }, 1);
    }

    const skillStore = new SkillStore(config.skills);
    await skillStore.loadAll();
    const discoverySkills = resolveDiscoverySkills({
      skillStore,
    });

    return runDiscover(discoverAgent, config.discovery, discoverySkills);
  }

  if (parsed.command === "e2e") {
    const scenarioPath = parsed.args[0];
    if (!scenarioPath) {
      return writeOutput(
        { command: "e2e", status: "error", error: "usage: dops e2e <scenario-file>" },
        2,
      );
    }

    const { readFile } = await import("node:fs/promises");
    const { createMastraAdapters } = await import("../server/agents.js");
    const { runE2e } = await import("./commands/e2e.js");

    let scenario: ScenarioFile;
    try {
      const raw = await readFile(resolve(scenarioPath), "utf-8");
      scenario = JSON.parse(raw);
    } catch (err) {
      return writeOutput(
        { command: "e2e", status: "error", error: `invalid scenario file: ${err instanceof Error ? err.message : err}` },
        2,
      );
    }

    const { chatAgent, investigationAgent } = await createMastraAdapters({
      config,
      providers,
      noHistory: !parsed.flags.history,
    });
    const result = await runE2e(
      scenario,
      { chatAgent, investigationAgent },
      config.services,
      { verbose: parsed.flags.verbose, history: parsed.flags.history },
      basename(scenarioPath),
    );
    const exitCode = result.status === "pass" ? 0 : 1;
    return writeOutput(result, exitCode);
  }

  // Unknown command
  return writeOutput(
    { command: parsed.command, status: "error", error: `unknown command: ${parsed.command}. Available: investigate, chat, discover, mcp-check, e2e, interactive` },
    2,
  );
}

// ── Timeout wrapper ───────────────────────────────────────────────────────────

const timeout = parsed.flags.timeout;
const timeoutPromise = new Promise<never>((_, reject) =>
  setTimeout(() => reject(new Error("timeout")), timeout),
);

try {
  await Promise.race([dispatch(), timeoutPromise]);
} catch (err) {
  if (!isInteractive) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    await writeOutput(
      { command: parsed.command, status: "error", error: errorMsg },
      1,
    );
  } else {
    throw err;
  }
}
