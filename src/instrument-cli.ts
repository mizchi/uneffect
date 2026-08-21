#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { instrumentRuntimeAssertions } from "./instrument.js";

const input = process.argv[2];
if (!input) {
  console.error("usage: uneffect-instrument <file.ts>");
  process.exitCode = 2;
} else {
  const fileName = resolve(input);
  const result = instrumentRuntimeAssertions(fileName, await readFile(fileName, "utf8"));
  for (const diagnostic of result.diagnostics) {
    console.error(`${diagnostic.fileName}:${diagnostic.line}: error: ${diagnostic.message}`);
  }
  if (result.diagnostics.length > 0) process.exitCode = 1;
  else process.stdout.write(result.code);
}
