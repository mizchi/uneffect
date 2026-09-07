import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import ts from "@typescript/typescript6";
import { describe, expect, it } from "vitest";
import { statementExit, functionMayFallThrough } from "../src/contracts/contract-control-flow.js";
import { oxcStatementExit, oxcFunctionMayFallThrough, analyzeOxcContractControlFlow, type OxcContractControlFlowOptions } from "../src/frontends/oxc/contract-control-flow.js";
import { parseOxcSource, topLevelOxcFunctions } from "../src/frontends/oxc/source.js";

const fixtures = JSON.parse(readFileSync("test/fixtures/oxc-control-flow-parity.json", "utf8")) as Array<{ body: string; exits: string[]; mayFallThrough: boolean }>;
const options: OxcContractControlFlowOptions = {
  isNeverCall: call => call.callee.type === "Identifier" && call.callee.name === "stop",
  constantBoolean: expression => expression.type === "Identifier"
    ? expression.name === "enabled" ? true : expression.name === "disabled" ? false : undefined : undefined,
};
describe("shared contract completion rules", () => {
  it.each(fixtures)("preserves both frontends' frozen completions: $body", fixture => {
    const text = `async function checked() { ${fixture.body} }`;
    const block = topLevelOxcFunctions(parseOxcSource("flow.ts", text))[0]!.node.body;
    expect([...oxcStatementExit(block, options)].sort()).toEqual(fixture.exits);
    expect(oxcFunctionMayFallThrough(block, options)).toBe(fixture.mayFallThrough);
    const source = ts.createSourceFile("flow.ts", text, ts.ScriptTarget.Latest, true);
    const legacyBlock = (source.statements[0] as ts.FunctionDeclaration).body!;
    const legacyOptions = {
      isNeverCall: (call: ts.CallExpression) => ts.isIdentifier(call.expression) && call.expression.text === "stop",
      constantBoolean: (expression: ts.Expression) => ts.isIdentifier(expression)
        ? expression.text === "enabled" ? true : expression.text === "disabled" ? false : undefined : undefined,
    };
    expect([...statementExit(legacyBlock, legacyOptions)].sort()).toEqual(fixture.exits);
    expect(functionMayFallThrough(legacyBlock, legacyOptions)).toBe(fixture.mayFallThrough);
  });
  it.each(["stop?.();", "maybe?.method();", "maybe?.method!();", "maybe?.method().next();",
    "disabled &&= stop();", "enabled ||= stop();", "maybe ??= stop();"])("keeps conditionally skipped never calls reachable: %s", body => {
    const text = `function checked() { ${body} }`;
    const oxcBody = topLevelOxcFunctions(parseOxcSource("flow.ts", text))[0]!.node.body;
    expect(oxcFunctionMayFallThrough(oxcBody, { ...options, isNeverCall: () => true })).toBe(true);
    const source = ts.createSourceFile("flow.ts", text, ts.ScriptTarget.Latest, true);
    const legacyBody = (source.statements[0] as ts.FunctionDeclaration).body!;
    expect(functionMayFallThrough(legacyBody, {
      isNeverCall: () => true,
      constantBoolean: node => ts.isIdentifier(node) ? node.text === "enabled" ? true : node.text === "disabled" ? false : undefined : undefined,
    })).toBe(true);
  });
  it.each(["(maybe?.method)(stop());", "(maybe?.method)[stop()];", "stop()?.method();", "enabled &&= stop();", "disabled ||= stop();"])("retains eager evaluation around conditional calls: %s", body => {
    const block = topLevelOxcFunctions(parseOxcSource("flow.ts", `function checked() { ${body} }`))[0]!.node.body;
    expect(oxcFunctionMayFallThrough(block, options)).toBe(false);
  });
  it("preserves original Program node identity for semantic callbacks", () => {
    const source = ts.createSourceFile("flow.ts", "function f() { if (flag) stop(); }", ts.ScriptTarget.Latest, true);
    const body = (source.statements[0] as ts.FunctionDeclaration).body!;
    const conditional = body.statements[0] as ts.IfStatement;
    const call = (conditional.thenStatement as ts.ExpressionStatement).expression;
    expect(functionMayFallThrough(body, {
      constantBoolean: node => node === conditional.expression ? true : undefined,
      isNeverCall: node => node === call,
    })).toBe(false);
  });
  it("reports structural source summaries with export spans and no inferred never calls", () => {
    const text = '// 😀\r\nexport function a() { return 1; }\nfunction b() { stop(); }\nfunction c() { while (true) {} }';
    const result = analyzeOxcContractControlFlow("flow.ts", text);
    expect(result.map(item => [item.name, item.exits, item.mayFallThrough])).toEqual([
      ["a", ["return"], false], ["b", ["normal"], true], ["c", [], false],
    ]);
    expect(text.slice(result[0]!.span.start, result[0]!.span.end)).toBe("export function a() { return 1; }");
    expect(result.every(item => item.evidence === "structural")).toBe(true);
  });
  it("rejects parser recovery", () => {
    expect(() => analyzeOxcContractControlFlow("bad.ts", "function bad() { return +; }")).toThrow(/invalid TypeScript syntax/);
  });
  it("runs the public source analysis with JavaScript compiler loading forbidden", () => {
    const script = `import { registerHooks } from 'node:module'; import assert from 'node:assert/strict';
      registerHooks({ resolve(specifier, context, next) {
        if (/^(?:typescript(?:\\/|$)|@typescript\\/typescript6(?:\\/|$))/.test(specifier)) throw new Error('compiler forbidden: ' + specifier);
        return next(specifier, context);
      } });
      const { analyzeOxcContractControlFlow } = await import('./src/spec/analysis-api.ts');
      assert.equal(analyzeOxcContractControlFlow('flow.ts', 'function f() { try { return 1; } finally {} }')[0].mayFallThrough, false);`;
    execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { stdio: "pipe", timeout: 30_000 });
  });
});
