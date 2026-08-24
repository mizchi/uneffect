import { resolve } from "node:path";
import { checkFiles } from "./check.js";
import { exitCode, parseCommandArgs, formatCommandHelp, type CliCommand, type CliStreams } from "./cli-support.js";
import { CliUsageError } from "./cli-support.js";
import { formatCheckEvidence, formatDiagnostics } from "./diagnostics.js";

export const checkCommand: CliCommand = {
  name: "check",
  summary: "Report effect, contract, and async-safety diagnostics for the given files.",
  arguments: "<file.ts> [...] [--infer] [--strict] [--evidence]",
  details: [
    "--infer      only check functions that already declare effects",
    "--strict     report an unknown effect name as an error instead of a warning",
    "--evidence   also print the proved obligations and the inferred effect of every function",
    "",
    "This is the default command: `uneffect <file.ts>` runs it.",
    "Exits 1 when any error-severity diagnostic is reported.",
  ],
  async run(args, io: CliStreams) {
    const { values, positionals } = parseCommandArgs(args, {
      infer: { type: "boolean" }, strict: { type: "boolean" }, evidence: { type: "boolean" },
    });
    if (values.help) { io.out(formatCommandHelp(checkCommand)); return exitCode.success; }
    if (positionals.length === 0) throw new CliUsageError("check needs at least one file");
    const result = await checkFiles(positionals.map((input) => resolve(input)), {
      mode: values.strict ? "strict" : "gradual",
      requireAnnotations: !values.infer,
    });
    io.err(formatDiagnostics(result.diagnostics, { cwd: process.cwd(), sources: result.sources }));
    if (values.evidence) io.err(formatCheckEvidence(result));
    return result.errors === 0 ? exitCode.success : exitCode.failed;
  },
};
