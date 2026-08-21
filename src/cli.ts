#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";
import { analyzeProgramEffects, type EffectDiagnostic } from "./effects.js";
import { verifyContracts, type ContractDiagnostic } from "./contracts.js";
import { analyzeAsyncSafetyInProgram, type AsyncSafetyDiagnostic } from "./async-safety.js";

const inferOnly = process.argv.includes("--infer");
const strict = process.argv.includes("--strict");
const files = process.argv.slice(2).filter((argument) => !argument.startsWith("--"));
if (files.length === 0) {
  console.error("usage: uneffect [--infer] [--strict] <file.ts> [...]");
  process.exitCode = 2;
} else {
  const fileNames = files.map((input) => resolve(input));
  const program = ts.createProgram(fileNames, { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], types: ["node"], noEmit: true });
  const effectDiagnostics = analyzeProgramEffects(program, { mode: strict ? "strict" : "gradual", requireAnnotations: !inferOnly }).diagnostics;
  let failures = 0;
  const diagnostics: Array<EffectDiagnostic | ContractDiagnostic | AsyncSafetyDiagnostic> = [...effectDiagnostics];
  for (const fileName of fileNames) {
    const source = await readFile(fileName, "utf8");
    diagnostics.push(...await verifyContracts(fileName, source));
    const sourceFile = program.getSourceFile(fileName);
    if (sourceFile) diagnostics.push(...analyzeAsyncSafetyInProgram(program, sourceFile).diagnostics);
  }
  for (const diagnostic of diagnostics) {
    const severity = "severity" in diagnostic ? diagnostic.severity : "error";
    if (severity === "error") failures++;
    console.error(`${diagnostic.fileName}:${diagnostic.line}: ${severity}: ${diagnostic.message}`);
    if ("model" in diagnostic && diagnostic.model) console.error(`  counterexample: ${diagnostic.model}`);
  }
  process.exitCode = failures === 0 ? 0 : 1;
}
