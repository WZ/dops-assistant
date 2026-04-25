import { useEffect, useState } from "react";
import { useStackContext } from "../contexts/StackContext";

type Rating = "useful" | "not_useful";

interface InvestigationFeedbackProps {
  investigationId: string;
}

/**
 * Thumbs-up / thumbs-down rating on an investigation. Closes the Learned
 * Patterns loop: the server already extracts a pattern on every first-time
 * "useful" vote (see routes.ts:1347) but before this component, nothing on
 * the client side ever called that endpoint, so `incident_patterns` could
 * never accumulate and the Ops Desk Learned Patterns section stayed empty
 * forever. Rating is upserted server-side — clicking a button twice just
 * confirms the same rating; switching flips it. Pattern extraction fires
 * only on the first transition to "useful" (see upsertFeedback return).
 */
export function InvestigationFeedback({ investigationId }: InvestigationFeedbackProps) {
  const { stackFetch } = useStackContext();
  const [rating, setRating] = useState<Rating | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch the current rating on mount. If the investigation has never been
  // rated the server returns { rating: null } and the buttons render neutral.
  useEffect(() => {
    const controller = new AbortController();
    stackFetch(`/api/investigations/${investigationId}/feedback`, { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : Promise.resolve({ rating: null })))
      .then((data: { rating: Rating | null }) => {
        setRating(data.rating);
      })
      .catch((err) => {
        if (err.name !== "AbortError") setRating(null);
      });
    return () => controller.abort();
  }, [stackFetch, investigationId]);

  const submit = async (next: Rating) => {
    // Optimistic: flip the UI immediately, roll back on failure. Users click
    // thumbs-up and expect the button to fill in instantly; waiting for the
    // round-trip makes the whole interaction feel laggy.
    const previous = rating;
    setSubmitting(true);
    setError(null);
    setRating(next);
    try {
      const res = await stackFetch(`/api/investigations/${investigationId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rating: next }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(body || `HTTP ${res.status}`);
      }
    } catch (err) {
      setRating(previous);
      setError(err instanceof Error ? err.message : "Failed to save rating");
    } finally {
      setSubmitting(false);
    }
  };

  const confirmation =
    rating === "useful"
      ? "Thanks — this feeds the pattern learner."
      : rating === "not_useful"
        ? "Got it — we'll use this to tune future investigations."
        : null;

  return (
    <section
      aria-label="Rate this investigation"
      className="mt-6 pt-4 border-t border-border/30 flex flex-wrap items-center gap-3"
    >
      <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground/60">
        Was this useful?
      </span>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => submit("useful")}
          disabled={submitting}
          aria-pressed={rating === "useful"}
          aria-label="Mark as useful"
          className={`h-8 w-8 rounded-md border text-sm transition-colors disabled:opacity-60 disabled:cursor-wait ${
            rating === "useful"
              ? "bg-success/15 border-success/60 text-success"
              : "border-border/40 text-foreground/65 hover:bg-card/70 hover:text-foreground"
          }`}
        >
          👍
        </button>
        <button
          type="button"
          onClick={() => submit("not_useful")}
          disabled={submitting}
          aria-pressed={rating === "not_useful"}
          aria-label="Mark as not useful"
          className={`h-8 w-8 rounded-md border text-sm transition-colors disabled:opacity-60 disabled:cursor-wait ${
            rating === "not_useful"
              ? "bg-destructive/15 border-destructive/60 text-destructive"
              : "border-border/40 text-foreground/65 hover:bg-card/70 hover:text-foreground"
          }`}
        >
          👎
        </button>
      </div>
      {confirmation && (
        <span className="font-mono text-[10px] text-muted-foreground/70">{confirmation}</span>
      )}
      {error && (
        <span role="alert" className="font-mono text-[10px] text-destructive">
          {error}
        </span>
      )}
    </section>
  );
}
