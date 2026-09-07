import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { inspectCorsaBuildOutputs } from "../src/project/corsa-build-output.js";
import { resolveCorsaExecutable } from "../src/frontends/corsa/corsa-api-frontend.js";

function project(run: (directory: string, configFile: string) => void, options: Record<string, unknown> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "uneffect-native-build-")), configFile = join(directory, "tsconfig.json");
  writeFileSync(join(directory, "input.ts"), "export function increment(value: number) { return value + 1; }\n");
  writeFileSync(configFile, JSON.stringify({ compilerOptions: { strict: true, target: "ES2022", module: "NodeNext", declaration: true, outDir: "dist", types: [], ...options }, files: ["input.ts"] }));
  try { run(directory, configFile); } finally { rmSync(directory, { recursive: true, force: true }); }
}
function build(configFile: string) {
  try { execFileSync(resolveCorsaExecutable(), ["--project", configFile], { stdio: "pipe" }); }
  catch (error) { throw new Error(String((error as { stdout?: Buffer }).stdout ?? error)); }
}
describe("native build-output verification gate", () => {
  it("verifies native JS/declarations and preserves build outputs and tsbuildinfo", () => {
    project((directory, configFile) => {
      build(configFile);
      const names = ["dist/input.js", "dist/input.d.ts", "dist/tsconfig.tsbuildinfo"];
      const before = names.map(name => [readFileSync(join(directory, name), "utf8"), statSync(join(directory, name)).mtimeMs]);
      const result = inspectCorsaBuildOutputs({ configFile });
      expect(result.status).toBe("verified");
      expect(result.outputs.map(output => output.kind).sort()).toEqual(["declaration", "runtime"]);
      expect(result.compiler.version).toBe("7.0.2");
      expect(result.compiler.digest).toMatch(/^[a-f0-9]{64}$/);
      expect(result.inputDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(names.map(name => [readFileSync(join(directory, name), "utf8"), statSync(join(directory, name)).mtimeMs])).toEqual(before);
    }, { incremental: true });
  });
  it("reports missing files without writing replacements into the consumer project", () => {
    project((directory, configFile) => {
      const result = inspectCorsaBuildOutputs({ configFile });
      expect(result.status).toBe("missing");
      expect(result.outputs).toHaveLength(2);
      expect(() => statSync(join(directory, "dist"))).toThrow();
    });
  });
  it.each(["input.js", "input.d.ts"])("detects tampering in %s even if build timestamps are current", name => {
    project((directory, configFile) => {
      build(configFile);
      const output = join(directory, "dist", name);
      writeFileSync(output, readFileSync(output, "utf8") + "\n// tampered\n");
      const result = inspectCorsaBuildOutputs({ configFile });
      expect(result.status).toBe("mismatch");
      expect(result.outputs.find(item => item.fileName === output)?.status).toBe("mismatch");
      expect(readFileSync(output, "utf8")).toContain("tampered");
    });
  });
  it("detects source changes after a build", () => {
    project((directory, configFile) => {
      build(configFile);
      writeFileSync(join(directory, "input.ts"), 'export function increment(value: number) { return String(value); }');
      const result = inspectCorsaBuildOutputs({ configFile });
      expect(result.status).toBe("mismatch");
      expect(result.outputs.every(output => output.status === "mismatch")).toBe(true);
    });
  });
  it("includes package metadata that changes NodeNext module interpretation in the input digest", () => {
    project((directory, configFile) => {
      build(configFile);
      const before = inspectCorsaBuildOutputs({ configFile });
      writeFileSync(join(directory, "package.json"), JSON.stringify({ type: "module" }));
      const after = inspectCorsaBuildOutputs({ configFile });
      expect(after.status).toBe("mismatch");
      expect(after.inputDigest).not.toBe(before.inputDigest);
    });
  });
  it("freezes source membership so redirecting outDir cannot include altered dist declarations", () => {
    project((directory, configFile) => {
      const config = JSON.parse(readFileSync(configFile, "utf8"));
      delete config.files;
      writeFileSync(configFile, JSON.stringify(config));
      writeFileSync(join(directory, "input.ts"), "export interface Shape { n: number } export const value: Shape = { n: 1 };");
      build(configFile);
      const output = join(directory, "dist", "input.d.ts");
      writeFileSync(output, readFileSync(output, "utf8") + '\ndeclare module "../input.js" { interface Shape { bad: string } }\n');
      const result = inspectCorsaBuildOutputs({ configFile });
      expect(result.status, result.message).toBe("mismatch");
      expect(result.outputs.find(item => item.fileName === output)?.status).toBe("mismatch");
    });
  });
  it("retains default type roots for explicitly requested ambient packages", () => {
    project((directory, configFile) => {
      mkdirSync(join(directory, "node_modules", "@types", "ambient"), { recursive: true });
      writeFileSync(join(directory, "node_modules", "@types", "ambient", "index.d.ts"), "declare const ambient: number;");
      writeFileSync(join(directory, "input.ts"), "export const value = ambient;");
      build(configFile);
      const result = inspectCorsaBuildOutputs({ configFile });
      expect(result.status, result.message).toBe("verified");
    }, { types: ["ambient"] });
  });
  it("retains inherited relative rootDir/output settings and source imports", () => {
    project((directory, configFile) => {
      mkdirSync(join(directory, "config"));
      mkdirSync(join(directory, "src"));
      writeFileSync(join(directory, "config", "base.json"), JSON.stringify({ compilerOptions: {
        target: "ES2022", module: "NodeNext", declaration: true, rootDir: "../src", outDir: "../dist", types: [],
      } }));
      writeFileSync(configFile, JSON.stringify({ extends: "./config/base.json", include: ["src/**/*.ts"] }));
      writeFileSync(join(directory, "src", "helper.ts"), "export interface Value { n: number } export const value: Value = { n: 1 };");
      writeFileSync(join(directory, "src", "input.ts"), 'import { value } from "./helper.js"; export function read() { return value; }');
      build(configFile);
      const result = inspectCorsaBuildOutputs({ configFile });
      expect(result.status, result.message).toBe("verified");
      expect(result.outputs).toHaveLength(4);
    });
  });
  it("supports a distinct declaration directory and ordinary source maps", () => {
    project((_directory, configFile) => { build(configFile); expect(inspectCorsaBuildOutputs({ configFile }).status).toBe("verified"); },
      { declarationDir: "types", sourceMap: true, declarationMap: true });
  });
  it.each([{ noCheck: true }, { noEmit: true }, { emitDeclarationOnly: true }, { inlineSourceMap: true }, { mapRoot: "maps" }, { outDir: undefined }])("rejects unsupported config %j", options => {
    project((_directory, configFile) => {
      const result = inspectCorsaBuildOutputs({ configFile });
      expect(result.status).toBe("error");
      expect(result.outputs).toEqual([]);
      expect(result.message).toMatch(/unsupported|requires/);
    }, options);
  });
  it("reports compiler errors instead of checking stale outputs", () => {
    project((directory, configFile) => {
      build(configFile);
      writeFileSync(join(directory, "input.ts"), 'export const broken: number = "wrong";');
      const result = inspectCorsaBuildOutputs({ configFile });
      expect(result.status).toBe("error");
      expect(result.message).toContain("TS2322");
      expect(result.outputs).toEqual([]);
    });
  });
  it("checks a referenced producer and refuses to claim whole-workspace verification", () => {
    project((directory, configFile) => {
      build(configFile);
      mkdirSync(join(directory, "app"));
      const appConfig = join(directory, "app", "tsconfig.json");
      writeFileSync(join(directory, "app", "index.ts"), 'import { increment } from "../input.js"; export const value = increment(1);');
      writeFileSync(appConfig, JSON.stringify({ compilerOptions: { composite: true, target: "ES2022", module: "NodeNext", outDir: "dist", types: [] }, files: ["index.ts"], references: [{ path: ".." }] }));
      execFileSync(resolveCorsaExecutable(), ["--build", appConfig], { stdio: "pipe" });
      const fresh = execFileSync(resolveCorsaExecutable(), ["--build", appConfig, "--dry", "--verbose", "--locale", "en"], { encoding: "utf8" });
      expect(fresh).toContain("up to date");
      writeFileSync(join(directory, "dist", "input.d.ts"), 'export declare function increment(value: string): string;');
      expect(inspectCorsaBuildOutputs({ configFile }).status).toBe("mismatch");
      const result = inspectCorsaBuildOutputs({ configFile: appConfig });
      expect(result.status).toBe("error");
      expect(result.message).toContain("references");
    }, { composite: true });
  });
  it("runs with JavaScript compiler imports forbidden", () => {
    project((_directory, configFile) => {
      build(configFile);
      const script = `import { registerHooks } from 'node:module'; import assert from 'node:assert/strict';
        registerHooks({ resolve(specifier, context, next) { if (/^(?:typescript(?:\\/|$)|@typescript\\/typescript6(?:\\/|$))/.test(specifier)) throw new Error('compiler forbidden'); return next(specifier, context); } });
        const { inspectCorsaBuildOutputs } = await import('./src/project/corsa-build-output.ts');
        assert.equal(inspectCorsaBuildOutputs({ configFile: ${JSON.stringify(configFile)} }).status, 'verified');`;
      execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { stdio: "pipe", timeout: 30_000 });
    });
  });
});
