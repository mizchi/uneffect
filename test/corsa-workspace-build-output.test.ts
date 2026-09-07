import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inspectCorsaWorkspaceBuildOutputs } from "../src/project/corsa-build-output.js";
import { resolveCorsaExecutable } from "../src/frontends/corsa/corsa-api-frontend.js";

function workspace(run: (directory: string, configFile: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), "uneffect-native-workspace-"));
  const configFile = join(directory, "tsconfig.json");
  const projects = [
    { name: "lib", references: [], source: "export const value: number = 1;" },
    { name: "left", references: ["../lib"], source: 'export { value } from "../lib/index.js";' },
    { name: "right", references: ["../lib/tsconfig.json"], source: 'export { value } from "../lib/index.js";' },
    { name: "app", references: ["../left", "../right"], source: 'import { value } from "../left/index.js"; import { value as other } from "../right/index.js"; export const result = value + other;' },
  ];
  for (const project of projects) {
    mkdirSync(join(directory, project.name));
    writeFileSync(join(directory, project.name, "index.ts"), project.source);
    writeFileSync(join(directory, project.name, "tsconfig.json"), JSON.stringify({
      compilerOptions: { composite: true, strict: true, target: "ES2022", module: "NodeNext", outDir: "dist", types: [] },
      files: ["index.ts"], references: project.references.map(path => ({ path })),
    }));
  }
  writeFileSync(configFile, JSON.stringify({ files: [], references: [{ path: "./app" }] }));
  try { run(directory, configFile); } finally { rmSync(directory, { recursive: true, force: true }); }
}
function build(configFile: string) {
  try { execFileSync(resolveCorsaExecutable(), ["--build", configFile], { stdio: "pipe" }); }
  catch (error) { throw new Error(String((error as { stdout?: Buffer }).stdout ?? error)); }
}
interface FixtureConfig {
  compilerOptions: Record<string, unknown>;
  references: { path: string }[];
}
function changeConfig(file: string, update: (config: FixtureConfig) => void) {
  const config = JSON.parse(readFileSync(file, "utf8"));
  update(config);
  writeFileSync(file, JSON.stringify(config));
}
// A real native invocation with a deterministic filesystem change immediately
// after the consumer emits, before the coordinator rechecks its producers.
function changingCompiler(directory: string, target: string) {
  const executable = join(directory, "compiler.cjs");
  writeFileSync(executable, `#!/usr/bin/env node
    const { readFileSync, appendFileSync } = require('node:fs');
    const { spawnSync } = require('node:child_process');
    const args = process.argv.slice(2);
    const result = spawnSync(${JSON.stringify(resolveCorsaExecutable())}, args, { encoding: 'utf8' });
    if (args.includes('--listEmittedFiles') && !args.includes('--listFilesOnly')) {
      const config = JSON.parse(readFileSync(args[args.indexOf('--project') + 1], 'utf8'));
      if (config.files.includes(${JSON.stringify(join(directory, "app", "index.ts"))})) appendFileSync(${JSON.stringify(target)}, '\\n ');
    }
    process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
    process.exit(result.status ?? 1);
  `);
  chmodSync(executable, 0o755);
  return executable;
}

