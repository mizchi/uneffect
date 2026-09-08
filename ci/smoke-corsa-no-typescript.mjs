import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const directory = mkdtempSync(join(tmpdir(), "uneffect-corsa-no-typescript-"));
try {
  const output = execFileSync("npm", ["pack", "--json", "--silent", "--pack-destination", directory], { encoding: "utf8" });
  const packed = JSON.parse(output.slice(output.lastIndexOf("\n[") + 1))[0];
  if (packed.files.some(file => file.path.includes("typescript-module-order-v2")
    || file.path === "dist/src/modules/module-initialization-v2.js")) {
    throw new Error("The retired TS6 module-order v2 implementation must not be shipped");
  }
  const consumer = join(directory, "consumer");
  execFileSync("npm", ["install", "--ignore-scripts", "--no-package-lock", "--prefix", consumer, join(directory, packed.filename),
    ...["corsa-oxlint", "@oxlint/plugins", "oxlint"].map(name => `${name}@${manifest.devDependencies[name]}`)], { stdio: "inherit" });
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
  writeFileSync(join(consumer, "query.ts"), 'export function run() { console.log("確認😀"); fetch("https://example.com"); }');
  writeFileSync(join(consumer, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, target: "ES2022", module: "NodeNext" }, files: ["query.ts"] }));
  writeFileSync(join(consumer, "entry.mts"), "const flag = Math.random() > .5; if (flag) await Promise.resolve(); export {};" );
  writeFileSync(join(consumer, "retry-policy.mts"), `/* uneffect:requires attempts < 2 */
/* uneffect:ensures result === 2 - attempts */
export function remaining(attempts: 0 | 1 | 2): number { return 2 - attempts; }`);
  writeFileSync(join(consumer, "retry-forward.mts"), `import { remaining } from "./retry-policy.mjs";
/* uneffect:requires count < 2 */
/* uneffect:ensures result === 2 - count */
export function forward(count: 0 | 1 | 2): number { return remaining(count) + 0; }
/* uneffect:ensures result === true */
export function safeRetry(count: 0 | 1 | 2): boolean { return count === 2 || remaining(count) > 0; }
/* uneffect:ensures result === (count < 2) */
export function lateGuard(count: 0 | 1 | 2): boolean { return remaining(count) > 0 && count < 2; }`);
  writeFileSync(join(consumer, "retry-client.mts"), `import { forward as retriesLeft, safeRetry, lateGuard } from "./retry-forward.mjs";
/* uneffect:ensures result === 1 */
export function budget(): number { return retriesLeft(1); }
/* uneffect:ensures result > 0 */
export function exhausted(): number { return retriesLeft(2); }
/* uneffect:ensures result >= 0 */
export function guarded(attempts: 0 | 1 | 2): number {
  if (attempts === 2) return 0;
  return retriesLeft(attempts);
}
/* uneffect:ensures result >= 0 */
export function unguarded(attempts: 0 | 1 | 2): number { return retriesLeft(attempts); }
/* uneffect:ensures result === true */
export function shortCircuit(attempts: 0 | 1 | 2): boolean { return safeRetry(attempts); }
/* uneffect:ensures result === (attempts < 2) */
export function tooLate(attempts: 0 | 1 | 2): boolean { return lateGuard(attempts); }`);
  writeFileSync(join(consumer, "tsconfig.contracts.json"), JSON.stringify({ compilerOptions: {
    strict: true, target: "ES2024", module: "NodeNext", types: [],
  }, files: ["retry-policy.mts", "retry-forward.mts", "retry-client.mts"] }));
  writeFileSync(join(consumer, "index.mjs"), `
    import assert from "node:assert/strict";
    import { createRequire } from "node:module";
    import { readFileSync } from "node:fs";
    import { resolve } from "node:path";
    const require = createRequire(import.meta.url);
    for (const name of ["typescript", "@typescript/typescript6"]) {
      assert.throws(() => require.resolve(name), { code: "MODULE_NOT_FOUND" });
    }
    const moduleOrder = await import("@mizchi/uneffect/module-order");
    const options = { entryFile: resolve("entry.mts") };
    assert.equal((await moduleOrder.analyzeModuleInitializationOrder(options)).evidence, "unknown");
    const order = await moduleOrder.analyzeModuleInitializationOrderV2(options);
    assert.equal(order.evidence, "verified");
    assert.match(order.compiler.typescriptVersion, /^7[.]/);
    const limited = await moduleOrder.analyzeModuleInitializationOrderV2({ ...options, proofBudget: { moduleControlFlowIterations: 1 } });
    assert.equal(limited.evidence, "unknown");
    assert(limited.unknowns.some(item => item.kind === "module-control-flow-proof"));
    const cfg = await import("@mizchi/uneffect/cfg");
    const api = await import("@mizchi/uneffect/corsa/api");
    const corsa = await import("@mizchi/uneffect/corsa");
    const experimental = await import("@mizchi/uneffect/experimental/corsa");
    assert.equal(typeof cfg.solveBasicBlockFixedPoint, "function");
    const configFile = resolve("tsconfig.json");
    const frontend = await api.openCorsaApiFrontend({ configFile });
    try {
      const files = new Map(frontend.rootFiles.map(file => [file, readFileSync(file, "utf8")]));
      const result = experimental.analyzeCorsaBuiltinCalls(files, frontend);
      assert.deepEqual(result.entries.map(entry => entry.operation), ["Console", "Fetch"]);
      assert.equal(result.summary.classified, 2);
    } finally { frontend.close(); }
    const checked = await corsa.checkCorsaProject({ configFile, requireAnnotations: false, includeBuiltinCalls: true });
    assert.equal(checked.corsaBuiltinCalls.summary.classified, 2);
    assert.equal(checked.errors, 0);
    assert.equal(checked.summaries.length, 1);
    const contracts = await corsa.checkCorsaProject({ configFile: resolve("tsconfig.contracts.json"), requireAnnotations: false });
    const clientArtifacts = contracts.artifacts.filter(item => item.source.fileName === resolve("retry-client.mts"));
    const statuses = (name, clause) => clientArtifacts.filter(item => item.obligation.functionName === name
      && item.obligation.clause === clause).map(item => item.status);
    assert.deepEqual(statuses("budget", "ensures"), ["verified"]);
    assert.deepEqual(statuses("exhausted", "requires"), ["counterexample", "counterexample"]);
    assert.deepEqual(statuses("exhausted", "ensures"), ["counterexample"]);
    assert.deepEqual(statuses("guarded", "requires"), ["verified", "verified"]);
    assert.deepEqual(statuses("guarded", "ensures"), ["verified", "verified"]);
    assert.deepEqual(statuses("unguarded", "requires"), ["counterexample", "counterexample"]);
    assert.deepEqual(statuses("unguarded", "ensures"), ["verified"]);
    assert.deepEqual(statuses("shortCircuit", "requires"), ["verified"]);
    assert.deepEqual(statuses("shortCircuit", "ensures"), ["verified"]);
    assert.deepEqual(statuses("tooLate", "requires"), ["counterexample"]);
    assert.deepEqual(statuses("tooLate", "ensures"), ["verified"]);
    assert(contracts.diagnostics.some(item => item.domain === "contract" && item.functionName === "unguarded"));
    assert(contracts.errors > 0);
    assert(clientArtifacts.every(item => item.native.coverage === "safe-integer-arithmetic"));
  `);
  execFileSync(process.execPath, [join(consumer, "index.mjs")], { cwd: consumer, stdio: "inherit" });
  console.log("Corsa analysis and published entrypoints passed without JS TypeScript packages");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
