#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildVerifiedOwnership, buildVerifiedOwnershipCached, instrumentOwnershipAssertions, instrumentRuntimeAssertions } from "./instrument.js";

const args = process.argv.slice(2), verifiedOwnership = args.includes("--verify-ownership"), ownership = verifiedOwnership || args.includes("--ownership");
const evidenceIndex = args.indexOf("--ownership-evidence");
const evidenceArgument = evidenceIndex >= 0 ? args[evidenceIndex + 1] : undefined;
const positional = args.filter((argument, index) => !argument.startsWith("--") && index !== evidenceIndex + 1);
const input = positional[0];
if (!input) {
  console.error("usage: uneffect-instrument [--ownership|--verify-ownership] [--ownership-evidence <cache.json>] <file.ts>");
  process.exitCode = 2;
} else {
  const fileName = resolve(input);
  const text = await readFile(fileName, "utf8");
  const cachedResult = verifiedOwnership && evidenceArgument ? buildVerifiedOwnershipCached(fileName, text, resolve(evidenceArgument)) : undefined;
  const verifiedResult = cachedResult ?? (verifiedOwnership ? buildVerifiedOwnership(fileName, text) : undefined);
  const result = verifiedResult ?? (ownership ? instrumentOwnershipAssertions(fileName, text) : instrumentRuntimeAssertions(fileName, text));
  const unresolvedCount = verifiedResult?.unresolved.length ?? 0;
  for (const diagnostic of result.diagnostics) {
    console.error(`${diagnostic.fileName}:${diagnostic.line}: error: ${diagnostic.message}`);
  }
  if (result.diagnostics.length > 0) process.exitCode = 1;
  else {
    if (cachedResult) {
      console.error(`ownership evidence: ${cachedResult.cache.reused} reused, ${cachedResult.cache.verified} verified, ${cachedResult.cache.stale.length} stale`);
    }
    if (unresolvedCount > 0) console.error(`${unresolvedCount} ownership obligation(s) remain runtime-checked`);
    process.stdout.write(result.code);
  }
}
