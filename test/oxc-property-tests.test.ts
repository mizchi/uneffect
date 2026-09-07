import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generateUneffectPropertyTests, type GenerateUneffectPropertyTestsOptions } from "../src/contracts/property-tests.js";

const fixtures = JSON.parse(readFileSync("test/fixtures/oxc-property-parity.json", "utf8")) as Array<{ options: GenerateUneffectPropertyTestsOptions; expected: unknown }>;
describe("Oxc property generation", () => {
  it.each(fixtures)("preserves generated tests, domains and hints for $options.files", fixture => {
    expect(generateUneffectPropertyTests(fixture.options)).toEqual(fixture.expected);
  });
  it.each(["value?.x === result", "value?.[0] === result", "value.has?.(1)", "value === 1); injected(); const other = (2"])("rejects unsupported expression %s", expression => {
    const result = generateUneffectPropertyTests({ files: { "input.ts": `/* uneffect:ensures ${expression} */\nexport function identity(value: Nat): Nat { return value; }` } });
    expect(result.generatedFiles).toEqual({});
    expect(result.diagnostics).toHaveLength(1);
  });
  it("rejects recovered source syntax", () => {
    expect(() => generateUneffectPropertyTests({ files: { "bad.ts": "/* uneffect:ensures result === x */ export function broken(x: Nat) { return x + ; }" } })).toThrow(/invalid TypeScript syntax/);
  });
  it("rejects ambiguous source-local overload declarations", () => {
    const result = generateUneffectPropertyTests({ files: { "input.ts": `export function valid(value: string): boolean;
      export function valid(value: string): boolean { return !!value; }
      /* uneffect:requires valid(value) */ /* uneffect:ensures result === value */
      export function identity(value: string): string { return value; }` },
    predicateSpecializations: { "input.ts:valid": { version: "uneffect-property-predicate/v1", values: ["yes"] } } });
    expect(result.generatedFiles).toEqual({});
    expect(result.diagnostics[0]?.message).toContain("exported source-local");
  });
  it("generates scalar, structured and imported-predicate properties without JavaScript compiler imports", () => {
    const script = `import { registerHooks } from 'node:module'; import assert from 'node:assert/strict';
      registerHooks({ resolve(specifier, context, next) {
        if (/^(?:typescript(?:\\/|$)|@typescript\\/typescript6(?:\\/|$))/.test(specifier)) throw new Error('compiler forbidden: ' + specifier);
        return next(specifier, context);
      } });
      const { generateUneffectPropertyTests } = await import('./src/spec/analysis-api.ts');
      for (const fixture of ${JSON.stringify(fixtures)}) assert.deepEqual(generateUneffectPropertyTests(fixture.options), fixture.expected);`;
    execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { stdio: "pipe", timeout: 30_000 });
  });
});
