/* uneffect:module_effect Throw<Error> | InvokeUserCode */
import { relative } from "node:path";
import { checkCommand } from "./check-command.js";
import { CliUsageError, exitCode, formatCommandHelp, processStreams, type CliCommand, type CliStreams } from "./cli-support.js";
import { readPackageManifest } from "./package-manifest.js";

const commandLoaders: ReadonlyArray<{ name: string; summary: string; load: () => Promise<CliCommand> }> = [
  { name: "check", summary: checkCommand.summary, load: async () => checkCommand },
  {
    name: "doctor",
    summary: "Check that everything the toolchain needs is present before you depend on a run.",
    load: async () => (await import("./doctor-command.js")).doctorCommand,
  },
  {
    name: "spec",
    summary: "Emit the specification IR, or the verifier program a backend consumes, for one file.",
    load: async () => (await import("./spec-command.js")).specCommand,
  },
  {
    name: "instrument",
    summary: "Emit the source with runtime assertions inserted for contracts or ownership.",
    load: async () => (await import("./instrument-command.js")).instrumentCommand,
  },
  {
    name: "evidence",
    summary: "Print the machine-readable effect evidence artifact for one file as JSON.",
    load: async () => (await import("./evidence-command.js")).evidenceCommand,
  },
  {
    name: "contract-summary",
    summary: "Publish a package contract summary from one TypeScript project entry.",
    load: async () => (await import("./contract-summary-command.js")).contractSummaryCommand,
  },
  {
    name: "module-order",
    summary: "Print the source-mapped ESM module-initialization partial-order IR.",
    load: async () => (await import("./module-order-command.js")).moduleOrderCommand,
  },
  {
    name: "resource-model",
    summary: "Generate the Quint resource-safety model for one file.",
    load: async () => (await import("./resource-command.js")).resourceCommand,
  },
  {
    name: "async-model",
    summary: "Generate the unified Quint model of Promise, exception, and resource flow for one function.",
    load: async () => (await import("./resource-command.js")).asyncModelCommand,
  },
];

export async function loadCliCommands(): Promise<readonly CliCommand[]> {
  return Promise.all(commandLoaders.map((item) => item.load()));
}

/** Command objects. Prefer `loadCliCommands` when the TypeScript 6 path must stay unloaded. */
export const cliCommands: readonly CliCommand[] = [checkCommand];

/** The published version, read from this package's own manifest. */
/* uneffect:effect FsRead */
export async function cliVersion(): Promise<string> {
  return (await readPackageManifest()).version ?? "unknown";
}

/* uneffect:effect none */
export function formatCliHelp(): string {
  const width = Math.max(...commandLoaders.map((command) => command.name.length));
  return [
    "usage: uneffect <command> [options] <file.ts> [...]",
    "",
    "Static effect, contract, and async-safety checking for annotated TypeScript.",
    "",
    "Commands:",
    ...commandLoaders.map((command) => `  ${command.name.padEnd(width)}  ${command.summary}`),
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

async function resolveCommand(name: string | undefined): Promise<CliCommand | undefined> {
  if (name === undefined) return undefined;
  const loader = commandLoaders.find((item) => item.name === name);
  return loader?.load();
}

/** Dispatch one command line. Returns the process exit code instead of exiting, so tests can drive it. */
/* uneffect:effect FsRead | Env<"UNEFFECT_DEBUG"> */
/* uneffect:effect_parameter io extends Console */
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
  const named = await resolveCommand(first);
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
    if (command.name === "doctor") throw cause;
    const message = cause instanceof Error ? cause.message : String(cause);
    io.err(`error: ${command.name} failed: ${message}\n`);
    io.err("run `uneffect doctor` to check the toolchain this command depends on; set UNEFFECT_DEBUG=1 for the stack\n");
    if (process.env.UNEFFECT_DEBUG && cause instanceof Error && cause.stack) io.err(`${cause.stack}\n`);
    return exitCode.failed;
  }
}
