#!/usr/bin/env node
import { resolve } from "node:path";
import { checkFiles } from "./check.js";
import { formatCheckEvidence, formatDiagnostics } from "./diagnostics.js";

const inferOnly = process.argv.includes("--infer");
const strict = process.argv.includes("--strict");
const withEvidence = process.argv.includes("--evidence");
const files = process.argv.slice(2).filter((argument) => !argument.startsWith("--"));
if (files.length === 0) {
  console.error("usage: uneffect [--infer] [--strict] [--evidence] <file.ts> [...]");
  process.exitCode = 2;
} else {
  const result = await checkFiles(files.map((input) => resolve(input)), { mode: strict ? "strict" : "gradual", requireAnnotations: !inferOnly });
  process.stderr.write(formatDiagnostics(result.diagnostics, { cwd: process.cwd(), sources: result.sources }));
  if (withEvidence) process.stderr.write(formatCheckEvidence(result));
  process.exitCode = result.errors === 0 ? 0 : 1;
}
