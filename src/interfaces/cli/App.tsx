import React, { useState, useCallback, useRef } from "react";
import { Box, Static, Text, useApp, useInput } from "ink";
import { TextInput, Spinner } from "@inkjs/ui";
import { Markdown } from "./Markdown.js";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentCore } from "../../agent/core.js";
import { matchService, type IntentClassifier } from "../../agent/intent.js";
import type { InvestigationAgent } from "../../agent/investigation.js";
import type { ConversationMemory } from "../../memory/conversation.js";
import type { ServiceConfig } from "../../config/schema.js";
import type { RcaReport } from "../../agent/rca-types.js";
import type { ImageAttachment } from "../../agent/types.js";
import type { PanelImage } from "../../mcp/client.js";
import type { TokenUsage } from "../../llm/openai.js";

type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "rca" | "error" | "image" | "toolcalls";
  content: string;
};

type ToolCallEntry = {
  name: string;
  args: string;
  tokens?: string;
};

type AppProps = {
  agent: AgentCore;
  memory: ConversationMemory;
  services: ServiceConfig[];
  classifier: IntentClassifier;
  investigationAgent: InvestigationAgent;
  toolCount: number;
};

export function formatRcaText(report: RcaReport): string {
  const severityEmoji: Record<string, string> = {
    low: "🟢", medium: "🟡", high: "🟠", critical: "🔴",
  };
  const emoji = severityEmoji[report.severity] ?? "⚪";

  const lines: string[] = [
    `${emoji} RCA Report: ${report.service}`,
    `Severity: ${report.severity} | Confidence: ${report.confidence}`,
    `Root cause: ${report.rootCause}`,
    `Summary: ${report.summary}`,
  ];

  const evidenceSections: string[] = [];
  if (report.evidence.metrics.length > 0) {
    evidenceSections.push(
      `  Metrics:\n${report.evidence.metrics.map((m) => `    • ${m}`).join("\n")}`,
    );
  }
  if (report.evidence.logs.length > 0) {
    evidenceSections.push(
      `  Logs:\n${report.evidence.logs.map((l) => `    • ${l}`).join("\n")}`,
    );
  }
  if (report.evidence.infra.length > 0) {
    evidenceSections.push(
      `  Infrastructure:\n${report.evidence.infra.map((i) => `    • ${i}`).join("\n")}`,
    );
  }
  if (report.dashboardLinks.length > 0) {
    evidenceSections.push(
      `  Dashboard links:\n${report.dashboardLinks.map((l) => `    • ${l}`).join("\n")}`,
    );
  }
  if (evidenceSections.length > 0) {
    lines.push(`Evidence:\n${evidenceSections.join("\n")}`);
  }

  if (report.recommendedActions.length > 0) {
    const actions = report.recommendedActions
      .map((a, i) => `  ${i + 1}. ${a}`)
      .join("\n");
    lines.push(`Actions:\n${actions}`);
  }

  lines.push(`Investigated at: ${report.investigatedAt}`);

  return lines.filter(Boolean).join("\n");
}

/** Convert raw PanelImage (base64) to ImageAttachment (Buffer) for file saving */
export function panelImagesToAttachments(images: PanelImage[]): ImageAttachment[] {
  return images.map((img, i) => ({
    filename: `panel-${i}.${img.mimeType.split("/")[1] ?? "png"}`,
    mimeType: img.mimeType,
    data: Buffer.from(img.data, "base64"),
  }));
}

