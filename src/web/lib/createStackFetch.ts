import { safeGetItem } from "./utils";

/** Base path from Vite config (e.g., "/dops/" or "/"). Always ends with "/". */
export const APP_BASE_PATH = import.meta.env.BASE_URL || "/";

/** Prepend the app base path to an API URL (e.g., "/api/health" → "/dops/api/health"). */
export function withBase(url: string): string {
  if (APP_BASE_PATH === "/") return url;
  const stripped = url.startsWith("/") ? url.slice(1) : url;
  return `${APP_BASE_PATH}${stripped}`;
}

export function createStackFetch(activeStackId: string) {
  return (url: string, opts?: RequestInit): Promise<Response> => {
    const headers = new Headers(opts?.headers);
    headers.set("X-Stack-Id", activeStackId);
    const apiKey = safeGetItem("dops-api-key");
    if (apiKey) {
      headers.set("X-API-Key", apiKey);
    }
    return fetch(withBase(url), { ...opts, headers });
  };
}
