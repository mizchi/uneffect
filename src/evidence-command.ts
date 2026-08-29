import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";
import { exitCode, formatCommandHelp, parseCommandArgs, singleFileArgument, type CliCommand } from "./cli-support.js";
import { analyzeEffectSummariesInProgram } from "./effects.js";
import { assessEvidenceArtifactEligibility, createEvidenceArtifact } from "./evidence.js";
import { builtinContractRegistry } from "./builtin-contracts.js";
import { loadBuiltinRegistryConfig } from "./registry-config.js";
import { CliUsageError } from "./cli-support.js";
import { loadUneffectModules } from "./modules.js";

export const evidenceCommand: CliCommand = {
  name: "evidence",
  summary: "Print the machine-readable effect evidence artifact for one file as JSON.",
  arguments: "<file.ts> [--config <registry.json>] [--semantics-module <module.json>]",
  details: ["The artifact records each function's effects with the evidence state that justifies them.", "--config  load a versioned caller-owned semantic registry", "--semantics-module  load a declarative trusted semantics module; repeat to compose modules"],
  async run(args, io) {
    const { values, positionals } = parseCommandArgs(args, { config: { type: "string" }, "semantics-module": { type: "string", multiple: true } });
    if (values.help) { io.out(formatCommandHelp(evidenceCommand)); return exitCode.success; }
    const fileName = resolve(singleFileArgument(positionals, "evidence"));
    const text = await readFile(fileName, "utf8");
    const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], types: ["node"], noEmit: true };
    const host = ts.createCompilerHost(options), original = host.getSourceFile.bind(host);
    host.getSourceFile = (name, language, onError, fresh) => name === fileName ? ts.createSourceFile(fileName, text, language, true) : original(name, language, onError, fresh);
    const program = ts.createProgram([fileName], options, host), source = program.getSourceFile(fileName)!;
    let registry = builtinContractRegistry;
    try { if (values.config !== undefined) registry = await loadBuiltinRegistryConfig(String(values.config)); }
    catch (cause) { throw new CliUsageError(cause instanceof Error ? cause.message : String(cause)); }
    try { if (values["semantics-module"] !== undefined) registry = (await loadUneffectModules(values["semantics-module"] as string[], registry)).registry; }
    catch (cause) { throw new CliUsageError(cause instanceof Error ? cause.message : String(cause)); }
    const analysis = analyzeEffectSummariesInProgram(program, source, { builtinRegistry: registry });
    const artifact = createEvidenceArtifact(program, source, analysis.summaries, registry);
    const eligibility = assessEvidenceArtifactEligibility(artifact);
    io.out(`${JSON.stringify({ artifact, eligibility, diagnostics: analysis.diagnostics }, null, 2)}\n`);
    return exitCode.success;
  },
};
