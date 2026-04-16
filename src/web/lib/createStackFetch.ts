import { safeGetItem } from "./utils";

export function createStackFetch(activeStackId: string) {
  return (url: string, opts?: RequestInit): Promise<Response> => {
    const headers = new Headers(opts?.headers);
    headers.set("X-Stack-Id", activeStackId);
    const apiKey = safeGetItem("dops-api-key");
    if (apiKey) {
      headers.set("X-API-Key", apiKey);
    }
    return fetch(url, { ...opts, headers });
  };
}
