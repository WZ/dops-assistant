import React, { useState, useEffect } from "react";
import { render, Box, Text, useInput, useApp } from "ink";
import { spawnSync } from "child_process";
import { writeFileSync, readFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { stringify, parse } from "yaml";
import type { IDiscoverAgent } from "../../types/agent-interfaces.js";
import type { ValidatedServiceConfig } from "../../types/discovery-types.js";
import type { ServiceConfig, DiscoveryConfig } from "../../config/schema.js";

type Phase = "running" | "review" | "editing" | "done";

interface DiscoverAppProps {
  agent: IDiscoverAgent;
  config: DiscoveryConfig;
}

function DiscoverApp({ agent, config }: DiscoverAppProps) {
  const { exit } = useApp();
  const [phase, setPhase] = useState<Phase>("running");
  const [currentPhase, setCurrentPhase] = useState<string>("discovery");
  const [iteration, setIteration] = useState({ current: 0, max: 0, label: "" });
  const [toolCalls, setToolCalls] = useState<string[]>([]);
  const [services, setServices] = useState<ValidatedServiceConfig[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    agent
      .discover(
        config,
        (p) => setCurrentPhase(p),
        (_phase, current, max, label) => setIteration({ current, max, label }),
        (name, args) => {
          const argsStr = JSON.stringify(args).slice(0, 80);
          setToolCalls((prev) => [...prev.slice(-20), `→ ${name}(${argsStr})`]);
        },
      )
      .then((result) => {
        setServices(result);
        setPhase("review");
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
        setPhase("done");
      });
  }, []);

  useInput((input, key) => {
    if (phase !== "review") return;

    if (input === "a") {
      agent.accept(
        services.map(({ confidence: _c, validationNotes: _v, ...s }) => s),
        "discovery",
      ).then(() => {
        setPhase("done");
        setTimeout(() => exit(), 100);
      });
    }

    if (input === "r") {
      setPhase("done");
      setTimeout(() => exit(), 100);
    }

    if (input === "f") {
      setServices((prev) => prev.filter((s) => s.confidence !== "unverified"));
    }

    if (input === "e") {
      setPhase("editing");
      const tmpFile = join(tmpdir(), `dops-discover-${Date.now()}.yaml`);
      const stripped = services.map(({ confidence: _c, validationNotes: _v, ...s }) => s);
      writeFileSync(tmpFile, stringify(stripped, { indent: 2 }));

      const editor = process.env["EDITOR"] || "vi";
      spawnSync(editor, [tmpFile], { stdio: "inherit" });

      try {
        const edited = readFileSync(tmpFile, "utf-8");
        const parsed = parse(edited) as ServiceConfig[];
        if (Array.isArray(parsed)) {
          setServices(parsed.map((s) => ({ ...s, confidence: "unverified" as const, validationNotes: "edited by user" })));
        }
      } catch { /* ignore parse errors */ }

      try { unlinkSync(tmpFile); } catch { /* ignore */ }
      setPhase("review");
    }
  });

  if (phase === "running") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color="magenta">▸ Phase: {currentPhase}</Text>
        {iteration.max > 0 && (
          <Text color="gray">  ⠋ {iteration.label} ({iteration.current}/{iteration.max})</Text>
        )}
        {toolCalls.slice(-5).map((tc, i) => (
          <Text key={i} color="gray" dimColor>  {tc}</Text>
        ))}
      </Box>
    );
  }

  if (phase === "review") {
    const verified = services.filter((s) => s.confidence === "verified").length;
    const partial = services.filter((s) => s.confidence === "partial").length;
    const unverified = services.filter((s) => s.confidence === "unverified").length;

    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color="yellow">▸ Review Results</Text>
        <Box gap={2}>
          <Text color="green">■ verified ({verified})</Text>
          <Text color="yellow">■ partial ({partial})</Text>
          <Text color="red">■ unverified ({unverified})</Text>
        </Box>
        <Box flexDirection="column" marginTop={1}>
          {services.slice(0, 10).map((s) => (
            <Text key={s.name} color={s.confidence === "verified" ? "green" : s.confidence === "partial" ? "yellow" : "red"}>
              {"  "}{s.name.padEnd(30)} {s.confidence.padEnd(12)} {s.validationNotes}
            </Text>
          ))}
          {services.length > 10 && <Text color="gray">  ... ({services.length - 10} more)</Text>}
        </Box>
        <Box marginTop={1}>
          <Text color="magenta">  [a] Accept all  [e] Edit in $EDITOR  [r] Reject  [f] Filter unverified</Text>
        </Box>
      </Box>
    );
  }

  if (error) {
    return <Text color="red">Error: {error}</Text>;
  }

  return <Text color="green">Done.</Text>;
}

export async function runDiscover(agent: IDiscoverAgent, config: DiscoveryConfig): Promise<void> {
  const { waitUntilExit } = render(<DiscoverApp agent={agent} config={config} />);
  await waitUntilExit();
}
