import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ts from "@typescript/typescript6";
import { describe, expect, it } from "vitest";
import { resolveCorsaRefinementDslLink } from "../src/spec/analysis-api.js";
import { resolveRefinementDslLink } from "../src/refinement/refinement-dsl.js";

const implementation = `/* uneffect:refinement_from "./counter.uneffect.ts#default" */
export type Runtime = { value: number };
export const create = (value: Runtime): Runtime => value;
export const observe = (value: Runtime): Runtime => value;
export function increment(value: Runtime): void { value.value++; }
export function nonnegative(value: Runtime): boolean { return value.value >= 0; }
`;
const specification = `import { defineRefinement, identityProjection } from "@mizchi/uneffect/spec";
import { create, observe, increment, nonnegative } from "./counter.js";
export default defineRefinement({ name: "counter", version: "1", create, observe,
  abstractions: { value: identityProjection("value") }, actions: { increment }, invariants: { nonnegative } });`;
async function project(source: string, spec: string, run: (options: { configFile: string; implementationFile: string; files: Record<string, string> }, directory: string) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "uneffect-native-refinement-"));
  const implementationFile = join(directory, "counter.ts"), configFile = join(directory, "tsconfig.json");
  const files = { [implementationFile]: source, [join(directory, "counter.uneffect.ts")]: spec };
  for (const [file, text] of Object.entries(files)) writeFileSync(file, text);
  writeFileSync(configFile, JSON.stringify({ compilerOptions: {
    strict: true, target: "ES2024", module: "NodeNext", types: ["node"], typeRoots: [resolve("node_modules/@types")],
    paths: { "@mizchi/uneffect/spec": [resolve("src/spec/index.ts")] },
  }, files: Object.keys(files) }));
  try { await run({ configFile, implementationFile, files }, directory); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}

describe("Corsa refinement DSL linking", () => {
  it.each([
    ["shorthand references", specification],
    ["renamed imports", specification.replace("{ create,", "{ create as construct,").replace('version: "1", create,', 'version: "1", create: construct,')],
    ["explicit properties", specification.replace("version: \"1\", create, observe", "version: \"1\", create: create, observe: observe").replace("{ increment }", "{ step: increment }").replace("{ nonnegative }", "{ valid: nonnegative }")],
  ])("preserves the Program manifest for %s", async (_name, spec) => {
    await project(implementation, spec!, async options => {
      const config = ts.parseJsonConfigFileContent(JSON.parse(readFileSync(options.configFile, "utf8")), ts.sys, resolve(options.configFile, ".."));
      const program = ts.createProgram(config.fileNames, config.options);
      expect(await resolveCorsaRefinementDslLink(options)).toEqual(resolveRefinementDslLink(options.implementationFile, options.files[options.implementationFile]!, options.files, program));
    });
  });
  it.each([
    ["create input", implementation.replace("(value: Runtime): Runtime => value", "(value: { value: number; extra: string }): Runtime => value"), /create input and result/],
    ["observe input", implementation.replace("observe = (value: Runtime)", "observe = (value: { value: number; extra: string })"), /observe must accept/],
    ["action input", implementation.replace("increment(value: Runtime)", "increment(value: { value: number; extra: string })"), /actions.increment must accept/],
    ["invariant input", implementation.replace("nonnegative(value: Runtime)", "nonnegative(value: { value: number; extra: string })"), /invariants.nonnegative must accept/],
    ["invariant result", implementation.replace(": boolean { return value.value >= 0; }", ": number { return value.value; }"), /must return boolean/],
    ["missing runtime parameter", implementation.replace("increment(value: Runtime): void { value.value++; }", "increment(): void {}"), /must accept a runtime parameter/],
    ["overloaded callable", implementation.replace("export function increment(value: Runtime): void", "export function increment(value: Runtime): void; export function increment(value: Runtime, extra: number): void; export function increment(value: Runtime, extra?: number): void"), /exactly one callable signature/],
    ["body type error", implementation.replace("value.value++;", 'value.value = "bad";'), /TS2322/],
  ])("rejects %s", async (_name, source, error) => {
    await project(source as string, specification, async options => {
      await expect(resolveCorsaRefinementDslLink(options)).rejects.toThrow(error as RegExp);
    });
  });
  it("rejects same-shaped callables declared outside the attached implementation", async () => {
    await project(implementation, specification.replace('"./counter.js"', '"./foreign.js"'), async (options, directory) => {
      writeFileSync(join(directory, "foreign.ts"), implementation.replace(/\/\*.*?\*\//, ""));
      await expect(resolveCorsaRefinementDslLink(options)).rejects.toThrow(/export declared by attached implementation/);
    });
  });
  it("follows barrel aliases back to the attached implementation", async () => {
    await project(implementation, specification.replace('"./counter.js"', '"./barrel.js"'), async (options, directory) => {
      writeFileSync(join(directory, "barrel.ts"), 'export { create, observe, increment, nonnegative } from "./counter.js";');
      const result = await resolveCorsaRefinementDslLink(options);
      expect(result.actions).toEqual({ increment: "increment" });
    });
  });
  it("does not count a foreign re-export as an implementation declaration", async () => {
    await project(implementation.replace(/export function nonnegative[^\n]+/, 'export { nonnegative } from "./foreign.js";'), specification, async (options, directory) => {
      writeFileSync(join(directory, "foreign.ts"), "export const nonnegative = (value: { value: number }): boolean => value.value >= 0;");
      await expect(resolveCorsaRefinementDslLink(options)).rejects.toThrow(/invariants.nonnegative does not resolve to an export declared/);
    });
  });
  it("rejects same-named authoring helpers from another module", async () => {
    await project(implementation, specification, async (options, directory) => {
      const fake = join(directory, "refinement-authoring.ts");
      writeFileSync(fake, "export const defineRefinement = (value: unknown) => value, identityProjection = (value: string) => value;");
      const config = JSON.parse(readFileSync(options.configFile, "utf8"));
      config.compilerOptions.paths["@mizchi/uneffect/spec"] = [fake];
      writeFileSync(options.configFile, JSON.stringify(config));
      await expect(resolveCorsaRefinementDslLink(options)).rejects.toThrow(/Corsa symbol identity/);
    });
  });
  it("rejects stale sources and unchecked projects", async () => {
    await project(implementation, specification, async options => {
      options.files[options.implementationFile] += "\n";
      await expect(resolveCorsaRefinementDslLink(options)).rejects.toThrow(/snapshot/);
      options.files[options.implementationFile] = implementation;
      const config = JSON.parse(readFileSync(options.configFile, "utf8"));
      config.compilerOptions.noCheck = true;
      writeFileSync(options.configFile, JSON.stringify(config));
      await expect(resolveCorsaRefinementDslLink(options)).rejects.toThrow(/noCheck/);
    });
  });
  it("links without loading the JavaScript compiler", async () => {
    await project(implementation, specification, async options => {
      const script = `import { registerHooks } from 'node:module'; import assert from 'node:assert/strict';
        registerHooks({ resolve(specifier, context, next) {
          if (/^(?:typescript(?:\\/|$)|@typescript\\/typescript6(?:\\/|$))/.test(specifier)) throw new Error('compiler forbidden: ' + specifier);
          return next(specifier, context);
        } });
        const { resolveCorsaRefinementDslLink } = await import('./src/spec/analysis-api.ts');
        const result = await resolveCorsaRefinementDslLink(${JSON.stringify(options)});
        assert.equal(result.schema, 'uneffect-refinement-bindings/v1');`;
      execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { timeout: 30_000, stdio: "pipe" });
    });
  });
});
