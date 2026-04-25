import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./index.css";

// Static-demo build (GitHub Pages): there is no live server to inject
// `window.__APP_BASE__` at serve time, so lazy chunks would fall back to
// "/" via vite.config.ts's `renderBuiltUrl` and 404 under the repo-scoped
// sub-path (`<user>.github.io/<repo>/`). Plant the build-time base path as
// the runtime global before any lazy import fires.
if (import.meta.env.VITE_DEMO_STATIC === "true" && typeof window !== "undefined") {
  (window as unknown as { __APP_BASE__?: string }).__APP_BASE__ ??= import.meta.env.BASE_URL;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
