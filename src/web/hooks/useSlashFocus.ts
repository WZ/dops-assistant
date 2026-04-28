import { useEffect, type RefObject } from "react";

/**
 * Focus the input pointed at by `ref` when the user presses `/`, matching
 * GitHub-style search shortcuts. Pressing `Escape` while focused on that
 * input blurs it.
 *
 * Skips activation when the user is already typing in any text input,
 * textarea, or contentEditable element so `/` still types literally where
 * expected.
 */
export function useSlashFocus(ref: RefObject<HTMLInputElement | null>) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Escape blurs only when the search input itself is focused.
      if (e.key === "Escape" && e.target === ref.current) {
        e.preventDefault();
        ref.current?.blur();
        return;
      }
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;

      const t = e.target as HTMLElement | null;
      if (t) {
        const tag = t.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable) {
          return;
        }
      }

      e.preventDefault();
      ref.current?.focus();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ref]);
}
