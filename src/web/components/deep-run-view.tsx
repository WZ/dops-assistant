/**
 * deep-run-view (PR-2d, T2) — the shared, presentational projection of a
 * `DeepRunState`, extracted from `InlineRunRegion` so BOTH the inline Console
 * strip and the wide `DeepInvestigationPanel` render from one source (DRY — no
 * divergent copy of the conclusion/causal-chain/move-log logic).
 *
 * Everything here is pure given a `DeepRunState` (+ an explicit `live` flag for
 * the stream) — no run-registry subscription, no local state. The two surfaces
 * own their own chrome (status strip vs panel header, collapse, pause bar) and
 * compose these pieces inside it.
 */
import { AgentStream, type AgentStreamFooterItem } from "./AgentStream";
import { DeepModeStream } from "./DeepModeStream";
import { buildExploreUrl, extractQueryFromToolCall } from "../lib/grafana-links";
import type { GrafanaProvider } from "../hooks/useGrafanaProviders";
import type { DeepRunState } from "../contexts/OrchestratorRunContext";
import type { EvidenceProvenance } from "../../types/ws-types";

/** Compact mm:ss / ss formatting for elapsed/duration. */
export function fmtSeconds(s: number): string {
  if (!isFinite(s) || s < 0) s = 0;
  return s >= 60 ? `${Math.floor(s / 60)}m${String(Math.floor(s % 60)).padStart(2, "0")}s` : `${Math.round(s)}s`;
}

export function outcomeHeadline(outcome: string | undefined): string {
  switch (outcome) {
    case "confirmed": return "Confirmed a root cause";
    case "operator-pause": return "Paused — needs a human call";
    case "aborted": return "Stopped — run cancelled";
    case "budget-exhausted": return "Stopped — hit the token budget";
    case "tool-cap": return "Stopped — hit the query limit";
    case "wall-clock": return "Stopped — hit the time limit";
    case "exhausted": return "Stopped — no further moves";
    case "inconclusive": return "Inconclusive — no clear cause";
    default: return "Deep investigation finished";
  }
}

/** A viewerless run the server parked (PR-2c). Resumes automatically once this
 *  client reattaches; shown distinctly from INTERRUPTED (which is unrecoverable
 *  here — the server no longer has the run). Park takes precedence. */
export function isParked(run: DeepRunState): boolean {
  return !!run.parked && run.running;
}

/** A run reconstructed from persisted events that was still `running` when the
 *  page last closed AND has no live server-side run to reattach to: shown as
 *  INTERRUPTED rather than a live (but frozen) run (PR-2, D). A parked run is
 *  recoverable, so it is not "interrupted". */
export function isInterrupted(run: DeepRunState): boolean {
  return !!run.hydrated && run.running && !run.parked;
}

export function kicker(run: DeepRunState): string {
  if (isParked(run)) return "Parked";
  if (isInterrupted(run)) return "Interrupted";
  if (run.kind === "deep-mode") return "Deep re-examination";
  if (run.running) return "Working theory";
  return run.outcome === "confirmed" ? "Current conclusion" : "Result";
}

/** The one-line conclusion shown result-first, derived from the real run state. */
export function conclusionHeadline(run: DeepRunState): string {
  if (isParked(run)) return "Parked while no one was watching — resuming…";
  if (isInterrupted(run)) {
    const last = run.steps[run.steps.length - 1];
    return last?.target
      ? `Interrupted while investigating: ${last.target}`
      : "Interrupted before reaching a conclusion";
  }
  if (run.kind === "deep-mode") {
    if (run.running) return "Re-judging the ruled-out causes…";
    const s = run.deepStats;
    if (s) return s.resurrected > 0
      ? `${s.resurrected} ruled-out cause${s.resurrected === 1 ? "" : "s"} resurrected on closer look`
      : "No ruled-out cause held up — the original RCA stands";
    return "Deep re-examination complete";
  }
  // orchestrator
  if (run.running) {
    const last = run.steps[run.steps.length - 1];
    return last?.target ? `Investigating: ${last.target}` : "Investigating the root cause…";
  }
  const root = run.causalChain?.find((l) => l.kind === "root-cause");
  if (run.outcome === "confirmed" && root) return root.label.replace(/^root cause:\s*/i, "");
  return outcomeHeadline(run.outcome);
}

/** Announce only state changes + the pause prompt (DZ4) — empty while a run
 *  streams mid-flight, so the move log never reaches the live region. */
