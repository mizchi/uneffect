import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lowerCorsaRuleCfg } from "../src/lint/corsa.js";
import { initializationRule, lintPrerequisites } from "../src/lint/index.js";

describe("Corsa/Oxc prerequisite boundary", () => {
  let directory: string, fileName: string;
  const bindings = [
    { functionName: "initialize", operation: "initialize", argumentIndex: 0 },
    { functionName: "use", operation: "use", argumentIndex: 0 },
  ];
  beforeAll(() => { directory = mkdtempSync(join(tmpdir(), "uneffect-corsa-rule-test-")); fileName = join(directory, "input.mts"); });
  afterAll(() => rmSync(directory, { recursive: true, force: true }));
  async function lower(declarations: string, extra: Record<string, unknown> = {}) {
    writeFileSync(fileName, `${declarations}\ndeclare function use(x: object): void;\nexport function run(client: object) { initialize(client); use(client); }`);
    return lowerCorsaRuleCfg({ fileName, functionName: "run", bindings, ...extra });
  }
  it("uses checker-inferred void signatures", async () => {
    const result = await lower("function initialize(x: object) {}");
    expect(result.status).toBe("lowered");
    if (result.status === "lowered") expect(lintPrerequisites(result.cfg, initializationRule).status).toBe("clean");
  });
  it.each([
    "async function initialize(x: object) {}",
    "function initialize(x: object) { return true; }",
    "declare function initialize(x: object): number; declare function initialize(x: object): void;",
  ])("rejects unchecked operation return semantics: %s", async declaration => {
    expect(await lower(declaration)).toMatchObject({ status: "unknown", reason: "unsupported-source" });
  });
  it("fails closed when the native compiler is missing", async () => {
    expect(await lower("declare function initialize(x: object): void;", { corsaExecutable: join(directory, "missing-native") }))
      .toMatchObject({ status: "unknown", reason: "frontend-error" });
  });
  it("checks project diagnostics including another file", async () => {
    const configFile = join(directory, "tsconfig.json"), other = join(directory, "other.mts");
    writeFileSync(other, "const value: string = 123; export {};");
    writeFileSync(configFile, JSON.stringify({ compilerOptions: { types: [], target: "ES2024", module: "NodeNext" }, files: [fileName, other] }));
    expect(await lower("declare function initialize(x: object): void;", { configFile }))
      .toMatchObject({ status: "unknown", reason: "typescript-error" });
  });
  it("rejects source outside the configured project", async () => {
    const configFile = join(directory, "outside.json"), other = join(directory, "valid.mts");
    writeFileSync(other, "export {};");
    writeFileSync(configFile, JSON.stringify({ compilerOptions: { types: [] }, files: [other] }));
    expect(await lower("declare function initialize(x: object): void;", { configFile }))
      .toMatchObject({ status: "unknown", reason: "invalid-input" });
  });
  it("rejects invalid configuration before spawning a compiler", async () => {
    expect(await lowerCorsaRuleCfg({ fileName, functionName: "run", bindings: [{ ...bindings[0]!, argumentIndex: -1 }] }))
      .toMatchObject({ status: "unknown", reason: "invalid-input" });
  });
  it("loads the independent API and runs CLI with all JavaScript TypeScript imports blocked", () => {
    const script = `
      import { registerHooks } from 'node:module';
      import assert from 'node:assert/strict';
      registerHooks({ resolve(specifier, context, next) {
        if (specifier === 'typescript' || specifier.startsWith('typescript/') || specifier === '@typescript/typescript6' || specifier.startsWith('@typescript/typescript6/')) throw new Error('JavaScript compiler forbidden: ' + specifier);
        return next(specifier, context);
      } });
      const core = await import('./src/lint/index.ts');
      const { lowerCorsaRuleCfg } = await import('./src/lint/corsa.ts');
      assert.equal(typeof core.lintPrerequisites, 'function');
      assert.equal(typeof lowerCorsaRuleCfg, 'function');
      const { runCli } = await import('./src/cli/cli-runner.ts');
      let output = '';
      const code = await runCli(['cfg-lint', 'examples/dogfood/cfg-lint-initialization.ts', 'branchMissing'], { out(text) { output += text; }, err(text) { throw new Error(text); } });
      assert.equal(code, 1);
      assert.equal(JSON.parse(output).status, 'findings');
    `;
    expect(() => execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: resolve("."), timeout: 30_000, stdio: "pipe" })).not.toThrow();
  });
});
