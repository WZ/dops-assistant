// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useWebSocket } from "./useWebSocket.js";

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string) { this.sent.push(data); }
  close() { this.readyState = 3; this.onclose?.(); }
  // test helpers
  open() { this.readyState = 1; this.onopen?.(); }
  drop() { this.readyState = 3; this.onerror?.(); this.onclose?.(); }
  receive(msg: unknown) { this.onmessage?.({ data: JSON.stringify(msg) }); }
}

const latest = () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;

describe("useWebSocket reconnect", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("reconnects with exponential backoff after the server drops the socket", () => {
    const { result } = renderHook(() => useWebSocket("stack-1"));
    act(() => latest().open());
    expect(result.current.status).toBe("connected");

    act(() => latest().drop());
    expect(result.current.status).toBe("disconnected");
    expect(FakeWebSocket.instances).toHaveLength(1);

    act(() => { vi.advanceTimersByTime(1000); });
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(result.current.status).toBe("connecting");

    act(() => latest().drop());
    act(() => { vi.advanceTimersByTime(1999); });
    expect(FakeWebSocket.instances).toHaveLength(2);
    act(() => { vi.advanceTimersByTime(1); });
    expect(FakeWebSocket.instances).toHaveLength(3);

    act(() => latest().open());
    expect(result.current.status).toBe("connected");
  });

  it("resets the backoff after a successful reconnect", () => {
    renderHook(() => useWebSocket("stack-1"));
    act(() => latest().drop());
    act(() => { vi.advanceTimersByTime(1000); });
    act(() => latest().drop());
    act(() => { vi.advanceTimersByTime(2000); });
    act(() => latest().open());

    act(() => latest().drop());
    act(() => { vi.advanceTimersByTime(1000); });
    expect(FakeWebSocket.instances).toHaveLength(4);
  });

  it("caps the backoff at 30s", () => {
    renderHook(() => useWebSocket("stack-1"));
    for (let i = 0; i < 8; i++) {
      act(() => latest().drop());
      act(() => { vi.advanceTimersByTime(30_000); });
    }
    expect(FakeWebSocket.instances).toHaveLength(9);
  });

  it("keeps received messages across a reconnect", () => {
    const { result } = renderHook(() => useWebSocket("stack-1"));
    act(() => latest().open());
    act(() => latest().receive({ type: "discover:phase", phase: "discovery", status: "running" }));
    act(() => latest().drop());
    act(() => { vi.advanceTimersByTime(1000); });
    act(() => latest().open());
    expect(result.current.messages).toHaveLength(1);
  });

  it("sends on the new socket after reconnecting", () => {
    const { result } = renderHook(() => useWebSocket("stack-1"));
    act(() => latest().open());
    act(() => latest().drop());
    act(() => { vi.advanceTimersByTime(1000); });
    act(() => latest().open());
    act(() => result.current.send({ type: "discover" }));
    expect(latest().sent).toEqual([JSON.stringify({ type: "discover" })]);
  });

  it("does not reconnect after unmount", () => {
    const { unmount } = renderHook(() => useWebSocket("stack-1"));
    act(() => latest().open());
    unmount();
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("does not reconnect the old stack's socket after a stack switch", () => {
    const { rerender } = renderHook(({ id }) => useWebSocket(id), { initialProps: { id: "stack-1" } });
    act(() => latest().open());
    rerender({ id: "stack-2" });
    expect(FakeWebSocket.instances).toHaveLength(2);
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(latest().url).toContain("stackId=stack-2");
  });
});
