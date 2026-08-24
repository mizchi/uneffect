import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { checkCommand } from "./check-command.js";
import { CliUsageError, exitCode, formatCommandHelp, processStreams, type CliCommand, type CliStreams } from "./cli-support.js";
import { evidenceCommand } from "./evidence-command.js";
import { instrumentCommand } from "./instrument-command.js";
import { asyncModelCommand, resourceCommand } from "./resource-command.js";
import { specCommand } from "./spec-command.js";

export const cliCommands: readonly CliCommand[] = [checkCommand, specCommand, instrumentCommand, evidenceCommand, resourceCommand, asyncModelCommand];

/** Read the published version without bundling it, from either the source tree or `dist/src`. */
export async function cliVersion(): Promise<string> {
  for (const candidate of ["../package.json", "../../package.json"]) {
    try {
      const manifest = JSON.parse(await readFile(join(import.meta.dirname, candidate), "utf8")) as { name?: string; version?: string };
      if (manifest.name === "@mizchi/uneffect" && manifest.version) return manifest.version;
    } catch {
      continue;
    }
  }
  return "unknown";
}

export function formatCliHelp(): string {
  const width = Math.max(...cliCommands.map((command) => command.name.length));
  return [
    "usage: uneffect <command> [options] <file.ts> [...]",
    "",
    "Static effect, contract, and async-safety checking for annotated TypeScript.",
    "",
    "Commands:",
    ...cliCommands.map((command) => `  ${command.name.padEnd(width)}  ${command.summary}`),
    "",
    "Run `uneffect <command> --help` for a command's options.",
    "A bare `uneffect <file.ts>` runs `check`.",
    "",
    "  --help       show this message",
    "  --version    show the installed version",
    "",
  ].join("\n");
}

const sourceFile = /\.[cm]?tsx?$/u;

/** Dispatch one command line. Returns the process exit code instead of exiting, so tests can drive it. */
export async function runCli(args: readonly string[], io: CliStreams = processStreams): Promise<number> {
  const [first, ...rest] = args;
  if (first === undefined) {
    io.err(formatCliHelp());
    return exitCode.usage;
  }
  if (first === "--help" || first === "-h" || first === "help") {
    io.out(formatCliHelp());
    return exitCode.success;
  }
  if (first === "--version" || first === "-v") {
    io.out(`${await cliVersion()}\n`);
    return exitCode.success;
  }
  const named = cliCommands.find((command) => command.name === first);
  const command = named ?? checkCommand;
  if (!named && !first.startsWith("-") && !sourceFile.test(first)) {
    io.err(`error: unknown command ${first}\n\n${formatCliHelp()}`);
    return exitCode.usage;
  }
  try {
    return await command.run(named ? rest : args, io);
  } catch (cause) {
    if (cause instanceof CliUsageError) {
      io.err(`error: ${cause.message}\n\n${formatCommandHelp(command)}`);
      return exitCode.usage;
    }
    throw cause;
  }
}
