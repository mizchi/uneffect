import { resolve } from "node:path";
import { checkFiles, createCheckProgram } from "./check.js";
import { exitCode, parseCommandArgs, formatCommandHelp, type CliCommand, type CliStreams } from "./cli-support.js";
import { CliUsageError } from "./cli-support.js";
import { formatCheckEvidence, formatDiagnostics } from "./diagnostics.js";
import { assessCheckAssurance, formatAssuranceAssessment, type AssuranceProfile } from "./assurance.js";
import { loadBuiltinRegistryConfig } from "./registry-config.js";
import { loadTypeScriptProject, loadTypeScriptWorkspace } from "./typescript-project.js";
import { createCheckJsonReport, createCheckWorkspaceJsonReport } from "./check-report.js";
import { composeWorkspaceEffects, inspectDeclarationOutputs, type CompletedEffectProject, type WorkspaceEffectComposition } from "./workspace-effects.js";
import { inspectBuildOutputs, mergeBuildOutputIntegrity, type BuildOutputIntegrity } from "./build-output-integrity.js";

export const checkCommand: CliCommand = {
  name: "check",
  summary: "Report effect, contract, and async-safety diagnostics for the given files.",
  arguments: "[<file.ts> ...] [--project <tsconfig.json>] [--infer] [--strict] [--evidence] [--assurance <profile>] [--config <registry.json>] [--require-build-artifacts] [--require-exact-build-artifacts] [--json]",
  details: [
    "--infer      only check functions that already declare effects",
    "--strict     report an unknown effect name as an error instead of a warning",
    "--evidence   also print the proved obligations and the inferred effect of every function",
    "--assurance  fail on non-proof evidence: no-unknown, or declared",
    "--config     load a versioned caller-owned semantic registry",
    "--project    use compiler options and, without files, inputs from a tsconfig.json",
    "--require-build-artifacts  fail unless SolutionBuilder reports composite outputs as current",
    "--require-exact-build-artifacts  also byte-compare TypeScript-emitted declarations and runtime JavaScript",
    "--json       emit a versioned decision report to stdout, including failures",
    "",
    "This is the default command: `uneffect <file.ts>` runs it.",
    "Exits 1 when any error-severity diagnostic is reported.",
  ],
  async run(args, io: CliStreams) {
    const { values, positionals } = parseCommandArgs(args, {
      infer: { type: "boolean" }, strict: { type: "boolean" }, evidence: { type: "boolean" },
      assurance: { type: "string" },
      config: { type: "string" },
      project: { type: "string" },
      "require-build-artifacts": { type: "boolean" },
      "require-exact-build-artifacts": { type: "boolean" },
      json: { type: "boolean" },
    });
    if (values.help) { io.out(formatCommandHelp(checkCommand)); return exitCode.success; }
    if (positionals.length === 0 && values.project === undefined) throw new CliUsageError("check needs at least one file or --project");
    if ((values["require-build-artifacts"] || values["require-exact-build-artifacts"]) && (values.project === undefined || positionals.length > 0)) {
      throw new CliUsageError("build-artifact assurance requires --project without positional files");
    }
    const assurance = values.assurance;
    if (assurance !== undefined && assurance !== "no-unknown" && assurance !== "declared") {
      throw new CliUsageError(`unknown assurance profile ${String(assurance)}; expected no-unknown or declared`);
    }
    let builtinRegistry;
    try { builtinRegistry = values.config === undefined ? undefined : await loadBuiltinRegistryConfig(String(values.config)); }
    catch (cause) { throw new CliUsageError(cause instanceof Error ? cause.message : String(cause)); }
    let project, workspace;
    try {
      if (values.project !== undefined) {
        if (positionals.length === 0) workspace = loadTypeScriptWorkspace(String(values.project));
        else project = loadTypeScriptProject(String(values.project));
      }
    }
    catch (cause) { throw new CliUsageError(cause instanceof Error ? cause.message : String(cause)); }
    if (workspace && (workspace.references.length > 0 || workspace.blockers.length > 0 || workspace.projects.length > 1 || values["require-build-artifacts"] || values["require-exact-build-artifacts"])) {
      const reports = [];
      const completed: CompletedEffectProject[] = [];
      const composed: WorkspaceEffectComposition = { contracts: new Map(), moduleContracts: new Map(), links: [], blockers: [] };
      const outputIntegrity: BuildOutputIntegrity = { status: values["require-exact-build-artifacts"] ? "verified" : "not-checked", outputs: [] };
      for (const domain of workspace.projects) {
        if (domain.fileNames.length === 0) continue;
        const program = createCheckProgram(domain.fileNames, {
          compilerOptions: domain.compilerOptions, projectReferences: domain.projectReferences,
        });
        if (values["require-exact-build-artifacts"]) mergeBuildOutputIntegrity(outputIntegrity, inspectBuildOutputs(program, domain.projectFile));
        const composition = composeWorkspaceEffects(program, domain, completed);
        composed.links.push(...composition.links);
        composed.blockers.push(...composition.blockers);
        const domainResult = await checkFiles(domain.fileNames, {
          mode: values.strict ? "strict" : "gradual", requireAnnotations: !values.infer, builtinRegistry,
          compilerOptions: domain.compilerOptions, project: domain.provenance,
          projectReferences: domain.projectReferences,
          program, externalFunctionEffects: composition.contracts, externalModuleEffects: composition.moduleContracts,
        });
        const domainAssessment = assurance === undefined ? undefined : assessCheckAssurance(domainResult, assurance as AssuranceProfile);
        reports.push({ result: domainResult, assessment: domainAssessment, report: createCheckJsonReport(domainResult, domainAssessment) });
        completed.push({ project: domain, summaries: domainResult.summaries, declarationOutputs: inspectDeclarationOutputs(program) });
      }
      const report = createCheckWorkspaceJsonReport(workspace, reports.map((item) => item.report), assurance as AssuranceProfile | undefined, {
        requireFreshBuildArtifacts: Boolean(values["require-build-artifacts"] || values["require-exact-build-artifacts"]), outputIntegrity,
      }, composed);
      if (values.json) io.out(`${JSON.stringify(report, null, 2)}\n`);
      else {
        for (const item of reports) {
          io.err(`\nproject ${item.result.project!.projectFile}\n`);
          io.err(formatDiagnostics(item.result.diagnostics, { cwd: process.cwd(), sources: item.result.sources }));
          if (values.evidence) io.err(formatCheckEvidence(item.result));
          if (item.assessment) io.err(formatAssuranceAssessment(item.assessment));
        }
        for (const blocker of report.blockers) io.err(`error workspace/${blocker.kind} ${blocker.projectFile}\n  message: ${blocker.message}\n`);
        io.err(`build artifacts: ${report.buildArtifacts.status} (TypeScript SolutionBuilder dry run)\n`);
        io.err(`output integrity: ${report.outputIntegrity.status} (same-compiler declaration/runtime byte comparison)\n`);
        io.err(`workspace: ${report.outcome}; ${reports.length} checked compiler domain(s), ${report.blockers.length} blocker(s)\n`);
      }
      return report.outcome === "passed" ? exitCode.success : exitCode.failed;
    }
    if (workspace) project = workspace.projects[0];
    const fileNames = positionals.length > 0 ? positionals.map((input) => resolve(input)) : project!.fileNames;
    const result = await checkFiles(fileNames, {
      mode: values.strict ? "strict" : "gradual",
      requireAnnotations: !values.infer,
      builtinRegistry,
      compilerOptions: project?.compilerOptions,
      project: project?.provenance,
      projectReferences: project?.projectReferences,
    });
    const assessment = assurance === undefined ? undefined : assessCheckAssurance(result, assurance as AssuranceProfile);
    if (values.json) io.out(`${JSON.stringify(createCheckJsonReport(result, assessment), null, 2)}\n`);
    else {
      io.err(formatDiagnostics(result.diagnostics, { cwd: process.cwd(), sources: result.sources }));
      if (values.evidence) io.err(formatCheckEvidence(result));
      if (assessment) io.err(formatAssuranceAssessment(assessment));
    }
    return result.errors === 0 && (assessment?.passed ?? true) ? exitCode.success : exitCode.failed;
  },
};
