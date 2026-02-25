import type { LlmClient } from "../llm/openai.js";
import type { InvestigationIntent } from "./rca-types.js";
import { INTENT_CLASSIFIER_PROMPT, INTENT_RESPONSE_FORMAT } from "./rca-prompts.js";

export class IntentClassifier {
  private readonly llm: LlmClient;

  constructor(llm: LlmClient) {
    this.llm = llm;
  }

  async classify(message: string): Promise<InvestigationIntent> {
    try {
      const response = await this.llm.chat(
        [
          { role: "system", content: INTENT_CLASSIFIER_PROMPT },
          { role: "user", content: message },
        ],
        [], // no tools needed for classification
        { responseFormat: INTENT_RESPONSE_FORMAT },
      );

      if (response.type !== "text") return { intent: "question" };

      const parsed = JSON.parse(response.content) as { intent: string; service: string };
      if (parsed.intent === "investigation") {
        return {
          intent: "investigation",
          service: parsed.service || undefined,
        };
      }
      return { intent: "question" };
    } catch {
      return { intent: "question" };
    }
  }
}
