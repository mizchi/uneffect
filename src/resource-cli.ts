#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { analyzeAsyncSafety, generateResourceSafetyQuint } from "./async-safety.js";

const fileName = process.argv[2];
if (!fileName) {
  console.error("usage: uneffect-resource <file.ts>");
  process.exitCode = 2;
} else {
  const source = await readFile(fileName, "utf8");
  const result = analyzeAsyncSafety(fileName, source);
  process.stdout.write(generateResourceSafetyQuint("resource_safety", result));
}
