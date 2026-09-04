import { resolve } from "node:path";
import { checkFiles, createCheckProgram } from "./check.js";
import { checkCommand } from "./check-command.js";
import { exitCode, parseCommandArgs, formatCommandHelp, type CliStreams } from "./cli-support.js";
import { CliUsageError } from "./cli-support.js";
import { formatCheckEvidence, formatDiagnostics } from "./diagnostics.js";
import { assessCheckAssurance, formatAssuranceAssessment, type AssuranceProfile } from "./assurance.js";
import { loadBuiltinRegistryConfig } from "./registry-config.js";
import { loadUneffectModules } from "./modules.js";
import { loadTypeScriptProject, loadTypeScriptWorkspace } from "./typescript-project.js";
import { createCheckJsonReport, createCheckWorkspaceJsonReport } from "./check-report.js";
import { composeWorkspaceEffects, inspectDeclarationOutputs, type CompletedEffectProject, type WorkspaceEffectComposition } from "./workspace-effects.js";
import { analyzeProjectRefinements, composeWorkspaceRefinements, type CompletedRefinementProject, type WorkspaceRefinementComposition } from "./workspace-refinements.js";
import { inspectBuildOutputs, mergeBuildOutputIntegrity, type BuildOutputIntegrity } from "./build-output-integrity.js";
import { loadDeclarationTransformManifest, validateDeclarationTransformManifest } from "./declaration-transforms.js";
import { loadAssumptionRegistry } from "./assumption-registry.js";
import { loadContractSummaryBundle } from "./contract-summary.js";
import { loadResourceCallableContractArtifact } from "./resource-callable-artifact.js";
import { openCorsaApiFrontend } from "./corsa-api-frontend.js";
import {
  composeWorkspaceModuleInitialization,
  type CompletedModuleInitializationProject,
  type WorkspaceModuleInitializationComposition,
} from "./workspace-module-initialization.js";

