import React, { useState, useCallback } from "react";
import { Box, Text, useApp } from "ink";
import { TextInput, Spinner } from "@inkjs/ui";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentCore } from "../../agent/core.js";
import type { IntentClassifier } from "../../agent/intent.js";
import type { InvestigationAgent } from "../../agent/investigation.js";
import type { ConversationMemory } from "../../memory/conversation.js";
import type { ServiceConfig } from "../../config/schema.js";
import type { RcaReport } from "../../agent/rca-types.js";
import type { ImageAttachment } from "../../agent/types.js";

type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "rca" | "error" | "image";
  content: string;
};

type ToolCallEntry = {
  name: string;
  args: string;
};

type AppProps = {
  agent: AgentCore;
  memory: ConversationMemory;
  services: ServiceConfig[];
  classifier: IntentClassifier;
  investigationAgent: InvestigationAgent;
  toolCount: number;
};

function formatRcaText(report: RcaReport): string {
  const severityEmoji: Record<string, string> = {
    low: "🟢", medium: "🟡", high: "🟠", critical: "🔴",
  };
  const emoji = severityEmoji[report.severity] ?? "⚪";
  const actions = report.recommendedActions
    .map((a, i) => `  ${i + 1}. ${a}`)
    .join("\n");
  return [
    `${emoji} RCA Report: ${report.service}`,
    `Severity: ${report.severity} | Confidence: ${report.confidence}`,
    `Root cause: ${report.rootCause}`,
    `Summary: ${report.summary}`,
    report.recommendedActions.length > 0 ? `Actions:\n${actions}` : "",
    `Investigated at: ${report.investigatedAt}`,
  ].filter(Boolean).join("\n");
}

function saveAndOpenImages(images: ImageAttachment[]): string[] {
  const saved: string[] = [];
  for (const img of images) {
    const filePath = join(tmpdir(), `dops-${img.filename}`);
    writeFileSync(filePath, img.data);
    saved.push(filePath);
    if (process.platform === "darwin") {
      execFile("open", [filePath], () => {});
    }
  }
  return saved;
}

export function App({ agent, memory, services, classifier, investigationAgent, toolCount }: AppProps) {
  const { exit } = useApp();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isThinking, setIsThinking] = useState(false);
  const [toolCalls, setToolCalls] = useState<ToolCallEntry[]>([]);
  const [thinkingLabel, setThinkingLabel] = useState("Thinking");
  const threadId = "cli-session";

  const addMessage = useCallback((msg: ChatMessage) => {
    setMessages((prev) => [...prev, msg]);
  }, []);

  const handleSubmit = useCallback(async (input: string) => {
    const trimmed = input.trim();
    if (!trimmed) return;

    if (trimmed === "exit" || trimmed === "quit") {
      exit();
      return;
    }

    if (trimmed === "clear") {
      setMessages([]);
      return;
    }

    addMessage({ id: randomUUID(), role: "user", content: trimmed });
    setIsThinking(true);
    setToolCalls([]);

    const correlationId = randomUUID().slice(0, 8);

    try {
      const intent = await classifier.classify(trimmed);

      if (intent.intent === "investigation") {
        setThinkingLabel("Running investigation");
        const service = services.find((s) => s.name === intent.service)
          ?? services[0];

        if (!service) {
          addMessage({ id: randomUUID(), role: "error", content: "No services configured to investigate." });
          setIsThinking(false);
          return;
        }

        const report = await investigationAgent.investigate(service, undefined, correlationId);
        addMessage({ id: randomUUID(), role: "rca", content: formatRcaText(report) });
      } else {
        setThinkingLabel("Thinking");
        const history = memory.get(threadId);
        memory.append(threadId, { role: "user", content: trimmed });

        const onToolCall = (name: string, args: Record<string, unknown>) => {
          const summary = JSON.stringify(args).slice(0, 80);
          setToolCalls((prev) => [...prev, { name, args: summary }]);
        };

        const result = await agent.run({
          mode: "conversational",
          message: trimmed,
          history,
          correlationId,
          onToolCall,
        });

        memory.append(threadId, { role: "assistant", content: result.response });
        addMessage({ id: randomUUID(), role: "assistant", content: result.response });

        if (result.images.length > 0) {
          const paths = saveAndOpenImages(result.images);
          for (const p of paths) {
            addMessage({ id: randomUUID(), role: "image", content: `📎 Saved: ${p} (opened)` });
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addMessage({ id: randomUUID(), role: "error", content: msg });
    } finally {
      setIsThinking(false);
      setToolCalls([]);
    }
  }, [agent, memory, services, classifier, investigationAgent, addMessage, exit]);

  return (
    <Box flexDirection="column" paddingX={1}>
      {messages.map((msg) => (
        <Box key={msg.id} marginBottom={msg.role === "rca" ? 1 : 0}>
          {msg.role === "user" && (
            <Text>
              <Text bold color="cyan">{"> "}</Text>
              <Text>{msg.content}</Text>
            </Text>
          )}
          {msg.role === "assistant" && (
            <Text color="white">{"  "}{msg.content}</Text>
          )}
          {msg.role === "rca" && (
            <Box borderStyle="round" borderColor="yellow" paddingX={1} flexDirection="column">
              <Text>{msg.content}</Text>
            </Box>
          )}
          {msg.role === "error" && (
            <Text color="red">{"  ✗ "}{msg.content}</Text>
          )}
          {msg.role === "image" && (
            <Text color="green">{"  "}{msg.content}</Text>
          )}
        </Box>
      ))}

      {toolCalls.map((tc, i) => (
        <Text key={i} dimColor>{"  ◼ "}{tc.name}({tc.args})</Text>
      ))}

      {isThinking ? (
        <Box marginTop={0}>
          <Text>{"  "}</Text>
          <Spinner label={thinkingLabel} />
        </Box>
      ) : (
        <Box marginTop={messages.length > 0 ? 1 : 0}>
          <Text bold color="cyan">{"> "}</Text>
          <TextInput
            placeholder="Ask a question or type 'investigate <service>'..."
            onSubmit={handleSubmit}
          />
        </Box>
      )}
    </Box>
  );
}
