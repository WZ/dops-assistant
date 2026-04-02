import { createContext, useContext, useCallback, type ReactNode } from "react";

interface StackContextValue {
  activeStackId: string;
  stackFetch: (url: string, opts?: RequestInit) => Promise<Response>;
}

const StackContext = createContext<StackContextValue | null>(null);

export function StackProvider({
  children,
  activeStackId,
}: {
  children: ReactNode;
  activeStackId: string;
}) {
  const stackFetch = useCallback(
    (url: string, opts?: RequestInit) => {
      const headers = new Headers(opts?.headers);
      headers.set("X-Stack-Id", activeStackId);
      const apiKey = localStorage.getItem("dops-api-key");
      if (apiKey) {
        headers.set("X-API-Key", apiKey);
      }
      return fetch(url, { ...opts, headers });
    },
    [activeStackId],
  );

  return (
    <StackContext.Provider value={{ activeStackId, stackFetch }}>
      {children}
    </StackContext.Provider>
  );
}

export function useStackContext(): StackContextValue {
  const ctx = useContext(StackContext);
  if (!ctx) {
    throw new Error("useStackContext must be used within a StackProvider");
  }
  return ctx;
}
