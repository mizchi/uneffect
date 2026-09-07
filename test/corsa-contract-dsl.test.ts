import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ts from "@typescript/typescript6";
import { describe, expect, it } from "vitest";
import { prepareCorsaContractDslLinks } from "../src/spec/analysis-api.js";
import { parseContractDsl, prepareContractDslLinks, validateContractDslLink } from "../src/contracts/contract-dsl.js";

const link = '/* uneffect:contract_from "./contract.uneffect.ts#Contract" */\n';
const specification = (domain: string) => `import { defineContract, ${domain} } from "@mizchi/uneffect/spec";
export const Contract = defineContract({ parameters: { value: ${domain}() }, returns: ${domain}(), ensures: ({value, result}) => result === value });`;
async function project(implementation: string, domain: string, run: (options: { configFile: string; files: Record<string, string> }, directory: string) => Promise<void>, config: Record<string, unknown> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "uneffect-contract-link-"));
  const files = { [join(directory, "implementation.ts")]: implementation, [join(directory, "contract.uneffect.ts")]: specification(domain) };
  const configFile = join(directory, "tsconfig.json");
  for (const [file, source] of Object.entries(files)) writeFileSync(file, source);
  writeFileSync(configFile, JSON.stringify({ compilerOptions: {
    strict: true, target: "ES2024", module: "NodeNext", types: ["node"], typeRoots: [resolve("node_modules/@types")],
    paths: { "@mizchi/uneffect/spec": [resolve("src/spec/index.ts")], "@mizchi/uneffect": [resolve("src/runtime/numeric.ts")] }, ...config,
  }, files: Object.keys(files) }));
  try { await run({ configFile, files }, directory); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}

