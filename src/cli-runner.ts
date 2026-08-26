import { relative } from "node:path";
import { checkCommand } from "./check-command.js";
import { CliUsageError, exitCode, formatCommandHelp, processStreams, type CliCommand, type CliStreams } from "./cli-support.js";
import { doctorCommand } from "./doctor-command.js";
import { readPackageManifest } from "./environment.js";
import { evidenceCommand } from "./evidence-command.js";
import { instrumentCommand } from "./instrument-command.js";
import { asyncModelCommand, resourceCommand } from "./resource-command.js";
import { specCommand } from "./spec-command.js";
import { moduleOrderCommand } from "./module-order-command.js";

export const cliCommands: readonly CliCommand[] = [checkCommand, doctorCommand, specCommand, instrumentCommand, evidenceCommand, moduleOrderCommand, resourceCommand, asyncModelCommand];

/** The published version, read from this package's own manifest. */
export async function cliVersion(): Promise<string> {
  return (await readPackageManifest()).version ?? "unknown";
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
    const failure = cause as NodeJS.ErrnoException;
    if (failure?.code === "ENOENT" && failure.path) {
      io.err(`error: cannot read ${relative(process.cwd(), failure.path) || failure.path}\n`);
      return exitCode.usage;
    }
    if (command === doctorCommand) throw cause;
    const message = cause instanceof Error ? cause.message : String(cause);
    io.err(`error: ${command.name} failed: ${message}\n`);
    io.err("run `uneffect doctor` to check the toolchain this command depends on; set UNEFFECT_DEBUG=1 for the stack\n");
    if (process.env.UNEFFECT_DEBUG && cause instanceof Error && cause.stack) io.err(`${cause.stack}\n`);
    return exitCode.failed;
  }
}
