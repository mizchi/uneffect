import { exitCode, formatCommandHelp, parseCommandArgs, CliUsageError, type CliCommand } from "./cli-support.js";
import { environmentSummary, formatEnvironmentReport, runEnvironmentChecks } from "./environment.js";

export const doctorCommand: CliCommand = {
  name: "doctor",
  summary: "Check that everything the toolchain needs is present before you depend on a run.",
  arguments: "[--json] [--skip-solver-probe]",
  details: [
    "--json                 emit the checks as JSON instead of a report",
    "--skip-solver-probe    skip loading the Z3 WASM build, which is the slow check",
    "",
    "An unmet requirement exits 1. A missing optional tool is a warning and exits 0,",
    "with the commands that need it named in the report.",
  ],
  async run(args, io) {
    const { values, positionals } = parseCommandArgs(args, { json: { type: "boolean" }, "skip-solver-probe": { type: "boolean" } });
    if (values.help) { io.out(formatCommandHelp(doctorCommand)); return exitCode.success; }
    if (positionals.length > 0) throw new CliUsageError(`doctor takes no file arguments, received ${positionals[0]}`);
    const checks = await runEnvironmentChecks({ skipSolverProbe: Boolean(values["skip-solver-probe"]) });
    const summary = environmentSummary(checks);
    io.out(values.json ? `${JSON.stringify({ checks, ...summary }, null, 2)}\n` : formatEnvironmentReport(checks));
    return summary.errors === 0 ? exitCode.success : exitCode.failed;
  },
};