export function liveAnnouncement(run: DeepRunState): string {
  if (isParked(run)) return "This deep investigation parked while no one was watching. Reattaching to resume it.";
  if (isInterrupted(run)) return "This deep investigation was interrupted when the page reloaded. Re-run to continue.";
  if (run.pause && !run.decisionSubmitted) return `Paused after ${run.pause.strikes} strikes — your decision is needed.`;
  if (!run.running && run.error) return `Deep investigation stopped: ${run.error}`;
  if (!run.running && run.outcome) return `Deep investigation finished: ${outcomeHeadline(run.outcome)}.`;
  if (run.running && run.steps.length === 0) return "Deep investigation started.";
  return "";
}

/**
 * Build a Grafana Explore URL for a causal-chain link's provenance (PR-3), the
 * same client-side path `EvidenceTimeline` uses: extract the query from the raw
 * tool call, resolve the provider by kind (metrics/logs), build the deep-link over
 * the incident window. Returns "" when the query isn't extractable, no provider is
 * configured for that role, or the time window is missing — caller renders no link.
 */
function provenanceUrl(p: EvidenceProvenance, providers: GrafanaProvider[]): string {
  const extracted = extractQueryFromToolCall(p.tool, p.args);
  if (!extracted) return "";
  const role = extracted.kind === "logs" ? "logs" : "metrics";
  const provider = providers.find((pr) => pr.role === role);
  if (!provider?.webUrl) return "";
  return buildExploreUrl({
    webUrl: provider.webUrl,
    datasource: extracted.datasource ?? provider.datasource,
    query: extracted.query,
    from: p.from ?? "",
    to: p.to ?? "",
  });
}

export function CausalChain({
  chain,
  providers = [],
}: {
  chain: NonNullable<DeepRunState["causalChain"]>;
  providers?: GrafanaProvider[];
}) {
  return (
    <div className="mt-2.5 flex flex-col font-mono text-[11px]">
      {chain.map((link, i) => {
        const url = link.provenance ? provenanceUrl(link.provenance, providers) : "";
        return (
          <div key={i} className="flex flex-col">
            {i > 0 && <span className="text-muted-foreground/40 leading-none my-0.5" aria-hidden>↓</span>}
            <span className={link.kind === "root-cause" ? "text-success" : "text-foreground/90"}>{link.label}</span>
            {link.evidence && <span className="text-[10px] text-muted-foreground/70 leading-snug pl-3">{link.evidence}</span>}
            {url && (
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                className="text-[10px] text-accent/80 hover:text-accent hover:underline leading-snug pl-3 w-fit"
              >
                Grafana ↗
              </a>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Result-first view (default): conclusion → causal chain → trace summary. The
 *  move log is hidden here (switch to Live log for it) — DZ1/DZ2. */
export function ResultView({ run, providers = [] }: { run: DeepRunState; providers?: GrafanaProvider[] }) {
  return (
    <div>
      <div className="font-mono text-[9px] tracking-[0.13em] uppercase text-accent/70">{kicker(run)}</div>
      <div className="font-semibold text-[14px] leading-snug mt-1 text-foreground">{conclusionHeadline(run)}</div>
      {run.causalChain && run.causalChain.length > 1 && <CausalChain chain={run.causalChain} providers={providers} />}
      {run.traceSummary && <div className="font-mono text-[10px] text-muted-foreground/60 mt-2">{run.traceSummary}</div>}
      {run.steps.length > 0 && (
        <div className="mt-2 font-mono text-[10px] text-muted-foreground/45">
          {run.steps.length} move{run.steps.length === 1 ? "" : "s"} · switch to Live log for detail
        </div>
      )}
    </div>
  );
}

/** The raw move stream — reuses the same renderers as the legacy surfaces. A
 *  hydrated-interrupted run is not live, so its stream is rendered settled
 *  (no trailing spinner) via the explicit `live` flag. */
export function LiveView({ run, live }: { run: DeepRunState; live: boolean }) {
  if (run.kind === "deep-mode") {
    return <DeepModeStream events={run.steps} stats={run.deepStats} running={live} />;
  }
  const s = run.orchStats;
  const footer: AgentStreamFooterItem[] | undefined = s
    ? [
        { label: "moves", value: s.moves },
        { label: "queries", value: s.toolCalls },
        ...(s.subagents > 0 ? [{ label: "subagents", value: s.subagents }] : []),
        { label: "strikes", value: s.strikes, tone: s.strikes > 0 ? "warn" : "default" },
        { label: "tokens", value: s.tokensSpent },
      ]
    : undefined;
  return <AgentStream label="Deep Investigation" events={run.steps} footer={footer} running={live} />;
}
