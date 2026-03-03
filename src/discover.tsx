import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";

const envPath = process.env["DOTENV_PATH"] ?? resolve(process.cwd(), "dev/.env");
loadDotenv({ path: envPath });

if (!process.env["LOG_LEVEL"]) {
  process.env["LOG_LEVEL"] = "silent";
}

import React, { useState, useEffect } from "react";
import { render, Box, Text, Static } from "ink";
import { Spinner } from "@inkjs/ui";
import { writeFileSync } from "node:fs";
import { stringify } from "yaml";
import { loadConfig, getServicesFilePath } from "./config/loader.js";
import { McpClient } from "./mcp/client.js";
import { LlmClient } from "./llm/openai.js";
import { DiscoveryAgent } from "./agent/discovery.js";
import type { ServiceConfig } from "./config/schema.js";
import type { TokenUsage } from "./llm/openai.js";

const configPath = process.env["CONFIG_PATH"] ?? "dev/config.yaml";

type LogEntry = { id: number; text: string };

function DiscoverApp() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [status, setStatus] = useState<"running" | "done" | "error">("running");
  const [services, setServices] = useState<ServiceConfig[]>([]);
  const [spinnerLabel, setSpinnerLabel] = useState("Connecting to MCP...");

  const log = (text: string) => {
    setLogs((prev) => [...prev, { id: prev.length, text }]);
  };

  useEffect(() => {
    let cancelled = false;

    async function run() {
      try {
        const config = loadConfig(configPath);
        const mcp = new McpClient(config.grafana.mcpServer, config.timeouts);
        await mcp.connect();
        if (cancelled) return;

        log(`Connected to MCP (${mcp.getTools().length} tools)`);

        const llm = new LlmClient(config.llm, config.timeouts, config.retry);
        const agent = new DiscoveryAgent(llm, mcp, { maxIterations: config.discovery.maxIterations });

        setSpinnerLabel("Discovering services...");

        const onTokenUsage = (usage: TokenUsage) => {
          log(`  tokens: ${usage.inputTokens + usage.outputTokens} (${usage.inputTokens} in / ${usage.outputTokens} out)`);
        };
        const onToolCall = (name: string, args: Record<string, unknown>) => {
          log(`  ${name}(${JSON.stringify(args).slice(0, 80)})`);
        };

        const discovered = await agent.discover(config.discovery, onTokenUsage, onToolCall);
        if (cancelled) return;

        // Merge: static services take precedence
        const staticNames = new Set(config.services.map((s) => s.name));
        const newServices = discovered.filter((s) => !staticNames.has(s.name));
        const merged = [...config.services, ...newServices];

        setServices(merged);

        if (newServices.length === 0) {
          log("No new services discovered beyond static config.");
        } else {
          log(`Discovered ${newServices.length} new service(s):`);
          for (const s of newServices) {
            log(`  - ${s.name}: ${s.metrics.length} metrics, ${Object.keys(s.logLabels).length} log labels`);
          }

          // Write discovered services to services.yaml
          const servicesPath = getServicesFilePath(configPath);
          const servicesYaml = stringify(merged, { indent: 2 });
          writeFileSync(servicesPath, servicesYaml);
          log(`Wrote ${merged.length} services to ${servicesPath}`);
        }

        await mcp.disconnect();
        setStatus("done");
      } catch (err) {
        log(`Error: ${err instanceof Error ? err.message : String(err)}`);
        setStatus("error");
      }
    }

    run();
    return () => { cancelled = true; };
  }, []);

  return (
    <>
      <Static items={logs}>
        {(entry) => (
          <Text key={entry.id} dimColor>{"  "}{entry.text}</Text>
        )}
      </Static>
      <Box paddingX={1}>
        {status === "running" && <Spinner label={spinnerLabel} />}
        {status === "done" && (
          <Text color="green">
            Discovery complete — {services.length} service(s) in config.
          </Text>
        )}
        {status === "error" && (
          <Text color="red">Discovery failed. See errors above.</Text>
        )}
      </Box>
    </>
  );
}

render(<DiscoverApp />);
