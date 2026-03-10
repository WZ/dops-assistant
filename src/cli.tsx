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
    { createMultiMcpClient },
    { LlmClient },
    { ChatAgent },
    { InvestigationAgent },
    { IntentRouter },
    { ConversationMemory },
    { App },
  ] = await Promise.all([
    import("react"),
    import("ink"),
    import("./config/loader.js"),
    import("./mcp/factory.js"),
    import("./llm/openai.js"),
    import("./agent/core.js"),
    import("./agent/investigation.js"),
    import("./agent/intent.js"),
    import("./memory/conversation.js"),
    import("./interfaces/cli/App.js"),
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

  const mcp = createMultiMcpClient(config);
  await mcp.connect();

  const toolCount = mcp.getTools().length;
  console.log(`  Connected to MCP providers (${toolCount} tools available)`);
  console.log("");

  const llm = new LlmClient(config.llm, config.timeouts, config.retry);
  const agent = new ChatAgent(llm, mcp, { maxIterations: config.agent.maxIterations });
  const memory = new ConversationMemory(config.agent.conversationMemory);
  const investigationAgent = new InvestigationAgent(llm, mcp, { maxIterations: config.agent.maxIterations, projectRoot: process.cwd() });
  const router = new IntentRouter(llm);

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
  await mcp.disconnect();
  console.log("\n  Goodbye!");
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
