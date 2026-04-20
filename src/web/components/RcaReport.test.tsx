// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RcaReport } from "./RcaReport";

const baseReport = {
  rootCause: "Deploy #2871 increased the default page buffer by 40%, pushing pod-7 past its memory limit.",
  trigger: "Deploy at 14:02 UTC",
  confidence: "high",
  confidenceScore: 0.84,
  severity: "high",
  summary: "payments-api 503s driven by OOM on pod-7 after deploy.",
  impact: { duration: "12m", description: "78% of requests to payments-api failed." },
  contributingFactors: ["Only pod-7 had reduced memory headroom"],
  timeline: [{ time: "14:02", event: "Deploy #2871 merged" }],
  recommendedActions: ["Increase memory.limit headroom on pod-7"],
  dashboardLinks: [],
};

describe("RcaReport — Evidence section", () => {
  it("renders per-category evidence lists when provided", () => {
    const report = {
      ...baseReport,
      evidence: {
        metrics: ["error_rate 0.02 → 0.78 at 14:03", "memory 94% of limit at 14:04"],
        logs: ["OOMKilled · pod-7 · 43 matches"],
        infra: [],
        changes: ["deploy #2871 @14:02"],
      },
    };
    render(<RcaReport report={report} />);
    expect(screen.getByText(/Evidence/i)).toBeDefined();
    expect(screen.getByText(/error_rate 0.02/)).toBeDefined();
    expect(screen.getByText(/OOMKilled · pod-7/)).toBeDefined();
    expect(screen.getByText(/deploy #2871 @14:02/)).toBeDefined();
  });

  it("does not render the Evidence section when evidence is absent", () => {
    render(<RcaReport report={baseReport} />);
    expect(screen.queryByText(/^Evidence/)).toBeNull();
  });

  it("does not render the Evidence section when every category is empty", () => {
    const report = {
      ...baseReport,
      evidence: { metrics: [], logs: [], infra: [], changes: [] },
    };
    render(<RcaReport report={report} />);
    expect(screen.queryByText(/^Evidence/)).toBeNull();
  });

  it("caps long categories with an overflow indicator", () => {
    const many = Array.from({ length: 8 }, (_, i) => `metric_${i} observation`);
    const report = { ...baseReport, evidence: { metrics: many, logs: [], infra: [] } };
    render(<RcaReport report={report} />);
    expect(screen.getByText(/\+ 3 more/)).toBeDefined();
  });
});

describe("RcaReport — Quick Actions", () => {
  it("does not render Quick Actions when actionLinks is absent", () => {
    render(<RcaReport report={baseReport} />);
    expect(screen.queryByText(/Quick Actions/i)).toBeNull();
  });

  it("renders action label, rationale, command, and URL", () => {
    const report = {
      ...baseReport,
      actionLinks: [
        {
          label: "Rollback deploy #2871",
          rationale: "Restores the previous page-buffer size on pod-7.",
          command: "kubectl rollout undo deployment/payments-api -n prod",
          url: "https://git.example.com/payments/-/merge_requests/2871",
          urlLabel: "View MR #2871",
          kind: "rollback" as const,
        },
      ],
    };
    render(<RcaReport report={report} />);
    expect(screen.getByText(/Quick Actions/)).toBeDefined();
    expect(screen.getByText(/Rollback deploy #2871/)).toBeDefined();
    expect(screen.getByText(/Restores the previous page-buffer size/)).toBeDefined();
    expect(screen.getByText(/kubectl rollout undo/)).toBeDefined();
    expect(screen.getByText(/View MR #2871/)).toBeDefined();
  });

  it("copies the command to the clipboard when Copy is clicked", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const report = {
      ...baseReport,
      actionLinks: [{ label: "Rollback", command: "kubectl rollout undo" }],
    };
    render(<RcaReport report={report} />);
    fireEvent.click(screen.getByLabelText(/Copy command/i));
    expect(writeText).toHaveBeenCalledWith("kubectl rollout undo");
  });

  it("renders an action with only a label gracefully", () => {
    const report = {
      ...baseReport,
      actionLinks: [{ label: "Investigate pod-7 startup probe" }],
    };
    render(<RcaReport report={report} />);
    expect(screen.getByText(/Investigate pod-7 startup probe/)).toBeDefined();
    expect(screen.queryByLabelText(/Copy command/i)).toBeNull();
  });
});