export function saveAndOpenImages(images: ImageAttachment[]): string[] {
  const saved: string[] = [];
  for (const img of images) {
    const filePath = join(tmpdir(), `dops-${img.filename}`);
    writeFileSync(filePath, img.data);
    saved.push(filePath);
    if (process.platform === "darwin") {
      execFile("open", [filePath], (error) => {
        if (error) {
          console.error(`Failed to open image: ${filePath}`, error.message);
        }
      });
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
  const [inputDefault, setInputDefault] = useState("");
  const [inputKey, setInputKey] = useState(0);
  const inputHistory = useRef<string[]>([]);
  const historyIndex = useRef(-1);
  const tokenTotals = useRef({ inputTokens: 0, outputTokens: 0 });
  const threadId = "cli-session";

  useInput((_input, key) => {
    if (isThinking) return;
    if (key.upArrow) {
      const hist = inputHistory.current;
      if (hist.length === 0) return;
      const next = Math.min(historyIndex.current + 1, hist.length - 1);
      historyIndex.current = next;
      setInputDefault(hist[hist.length - 1 - next]!);
      setInputKey((k) => k + 1);
    } else if (key.downArrow) {
      const next = historyIndex.current - 1;
      if (next < 0) {
        historyIndex.current = -1;
        setInputDefault("");
      } else {
        historyIndex.current = next;
        setInputDefault(inputHistory.current[inputHistory.current.length - 1 - next]!);
      }
      setInputKey((k) => k + 1);
    }
  });

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

    inputHistory.current.push(trimmed);
    historyIndex.current = -1;
    setInputDefault("");
    setInputKey((k) => k + 1);
    addMessage({ id: randomUUID(), role: "user", content: trimmed });
    setIsThinking(true);
    setToolCalls([]);
    tokenTotals.current = { inputTokens: 0, outputTokens: 0 };

    const correlationId = randomUUID().slice(0, 8);

    let pendingTokens: string | undefined;

    const onTokenUsage = (usage: TokenUsage) => {
      tokenTotals.current.inputTokens += usage.inputTokens;
      tokenTotals.current.outputTokens += usage.outputTokens;
      pendingTokens = `${usage.inputTokens + usage.outputTokens} tok`;
    };

    try {
      const serviceNames = services.map((s) => s.name);
      const intent = await classifier.classify(trimmed, serviceNames);

      if (intent.intent === "investigation") {
        setThinkingLabel("Running investigation");
        const service = matchService(intent.service, services);

        if (!service) {
          const available = services.map((s) => s.name).join(", ") || "none";
          const name = intent.service ?? "unknown";
          addMessage({
            id: randomUUID(),
            role: "error",
            content: `No matching service found for "${name}". Available: ${available}`,
          });
          setIsThinking(false);
          return;
        }

        const report = await investigationAgent.investigate(service, undefined, correlationId, onTokenUsage);
        addMessage({ id: randomUUID(), role: "rca", content: formatRcaText(report) });
        if (report.panelImages.length > 0) {
          const paths = saveAndOpenImages(panelImagesToAttachments(report.panelImages));
          for (const p of paths) {
            addMessage({ id: randomUUID(), role: "image", content: `📎 Panel image: ${p} (opened)` });
          }
        }
      } else {
        setThinkingLabel("Thinking");
        const history = memory.get(threadId);
        memory.append(threadId, { role: "user", content: trimmed });

        const result = await agent.run({
          mode: "conversational",
          message: trimmed,
          history,
          correlationId,
          onToolCall: (name: string, args: Record<string, unknown>) => {
            const summary = JSON.stringify(args).slice(0, 80);
            const tokens = pendingTokens;
            pendingTokens = undefined;
            setToolCalls((prev) => [...prev, { name, args: summary, tokens }]);
          },
          onTokenUsage,
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
      setToolCalls((prev) => {
        const parts: string[] = [];
        if (prev.length > 0) {
          parts.push(`${prev.length} tool call${prev.length === 1 ? "" : "s"}`);
        }
        const { inputTokens, outputTokens } = tokenTotals.current;
        if (inputTokens > 0 || outputTokens > 0) {
          parts.push(`${inputTokens + outputTokens} tokens (${inputTokens} in / ${outputTokens} out)`);
        }
        if (parts.length > 0) {
          addMessage({ id: randomUUID(), role: "toolcalls", content: parts.join(" · ") });
        }
        return [];
      });
    }
  }, [agent, memory, services, classifier, investigationAgent, addMessage, exit]);

  return (
    <>
      <Static items={messages}>
        {(msg) => (
          <Box key={msg.id} paddingX={1} marginBottom={msg.role === "rca" ? 1 : 0}>
            {msg.role === "user" && (
              <Text>
                <Text bold color="cyan">{"> "}</Text>
                <Text>{msg.content}</Text>
              </Text>
            )}
            {msg.role === "assistant" && (
              <Markdown text={msg.content} />
            )}
            {msg.role === "rca" && (
              <Box borderStyle="round" borderColor="yellow" paddingX={1} flexDirection="column">
                <Markdown text={msg.content} indent="" />
              </Box>
            )}
            {msg.role === "error" && (
              <Text color="red">{"  ✗ "}{msg.content}</Text>
            )}
            {msg.role === "image" && (
              <Text color="green">{"  "}{msg.content}</Text>
            )}
            {msg.role === "toolcalls" && (
              <Text dimColor>{"  "}{msg.content}</Text>
            )}
          </Box>
        )}
      </Static>

      <Box flexDirection="column" paddingX={1}>
        {toolCalls.map((tc, i) => (
          <Text key={i} dimColor>{"  ◼ "}{tc.name}({tc.args}){tc.tokens ? ` [${tc.tokens}]` : ""}</Text>
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
              key={inputKey}
              placeholder="Ask a question or type 'investigate <service>'..."
              defaultValue={inputDefault}
              onSubmit={handleSubmit}
            />
          </Box>
        )}
      </Box>
    </>
  );
}
