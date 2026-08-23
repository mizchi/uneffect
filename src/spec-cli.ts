#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { generateQuint, generateSmtLib } from "./spec-backends.js";
import { parseSpec } from "./spec-ir.js";
import { generateComposedQuint, parseTemporalComposition } from "./temporal-compose.js";
import { analyzeAsyncPatterns, generateAsyncPatternsQuint, generateNodeEventLoopQuint, generateWebEventLoopQuint } from "./async-patterns.js";
import { analyzePromiseChains, generatePromiseChainsQuint } from "./promise-chains.js";
import { lintSpecWithZ3 } from "./spec-lint.js";

const [command, fileName, ...arguments_] = process.argv.slice(2);
const selectedFunction = arguments_.find((argument) => !argument.startsWith("--"));
const strengtheningProperties = arguments_.flatMap((argument) => argument.startsWith("--strengthening=")
  ? argument.slice("--strengthening=".length).split(",").map((name) => name.trim()).filter(Boolean)
  : []);
const discoverStrengtheningProperties = arguments_.includes("--discover-strengthening");
const synthesizeStrengtheningProperties = arguments_.includes("--synthesize-strengthening");
const synthesizeRelationalStrengtheningProperties = arguments_.includes("--synthesize-relational-strengthening");
const numericOption = (prefix: string): number | undefined => {
  const argument = arguments_.find((candidate) => candidate.startsWith(prefix));
  if (!argument) return undefined;
  const value = Number(argument.slice(prefix.length));
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${prefix.slice(2, -1)} must be a non-negative safe integer`);
  return value;
};
const relationalStrengtheningMaxArity = numericOption("--relational-max-arity=");
const relationalStrengtheningMaxCoefficient = numericOption("--relational-max-coefficient=");
const relationalStrengtheningCandidateLimit = numericOption("--relational-candidate-limit=");
if (relationalStrengtheningMaxArity !== undefined && (relationalStrengtheningMaxArity < 3 || relationalStrengtheningMaxArity > 6)) {
  throw new Error("relational-max-arity must be between 3 and 6");
}
if (relationalStrengtheningMaxCoefficient !== undefined && (relationalStrengtheningMaxCoefficient < 1 || relationalStrengtheningMaxCoefficient > 8)) {
  throw new Error("relational-max-coefficient must be between 1 and 8");
}
const synthesizeCollectionStrengtheningProperties = arguments_.includes("--synthesize-collection-strengthening");
if (!command || !fileName || !["ir", "lint", "z3", "quint", "compose", "async-quint", "web-loop-quint", "node-loop-quint", "promise-quint"].includes(command)) {
  console.error("usage: uneffect-spec <ir|lint|z3|quint|compose|async-quint|web-loop-quint|node-loop-quint|promise-quint> <file.ts> [function] [--strengthening=name,...] [--discover-strengthening] [--synthesize-strengthening] [--synthesize-relational-strengthening] [--relational-max-arity=3..6] [--relational-max-coefficient=1..8] [--relational-candidate-limit=256] [--synthesize-collection-strengthening]");
  process.exit(2);
}

const source = await readFile(fileName, "utf8");
const spec = parseSpec(fileName, source);

if (command === "ir") {
  console.log(JSON.stringify(spec, null, 2));
} else if (command === "lint") {
  const result = await lintSpecWithZ3(fileName, source, { strengtheningProperties, discoverStrengtheningProperties, synthesizeStrengtheningProperties, synthesizeRelationalStrengtheningProperties, relationalStrengtheningMaxArity, relationalStrengtheningMaxCoefficient, relationalStrengtheningCandidateLimit, synthesizeCollectionStrengtheningProperties });
  console.log(JSON.stringify(result.diagnostics, null, 2));
  if (result.diagnostics.length > 0) process.exitCode = 1;
} else if (command === "z3") {
  const invariant = selectedFunction
    ? spec.invariants.find((item) => item.functionName === selectedFunction)
    : spec.invariants[0];
  if (!invariant) throw new Error(selectedFunction ? `unknown invariant function: ${selectedFunction}` : "no invariant specification found");
  process.stdout.write(generateSmtLib(invariant));
} else if (command === "quint") {
  const moduleName = basename(fileName).replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_]/g, "_");
  process.stdout.write(generateQuint(moduleName, spec.temporal));
} else if (command === "compose") {
  if (!selectedFunction) throw new Error("compose requires a root function");
  const moduleName = basename(fileName).replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_]/g, "_");
  process.stdout.write(generateComposedQuint(moduleName, parseTemporalComposition(fileName, source, selectedFunction)));
} else if (command === "async-quint") {
  const moduleName = basename(fileName).replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_]/g, "_");
  process.stdout.write(generateAsyncPatternsQuint(moduleName, analyzeAsyncPatterns(fileName, source)));
} else if (command === "web-loop-quint") {
  const moduleName = basename(fileName).replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_]/g, "_");
  process.stdout.write(generateWebEventLoopQuint(moduleName, analyzeAsyncPatterns(fileName, source), {}, analyzePromiseChains(fileName, source)));
} else if (command === "node-loop-quint") {
  const moduleName = basename(fileName).replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_]/g, "_");
  process.stdout.write(generateNodeEventLoopQuint(moduleName, analyzeAsyncPatterns(fileName, source), {}, analyzePromiseChains(fileName, source)));
} else {
  const moduleName = basename(fileName).replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_]/g, "_");
  process.stdout.write(generatePromiseChainsQuint(moduleName, analyzePromiseChains(fileName, source)));
}
