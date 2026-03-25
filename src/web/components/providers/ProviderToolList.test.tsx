// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ProviderToolList } from "./ProviderToolList";

const mockTools = [
  { name: "query_prometheus", description: "Query metrics", readOnly: true, enabled: true },
  { name: "list_datasources", description: "List datasources", readOnly: true, enabled: true },
  { name: "create_dashboard", description: "Create a dashboard", readOnly: false, enabled: false },
  { name: "update_alert_rule", description: "Update alert rule", readOnly: false, enabled: false },
];

describe("ProviderToolList", () => {
  afterEach(() => vi.restoreAllMocks());

  it("renders tool rows with correct badges", () => {
    render(<ProviderToolList tools={mockTools} providerName="grafana" source="gui" onUpdate={vi.fn()} />);
    expect(screen.getByText("query_prometheus")).toBeDefined();
    expect(screen.getAllByText("READ").length).toBe(2);
    expect(screen.getAllByText("WRITE").length).toBe(2);
  });

  it("shows safety banner", () => {
    render(<ProviderToolList tools={mockTools} providerName="grafana" source="gui" onUpdate={vi.fn()} />);
    expect(screen.getByText(/read-only tools are enabled/i)).toBeDefined();
  });

  it("sorts read-only tools before write tools", () => {
    render(<ProviderToolList tools={mockTools} providerName="grafana" source="gui" onUpdate={vi.fn()} />);
    const names = screen.getAllByTestId("tool-name").map(el => el.textContent);
    expect(names[0]).toBe("list_datasources");
    expect(names[1]).toBe("query_prometheus");
    expect(names[2]).toBe("create_dashboard");
    expect(names[3]).toBe("update_alert_rule");
  });

  it("calls onUpdate when toggle is clicked", async () => {
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    render(<ProviderToolList tools={mockTools} providerName="grafana" source="gui" onUpdate={onUpdate} />);
    const switches = screen.getAllByRole("switch");
    fireEvent.click(switches[2]!);
    await waitFor(() => {
      expect(onUpdate).toHaveBeenCalledWith(
        expect.arrayContaining(["query_prometheus", "list_datasources", "create_dashboard"])
      );
    });
  });

  it("shows config warning for system providers", () => {
    render(<ProviderToolList tools={mockTools} providerName="grafana" source="config" onUpdate={vi.fn()} />);
    expect(screen.getByText(/in-memory only/i)).toBeDefined();
  });

  it("shows loading state", () => {
    render(<ProviderToolList tools={null} providerName="grafana" source="gui" onUpdate={vi.fn()} />);
    expect(screen.getByTestId("tool-list-loading")).toBeDefined();
  });
});
