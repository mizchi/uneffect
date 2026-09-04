import ts from "@typescript/typescript6";
import { describe, expect, it } from "vitest";
import { functionMayFallThrough, type ContractControlFlowOptions } from "../src/contract-control-flow.js";

function functionBody(statement: string): ts.Block {
  const source = ts.createSourceFile(
    "flow.ts",
    `function checked(): number { ${statement} }`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const declaration = source.statements[0];
  if (!declaration || !ts.isFunctionDeclaration(declaration) || !declaration.body) throw new Error("expected function body");
  return declaration.body;
}

const neverCalls: ContractControlFlowOptions = {
  isNeverCall: (call) => ts.isIdentifier(call.expression) && call.expression.text === "stop",
};

const booleanConstants: ContractControlFlowOptions = {
  constantBoolean: (expression) => ts.isIdentifier(expression)
    ? expression.text === "enabled" ? true : expression.text === "disabled" ? false : undefined
    : undefined,
};

describe("contract control-flow semantic reachability", () => {
  it("recognizes never calls in eagerly evaluated expression positions", () => {
    expect(functionMayFallThrough(functionBody("const value = stop();"), neverCalls)).toBe(false);
    expect(functionMayFallThrough(functionBody("void (stop() as never);"), neverCalls)).toBe(false);
    expect(functionMayFallThrough(functionBody("1 + stop();"), neverCalls)).toBe(false);
    expect(functionMayFallThrough(functionBody("!stop();"), neverCalls)).toBe(false);
    expect(functionMayFallThrough(functionBody("if (stop()) return 1;"), neverCalls)).toBe(false);
  });

  it("does not inspect a conditionally evaluated short-circuit operand", () => {
    expect(functionMayFallThrough(functionBody("false && stop();"), neverCalls)).toBe(true);
    expect(functionMayFallThrough(functionBody("maybe?.(stop());"), neverCalls)).toBe(true);
    expect(functionMayFallThrough(functionBody("maybe?.[stop()];"), neverCalls)).toBe(true);
  });

  it("composes literal-type booleans through syntax-level conditions", () => {
    expect(functionMayFallThrough(functionBody("if (true) return 1;"))).toBe(false);
    expect(functionMayFallThrough(functionBody("if (enabled === true) return 1;"), booleanConstants)).toBe(false);
    expect(functionMayFallThrough(functionBody("while (enabled === true) {}"), booleanConstants)).toBe(false);
    expect(functionMayFallThrough(functionBody("if (widened === true) return 1;"), booleanConstants)).toBe(true);
  });

  it("distinguishes do-while body exits from condition exits", () => {
    expect(functionMayFallThrough(functionBody("do { return 1; } while (false);"))).toBe(false);
    expect(functionMayFallThrough(functionBody("do { continue; } while (false);"))).toBe(true);
  });
});
