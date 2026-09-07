import assert from "node:assert/strict";
import { initializationRule, lintPrerequisites } from "../../src/lint/prerequisites.js";
import { lowerCorsaRuleCfg } from "../../src/lint/corsa.js";
import { generatedRuleCfg, referenceMissingUses } from "./oracle.js";

const fileName = "examples/dogfood/cfg-lint-initialization.ts";
const start = performance.now();
const cases = [
  ["ready", "safe", "clean"], ["branchMissing", "violation", "findings"],
  ["earlyReturn", "safe", "clean"], ["zeroIterations", "violation", "findings"],
  ["atLeastOnce", "safe", "clean"], ["loopReset", "violation", "findings"],
  ["alias", "safe", "clean"], ["shadow", "violation", "findings"],
  ["unsupportedCallback", "unsupported", "unknown"],
  ["correlatedBranches", "safe", "findings"],
] as const;
const sources = [];
for (const [functionName, reference, expected] of cases) {
  const lowered = await lowerCorsaRuleCfg({ fileName, functionName, bindings: [
    { functionName: "initialize", operation: "initialize", argumentIndex: 0 },
    { functionName: "use", operation: "use", argumentIndex: 0 },
    { functionName: "reset", operation: "reset", argumentIndex: 0 },
  ] });
  const result = lowered.status === "lowered" ? lintPrerequisites(lowered.cfg, initializationRule) : lowered;
  assert.equal(result.status, expected, functionName);
  sources.push({ functionName, reference, status: result.status,
    ...(result.status === "unknown" ? { reason: result.reason } : { diagnostics: result.diagnostics.length, iterations: result.iterations }) });
}
let configurations = 0;
for (let seed = 1; seed <= 256; seed++) {
  const cfg = generatedRuleCfg(seed), expected = referenceMissingUses(cfg);
  const actual = lintPrerequisites(cfg, initializationRule);
  assert.notEqual(actual.status, "unknown");
  if (actual.status === "unknown") throw new Error(actual.detail);
  assert.deepEqual(actual.diagnostics.map(diagnostic => diagnostic.location.start).sort((a, b) => a - b), expected.missing, `seed ${seed}`);
  configurations += expected.configurations;
}
console.log(JSON.stringify({
  frontend: "corsa/oxc",
  sources,
  qualification: {
    injectedViolationsDetected: "4/4", safeCasesClean: "4/5", unsupportedCasesUnknown: "1/1",
    knownFalsePositive: "Repeated conditions are independent CFG choices; correlatedBranches loses the relation between its two flag checks.",
    note: "Curated prototype fixtures, not a general precision/recall estimate. Registered operation semantics are assumptions.",
  },
  differential: { graphs: 256, configurations, mismatches: 0 },
  elapsedMs: Math.round(performance.now() - start),
}, null, 2));
