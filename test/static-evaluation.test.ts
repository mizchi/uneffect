import { describe, expect, it } from "vitest";
import ts from "@typescript/typescript6";
import { evaluateStaticBoolean, evaluateStaticPrimitive } from "../src/static-evaluation.js";

function expression(text: string): ts.Expression {
  const source = ts.createSourceFile("static.ts", `const result = ${text}`, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const statement = source.statements[0] as ts.VariableStatement;
  return statement.declarationList.declarations[0]!.initializer!;
}

describe("finite static evaluation", () => {
  it("preserves boolean-only short-circuit and strict primitive equality", () => {
    const values = new Map<string, string | number | boolean>([["mode", "proxy"], ["enabled", true]]);
    const options = { resolveIdentifier(identifier: ts.Identifier) {
      const value = values.get(identifier.text);
      return value === undefined ? undefined : { key: identifier.text, value };
    } };
    expect(evaluateStaticBoolean(expression('mode === "proxy" && enabled'), options)).toBe(true);
    expect(evaluateStaticBoolean(expression("true || unknown"), options)).toBe(true);
    expect(evaluateStaticPrimitive(expression('200 !== "200"'), options)).toBe(true);
    expect(evaluateStaticPrimitive(expression('200 == "200"'), options)).toBeUndefined();
  });

  it("terminates identifier-expression cycles as unknown", () => {
    const aliases = new Map<string, ts.Expression>([["left", expression("right")], ["right", expression("left")]]);
    expect(evaluateStaticPrimitive(expression("left"), { resolveIdentifier(identifier) {
      return { key: identifier.text, expression: aliases.get(identifier.text) };
    } })).toBeUndefined();
  });
});
