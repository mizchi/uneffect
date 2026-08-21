import { describe, expect, it } from "vitest";
import {
  generateQuintExpression,
  generateRuntimeAssertionExpression,
  generateRuntimeAssertionStatement,
  parseTemporalExpression,
  typeCheckTemporalExpression,
} from "../src/temporal-expressions.js";

describe("restricted TypeScript temporal expressions", () => {
  it("lowers one neutral AST to Quint and runtime JavaScript", () => {
    const expression = parseTemporalExpression("phase === 0 && !cancelled");
    expect(generateQuintExpression(expression)).toBe("phase == 0 and not(cancelled)");
    expect(generateRuntimeAssertionExpression(expression)).toBe("phase === 0 && !cancelled");
  });

  it("supports arithmetic and relational predicates", () => {
    const expression = parseTemporalExpression("epoch + 1 <= limit || ready");
    expect(generateQuintExpression(expression)).toBe("epoch + 1 <= limit or ready");
  });

  it("rejects calls, property access, and loose equality", () => {
    expect(() => parseTemporalExpression("check(value)")).toThrow(/unsupported temporal expression/);
    expect(() => parseTemporalExpression("state.value === 1")).toThrow(/unsupported temporal expression/);
    expect(() => parseTemporalExpression("phase == 0")).toThrow(/strict equality/);
  });

  it("can compile the same predicate into an optional runtime assertion", () => {
    const statement = generateRuntimeAssertionStatement(parseTemporalExpression("phase === 1"), "bad phase");
    const check = new Function("phase", statement);
    expect(() => check(1)).not.toThrow();
    expect(() => check(0)).toThrow("bad phase");
  });

  it("type-checks names and operators against an explicit symbol table", () => {
    const symbols = new Map([["phase", "int"], ["ready", "bool"]] as const);
    expect(typeCheckTemporalExpression(parseTemporalExpression("phase < 2 && ready"), symbols)).toBe("bool");
    expect(() => typeCheckTemporalExpression(parseTemporalExpression("phase && ready"), symbols)).toThrow(/requires boolean operands/);
    expect(() => typeCheckTemporalExpression(parseTemporalExpression("missing === 0"), symbols)).toThrow(/unknown temporal symbol `missing`/);
  });
});
