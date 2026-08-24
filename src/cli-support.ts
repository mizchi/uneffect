import { parseArgs, type ParseArgsConfig } from "node:util";

/** Output sinks, so commands stay testable without spawning a process. */
export interface CliStreams { out(text: string): void; err(text: string): void }

export const processStreams: CliStreams = {
  out: (text) => void process.stdout.write(text),
  err: (text) => void process.stderr.write(text),
};

/** Exit codes: 0 success, 1 the checked program failed, 2 the command line was wrong. */
export const exitCode = { success: 0, failed: 1, usage: 2 } as const;

/** A wrong command line, reported with the command's usage instead of a stack trace. */
export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

export interface CliCommand {
  name: string;
  summary: string;
  /** Argument line shown after the command name, e.g. `<file.ts> [--strict]`. */
  arguments: string;
  /** Option and behaviour lines shown under `uneffect <name> --help`. */
  details: readonly string[];
  run(args: readonly string[], io: CliStreams): Promise<number>;
}

type OptionConfig = NonNullable<ParseArgsConfig["options"]>;

/** Strict parsing: an unknown or malformed option is a usage error, never a silently ignored word. */
export function parseCommandArgs(args: readonly string[], options: OptionConfig): { values: Record<string, unknown>; positionals: string[] } {
  try {
    const parsed = parseArgs({ args: [...args], options: { help: { type: "boolean" }, ...options }, allowPositionals: true, strict: true });
    return { values: parsed.values as Record<string, unknown>, positionals: parsed.positionals };
  } catch (cause) {
    throw new CliUsageError(cause instanceof Error ? cause.message : String(cause));
  }
}

export function formatCommandHelp(command: CliCommand): string {
  return [`usage: uneffect ${command.name} ${command.arguments}`, "", command.summary, ...command.details.map((line) => (line ? `  ${line}` : line)), ""].join("\n");
}

/** One required file argument, the shape most commands take. */
export function singleFileArgument(positionals: readonly string[], command: string): string {
  if (positionals.length === 0) throw new CliUsageError(`${command} needs one file`);
  if (positionals.length > 1) throw new CliUsageError(`${command} takes one file, received ${positionals.length}`);
  return positionals[0]!;
}
