import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { instrumentRuntimeAssertions } from "../src/optimizer/instrument.js";

const baseline = JSON.parse(readFileSync(new URL("./fixtures/oxc-instrument-parity.json", import.meta.url), "utf8")) as {
  cases: Array<{ name: string; source: string; result: ReturnType<typeof instrumentRuntimeAssertions> }>;
};
const annotated = (schema: string, parameters = "value: unknown") => `/* uneffect:assert value: ${schema} */\nexport function check(${parameters}) { return value }`;

describe("Oxc runtime assertion migration", () => {
  it.each(baseline.cases)("preserves legacy $name output", ({ source, result }) => {
    expect(instrumentRuntimeAssertions("input.ts", source)).toEqual(result);
  });
  it.each([
    'v.number()); globalThis.sideEffect(); const escaped = (v.string()',
    'v.number?.()', 'v?.number()', 'v["number"]()',
    'v.constructor.constructor("return globalThis")()',
    'v.object({ __proto__: v.string() })',
    'v.object({ ["name"]: v.string() })',
    'v.pipe(v.number(), ...actions)',
    'v.pipe(v.number(), () => 1)',
    'new v.Schema()', 'v.literal(1n)', 'v.literal(/x/)',
  ])("rejects unsupported schema %s", schema => {
    const source = annotated(schema);
    const result = instrumentRuntimeAssertions("input.ts", source);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ kind: "invalid-schema" }));
    expect(result.code).toBe(source);
  });
  it("does not rename namespace text inside literals", () => {
    const result = instrumentRuntimeAssertions("input.ts", annotated('v.literal("v.number")'));
    expect(result.code).toContain('__uneffect_v.literal("v.number")');
  });
  it.each([
    ["Int", 3, 1.5], ["Nat", 0, -1], ["Float", 1.5, Infinity],
    ['v.literal("v.number")', "v.number", "__uneffect_v.number"],
    ['v.object({ name: v.string() })', { name: "ok" }, { name: 1 }],
  ])("executes the generated %s check", (schema, accepted, rejected) => {
    const result = instrumentRuntimeAssertions("input.ts", annotated(schema as string));
    expect(result.diagnostics).toEqual([]);
    const code = stripTypeScriptTypes(result.code.replace('import * as __uneffect_v from "valibot";\n', "").replace("export function", "function"));
    const check = new Function("__uneffect_v", code + "\nreturn check;")(v) as (value: unknown) => unknown;
    expect(check(accepted)).toEqual(accepted);
    expect(() => check(rejected)).toThrow();
  });
  it("avoids capturing names in the original source", () => {
    const result = instrumentRuntimeAssertions("input.ts", annotated("Int", "value: unknown, __uneffect_v: unknown, __uneffect_v_1: unknown"));
    expect(result.code).toContain('import * as __uneffect_v_2 from "valibot"');
    expect(result.code).toContain('__uneffect_v_2.parse(__uneffect_v_2.pipe(');
  });
  it("keeps hashbangs and directive prologues before generated statements", () => {
    const source = '#!/usr/bin/env node\n"use strict";\n' + annotated("Int").replace("{ return", '{ "use strict"; return');
    const result = instrumentRuntimeAssertions("input.ts", source);
    expect(result.code).toMatch(/^#!\/usr\/bin\/env node\n"use strict";\nimport /);
    expect(result.code).toContain('{ "use strict";\n__uneffect_v.parse(');
  });
  it("rejects parser recovery before transforming source", () => {
    expect(() => instrumentRuntimeAssertions("input.ts", annotated("Int") + "\nconst = ;")).toThrow(/syntax/);
  });
  it("runs the source API and default CLI without JavaScript TypeScript imports", () => {
    const script = `
      import { registerHooks } from 'node:module'; import assert from 'node:assert/strict';
      registerHooks({ resolve(specifier, context, next) {
        if (/^(?:typescript(?:\\/|$)|@typescript\\/typescript6(?:\\/|$))/.test(specifier)) throw new Error('JavaScript compiler forbidden: ' + specifier);
        return next(specifier, context);
      } });
      const { instrumentRuntimeAssertions } = await import('./src/optimizer/runtime-assertions.ts');
      assert.equal(instrumentRuntimeAssertions('input.ts', ${JSON.stringify(annotated("Int"))}).diagnostics.length, 0);
      const { runCli } = await import('./src/cli/cli-runner.ts');
      let output = '';
      assert.equal(await runCli(['instrument', 'examples/gradual.ts'], { out: s => output += s, err: s => { throw new Error(s); } }), 0);
      assert.ok(output.includes('__uneffect_v.parse'));
    `;
    execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { stdio: "pipe", timeout: 30_000 });
  });
});
