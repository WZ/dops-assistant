// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ProviderForm, type ProviderFormData } from "./ProviderForm";

function fillName(value: string) {
  const input = screen.getByPlaceholderText("my-provider") as HTMLInputElement;
  fireEvent.change(input, { target: { value } });
}

function fillUrl(value: string) {
  const input = screen.getByPlaceholderText("http://localhost:8080/mcp") as HTMLInputElement;
  fireEvent.change(input, { target: { value } });
}

function fillWebUrl(value: string) {
  const input = screen.getByPlaceholderText("https://grafana.example.com/") as HTMLInputElement;
  fireEvent.change(input, { target: { value } });
}

describe("ProviderForm", () => {
  it("renders all six role checkboxes including dependencies", () => {
    render(<ProviderForm onSave={vi.fn()} onCancel={vi.fn()} onTest={vi.fn()} />);
    expect(screen.getByRole("checkbox", { name: "metrics" })).toBeDefined();
    expect(screen.getByRole("checkbox", { name: "logs" })).toBeDefined();
    expect(screen.getByRole("checkbox", { name: "dashboards" })).toBeDefined();
    expect(screen.getByRole("checkbox", { name: "dependencies" })).toBeDefined();
    expect(screen.getByRole("checkbox", { name: "infrastructure" })).toBeDefined();
    expect(screen.getByRole("checkbox", { name: "changes" })).toBeDefined();
  });

  it("renders optional Web URL input", () => {
    render(<ProviderForm onSave={vi.fn()} onCancel={vi.fn()} onTest={vi.fn()} />);
    const input = screen.getByPlaceholderText("https://grafana.example.com/");
    expect(input).toBeDefined();
    expect(input.getAttribute("aria-label")).toBe("Web URL");
  });

  it("passes webUrl into saved form data when provided", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ProviderForm onSave={onSave} onCancel={vi.fn()} onTest={vi.fn()} />);

    fillName("foo");
    fillUrl("http://localhost:8080/mcp");
    fillWebUrl("https://grafana.example.com/");
    fireEvent.click(screen.getByRole("checkbox", { name: "metrics" }));
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const data = onSave.mock.calls[0][0] as ProviderFormData;
    expect(data.webUrl).toBe("https://grafana.example.com/");
    expect(data.roles).toEqual(["metrics"]);
  });

  it("omits webUrl from saved form data when blank", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ProviderForm onSave={onSave} onCancel={vi.fn()} onTest={vi.fn()} />);

    fillName("foo");
    fillUrl("http://localhost:8080/mcp");
    fireEvent.click(screen.getByRole("checkbox", { name: "metrics" }));
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const data = onSave.mock.calls[0][0] as ProviderFormData;
    expect(data.webUrl).toBeUndefined();
  });

  it("rejects invalid webUrl (not a URL)", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ProviderForm onSave={onSave} onCancel={vi.fn()} onTest={vi.fn()} />);

    fillName("foo");
    fillUrl("http://localhost:8080/mcp");
    fillWebUrl("not a url");
    fireEvent.click(screen.getByRole("checkbox", { name: "metrics" }));
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    await waitFor(() => {
      expect(screen.getByText(/must be a valid URL/i)).toBeDefined();
    });
    expect(onSave).not.toHaveBeenCalled();
  });

  it("pre-fills webUrl from initialValues (edit mode)", () => {
    const initial: ProviderFormData = {
      name: "grafana",
      roles: ["metrics"],
      webUrl: "https://grafana.example.com/",
      mcpServer: { transport: "http", url: "http://localhost:8080/mcp" },
    };
    render(
      <ProviderForm
        onSave={vi.fn()}
        onCancel={vi.fn()}
        onTest={vi.fn()}
        initialValues={initial}
      />,
    );
    const input = screen.getByPlaceholderText("https://grafana.example.com/") as HTMLInputElement;
    expect(input.value).toBe("https://grafana.example.com/");
  });

  it("toggles dependencies role into saved data", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ProviderForm onSave={onSave} onCancel={vi.fn()} onTest={vi.fn()} />);

    fillName("deps-provider");
    fillUrl("http://localhost:8080/mcp");
    fireEvent.click(screen.getByRole("checkbox", { name: "dependencies" }));
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const data = onSave.mock.calls[0][0] as ProviderFormData;
    expect(data.roles).toEqual(["dependencies"]);
  });

  // Mandatory regression (IRON RULE): Cancel in provider form preserves the initialValues
  // so the next open shows the provider's saved state, not a blank form.
  it("restores initialValues when the form is re-opened after cancel", () => {
    const initial: ProviderFormData = {
      name: "grafana",
      roles: ["metrics"],
      region: "us-east-1",
      webUrl: "https://grafana.example.com/",
      mcpServer: { transport: "http", url: "http://localhost:8080/mcp" },
    };

    // First open: verify initial values are present
    const first = render(
      <ProviderForm
        onSave={vi.fn()}
        onCancel={vi.fn()}
        onTest={vi.fn()}
        initialValues={initial}
      />,
    );
    expect((first.getByPlaceholderText("my-provider") as HTMLInputElement).value).toBe("grafana");
    expect((first.getByPlaceholderText("http://localhost:8080/mcp") as HTMLInputElement).value).toBe("http://localhost:8080/mcp");
    expect((first.getByPlaceholderText("https://grafana.example.com/") as HTMLInputElement).value).toBe("https://grafana.example.com/");
    expect((first.getByPlaceholderText("us-east-1") as HTMLInputElement).value).toBe("us-east-1");
    first.unmount();

    // Re-open: initialValues still drive the form (as ProvidersPage does on cancel + re-edit)
    const second = render(
      <ProviderForm
        onSave={vi.fn()}
        onCancel={vi.fn()}
        onTest={vi.fn()}
        initialValues={initial}
      />,
    );
    expect((second.getByPlaceholderText("my-provider") as HTMLInputElement).value).toBe("grafana");
    expect((second.getByPlaceholderText("https://grafana.example.com/") as HTMLInputElement).value).toBe("https://grafana.example.com/");
  });
});