/** TypeScript 6 Program path: workspace composition, contracts, and `--corsa-parity`. */
export async function runTypeScriptCheckCommand(args: readonly string[], io: CliStreams): Promise<number> {
    const { values, positionals } = parseCommandArgs(args, {
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
    });
    if (values.help) { io.out(formatCommandHelp(checkCommand)); return exitCode.success; }
    if (positionals.length === 0 && values.project === undefined) throw new CliUsageError("check needs at least one file or --project");
    if ((values["corsa-parity"] || values["corsa-executable"] !== undefined) && values.project === undefined) {
      throw new CliUsageError("Corsa parity requires --project so compiler and source membership are explicit");
    }
    if (values["corsa-executable"] !== undefined && !values["corsa-parity"]) {
      throw new CliUsageError("--corsa-executable requires --corsa-parity");
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
    let builtinRegistry;
    try {
      builtinRegistry = values.config === undefined ? undefined : await loadBuiltinRegistryConfig(String(values.config));
      if (values["semantics-module"] !== undefined) {
        builtinRegistry = (await loadUneffectModules(values["semantics-module"] as string[], builtinRegistry)).registry;
      }
    }
    catch (cause) { throw new CliUsageError(cause instanceof Error ? cause.message : String(cause)); }
    let resourceCallableArtifacts;
    try {
      resourceCallableArtifacts = values["resource-contract"] === undefined ? undefined
        : await Promise.all((values["resource-contract"] as string[]).map((fileName) => loadResourceCallableContractArtifact(String(fileName))));
    }
    catch (cause) { throw new CliUsageError(cause instanceof Error ? cause.message : String(cause)); }
    let assumptionRegistry;
    try { assumptionRegistry = values.assumptions === undefined ? undefined : await loadAssumptionRegistry(String(values.assumptions)); }
    catch (cause) { throw new CliUsageError(cause instanceof Error ? cause.message : String(cause)); }
    let contractSummaryBundles;
    try {
      contractSummaryBundles = values["contract-summary"] === undefined ? undefined
        : await Promise.all((values["contract-summary"] as string[]).map((fileName) => loadContractSummaryBundle(String(fileName))));
    }
    catch (cause) { throw new CliUsageError(cause instanceof Error ? cause.message : String(cause)); }
    let declarationTransforms;
    try { declarationTransforms = values["declaration-transforms"] === undefined
      ? undefined : await loadDeclarationTransformManifest(String(values["declaration-transforms"])); }
    catch (cause) { throw new CliUsageError(cause instanceof Error ? cause.message : String(cause)); }
    const transformValidation = declarationTransforms === undefined
      ? undefined : validateDeclarationTransformManifest(declarationTransforms);
    let project, workspace;
    try {
      if (values.project !== undefined) {
        if (positionals.length === 0) workspace = loadTypeScriptWorkspace(String(values.project));
        else project = loadTypeScriptProject(String(values.project));
      }
    }
    catch (cause) { throw new CliUsageError(cause instanceof Error ? cause.message : String(cause)); }
    if (workspace && (workspace.references.length > 0 || workspace.blockers.length > 0 || workspace.projects.length > 1 || values["require-build-artifacts"] || values["require-exact-build-artifacts"] || declarationTransforms || values["module-entry"] !== undefined)) {
      const reports = [];
      const completed: CompletedEffectProject[] = [];
      const completedRefinements: CompletedRefinementProject[] = [];
      const completedModuleInitialization: CompletedModuleInitializationProject[] = [];
      let moduleInitializationComposition: WorkspaceModuleInitializationComposition | undefined;
      const moduleEntry = values["module-entry"] === undefined ? undefined : resolve(String(values["module-entry"]));
      const composed: WorkspaceEffectComposition = { contracts: new Map(), moduleContracts: new Map(), links: [], blockers: [] };
      const composedRefinements: WorkspaceRefinementComposition = { contracts: new Map(), links: [], blockers: [] };
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
        const refinementComposition = composeWorkspaceRefinements(program, domain, completedRefinements);
        composedRefinements.links.push(...refinementComposition.links);
        composedRefinements.blockers.push(...refinementComposition.blockers);
        const corsaFrontend = values["corsa-parity"] ? await openCorsaApiFrontend({
          configFile: domain.projectFile,
          ...(values["corsa-executable"] === undefined ? {} : { corsaExecutable: String(values["corsa-executable"]) }),
        }) : undefined;
        const domainResult = await (async () => {
          try {
            return await checkFiles(domain.fileNames, {
              mode: values.strict ? "strict" : "gradual", requireAnnotations: !values.infer, builtinRegistry, assumptionRegistry,
              compilerOptions: domain.compilerOptions, project: domain.provenance,
              projectReferences: domain.projectReferences,
              program, externalFunctionEffects: composition.contracts, externalModuleEffects: composition.moduleContracts,
              contractSummaryBundles,
              resourceCallableArtifacts,
              corsaFrontend,
            });
          } finally { corsaFrontend?.close(); }
        })();
        const domainAssessment = assurance === undefined ? undefined : assessCheckAssurance(domainResult, assurance as AssuranceProfile);
        reports.push({ result: domainResult, assessment: domainAssessment, report: createCheckJsonReport(domainResult, domainAssessment) });
        const declarationOutputs = inspectDeclarationOutputs(program, declarationTransforms && transformValidation
          ? { manifest: declarationTransforms, validation: transformValidation } : undefined);
        if (moduleEntry !== undefined && domain.fileNames.includes(moduleEntry)) {
          moduleInitializationComposition = composeWorkspaceModuleInitialization(
            program, domain, completedModuleInitialization, moduleEntry,
          );
        }
        completed.push({ project: domain, summaries: domainResult.summaries, declarationOutputs });
        const refinementAnalysis = analyzeProjectRefinements(program, domain, refinementComposition.contracts);
        composedRefinements.blockers.push(...refinementAnalysis.blockers);
        completedRefinements.push({ project: domain, summaries: refinementAnalysis.summaries, declarationOutputs });
        completedModuleInitialization.push({ project: domain, program, declarationOutputs });
      }
      const report = createCheckWorkspaceJsonReport(workspace, reports.map((item) => item.report), assurance as AssuranceProfile | undefined, {
        requireFreshBuildArtifacts: Boolean(values["require-build-artifacts"] || values["require-exact-build-artifacts"]), outputIntegrity,
        additionalBlockers: [
          ...(transformValidation?.diagnostics.map((diagnostic) => ({
          kind: "declaration-transform", classification: "violation" as const,
          projectFile: workspace.rootProjectFile, subject: diagnostic.generatedFile, message: diagnostic.message,
          })) ?? []),
          ...(moduleEntry !== undefined && moduleInitializationComposition === undefined ? [{
            kind: "module-initialization", classification: "unknown" as const,
            projectFile: workspace.rootProjectFile, subject: moduleEntry,
            message: "module entry is not selected by any loaded TypeScript project",
          }] : []),
        ],
        moduleInitializationComposition,
      }, composed, composedRefinements);
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
    const program = createCheckProgram(fileNames, {
      compilerOptions: project?.compilerOptions, projectReferences: project?.projectReferences,
    });
    const corsaFrontend = values["corsa-parity"] ? await openCorsaApiFrontend({
      configFile: project!.projectFile,
      ...(values["corsa-executable"] === undefined ? {} : { corsaExecutable: String(values["corsa-executable"]) }),
    }) : undefined;
    const result = await (async () => {
      try {
        return await checkFiles(fileNames, {
          mode: values.strict ? "strict" : "gradual",
          requireAnnotations: !values.infer,
          builtinRegistry,
          assumptionRegistry,
          contractSummaryBundles,
          resourceCallableArtifacts,
          compilerOptions: project?.compilerOptions,
          project: project?.provenance,
          projectReferences: project?.projectReferences,
          program,
          corsaFrontend,
        });
      } finally { corsaFrontend?.close(); }
    })();
    const assessment = assurance === undefined ? undefined : assessCheckAssurance(result, assurance as AssuranceProfile);
    if (values.json) io.out(`${JSON.stringify(createCheckJsonReport(result, assessment), null, 2)}\n`);
    else {
      io.err(formatDiagnostics(result.diagnostics, { cwd: process.cwd(), sources: result.sources }));
      if (values.evidence) io.err(formatCheckEvidence(result));
      if (assessment) io.err(formatAssuranceAssessment(assessment));
    }
    return result.errors === 0 && (assessment?.passed ?? true) ? exitCode.success : exitCode.failed;
}
