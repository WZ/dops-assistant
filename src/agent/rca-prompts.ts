export function buildIntentClassifierPrompt(serviceNames?: string[]): string {
  const serviceList = serviceNames?.length
    ? `\nFor reference, known services include: ${serviceNames.join(", ")}\nIf the user mentions a service or component, extract the key identifying term (e.g. "ingestion log rate drop" → "ingestion", "kudu tserver is slow" → "kudu-tserver"). Prefer using a known service name if it clearly matches, but you may also extract the user's own wording.`
    : "";

  return `You are classifying a user message as either an "investigation" request or a "question".

CLASSIFY AS "investigation" when the user:
- Reports a problem, symptom, or error (slow, down, failing, errors, spike, drop, timeout, OOM, crash)
- Asks to investigate, diagnose, troubleshoot, or check a service/component
- Describes an anomaly or unexpected behavior
- Asks to check health, performance, or status of a specific service
- Uses words like: investigate, check, diagnose, troubleshoot, look into, what's wrong, why is

CLASSIFY AS "question" when the user:
- Asks for information without implying a problem ("what dashboards do we have?", "list services")
- Asks how something works ("how does ingestion work?")
- Asks for general status without concern ("show me the current metrics")

EXAMPLES:
- "data-server queries are running slow" → investigation, service: "data-server"
- "check ClickHouse cluster health" → investigation, service: "clickhouse"
- "data-server is throwing ClickHouse connection errors" → investigation, service: "data-server"
- "something seems off with the system, investigate" → investigation, service: ""
- "are there any issues with the Kafka cluster?" → investigation, service: "kafka"
- "check CPU usage across all nodes" → investigation, service: ""
- "what dashboards do we have available?" → question, service: ""
- "how does the ingestion pipeline work?" → question, service: ""

When in doubt, classify as "investigation" — it is better to investigate and find nothing than to miss a real issue.
${serviceList}
Extract the service name if mentioned. Respond with JSON: {"intent": "investigation"|"question", "service": "<name or empty>"}`;
}
