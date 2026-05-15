// QA harness: spin a local mock chat-completions endpoint, fire the wrapped
// model through it with each effort level, and dump every captured request
// body so we can confirm `reasoning_effort` reaches the wire.
import http from "node:http";
import { createModel } from "../src/mastra/index.ts";
import { generateText } from "ai";

const PORT = 38181;
const captured = [];

const server = http.createServer((req, res) => {
  let chunks = "";
  req.on("data", (c) => { chunks += c; });
  req.on("end", () => {
    let parsed;
    try { parsed = JSON.parse(chunks); } catch { parsed = chunks; }
    captured.push({ path: req.url, body: parsed });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      id: "mock", object: "chat.completion", choices: [
        { index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } }
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  });
});

await new Promise((r) => server.listen(PORT, r));

const llmConfig = {
  model: "qa-model",
  apiKey: "qa-key",
  baseURL: `http://127.0.0.1:${PORT}`,
  retry: { maxAttempts: 1, initialDelayMs: 100, maxDelayMs: 1000, jitterPercent: 0 },
};

async function fire(label, opts) {
  const model = createModel(llmConfig, opts);
  await generateText({ model, prompt: "say ok" });
  const last = captured[captured.length - 1];
  console.log(`\n[${label}]`);
  console.log(`  path = ${last.path}`);
  console.log(`  reasoning_effort = ${JSON.stringify(last.body?.reasoning_effort ?? null)}`);
  return last;
}

await fire("no effort (omitted)", {});
await fire("effort=low", { reasoningEffort: "low" });
await fire("effort=medium", { reasoningEffort: "medium" });
await fire("effort=high", { reasoningEffort: "high" });

server.close();

console.log("\n--- Full capture ---");
console.log(JSON.stringify(captured.map(c => ({
  path: c.path,
  model: c.body?.model,
  reasoning_effort: c.body?.reasoning_effort ?? null,
})), null, 2));
