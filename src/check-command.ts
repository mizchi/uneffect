import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { exitCode, parseCommandArgs, formatCommandHelp, type CliCommand, type CliStreams } from "./cli-support.js";
import { CliUsageError } from "./cli-support.js";
import { assessCheckAssurance, formatAssuranceAssessment, type AssuranceProfile } from "./assurance.js";
import { loadBuiltinRegistryConfig } from "./registry-config.js";
import { loadUneffectModules } from "./modules.js";
import { checkCorsaProject } from "./corsa-check.js";
import { createCorsaCheckJsonReport, formatCorsaCheckEvidence } from "./corsa-check-report.js";
import { inspectProjectConfig, writeEphemeralCorsaProject } from "./corsa-project.js";
import {
  formatEffectBaselineAssessment, processEffectBaseline,
} from "./effect-baseline.js";

const checkArgOptions = {
  infer: { type: "boolean" }, strict: { type: "boolean" }, evidence: { type: "boolean" },
  assurance: { type: "string" },
  config: { type: "string" },
  assumptions: { type: "string" },
  "semantics-module": { type: "string", multiple: true },
  "contract-summary": { type: "string", multiple: true },
  "resource-contract": { type: "string", multiple: true },
  "declaration-transforms": { type: "string" },
  project: { type: "string" },
  "corsa-parity": { type: "boolean" },
  "corsa-executable": { type: "string" },
  "module-entry": { type: "string" },
  "require-build-artifacts": { type: "boolean" },
  "require-exact-build-artifacts": { type: "boolean" },
  "typescript-program": { type: "boolean" },
  json: { type: "boolean" },
  "effect-baseline": { type: "string" },
  "write-effect-baseline": { type: "string" },
} as const;

function usesTypeScriptProgramPath(values: Record<string, unknown>): boolean {
  if (values["typescript-program"] || values["corsa-parity"]) return true;
  if (values["contract-summary"] !== undefined || values["resource-contract"] !== undefined) return true;
  if (values["declaration-transforms"] !== undefined || values["module-entry"] !== undefined) return true;
  if (values["require-build-artifacts"] || values["require-exact-build-artifacts"]) return true;
  if (values.project === undefined) return false;
  return inspectProjectConfig(String(values.project)).hasReferences;
}

function missingFileError(file: string): NodeJS.ErrnoException {
  const error = new Error(`ENOENT: no such file or directory, open '${file}'`) as NodeJS.ErrnoException;
  error.code = "ENOENT";
  error.path = file;
  return error;
}

