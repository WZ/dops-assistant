// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { ProvidersPage } from "./ProvidersPage";
import { StackProvider } from "../contexts/StackContext";

function Wrapper({ children }: { children: ReactNode }) {
  return <StackProvider activeStackId="test-stack">{children}</StackProvider>;
}

interface ApiProvider {
  name: string;
  roles: string[];
  region?: string;
  transport: string;
  url?: string;
  webUrl?: string;
  source: "config" | "gui";
  status: "connected" | "error" | "unknown";
  toolCount: number;
  enabledToolCount?: number;
}

function mockFetch(providers: ApiProvider[]): Record<string, unknown> {
  const capturedRequests: Array<{ url: string; init?: RequestInit }> = [];

  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    capturedRequests.push({ url: urlStr, init });

    // Match: /api/stacks/:id/api/providers (from createStackFetch) or /api/providers
    if (urlStr.endsWith("/api/providers") && (!init || init.method === "GET" || !init.method)) {
      return new Response(JSON.stringify(providers), { status: 200 });
    }
    if (urlStr.endsWith("/api/providers") && init?.method === "POST") {
      return new Response(JSON.stringify({ name: "new", status: "connected", toolCount: 0 }), { status: 201 });
    }
    const putMatch = urlStr.match(/\/api\/providers\/([^/]+)$/);
    if (putMatch && init?.method === "PUT") {
      return new Response(JSON.stringify({ name: putMatch[1], status: "connected", toolCount: 0 }), { status: 200 });
    }
    if (putMatch && init?.method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  });

  return { fetchImpl, capturedRequests };
}

describe("ProvidersPage webUrl round-trip", () => {
  const originalFetch = global.fetch;
  let fetchImpl: ReturnType<typeof vi.fn>;
  let capturedRequests: Array<{ url: string; init?: RequestInit }>;

  beforeEach(() => {
    const guiProvider: ApiProvider = {
      name: "gui-grafana",
      roles: ["metrics"],
      transport: "http",
      url: "http://localhost:8080/mcp",
      webUrl: "https://grafana.example.com/",
      source: "gui",
      status: "connected",
      toolCount: 3,
      enabledToolCount: 3,
    };
    const mock = mockFetch([guiProvider]);
    fetchImpl = mock.fetchImpl as ReturnType<typeof vi.fn>;
    capturedRequests = mock.capturedRequests as Array<{ url: string; init?: RequestInit }>;
    global.fetch = fetchImpl as unknown as typeof global.fetch;
    // Silence alerts
    window.alert = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.clearAllMocks();
  });

  it("sends webUrl in the PUT body when editing an existing provider", async () => {
    render(
      <Wrapper>
        <ProvidersPage onRunDiscovery={vi.fn()} />
      </Wrapper>,
    );

    // Wait for provider card to appear
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit gui-grafana" })).toBeDefined());

    // Click Edit to open the form pre-filled with gui-grafana
    fireEvent.click(screen.getByRole("button", { name: "Edit gui-grafana" }));

    // Form should have webUrl pre-filled from provider data (handleEdit round-trip)
    const webUrlInput = screen.getByPlaceholderText("https://grafana.example.com/") as HTMLInputElement;
    expect(webUrlInput.value).toBe("https://grafana.example.com/");

    // Change webUrl and save
    fireEvent.change(webUrlInput, { target: { value: "https://grafana.new.example/" } });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    await waitFor(() => {
      const putCall = capturedRequests.find(r => r.init?.method === "PUT");
      expect(putCall).toBeDefined();
      expect(putCall!.url).toContain("/api/providers/gui-grafana");
      const body = JSON.parse(putCall!.init!.body as string);
      expect(body.webUrl).toBe("https://grafana.new.example/");
      expect(body.name).toBe("gui-grafana");
      expect(body.mcpServer).toEqual({ transport: "http", url: "http://localhost:8080/mcp" });
    });
  });

  it("opens a confirm dialog on Remove and does NOT delete until confirmed", async () => {
    render(
      <Wrapper>
        <ProvidersPage onRunDiscovery={vi.fn()} />
      </Wrapper>,
    );

    await waitFor(() => expect(screen.getByRole("button", { name: "Remove gui-grafana" })).toBeDefined());

    // Click Remove — should open dialog, NOT fire DELETE
    fireEvent.click(screen.getByRole("button", { name: "Remove gui-grafana" }));

    await waitFor(() => {
      expect(screen.getByRole("alertdialog")).toBeDefined();
    });
    expect(screen.getByText(/Remove provider "gui-grafana"\?/)).toBeDefined();

    // No DELETE yet
    expect(capturedRequests.find(r => r.init?.method === "DELETE")).toBeUndefined();

    // Cancel preserves provider
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(capturedRequests.find(r => r.init?.method === "DELETE")).toBeUndefined();
  });

  it("fires DELETE after confirm in the remove dialog", async () => {
    render(
      <Wrapper>
        <ProvidersPage onRunDiscovery={vi.fn()} />
      </Wrapper>,
    );

    await waitFor(() => expect(screen.getByRole("button", { name: "Remove gui-grafana" })).toBeDefined());

    fireEvent.click(screen.getByRole("button", { name: "Remove gui-grafana" }));
    await waitFor(() => expect(screen.getByRole("alertdialog")).toBeDefined());

    // Confirm — should trigger DELETE
    const dialog = screen.getByRole("alertdialog");
    const confirmBtn = Array.from(dialog.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Remove",
    );
    expect(confirmBtn).toBeDefined();
    fireEvent.click(confirmBtn!);

    await waitFor(() => {
      const deleteCall = capturedRequests.find(r => r.init?.method === "DELETE");
      expect(deleteCall).toBeDefined();
      expect(deleteCall!.url).toContain("/api/providers/gui-grafana");
    });
  });

  it("includes webUrl in the POST body when adding a new provider", async () => {
    render(
      <Wrapper>
        <ProvidersPage onRunDiscovery={vi.fn()} />
      </Wrapper>,
    );

    await waitFor(() => expect(screen.getByRole("button", { name: /New Provider/ })).toBeDefined());

    fireEvent.click(screen.getByRole("button", { name: /New Provider/ }));

    fireEvent.change(screen.getByPlaceholderText("my-provider"), { target: { value: "new-one" } });
    fireEvent.change(screen.getByPlaceholderText("http://localhost:8080/mcp"), {
      target: { value: "http://localhost:9000/mcp" },
    });
    fireEvent.change(screen.getByPlaceholderText("https://grafana.example.com/"), {
      target: { value: "https://g.example.org/" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "metrics" }));
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    await waitFor(() => {
      const postCall = capturedRequests.find(r => r.init?.method === "POST" && r.url.endsWith("/api/providers"));
      expect(postCall).toBeDefined();
      const body = JSON.parse(postCall!.init!.body as string);
      expect(body.webUrl).toBe("https://g.example.org/");
      expect(body.name).toBe("new-one");
    });
  });
});
