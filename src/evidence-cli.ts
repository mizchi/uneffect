#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";
import { createEvidenceArtifact } from "./evidence.js";
import { analyzeEffectSummariesInProgram } from "./effects.js";

const input = process.argv[2];
if (!input) {
  console.error("usage: uneffect-evidence <file.ts>");
  process.exitCode = 2;
} else {
  const fileName = resolve(input), text = await readFile(fileName, "utf8");
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], types: ["node"], noEmit: true };
  const host = ts.createCompilerHost(options), original = host.getSourceFile.bind(host);
  host.getSourceFile = (name, language, onError, fresh) => name === fileName ? ts.createSourceFile(fileName, text, language, true) : original(name, language, onError, fresh);
  const program = ts.createProgram([fileName], options, host), source = program.getSourceFile(fileName)!;
  const analysis = analyzeEffectSummariesInProgram(program, source);
  process.stdout.write(`${JSON.stringify({ artifact: createEvidenceArtifact(program, source, analysis.summaries), diagnostics: analysis.diagnostics }, null, 2)}\n`);
}
