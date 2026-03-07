import React, { useState, useCallback, useRef } from "react";
import { Box, Static, Text, useApp, useInput } from "ink";
import { Spinner } from "@inkjs/ui";
import { CliTextInput } from "./CliTextInput.js";
import { Markdown } from "./Markdown.js";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatAgent } from "../../agent/core.js";
import { matchService, matchServiceFromText, type IntentRouter } from "../../agent/intent.js";
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
  agent: ChatAgent;
  memory: ConversationMemory;
  services: ServiceConfig[];
  router: IntentRouter;
  investigationAgent: InvestigationAgent;
  toolCount: number;
};

/** Strip leading bullet/number markers that the LLM may include in list items */
function stripLeadingBullet(s: string): string {
  let cleaned = s.trim();
  // Strip emoji numbers (1️⃣ through 🔟) — keycap sequences: digit + U+FE0F + U+20E3
  cleaned = cleaned.replace(/^[\u0030-\u0039]\uFE0F?\u20E3\s*/, "");
  // Strip leading "N." or "N)" numbering
  cleaned = cleaned.replace(/^\d+[.)]\s*/, "");
  // Strip bullet markers (•, -, *)
  cleaned = cleaned.replace(/^[•\-\*]\s*/, "");
  return cleaned.trim();
}

export function formatRcaText(report: RcaReport): string {
  const severityEmoji: Record<string, string> = {
    low: "🟢", medium: "🟡", high: "🟠", critical: "🔴",
  };
  const emoji = severityEmoji[report.severity] ?? "⚪";

  const confidenceEmoji: Record<string, string> = {
    low: "⬜", medium: "🔷", high: "✅",
  };

  const lines: string[] = [
    `# ${emoji} RCA: ${report.service}`,
    "",
    `${emoji} **Severity:** ${report.severity}  ·  ${confidenceEmoji[report.confidence] ?? "⬜"} **Confidence:** ${report.confidence}  ·  🕐 ${report.investigatedAt}`,
    "",
    `## 📋 Summary`,
    "",
    report.summary,
    "",
    `## 🔍 Root Cause`,
    "",
    report.rootCause,
  ];

  // Evidence
  const hasEvidence =
    report.evidence.metrics.length > 0 ||
    report.evidence.logs.length > 0 ||
    report.evidence.infra.length > 0;

  if (hasEvidence) {
    lines.push("", `## 📊 Evidence`);

    if (report.evidence.metrics.length > 0) {
      lines.push("", "### 📈 Metrics");
      for (const m of report.evidence.metrics) {
        lines.push(`- ${stripLeadingBullet(m)}`);
      }
    }
    if (report.evidence.logs.length > 0) {
      lines.push("", "### 📝 Logs");
      for (const l of report.evidence.logs) {
        lines.push(`- ${stripLeadingBullet(l)}`);
      }
    }
    if (report.evidence.infra.length > 0) {
      lines.push("", "### 🖥️ Infrastructure");
      for (const i of report.evidence.infra) {
        lines.push(`- ${stripLeadingBullet(i)}`);
      }
    }
  }

  if (report.dashboardLinks.length > 0) {
    lines.push("", "## 🔗 Dashboard Links");
    for (const l of report.dashboardLinks) {
      lines.push(`- ${stripLeadingBullet(l)}`);
    }
  }

  if (report.recommendedActions.length > 0) {
    lines.push("", "## 🛠️ Recommended Actions");
    for (let i = 0; i < report.recommendedActions.length; i++) {
      lines.push(`${i + 1}. ${stripLeadingBullet(report.recommendedActions[i]!)}`);
    }
  }

  return lines.join("\n");
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

export function App({ agent, memory, services, router, investigationAgent, toolCount }: AppProps) {
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
  const abortRef = useRef<AbortController | null>(null);
  const lastEscRef = useRef(0);
  const threadId = "cli-session";

  useInput((input, key) => {
    if (key.escape && isThinking) {
      const now = Date.now();
      if (now - lastEscRef.current < 500) {
        abortRef.current?.abort();
        lastEscRef.current = 0;
      } else {
        lastEscRef.current = now;
      }
      return;
    }
    if (isThinking) return;
    if (key.ctrl && input === "d") {
      exit();
      return;
    }
    if (key.ctrl && input === "l") {
      setMessages([]);
      return;
    }
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

    const abort = new AbortController();
    abortRef.current = abort;
    const correlationId = randomUUID().slice(0, 8);

    let pendingTokens: string | undefined;

    const onTokenUsage = (usage: TokenUsage) => {
      tokenTotals.current.inputTokens += usage.inputTokens;
      tokenTotals.current.outputTokens += usage.outputTokens;
      pendingTokens = `${usage.inputTokens + usage.outputTokens} tok`;
    };

    try {
      const serviceNames = services.map((s) => s.name);
      const intent = await router.route(trimmed, serviceNames);
      if (abort.signal.aborted) throw new DOMException("Aborted", "AbortError");

      // Resolve service: try direct message matching first (more reliable),
      // fall back to LLM-extracted service name
      const service = intent.intent === "investigation"
        ? (matchServiceFromText(trimmed, services) ?? matchService(intent.service, services))
        : undefined;

      const routeLabel = service
        ? `▸ Routed to investigation agent (service: ${service.name})`
        : intent.intent === "investigation"
          ? `▸ Routed to conversation agent (service "${intent.service}" not found)`
          : `▸ Routed to conversation agent`;
      addMessage({ id: randomUUID(), role: "toolcalls", content: routeLabel });

      if (service) {
        // Run structured RCA investigation for matched service
        setThinkingLabel("Running investigation");
        const report = await investigationAgent.investigate(service, undefined, correlationId, onTokenUsage, trimmed, (name: string, args: Record<string, unknown>) => {
            const summary = JSON.stringify(args).slice(0, 80);
            const tokens = pendingTokens;
            pendingTokens = undefined;
            setToolCalls((prev) => [...prev, { name, args: summary, tokens }]);
          }, (phase: string) => {
            setThinkingLabel(phase);
          });
        if (abort.signal.aborted) throw new DOMException("Aborted", "AbortError");
        addMessage({ id: randomUUID(), role: "rca", content: formatRcaText(report) });
        if (report.panelImages.length > 0) {
          const paths = saveAndOpenImages(panelImagesToAttachments(report.panelImages));
          for (const p of paths) {
            addMessage({ id: randomUUID(), role: "image", content: `📎 Panel image: ${p} (opened)` });
          }
        }
      } else {
        // Conversational agent — handles questions, unmatched services, and general infra queries
        setThinkingLabel("Thinking");
        const history = memory.get(threadId);
        memory.append(threadId, { role: "user", content: trimmed });

        const result = await agent.chat({
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

        if (abort.signal.aborted) throw new DOMException("Aborted", "AbortError");
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
      if (err instanceof DOMException && err.name === "AbortError") {
        addMessage({ id: randomUUID(), role: "error", content: "Query aborted" });
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        addMessage({ id: randomUUID(), role: "error", content: msg });
      }
    } finally {
      abortRef.current = null;
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
  }, [agent, memory, services, router, investigationAgent, addMessage, exit]);

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
            <CliTextInput
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
