import { describe, it, expect } from "vitest";
import {
  validateExternalInput,
  AlertPayloadSchema,
  ChatMessageSchema,
  DeepInvestigateMessageSchema,
  SkillInputSchema,
} from "./sanitize.js";

// ── validateExternalInput ─────────────────────────────────────────────────────

describe("validateExternalInput", () => {
  it("passes through clean strings unchanged", () => {
    expect(validateExternalInput("hello world", { maxLength: 100 })).toBe("hello world");
  });

  it("strips control characters except newlines and carriage returns", () => {
    const input = "hello\x00\x01\x02\x07\x08\tworld\nfoo\rbar";
    const result = validateExternalInput(input, { maxLength: 1000 });
    expect(result).toBe("helloworld\nfoo\rbar");
    // Tab (0x09) is a control char that should be stripped
    expect(result).not.toContain("\t");
    // Null byte (0x00) must be stripped
    expect(result).not.toContain("\x00");
  });

  it("removes null bytes", () => {
    expect(validateExternalInput("a\x00b\x00c", { maxLength: 100 })).toBe("abc");
  });

  it("preserves newlines (0x0a) and carriage returns (0x0d)", () => {
    const input = "line1\nline2\r\nline3";
    expect(validateExternalInput(input, { maxLength: 1000 })).toBe("line1\nline2\r\nline3");
  });

  it("enforces max length by truncation", () => {
    const input = "a".repeat(200);
    const result = validateExternalInput(input, { maxLength: 50 });
    expect(result).toHaveLength(50);
    expect(result).toBe("a".repeat(50));
  });

  it("applies allowed pattern to filter characters", () => {
    const result = validateExternalInput("abc123!@#def456", {
      maxLength: 1000,
      allowedPattern: /[a-z0-9]/,
    });
    expect(result).toBe("abc123def456");
  });

  it("handles empty strings", () => {
    expect(validateExternalInput("", { maxLength: 100 })).toBe("");
  });

  it("handles unicode correctly", () => {
    const input = "Hello 世界 🌍";
    const result = validateExternalInput(input, { maxLength: 1000 });
    expect(result).toBe("Hello 世界 🌍");
  });

  it("strips control chars before enforcing max length", () => {
    // 5 chars + 5 null bytes = 10 bytes. After stripping: 5 chars. maxLength=3 → "abc"
    const input = "a\x00b\x00c\x00d\x00e\x00";
    const result = validateExternalInput(input, { maxLength: 3 });
    expect(result).toBe("abc");
  });

  it("handles string of only control characters", () => {
    const input = "\x00\x01\x02\x03\x04";
    expect(validateExternalInput(input, { maxLength: 100 })).toBe("");
  });
});

// ── AlertPayloadSchema ───────────────────────────────────────────────────────

describe("AlertPayloadSchema", () => {
  const validPayload = {
    version: "4",
    groupKey: "test-group",
    status: "firing" as const,
    receiver: "webhook",
    alerts: [
      {
        status: "firing" as const,
        labels: { alertname: "HighCPU", severity: "critical", service: "api" },
        annotations: { summary: "CPU is high" },
        startsAt: "2024-01-01T00:00:00Z",
        endsAt: "0001-01-01T00:00:00Z",
      },
    ],
  };

  it("accepts a valid Alertmanager payload", () => {
    const result = AlertPayloadSchema.safeParse(validPayload);
    expect(result.success).toBe(true);
  });

  it("accepts payloads with extra fields (passthrough)", () => {
    const payload = { ...validPayload, customField: "extra", groupLabels: { foo: "bar" } };
    const result = AlertPayloadSchema.safeParse(payload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>)["customField"]).toBe("extra");
    }
  });

  it("rejects payloads with empty alerts array", () => {
    const result = AlertPayloadSchema.safeParse({ ...validPayload, alerts: [] });
    expect(result.success).toBe(false);
  });

  it("rejects payloads with missing alerts field", () => {
    const { alerts: _a, ...noAlerts } = validPayload;
    const result = AlertPayloadSchema.safeParse(noAlerts);
    expect(result.success).toBe(false);
  });

  it("rejects alerts with invalid status", () => {
    const payload = {
      ...validPayload,
      alerts: [{ ...validPayload.alerts[0]!, status: "invalid" }],
    };
    const result = AlertPayloadSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it("sanitizes control characters in label values", () => {
    const payload = {
      ...validPayload,
      alerts: [
        {
          ...validPayload.alerts[0]!,
          labels: { alertname: "test\x00\x01alert", severity: "critical" },
        },
      ],
    };
    const result = AlertPayloadSchema.safeParse(payload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.alerts[0]!.labels["alertname"]).toBe("testalert");
    }
  });

  it("truncates long label values to 2000 chars", () => {
    const longValue = "x".repeat(3000);
    const payload = {
      ...validPayload,
      alerts: [
        {
          ...validPayload.alerts[0]!,
          labels: { alertname: longValue, severity: "critical" },
        },
      ],
    };
    const result = AlertPayloadSchema.safeParse(payload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.alerts[0]!.labels["alertname"]!.length).toBe(2000);
    }
  });

  it("sanitizes annotation values", () => {
    const payload = {
      ...validPayload,
      alerts: [
        {
          ...validPayload.alerts[0]!,
          annotations: { summary: "high\x00 cpu\x07 usage" },
        },
      ],
    };
    const result = AlertPayloadSchema.safeParse(payload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.alerts[0]!.annotations["summary"]).toBe("high cpu usage");
    }
  });

  it("accepts minimal payload with only required fields", () => {
    const minimal = {
      alerts: [
        {
          status: "firing" as const,
          labels: { alertname: "test" },
        },
      ],
    };
    const result = AlertPayloadSchema.safeParse(minimal);
    expect(result.success).toBe(true);
  });
});

