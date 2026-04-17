import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

export default defineConfig({
  base: process.env.VITE_BASE_PATH || "/",
  plugins: [react(), tailwindcss()],
  root: "src/web",
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
  },
  // Make dynamically-loaded chunk and CSS preload URLs runtime-configurable.
  // Without this, Vite bakes `base` into every `preloadHelper` call and
  // lazy-chunk import, so sub-path deploys served without a matching
  // VITE_BASE_PATH build-arg 404 on every lazy-loaded route (e.g. the
  // ServiceDetail page at /dops/services/<name>).
  //
  // Static references in index.html still use the build-time `base` ("/") —
  // the server rewrites those to the configured sub-path at serve time.
  experimental: {
    renderBuiltUrl(filename, { hostType }) {
      if (hostType === "html") return undefined;
      return {
        runtime: `(globalThis.__APP_BASE__ ?? "/") + ${JSON.stringify(filename)}`,
      };
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src/web"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3000",
      "/ws": {
        target: "ws://localhost:3000",
        ws: true,
      },
    },
  },
});
