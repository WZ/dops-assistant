import { McpClient } from "./client.js";
import { MultiMcpClient } from "./multi-client.js";
import type { Config } from "../config/schema.js";

export function createMultiMcpClient(config: Config): MultiMcpClient {
  const entries = config.providers.map((p) => ({
    name: p.name,
    roles: p.roles,
    client: new McpClient(p.mcpServer, config.timeouts),
  }));
  return new MultiMcpClient(entries);
}
