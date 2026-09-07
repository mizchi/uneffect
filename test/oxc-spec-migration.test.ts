import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseTemporalExpression, parseTemporalValueType, generateQuintExpression, generateRuntimeAssertionExpression } from "../src/spec/temporal-expressions.js";
import { parseLogicExpression, parseLogicExpressionForHints } from "../src/contracts/logic.js";
import { obligationFromSpec, generateObligationSmt } from "../src/contracts/obligations.js";
import type { InvariantSpec } from "../src/spec/spec-ir.js";
import { parseSpec } from "../src/spec/spec-ir.js";
import { generateComposedQuint, parseTemporalComposition } from "../src/spec/temporal-compose.js";

const baseline = JSON.parse(readFileSync(new URL("./fixtures/oxc-spec-parity.json", import.meta.url), "utf8")) as {
  logic: Array<{ source: string; value?: unknown; rejected?: true; hint: { value?: unknown; rejected?: true } }>;
  obligation: { spec: InvariantSpec; expected: unknown; smt: string };
  expressions: Array<{ source: string; value?: unknown; rejected?: true }>;
  types: Array<{ source: string; value?: unknown; rejected?: true }>;
  spec: { source: string; expected: unknown };
  composition: { source: string; expected: unknown; quint: string };
};

describe("Oxc specification migration", () => {
  it.each(baseline.logic)("preserves scalar logic and hint semantics: $source", ({ source, value, rejected, hint }) => {
    if (rejected) expect(() => parseLogicExpression(source)).toThrow(); else expect(parseLogicExpression(source)).toEqual(value);
    if (hint.rejected) expect(() => parseLogicExpressionForHints(source)).toThrow(); else expect(parseLogicExpressionForHints(source)).toEqual(hint.value);
  });
  it("preserves synthetic obligation IDs and SMT output", () => {
    const actual = obligationFromSpec(baseline.obligation.spec);
    expect(actual).toEqual(baseline.obligation.expected);
    expect(generateObligationSmt(actual)).toBe(baseline.obligation.smt);
  });
  it.each(baseline.expressions)("preserves the former temporal expression result: $source", ({ source, value, rejected }) => {
    const parse = () => { const ast = parseTemporalExpression(source); return { ast, quint: generateQuintExpression(ast), runtime: generateRuntimeAssertionExpression(ast) }; };
    if (rejected) expect(parse).toThrow(); else expect(parse()).toEqual(value);
  });
  it.each(baseline.types)("preserves the former state type result: $source", ({ source, value, rejected }) => {
    if (rejected) expect(() => parseTemporalValueType(source)).toThrow(); else expect(parseTemporalValueType(source)).toEqual(value);
  });
  it("preserves annotation attachment, exported function spans and UTF-16/CRLF locations", () => {
    expect(JSON.parse(JSON.stringify(parseSpec("fixture.ts", baseline.spec.source)))).toEqual(baseline.spec.expected);
  });
  it("preserves call composition and generated Quint", () => {
    const actual = parseTemporalComposition("composition.ts", baseline.composition.source, "main");
    expect(JSON.parse(JSON.stringify({ ...actual, summaries: [...actual.summaries] }))).toEqual(baseline.composition.expected);
    expect(generateComposedQuint("migration", actual)).toBe(baseline.composition.quint);
  });
  it("runs the specification CLI backends with JavaScript TypeScript imports prohibited", () => {
    const script = `
      import { registerHooks } from 'node:module';
      import assert from 'node:assert/strict';
      import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
      import { tmpdir } from 'node:os';
      import { join } from 'node:path';
      registerHooks({ resolve(specifier, context, next) {
        if (/^(?:typescript(?:\\/|$)|@typescript\\/typescript6(?:\\/|$))/.test(specifier)) throw new Error('JavaScript compiler forbidden: ' + specifier);
        return next(specifier, context);
      } });
      const analysis = await import('./src/spec/analysis-api.ts');
      assert.equal(typeof analysis.parseSpec, 'function');
      assert.equal(typeof analysis.lintSpecWithZ3, 'function');
      const { runCli } = await import('./src/cli/cli-runner.ts');
      const directory = mkdtempSync(join(tmpdir(), 'uneffect-oxc-spec-'));
      try {
        const file = join(directory, 'input.ts');
        writeFileSync(file, ${JSON.stringify('/* uneffect:ensures result >= x */\nfunction identity(x: number) { return x; }\n' + baseline.composition.source + '\n/* uneffect: action advance: phase\' = phase + 1 */')});
        for (const backend of ['ir', 'quint', 'compose', 'z3']) {
          let output = '';
          const code = await runCli(['spec', backend, file, ...(backend === 'compose' ? ['main'] : [])], { out(value) { output += value; }, err(value) { throw new Error(value); } });
          assert.equal(code, 0);
          if (backend === 'ir') assert.equal(JSON.parse(output).temporal.states[0].name, 'phase');
          else if (backend === 'z3') assert.match(output, /check-sat/);
          else assert.match(output, /module input/);
        }
      } finally { rmSync(directory, { recursive: true, force: true }); }
    `;
    execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { timeout: 30_000, stdio: "pipe" });
  });
  it.each(["1); const ignored = (2", "1); false; (2", "1 +"])("rejects malformed scalar contracts: %s", source => {
    expect(() => parseLogicExpression(source)).toThrow();
  });
  it("rejects malformed source before emitting a partial specification", () => {
    expect(() => parseSpec("broken.ts", "/* uneffect:ensures result > 0 */ function broken( {")).toThrow(/invalid TypeScript syntax/);
  });
  it("rejects prototype setters absent from the record IR", () => {
    expect(() => parseTemporalExpression("({ __proto__: base })")).toThrow();
    expect(() => parseTemporalValueType("{ __proto__: int }")).toThrow();
  });
  it.each(['true); const ignored = (false', 'true); false; (true'])("rejects expressions escaping their wrapper: %s", source => {
    expect(() => parseTemporalExpression(source)).toThrow();
  });
  it("rejects trailing declarations in a state type", () => {
    expect(() => parseTemporalValueType("int; type Ignored = bool")).toThrow();
  });
  it.each(["obj?.value", "Set?.(1)", "values.forall(async x => true)", "values.forall((x = 1) => true)", "values.forall((...x) => true)"])("rejects semantics absent from the temporal IR: %s", source => {
    expect(() => parseTemporalExpression(source)).toThrow();
  });
});