describe("Corsa contract DSL linking", () => {
  it.each([
    ["int", link + "export function same(value: number) { return value; }"],
    ["bool", link + "export function same(value: boolean) { return value; }"],
    ["int", link + "export function same(value = 1): number { return value; }"],
    ["nat", 'import type { Nat as Natural } from "@mizchi/uneffect";\n' + link + "export function same(value: Natural): Natural { return value; }"],
    ["float", 'import type { Float } from "@mizchi/uneffect";\n' + link + "export function same(value: Float): Float { return value; }"],
  ])("preserves %s signature validation and clause provenance", async (domain, implementation) => {
    await project(implementation!, domain!, async options => {
      const parsed = ts.readConfigFile(options.configFile, ts.sys.readFile);
      const config = ts.parseJsonConfigFileContent(parsed.config, ts.sys, resolve(options.configFile, ".."));
      const program = ts.createProgram(config.fileNames, config.options);
      expect(await prepareCorsaContractDslLinks(options)).toEqual(prepareContractDslLinks(options.files, program));
    });
  });
  it.each([
    ["boolean parameter", "export function same(value: boolean): number { return 1; }", /parameter value expects int/],
    ["wrong result", "export function same(value: number) { return true; }", /result expects int/],
    ["any parameter", "export function same(value: any): number { return 1; }", /parameter value expects int/],
    ["any result", "export function same(value: number): any { return value; }", /result expects int/],
    ["optional parameter", "export function same(value?: number): number { return value ?? 0; }", /required identifier/],
    ["rest parameter", "export function same(...value: number[]): number { return 1; }", /required identifier/],
    ["renamed parameter", "export function same(other: number): number { return other; }", /required identifier/],
    ["wrong count", "export function same(value: number, other: number) { return value; }", /parameter count/],
    ["body type error", 'export function same(value: number): number { return "bad"; }', /TS2322/],
    ["missing body", "export declare function same(value: number): number;", /function declaration/],
    ["misplaced link", "const value = 1; export function same(value: number): number { return value; }", /function declaration/],
  ])("rejects %s", async (_name, implementation, error) => {
    await project(link + implementation, "int", async options => {
      await expect(prepareCorsaContractDslLinks(options)).rejects.toThrow(error as RegExp);
    });
  });
  it("rejects a same-name numeric type from a different numeric module", async () => {
    await project('import type { Nat } from "./numeric.js";\n' + link + "export function same(value: Nat): Nat { return value; }", "nat", async (options, directory) => {
      writeFileSync(join(directory, "numeric.ts"), "export type Nat = number;");
      await expect(prepareCorsaContractDslLinks(options)).rejects.toThrow(/expects nat/);
    });
  });
  it("keeps direct Program validation from overlooking links on ambient declarations", async () => {
    const source = link + "export declare function other(value: number): number;\n" + link + "export function same(value: number): number { return value; }";
    await project(source, "int", async options => {
      const parsed = ts.readConfigFile(options.configFile, ts.sys.readFile);
      const config = ts.parseJsonConfigFileContent(parsed.config, ts.sys, resolve(options.configFile, ".."));
      const program = ts.createProgram(config.fileNames, config.options);
      const [implementation, spec] = Object.keys(options.files);
      const contract = parseContractDsl(spec!, options.files[spec!]!, "Contract");
      expect(() => validateContractDslLink(program, implementation!, spec!, contract)).toThrow(/exactly one function declaration/);
    });
  });
  it("rejects a counterfeit public numeric module in both native and Program adapters", async () => {
    await project('import type { Nat } from "@mizchi/uneffect";\n' + link + "export function same(value: Nat): Nat { return value; }", "nat", async (options, directory) => {
      const fake = join(directory, "numeric.ts");
      writeFileSync(fake, "export type Nat = number;");
      const config = JSON.parse(readFileSync(options.configFile, "utf8"));
      config.compilerOptions.paths["@mizchi/uneffect"] = [fake];
      writeFileSync(options.configFile, JSON.stringify(config));
      await expect(prepareCorsaContractDslLinks(options)).rejects.toThrow(/expects nat/);
      const parsed = ts.parseJsonConfigFileContent(config, ts.sys, directory);
      const program = ts.createProgram(parsed.fileNames, parsed.options);
      expect(() => prepareContractDslLinks(options.files, program)).toThrow(/expects nat/);
    });
  });
  it("rejects helper impostors even when the authoring filename matches", async () => {
    await project(link + "export function same(value: number) { return value; }", "int", async (options, directory) => {
      const fake = join(directory, "contract-authoring.ts");
      writeFileSync(fake, "export const defineContract = (value: unknown) => value; export const int = () => 1;");
      // The counterfeit helper is type correct too; identity must still reject it.
      const file = Object.keys(options.files).find(file => file.endsWith(".uneffect.ts"))!;
      options.files[file] = options.files[file]!.replace("({value, result})", "({value, result}: {value: number; result: number})");
      writeFileSync(file, options.files[file]!);
      writeFileSync(options.configFile, JSON.stringify({ compilerOptions: { strict: true, types: [], paths: { "@mizchi/uneffect/spec": [fake] } }, files: Object.keys(options.files) }));
      await expect(prepareCorsaContractDslLinks(options)).rejects.toThrow(/Corsa symbol identity/);
    });
  });
  it("rejects noCheck and stale source instead of accepting unchecked links", async () => {
    await project(link + "export function same(value: number): number { return value; }", "int", async options => {
      await expect(prepareCorsaContractDslLinks(options)).rejects.toThrow(/noCheck/);
    }, { noCheck: true });
    await project(link + "export function same(value: number): number { return value; }", "int", async options => {
      const file = Object.keys(options.files)[0]!;
      options.files[file] += "\n";
      await expect(prepareCorsaContractDslLinks(options)).rejects.toThrow(/snapshot/);
    });
  });
  it("prepares linked contracts without JavaScript compiler imports", async () => {
    await project(link + "export function same(value: number) { return value; }", "int", async options => {
      const script = `
        import { registerHooks } from 'node:module'; import assert from 'node:assert/strict';
        registerHooks({ resolve(specifier, context, next) {
          if (/^(?:typescript(?:\\/|$)|@typescript\\/typescript6(?:\\/|$))/.test(specifier)) throw new Error('JavaScript compiler forbidden: ' + specifier);
          return next(specifier, context);
        } });
        const { prepareCorsaContractDslLinks } = await import('./src/spec/analysis-api.ts');
        const result = await prepareCorsaContractDslLinks(${JSON.stringify(options)});
        assert.equal(Object.values(result.provenance)[0].length, 1);
      `;
      execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { stdio: "pipe", timeout: 30_000 });
    });
  });
});
