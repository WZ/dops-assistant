import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";

// Capture user's explicit LOG_LEVEL before dotenv can override it
const userLogLevel = process.env["LOG_LEVEL"];

const envPath = process.env["DOTENV_PATH"] ?? resolve(process.cwd(), "dev/.env");
loadDotenv({ path: envPath });

// Silence pino loggers — their stdout output corrupts Ink's terminal rendering.
// Only allow verbose logging if the user explicitly set LOG_LEVEL on the command line.
process.env["LOG_LEVEL"] = userLogLevel ?? "silent";

// IMPORTANT: All modules that create pino loggers at module-load time must be
// dynamically imported AFTER LOG_LEVEL is set. ESM hoists static imports above
// all module-level code, so static imports would capture the wrong LOG_LEVEL.

const configPath = process.env["CONFIG_PATH"] ?? "dev/config.yaml";

async function main(): Promise<void> {
  const [
    { default: React },
    { render },
    { loadConfig },
    { IntentRouter },
    { ConversationMemory },
    { App },
    { createMcpProvider },
    { createMastraAdapters },
    { createModel },
  ] = await Promise.all([
    import("react"),
    import("ink"),
    import("./config/loader.js"),
    import("./agents/intent.js"),
    import("./memory/conversation.js"),
    import("./interfaces/cli/App.js"),
    import("./mcp/provider.js"),
    import("./server/mastra-adapter.js"),
    import("./mastra/index.js"),
  ]);

  const config = loadConfig(configPath);

  const R = "\x1b[31m";   // red (Fortinet brand)
  const B = "\x1b[1m";    // bold
  const DM = "\x1b[2m";   // dim
  const X = "\x1b[0m";    // reset

  console.log(`
  ${R}███${X} ${R}███${X} ${R}███${X}

  ${R}███${X}     ${R}███${X}        ${B}dops-assistant${X} ${DM}v0.1.0${X}

  ${R}███${X} ${R}███${X} ${R}███${X}   Agentic DevOps Assistant for RCA

  `);
  console.log("  Connecting to MCP providers...");

  const providers = config.providers.map(createMcpProvider);
  // Count tools by resolving all provider tool lists
  const { getAllTools } = await import("./mcp/provider.js");
  const allTools = await getAllTools(providers).catch(() => ({}));
  const toolCount = Object.keys(allTools).length;
  console.log(`  Connected to MCP providers (${toolCount} tools available)`);
  console.log("");

  const model = createModel(config.llm);
  const memory = new ConversationMemory(config.agent.conversationMemory);
  const router = new IntentRouter(model);

  const mastraAdapters = await createMastraAdapters({ config, providers });
  const { chatAgent: agent, investigationAgent } = mastraAdapters;

  const { waitUntilExit } = render(
    <App
      agent={agent}
      memory={memory}
      services={config.services}
      router={router}
      investigationAgent={investigationAgent}
      toolCount={toolCount}
    />,
  );

  await waitUntilExit();

  memory.destroy();
  console.log("\n  Goodbye!");
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
