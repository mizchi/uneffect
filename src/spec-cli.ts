#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { generateQuint, generateSmtLib } from "./spec-backends.js";
import { parseSpec } from "./spec-ir.js";
import { generateComposedQuint, parseTemporalComposition } from "./temporal-compose.js";
import { analyzeAsyncPatterns, generateAsyncPatternsQuint } from "./async-patterns.js";
import { analyzePromiseChains, generatePromiseChainsQuint } from "./promise-chains.js";

const [command, fileName, selectedFunction] = process.argv.slice(2);
if (!command || !fileName || !["ir", "z3", "quint", "compose", "async-quint", "promise-quint"].includes(command)) {
  console.error("usage: uneffect-spec <ir|z3|quint|compose|async-quint|promise-quint> <file.ts> [function]");
  process.exit(2);
}

const source = await readFile(fileName, "utf8");
const spec = parseSpec(fileName, source);

if (command === "ir") {
  console.log(JSON.stringify(spec, null, 2));
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
} else {
  const moduleName = basename(fileName).replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_]/g, "_");
  process.stdout.write(generatePromiseChainsQuint(moduleName, analyzePromiseChains(fileName, source)));
}