describe("native workspace build-output verification", () => {
  it("verifies a solution and diamond references once in dependency order without modifying artifacts", () => {
    workspace((directory, configFile) => {
      build(configFile);
      const files = ["lib", "left", "right", "app"].flatMap(name => ["index.js", "index.d.ts", "tsconfig.tsbuildinfo"].map(file => join(directory, name, "dist", file)));
      const before = files.map(file => [readFileSync(file, "utf8"), statSync(file).mtimeMs]);
      const result = inspectCorsaWorkspaceBuildOutputs({ configFile: "tsconfig.json", cwd: directory });
      expect(result.status, result.message).toBe("verified");
      expect(result.coverage).toBe("project-reference-js-and-declarations");
      expect(result.compiler.version).toBe("7.0.2");
      expect(result.projects.map(project => project.configFile)).toEqual(["lib", "left", "right", "app"].map(name => join(directory, name, "tsconfig.json")).concat(configFile));
      expect(result.projects.at(-1)?.kind).toBe("solution");
      expect(result.outputs).toHaveLength(8);
      expect(files.map(file => [readFileSync(file, "utf8"), statSync(file).mtimeMs])).toEqual(before);
    });
  });
  it("also accepts an emitting root with references", () => {
    workspace((directory, configFile) => {
      build(configFile);
      const result = inspectCorsaWorkspaceBuildOutputs({ configFile: join(directory, "app", "tsconfig.json") });
      expect(result.status, result.message).toBe("verified");
      expect(result.projects).toHaveLength(4);
    });
  });
  it.each(["missing declaration", "tampered declaration", "tampered runtime", "stale source"])("blocks transitive consumers of a producer with %s", change => {
    workspace((directory, configFile) => {
      build(configFile);
      const declaration = join(directory, "lib", "dist", "index.d.ts");
      if (change === "missing declaration") rmSync(declaration);
      else if (change === "tampered declaration") writeFileSync(declaration, "export declare const value: string;");
      else if (change === "tampered runtime") writeFileSync(join(directory, "lib", "dist", "index.js"), "// changed");
      else writeFileSync(join(directory, "lib", "index.ts"), "export const value: string = 'changed';");
      const result = inspectCorsaWorkspaceBuildOutputs({ configFile });
      expect(result.status, result.message).toBe(change === "missing declaration" ? "missing" : "mismatch");
      const app = result.projects.find(project => project.configFile === join(directory, "app", "tsconfig.json"));
      expect(app?.status).toBe("not-checked");
      expect(app?.blockedBy).toEqual(["left", "right"].map(name => join(directory, name, "tsconfig.json")));
      expect(app?.outputs).toEqual([]);
      expect(result.projects.every(project => project.status !== "verified")).toBe(true);
    });
  });
  it("fails on consumer diagnostics after verifying dependencies", () => {
    workspace((directory, configFile) => {
      build(configFile);
      writeFileSync(join(directory, "app", "index.ts"), 'export const broken: number = "wrong";');
      const result = inspectCorsaWorkspaceBuildOutputs({ configFile });
      expect(result.status).toBe("error");
      expect(result.projects.find(project => project.configFile.includes("/app/"))?.message).toContain("TS2322");
      expect(result.projects[0]?.status).toBe("verified");
    });
  });
  it("blocks consumers on producer diagnostics while checking independent projects", () => {
    workspace((directory, configFile) => {
      build(configFile);
      writeFileSync(join(directory, "left", "index.ts"), 'export const value: number = "wrong";');
      const result = inspectCorsaWorkspaceBuildOutputs({ configFile });
      expect(result.status).toBe("error");
      expect(result.projects.find(project => project.configFile.includes("/left/"))?.status).toBe("error");
      expect(result.projects.find(project => project.configFile.includes("/right/"))?.status).toBe("verified");
      expect(result.projects.find(project => project.configFile.includes("/app/"))?.blockedBy).toEqual([join(directory, "left", "tsconfig.json")]);
    });
  });
  it.each([false, true])("rejects shared output ownership even when bytes match (symlink: %s)", alias => {
    workspace((directory, configFile) => {
      if (alias) {
        mkdirSync(join(directory, "shared"));
        symlinkSync(join(directory, "shared"), join(directory, "shared-alias"), "dir");
      }
      for (const name of ["lib", "right"]) {
        writeFileSync(join(directory, name, "index.ts"), "export const value: number = 1;");
        changeConfig(join(directory, name, "tsconfig.json"), config => {
          config.references = [];
          config.compilerOptions.outDir = alias && name === "right" ? "../shared-alias" : "../shared";
          config.compilerOptions.tsBuildInfoFile = `../${name}.tsbuildinfo`;
        });
      }
      changeConfig(configFile, config => { config.references = [{ path: "./lib" }, { path: "./right" }]; });
      build(configFile);
      const result = inspectCorsaWorkspaceBuildOutputs({ configFile });
      expect(result.status).toBe("error");
      expect(result.message).toContain("overlapping project output");
      expect(result.outputs).toEqual([]);
      expect(result.projects.every(project => project.status !== "verified")).toBe(true);
    });
  });
  it.each(["lib/index.ts", "lib/dist/index.js", "tsconfig.json"])("invalidates earlier evidence when %s changes during consumer emission", name => {
    workspace((directory, configFile) => {
      build(configFile);
      const result = inspectCorsaWorkspaceBuildOutputs({ configFile, corsaExecutable: changingCompiler(directory, join(directory, name)) });
      expect(result.status, result.message).toBe("error");
      expect(result.message).toMatch(/changed during workspace inspection/);
      expect(result.outputs).toEqual([]);
      expect(result.projects.every(project => project.status !== "verified")).toBe(true);
    });
  });
  it.each(["cycle", "missing config", "empty solution"])("fails closed for %s", problem => {
    workspace((directory, configFile) => {
      if (problem === "cycle") changeConfig(join(directory, "lib", "tsconfig.json"), config => { config.references = [{ path: "../app" }]; });
      if (problem === "missing config") rmSync(join(directory, "lib", "tsconfig.json"));
      if (problem === "empty solution") writeFileSync(configFile, '{"files":[]}');
      const result = inspectCorsaWorkspaceBuildOutputs({ configFile });
      expect(result.status).toBe("error");
      expect(result.outputs).toEqual([]);
      expect(result.message).toMatch(/cycle|ENOENT|source files|empty|TS18002/);
    });
  });
  it("works without loading the JavaScript compiler", () => {
    workspace((_directory, configFile) => {
      build(configFile);
      const script = `import { registerHooks } from 'node:module'; import assert from 'node:assert/strict';
        registerHooks({ resolve(specifier, context, next) { if (/^(?:typescript(?:\\/|$)|@typescript\\/typescript6(?:\\/|$))/.test(specifier)) throw new Error('compiler forbidden'); return next(specifier, context); } });
        const { inspectCorsaWorkspaceBuildOutputs } = await import('./src/project/corsa-build-output.ts');
        const result = inspectCorsaWorkspaceBuildOutputs({ configFile: ${JSON.stringify(configFile)} });
        assert.equal(result.status, 'verified', result.message);`;
      execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { stdio: "pipe", timeout: 30_000 });
    });
  });
});
