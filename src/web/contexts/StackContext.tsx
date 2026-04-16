import { createContext, useContext, useMemo, type ReactNode } from "react";
import { createStackFetch } from "../lib/createStackFetch";

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
  const stackFetch = useMemo(() => createStackFetch(activeStackId), [activeStackId]);

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