// ── ChatMessageSchema ───────────────────────────────────────────────────────

describe("ChatMessageSchema", () => {
  it("accepts a valid chat message", () => {
    const result = ChatMessageSchema.safeParse({ type: "chat", message: "hello" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.message).toBe("hello");
    }
  });

  it("rejects non-chat message types", () => {
    const result = ChatMessageSchema.safeParse({ type: "discover", message: "hello" });
    expect(result.success).toBe(false);
  });

  it("rejects messages without a message field", () => {
    const result = ChatMessageSchema.safeParse({ type: "chat" });
    expect(result.success).toBe(false);
  });

  it("truncates messages longer than 10000 chars", () => {
    const longMsg = "x".repeat(15000);
    const result = ChatMessageSchema.safeParse({ type: "chat", message: longMsg });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.message.length).toBe(10000);
    }
  });

  it("strips control characters from message", () => {
    const result = ChatMessageSchema.safeParse({ type: "chat", message: "hello\x00\x01world" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.message).toBe("helloworld");
    }
  });

  it("preserves newlines in message", () => {
    const result = ChatMessageSchema.safeParse({ type: "chat", message: "line1\nline2" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.message).toBe("line1\nline2");
    }
  });

  it("accepts message with optional serviceContext", () => {
    const result = ChatMessageSchema.safeParse({ type: "chat", message: "hello", serviceContext: "api-service" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.serviceContext).toBe("api-service");
    }
  });
});

// ── DeepInvestigateMessageSchema ─────────────────────────────────────────────

describe("DeepInvestigateMessageSchema", () => {
  it("accepts a valid deep_investigate message", () => {
    const result = DeepInvestigateMessageSchema.safeParse({
      type: "deep_investigate",
      investigationId: "inv_123",
      message: "What caused this?",
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing investigationId", () => {
    const result = DeepInvestigateMessageSchema.safeParse({
      type: "deep_investigate",
      message: "What caused this?",
    });
    expect(result.success).toBe(false);
  });

  it("sanitizes message content", () => {
    const result = DeepInvestigateMessageSchema.safeParse({
      type: "deep_investigate",
      investigationId: "inv_123",
      message: "test\x00\x01message",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.message).toBe("testmessage");
    }
  });
});

// ── SkillInputSchema ────────────────────────────────────────────────────────

describe("SkillInputSchema", () => {
  it("accepts valid skill input", () => {
    const result = SkillInputSchema.safeParse({
      title: "My Skill",
      services: ["api"],
      alerts: [],
      tags: ["monitoring"],
      body: "Some instructions",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.title).toBe("My Skill");
      expect(result.data.body).toBe("Some instructions");
    }
  });

  it("rejects missing title", () => {
    const result = SkillInputSchema.safeParse({ body: "content" });
    expect(result.success).toBe(false);
  });

  it("truncates title longer than 500 chars", () => {
    const longTitle = "t".repeat(600);
    const result = SkillInputSchema.safeParse({ title: longTitle });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.title.length).toBe(500);
    }
  });

  it("truncates body longer than 50000 chars", () => {
    const longBody = "b".repeat(60000);
    const result = SkillInputSchema.safeParse({ title: "Test", body: longBody });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.body!.length).toBe(50000);
    }
  });

  it("strips control characters from title and body", () => {
    const result = SkillInputSchema.safeParse({
      title: "my\x00skill\x01title",
      body: "body\x00content\x07here",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.title).toBe("myskilltitle");
      expect(result.data.body).toBe("bodycontenthere");
    }
  });

  it("accepts skill with only title (other fields optional)", () => {
    const result = SkillInputSchema.safeParse({ title: "Minimal Skill" });
    expect(result.success).toBe(true);
  });

  it("accepts empty arrays for services, alerts, tags", () => {
    const result = SkillInputSchema.safeParse({
      title: "Test",
      services: [],
      alerts: [],
      tags: [],
    });
    expect(result.success).toBe(true);
  });
});
