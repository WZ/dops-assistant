import { test, expect } from "@playwright/test";

/**
 * Stack isolation E2E.
 *
 * Providers are stack-scoped: two stacks can each have a provider with the
 * same name but different URLs without collision. This was verified manually
 * during QA; pinning here prevents regression.
 */
test.describe("Stack isolation", () => {
  const PROVIDER_NAME = "e2e-isolation";
  let stackAId = "";
  let stackBId = "";

  test.beforeAll(async ({ request }) => {
    // Use the default stack as stack A.
    const stacks = await request.get("/api/stacks").then((r) => r.json() as Promise<Array<{ id: string; isDefault: boolean }>>);
    stackAId = stacks.find((s) => s.isDefault)?.id ?? stacks[0]?.id ?? "";
    expect(stackAId).toBeTruthy();

    // Create a second stack for B. POST /api/stacks requires {name, slug, config}
    // where config matches StackConfigSchema — {providers: []} is the minimal shape.
    const createRes = await request.post("/api/stacks", {
      data: { name: "e2e-stack-b", slug: "e2e-stack-b", config: { providers: [] } },
    });
    if (createRes.ok()) {
      const body = (await createRes.json()) as { id: string };
      stackBId = body.id;
    } else {
      // Fallback: existing one
      const all = await request.get("/api/stacks").then((r) => r.json() as Promise<Array<{ id: string; slug: string }>>);
      stackBId = all.find((s) => s.slug === "e2e-stack-b")?.id ?? "";
    }
    expect(stackBId).toBeTruthy();
  });

  test.afterAll(async ({ request }) => {
    // Cleanup — best-effort.
    await request.delete(`/api/providers/${PROVIDER_NAME}`, { headers: { "X-Stack-Id": stackAId } }).catch(() => {});
    await request.delete(`/api/providers/${PROVIDER_NAME}`, { headers: { "X-Stack-Id": stackBId } }).catch(() => {});
    if (stackBId) await request.delete(`/api/stacks/${stackBId}`).catch(() => {});
  });

  test("same provider name in two stacks with different URLs", async ({ request }) => {
    const mkBody = (url: string) => ({
      name: PROVIDER_NAME,
      mcpServer: { transport: "http", url },
      roles: ["metrics"],
      region: "test",
    });

    const resA = await request.post("/api/providers", {
      headers: { "X-Stack-Id": stackAId, "Content-Type": "application/json" },
      data: mkBody("http://127.0.0.1:59001/mcp"),
    });
    const resB = await request.post("/api/providers", {
      headers: { "X-Stack-Id": stackBId, "Content-Type": "application/json" },
      data: mkBody("http://127.0.0.1:59002/mcp"),
    });

    // Both should succeed — stacks are isolated.
    expect([200, 201].includes(resA.status())).toBeTruthy();
    expect([200, 201].includes(resB.status())).toBeTruthy();

    const listA = await request.get("/api/providers", { headers: { "X-Stack-Id": stackAId } }).then((r) => r.json() as Promise<Array<{ name: string; url: string }>>);
    const listB = await request.get("/api/providers", { headers: { "X-Stack-Id": stackBId } }).then((r) => r.json() as Promise<Array<{ name: string; url: string }>>);

    const a = listA.find((p) => p.name === PROVIDER_NAME);
    const b = listB.find((p) => p.name === PROVIDER_NAME);
    expect(a?.url).toBe("http://127.0.0.1:59001/mcp");
    expect(b?.url).toBe("http://127.0.0.1:59002/mcp");
  });
});
