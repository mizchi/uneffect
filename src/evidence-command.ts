import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";
import { exitCode, formatCommandHelp, parseCommandArgs, singleFileArgument, type CliCommand } from "./cli-support.js";
import { analyzeEffectSummariesInProgram } from "./effects.js";
import { createEvidenceArtifact } from "./evidence.js";

export const evidenceCommand: CliCommand = {
  name: "evidence",
  summary: "Print the machine-readable effect evidence artifact for one file as JSON.",
  arguments: "<file.ts>",
  details: ["The artifact records each function's effects with the evidence state that justifies them."],
  async run(args, io) {
    const { values, positionals } = parseCommandArgs(args, {});
    if (values.help) { io.out(formatCommandHelp(evidenceCommand)); return exitCode.success; }
    const fileName = resolve(singleFileArgument(positionals, "evidence"));
    const text = await readFile(fileName, "utf8");
    const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], types: ["node"], noEmit: true };
    const host = ts.createCompilerHost(options), original = host.getSourceFile.bind(host);
    host.getSourceFile = (name, language, onError, fresh) => name === fileName ? ts.createSourceFile(fileName, text, language, true) : original(name, language, onError, fresh);
    const program = ts.createProgram([fileName], options, host), source = program.getSourceFile(fileName)!;
    const analysis = analyzeEffectSummariesInProgram(program, source);
    io.out(`${JSON.stringify({ artifact: createEvidenceArtifact(program, source, analysis.summaries), diagnostics: analysis.diagnostics }, null, 2)}\n`);
    return exitCode.success;
  },
};
