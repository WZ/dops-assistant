/**
 * DemoBanner — thin strip shown at the top of the app when the server is
 * running in read-only demo mode. Renders only when `window.__DEMO_MODE__`
 * was injected at serve time (see src/server/index.ts buildIndexHtml).
 *
 * The banner is the ONLY UI signal that distinguishes demo mode from a
 * normal deployment — without it, visitors could try to trigger actions
 * and get cryptic 403s. Leave it at the very top of the render tree.
 */

/**
 * Read the demo-mode flag injected into the document at serve time. Kept as
 * a function (not a module constant) so SSR / tests can stub `window`.
 */
export function isDemoActive(): boolean {
  if (typeof window === "undefined") return false;
  return (window as unknown as { __DEMO_MODE__?: boolean }).__DEMO_MODE__ === true;
}

export interface DemoBannerProps {
  /** Override the default repo URL. Primarily useful for tests. */
  repoUrl?: string;
}

export function DemoBanner({ repoUrl = "https://github.com/WZ/dops-assistant" }: DemoBannerProps) {
  if (!isDemoActive()) return null;
  return (
    <div
      role="region"
      aria-label="Demo mode"
      className="shrink-0 flex items-center justify-center gap-3 px-4 py-1.5 text-xs font-medium bg-amber-500/10 border-b border-amber-500/30 text-amber-100"
    >
      <span className="uppercase tracking-wider text-amber-400 font-semibold">Demo</span>
      <span className="opacity-80">
        Read-only showcase with seeded data. Chat, investigations, and config changes are disabled.
      </span>
      <a
        href={repoUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="underline decoration-amber-400/60 underline-offset-2 hover:decoration-amber-300"
      >
        Run it yourself →
      </a>
    </div>
  );
}
