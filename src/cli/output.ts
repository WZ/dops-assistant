export type BuildOutputOpts = {
  command: string;
  status: string;
  durationMs: number;
  tokens?: { input: number; output: number; total: number } | null;
  toolCalls?: Array<Record<string, unknown>>;
  result?: unknown;
  error?: string;
  extra?: Record<string, unknown>;
};

export function buildOutput(opts: BuildOutputOpts): Record<string, unknown> {
  const { command, status, durationMs, tokens, toolCalls, result, error, extra } = opts;
  return {
    command,
    ...extra,
    status,
    durationMs,
    tokens: tokens ?? null,
    toolCalls: toolCalls ?? [],
    result: result ?? null,
    error: error ?? null,
  };
}

export function writeOutput(data: unknown, exitCode: number): Promise<never> {
  const json = JSON.stringify(data, null, 2) + "\n";
  return new Promise<never>((resolve) => {
    process.stdout.write(json, () => {
      resolve(undefined as never);
      process.exit(exitCode);
    });
  });
}
