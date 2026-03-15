import type { CliFlags } from "./types.js";

export type ParsedArgs = {
  command: string;
  args: string[];
  flags: CliFlags;
};

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: CliFlags = {
    timeout: 120000,
    verbose: false,
    config: process.env.CONFIG_PATH ?? "config.yaml",
    history: false,
  };

  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--verbose") {
      flags.verbose = true;
    } else if (arg === "--timeout" && argv[i + 1]) {
      flags.timeout = parseInt(argv[++i]!, 10);
    } else if (arg === "--config" && argv[i + 1]) {
      flags.config = argv[++i]!;
    } else if (arg === "--history") {
      flags.history = true;
    } else if (!arg.startsWith("--")) {
      positional.push(arg);
    }
  }

  const command = positional[0] ?? "interactive";
  const args = positional.slice(1);

  return { command, args, flags };
}
