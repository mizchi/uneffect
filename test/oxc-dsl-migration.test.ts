import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseContractDsl, prepareContractDslLinks } from "../src/contracts/contract-dsl.js";
import { parseTemporalDsl, resolveTemporalDslLink } from "../src/spec/temporal-dsl.js";
import { generateQuint } from "../src/spec/spec-backends.js";

// Frozen with TypeScript 6 before replacing the DSL parsers. Do not regenerate from Oxc.
const fixture = JSON.parse(readFileSync("test/fixtures/oxc-dsl-parity.json", "utf8")) as {
  temporal: Array<{ source: string; parsed: ReturnType<typeof parseTemporalDsl>; quint: string; link: ReturnType<typeof resolveTemporalDslLink> }>;
  contract: Array<{ source: string; parsed: ReturnType<typeof parseContractDsl>; prepared: ReturnType<typeof prepareContractDslLinks> }>;
};
const temporal: string = fixture.temporal[0]!.source;
const contract: string = fixture.contract[0]!.source;

describe("Oxc DSL migration", () => {
  it.each(fixture.temporal)("preserves temporal IR, Quint, and link data %#", (item) => {
    const parsed = parseTemporalDsl("model.uneffect.ts", item.source);
    expect(parsed).toEqual(item.parsed);
    expect(generateQuint("model", parsed)).toBe(item.quint);
    expect(resolveTemporalDslLink("src/model.ts", '/* uneffect:temporal_from "./model.uneffect.ts#default" */', { "src/model.uneffect.ts": item.source })).toEqual(item.link);
  });
  it.each(fixture.contract)("preserves contract clauses, materialization, and UTF-16 provenance %#", (item) => {
    expect(parseContractDsl("contract.uneffect.ts", item.source, "Increment")).toEqual(item.parsed);
    expect(prepareContractDslLinks({
      "src/contract.ts": '/* uneffect:contract_from "./contract.uneffect.ts#Increment" */\nexport function increment(value: number): number { return value + 1 }',
      "src/contract.uneffect.ts": item.source,
    })).toEqual(item.prepared);
  });
  it("keeps exported type declarations in declarative temporal modules", () => {
    const typed = temporal.replace("export default", "export type State = { attempts: number }; export interface Marker { done: boolean } export default");
    expect(parseTemporalDsl("model.uneffect.ts", typed)).toEqual(fixture.temporal[0]!.parsed);
  });
  it.each([
    ['async callback', '({ attempts }) => ({ attempts: attempts + 1 })', 'async ({ attempts }) => ({ attempts: attempts + 1 })'],
    ['default state parameter', '({ attempts }) =>', '({ attempts } = { attempts: 0 }) =>'],
    ['default state field', '({ attempts }) =>', '({ attempts = 10 }) =>'],
    ['renamed state field', '({ attempts }) =>', '({ attempts: other }) =>'],
    ['rest state fields', '({ attempts }) =>', '({ ...attempts }) =>'],
    ['optional helper call', 'defineTemporal({', 'defineTemporal?.({'],
    ['type-only helper', 'import {', 'import type {'],
    ['extra helper argument', 'attempts: int()', 'attempts: int(1)'],
    ['duplicate nested field', 'attempts: int()', 'attempts: int(), attempts: int()'],
    ['comment escape in key', 'attempts: int()', '"attempts */": int()'],
    ['prototype setter', 'attempts: int()', '__proto__: int()'],
    ['computed state key', 'attempts: int()', '["attempts"]: int()'],
  ])("rejects temporal semantics absent from the IR: %s", (_name, before, after) => {
    expect(() => parseTemporalDsl("invalid.uneffect.ts", temporal.replace(before!, after!))).toThrow();
  });
  it.each([
    ['async predicate', '({ value }) => value >= 0', 'async ({ value }) => value >= 0'],
    ['default parameter', '({ value }) =>', '({ value } = { value: 0 }) =>'],
    ['default field', '({ value }) =>', '({ value = 0 }) =>'],
    ['aliased field', '({ value }) =>', '({ value: other }) =>'],
    ['rest field', '({ value }) =>', '({ ...value }) =>'],
    ['optional helper call', 'defineContract({', 'defineContract?.({'],
    ['type-only helper', 'import {', 'import type {'],
    ['unknown section', 'requires:', 'ignored:'],
    ['comment escape in parameter', 'parameters: { value: int() }', 'parameters: { "value */": int() }'],
    ['prototype parameter', 'parameters: { value: int() }', 'parameters: { __proto__: int() }'],
    ['computed property', 'parameters:', '["parameters"]:'],
    ['helper arity', 'returns: int()', 'returns: int(1)'],
  ])("rejects contract semantics absent from the IR: %s", (_name, before, after) => {
    expect(() => parseContractDsl("invalid.uneffect.ts", contract.replace(before!, after!), "Increment")).toThrow();
  });
  it("rejects recovered syntax and comment escapes before materializing predicates", () => {
    expect(() => parseContractDsl("invalid.uneffect.ts", contract + "const = ;", "Increment")).toThrow();
    expect(() => parseTemporalDsl("invalid.uneffect.ts", temporal + "const = ;")).toThrow();
    const escaped = contract.replace('result === value + 1', '"*/" === "*/"');
    expect(() => prepareContractDslLinks({ "src/contract.ts": '/* uneffect:contract_from "./contract.uneffect.ts#Increment" */', "src/contract.uneffect.ts": escaped })).toThrow();
  });
  it("loads and exercises the published analysis facade with JavaScript compilers forbidden", () => {
    const script = `
      import { registerHooks } from 'node:module'; import assert from 'node:assert/strict';
      registerHooks({ resolve(specifier, context, next) {
        if (/^(?:typescript(?:\\/|$)|@typescript\\/typescript6(?:\\/|$))/.test(specifier)) throw new Error('JavaScript compiler forbidden: ' + specifier);
        return next(specifier, context);
      } });
      const api = await import('./src/spec/analysis-api.ts');
      assert.equal(api.parseTemporalDsl('model.uneffect.ts', ${JSON.stringify(temporal)}).states.length, 2);
      assert.equal(api.parseContractDsl('contract.uneffect.ts', ${JSON.stringify(contract)}, 'Increment').requires.length, 2);
      const files = { 'src/contract.ts': '/* uneffect:contract_from "./contract.uneffect.ts#Increment" */', 'src/contract.uneffect.ts': ${JSON.stringify(contract)} };
      assert.equal(api.prepareContractDslSources(files).provenance['src/contract.ts'].length, 4);
      assert.equal(api.resolveTemporalDslSourceLink('src/model.ts', '/* uneffect:temporal_from "./model.uneffect.ts#default" */', {'src/model.uneffect.ts': ${JSON.stringify(temporal)}}).spec.states.length, 2);
    `;
    execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { timeout: 30_000, stdio: "pipe" });
  });
});