export const checkCommand: CliCommand = {
  name: "check",
  summary: "Report effect, contract, and async-safety diagnostics for the given files.",
  arguments: "[<file.ts> ...] [--project <tsconfig.json>] [--infer] [--effect-baseline <file>] [--write-effect-baseline <file>] [--assurance <profile>] [--json]",
  details: [
    "--infer      infer every selected function, including unannotated functions",
    "--effect-baseline  fail when inference adds effects or unknown reasons beyond a reviewed baseline",
    "--write-effect-baseline  write the current inferred effects as a reviewable baseline",
    "--strict     report an unknown effect name as an error instead of a warning",
    "--evidence   also print the proved obligations and the inferred effect of every function",
    "--assurance  fail on non-proof evidence: no-unknown, declared, or verified",
    "--config     load a versioned caller-owned semantic registry",
    "--assumptions  load a versioned caller-owned assumption registry",
    "--semantics-module  load a declarative trusted semantics module; repeat to compose modules",
    "--contract-summary  bind a verified package contract summary; repeat to compose packages",
    "--resource-contract  bind a reviewed package resource lifecycle artifact; repeat to compose exports",
    "--declaration-transforms  bind generated TypeScript to exact spans in non-TypeScript sources",
    "--project    use compiler options and, without files, inputs from a tsconfig.json",
    "--corsa-parity  compare the admitted Corsa Effect slice with TypeScript; mismatches block assurance",
    "--corsa-executable  use this pinned Corsa-compatible compiler instead of Uneffect's prebuilt tsgo",
    "--typescript-program  use a JavaScript TypeScript 6 Program instead of the default Corsa check",
    "--module-entry  compose the supported module-initialization order from this workspace entry",
    "--require-build-artifacts  fail unless SolutionBuilder reports composite outputs as current",
    "--require-exact-build-artifacts  also byte-compare TypeScript-emitted declarations and runtime JavaScript",
    "--json       emit a versioned decision report to stdout, including failures",
    "",
    "Default check uses Corsa plus Oxc and does not construct a JS TypeScript 6 Program.",
    "Workspace references, contracts, and `--corsa-parity` still load the TypeScript 6 path.",
    "This is the default command: `uneffect <file.ts>` runs it.",
    "Exits 1 when any error-severity diagnostic is reported.",
  ],
  async run(args, io: CliStreams) {
    const { values, positionals } = parseCommandArgs(args, checkArgOptions);
    if (values.help) { io.out(formatCommandHelp(checkCommand)); return exitCode.success; }
    if (positionals.length === 0 && values.project === undefined) throw new CliUsageError("check needs at least one file or --project");
    if (values["effect-baseline"] !== undefined && values["write-effect-baseline"] !== undefined) {
      throw new CliUsageError("--effect-baseline and --write-effect-baseline are mutually exclusive");
    }
    if (values["corsa-parity"] && values.project === undefined) {
      throw new CliUsageError("Corsa parity requires --project so compiler and source membership are explicit");
    }
    if (values["corsa-executable"] !== undefined && values.project === undefined && positionals.length === 0) {
      throw new CliUsageError("--corsa-executable requires --project or input files");
    }
    if ((values["require-build-artifacts"] || values["require-exact-build-artifacts"]) && (values.project === undefined || positionals.length > 0)) {
      throw new CliUsageError("build-artifact assurance requires --project without positional files");
    }
    if (values["declaration-transforms"] !== undefined && (values.project === undefined || positionals.length > 0)) {
      throw new CliUsageError("declaration transform evidence requires --project without positional files");
    }
    if (values["module-entry"] !== undefined && (values.project === undefined || positionals.length > 0)) {
      throw new CliUsageError("workspace module-order evidence requires --project without positional files");
    }
    const assurance = values.assurance;
    if (assurance !== undefined && assurance !== "no-unknown" && assurance !== "declared" && assurance !== "verified") {
      throw new CliUsageError(`unknown assurance profile ${String(assurance)}; expected no-unknown, declared, or verified`);
    }
    if (usesTypeScriptProgramPath(values)) {
      const { runTypeScriptCheckCommand } = await import("./check-command-typescript.js");
      return runTypeScriptCheckCommand(args, io);
    }
    let builtinRegistry;
    try {
      builtinRegistry = values.config === undefined ? undefined : await loadBuiltinRegistryConfig(String(values.config));
      if (values["semantics-module"] !== undefined) {
        builtinRegistry = (await loadUneffectModules(values["semantics-module"] as string[], builtinRegistry)).registry;
      }
    }
    catch (cause) { throw new CliUsageError(cause instanceof Error ? cause.message : String(cause)); }
    const files = positionals.map((input) => resolve(input));
    for (const file of files) {
      if (!existsSync(file)) throw missingFileError(file);
    }
    let configFile: string;
    let ephemeralDirectory: string | undefined;
    if (values.project !== undefined) {
      const inspected = inspectProjectConfig(String(values.project));
      if (inspected.parseError) {
        throw new CliUsageError(`cannot read TypeScript project ${inspected.absolute}: ${inspected.parseError}`);
      }
      configFile = inspected.absolute;
    } else {
      const ephemeral = writeEphemeralCorsaProject(files);
      configFile = ephemeral.configFile;
      ephemeralDirectory = ephemeral.directory;
    }
    let result;
    try {
      result = await checkCorsaProject({
        configFile,
        requireAnnotations: !values.infer && values["effect-baseline"] === undefined && values["write-effect-baseline"] === undefined,
        ...(files.length === 0 ? {} : { fileNames: files }),
        ...(values["corsa-executable"] === undefined ? {} : { corsaExecutable: String(values["corsa-executable"]) }),
        ...(builtinRegistry === undefined ? {} : { builtinRegistry }),
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (message.includes("does not select any source files") || message.includes("Corsa did not open a project")) {
        throw new CliUsageError(`TypeScript project ${configFile} does not select any source files`);
      }
      if (message.includes("cannot read TypeScript project")) throw new CliUsageError(message);
      throw new CliUsageError(values.project === undefined ? message : `cannot read TypeScript project ${configFile}: ${message}`);
    } finally {
      if (ephemeralDirectory !== undefined) rmSync(ephemeralDirectory, { recursive: true, force: true });
    }
    const assessment = assurance === undefined ? undefined : assessCheckAssurance({
      artifacts: result.artifacts,
      summaries: result.summaries,
      sources: result.sources,
      assumptions: result.assumptions,
      typedArrays: result.typedArrays,
      ownership: result.ownership,
      asyncIterators: result.asyncIterators,
      resourceProtocols: result.resourceProtocols,
      project: result.project,
    }, assurance as AssuranceProfile);
    const baselineFile = values["effect-baseline"] === undefined ? undefined : resolve(String(values["effect-baseline"]));
    const writeBaselineFile = values["write-effect-baseline"] === undefined ? undefined : resolve(String(values["write-effect-baseline"]));
    const baseReport = createCorsaCheckJsonReport(result, assessment);
    let baselineRun;
    try {
      baselineRun = await processEffectBaseline({
        baselineFile, writeBaselineFile, summaries: baseReport.effects, cwd: process.cwd(),
        checkPassed: result.errors === 0 && (assessment?.passed ?? true),
      });
    } catch (cause) { throw new CliUsageError(cause instanceof Error ? cause.message : String(cause)); }
    const baselineAssessment = baselineRun.assessment;
    if (baselineRun.written) io.err(`effect baseline: wrote ${baselineRun.written.entries} function(s) to ${baselineRun.written.fileName}\n`);
    if (baselineRun.writeSkipped) io.err("effect baseline: not written because check failed\n");
    const report = baselineAssessment === undefined ? baseReport : {
      ...baseReport,
      outcome: baselineAssessment.status === "failed" ? "failed" as const : baseReport.outcome,
      effectBaseline: baselineAssessment,
    };
    if (values.json) io.out(`${JSON.stringify(report, null, 2)}\n`);
    else {
      if (result.diagnostics.length === 0 && !values.evidence && !baselineAssessment) io.err("no diagnostics\n");
      else {
        for (const diagnostic of result.diagnostics) {
          io.err(`error syntax ${diagnostic.fileName}\n  message: ${diagnostic.message}\n`);
        }
      }
      if (values.evidence) io.err(formatCorsaCheckEvidence(result));
      if (assessment) io.err(formatAssuranceAssessment(assessment));
      if (baselineAssessment) io.err(formatEffectBaselineAssessment(baselineAssessment));
    }
    return result.errors === 0 && (assessment?.passed ?? true) && (baselineAssessment?.status !== "failed")
      ? exitCode.success : exitCode.failed;
  },
};
