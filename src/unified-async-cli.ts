#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { analyzeAsyncSafety, generateUnifiedAsyncQuint } from "./async-safety.js";

const fileName = process.argv[2], owner = process.argv[3];
if (!fileName || !owner) {
  console.error("usage: uneffect-unified-async <file.ts> <function>");
  process.exitCode = 2;
} else {
  const source = await readFile(fileName, "utf8");
  process.stdout.write(generateUnifiedAsyncQuint("unified_async", analyzeAsyncSafety(fileName, source), owner));
}
