import { useRef, useEffect } from "react";

/**
 * Auto-scroll a container to the bottom when dependencies change,
 * but only if the user hasn't scrolled up manually.
 *
 * Returns a ref to attach to the scrollable container element.
 */
export function useAutoScroll(deps: unknown[]) {
  const ref = useRef<HTMLDivElement>(null);
  const isNearBottom = useRef(true);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      isNearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (isNearBottom.current && ref.current) {
      // Instant rather than smooth: during streaming the deps change every
      // animation frame as deltas arrive, so a smooth animation never
      // catches up with the growing content and the bottom of the bubble
      // ends up below the fold.
      ref.current.scrollTop = ref.current.scrollHeight;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return ref;
}
