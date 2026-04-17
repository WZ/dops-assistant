// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ConfirmActionDialog } from "./ConfirmActionDialog";

describe("ConfirmActionDialog", () => {
  it("does not render when open=false", () => {
    render(
      <ConfirmActionDialog
        open={false}
        onOpenChange={() => {}}
        title="Test"
        confirmLabel="OK"
        onConfirm={() => {}}
      />,
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("renders title, body, and labels when open", () => {
    render(
      <ConfirmActionDialog
        open={true}
        onOpenChange={() => {}}
        title="Remove provider 'foo'?"
        body="This will also wipe enabled tools."
        confirmLabel="Remove"
        onConfirm={() => {}}
      />,
    );
    expect(screen.getByRole("alertdialog")).toBeDefined();
    expect(screen.getByText("Remove provider 'foo'?")).toBeDefined();
    expect(screen.getByText("This will also wipe enabled tools.")).toBeDefined();
    expect(screen.getByRole("button", { name: "Remove" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDefined();
  });

  it("focuses Cancel by default (keyboard-safe)", async () => {
    render(
      <ConfirmActionDialog
        open={true}
        onOpenChange={() => {}}
        title="Test"
        confirmLabel="OK"
        onConfirm={() => {}}
      />,
    );
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
    });
  });

  it("calls onOpenChange(false) when Cancel clicked", () => {
    const onOpenChange = vi.fn();
    render(
      <ConfirmActionDialog
        open={true}
        onOpenChange={onOpenChange}
        title="Test"
        confirmLabel="OK"
        onConfirm={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("calls onOpenChange(false) on Escape", () => {
    const onOpenChange = vi.fn();
    render(
      <ConfirmActionDialog
        open={true}
        onOpenChange={onOpenChange}
        title="Test"
        confirmLabel="OK"
        onConfirm={() => {}}
      />,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("calls onOpenChange(false) on backdrop click", () => {
    const onOpenChange = vi.fn();
    render(
      <ConfirmActionDialog
        open={true}
        onOpenChange={onOpenChange}
        title="Test"
        confirmLabel="OK"
        onConfirm={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId("confirm-action-backdrop"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("calls onConfirm then closes on Confirm click", async () => {
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <ConfirmActionDialog
        open={true}
        onOpenChange={onOpenChange}
        title="Test"
        confirmLabel="Confirm"
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalled();
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it("awaits async onConfirm before closing", async () => {
    let resolveConfirm: () => void = () => {};
    const onConfirm = vi.fn(() => new Promise<void>((r) => { resolveConfirm = r; }));
    const onOpenChange = vi.fn();
    render(
      <ConfirmActionDialog
        open={true}
        onOpenChange={onOpenChange}
        title="Test"
        confirmLabel="Confirm"
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    // While pending, onOpenChange should not have been called
    expect(onOpenChange).not.toHaveBeenCalled();
    resolveConfirm();
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("applies destructive variant styling on confirm button", () => {
    render(
      <ConfirmActionDialog
        open={true}
        onOpenChange={() => {}}
        title="Test"
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={() => {}}
      />,
    );
    const confirmBtn = screen.getByRole("button", { name: "Delete" });
    expect(confirmBtn.className).toContain("bg-destructive");
  });

  it("applies default (primary) variant styling when unspecified", () => {
    render(
      <ConfirmActionDialog
        open={true}
        onOpenChange={() => {}}
        title="Test"
        confirmLabel="OK"
        onConfirm={() => {}}
      />,
    );
    const confirmBtn = screen.getByRole("button", { name: "OK" });
    expect(confirmBtn.className).toContain("bg-primary");
  });

  it("supports custom cancel label", () => {
    render(
      <ConfirmActionDialog
        open={true}
        onOpenChange={() => {}}
        title="Test"
        confirmLabel="OK"
        cancelLabel="Go Back"
        onConfirm={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Go Back" })).toBeDefined();
  });
});
