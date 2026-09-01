import ts from "typescript";
import { describe, expect, it } from "vitest";
import { interpretBuiltinCallSemantics, interpretBuiltinPropertySemantics } from "../src/builtin-semantic-interpreter.js";
import type { BuiltinSemantics } from "../src/builtin-semantic-schema.js";

function callOf(text: string): ts.CallExpression {
  const source = ts.createSourceFile("fixture.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const statement = source.statements[0];
  if (!statement || !ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) throw new Error("expected call fixture");
  return statement.expression;
}

function propertyOf(text: string): ts.PropertyAccessExpression {
  const source = ts.createSourceFile("fixture.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const statement = source.statements[0];
  if (!statement || !ts.isExpressionStatement(statement) || !ts.isPropertyAccessExpression(statement.expression)) throw new Error("expected property fixture");
  return statement.expression;
}

describe("generic builtin semantic interpreter", () => {
  it("projects an omitted optional argument without producing unknown evidence", () => {
    const call = callOf("target()");
    const events = interpretBuiltinCallSemantics({ schema: "uneffect-semantic-primitives/v1", primitives: [{
      kind: "protocol", name: "optional", transition: "call", inputs: { value: { kind: "argument", index: 0, optional: true } },
    }] }, call, { symbol: { module: "test", export: "target" }, span: { start: 0, end: 8 } });
    expect(events).toEqual([expect.objectContaining({
      kind: "protocol", inputs: { value: { status: "absent", path: [] } },
    })]);
  });
  it("projects effects and receiver mutation with shared source attribution", () => {
    const call = callOf("values.push(1)");
    const semantics: BuiltinSemantics = { schema: "uneffect-semantic-primitives/v1", primitives: [
      { kind: "effect", capability: "Audit", scope: { kind: "literal", value: "writes" } },
      { kind: "mutate", target: { kind: "receiver" } },
    ] };
    const events = interpretBuiltinCallSemantics(semantics, call, {
      symbol: { module: "lib.es", export: "Array#push" }, span: { start: call.getStart(), end: call.getEnd() },
    });
    if (!ts.isPropertyAccessExpression(call.expression)) throw new Error("expected property call");
    const receiver = call.expression.expression;
    expect(events).toMatchObject([
      { kind: "effect", capability: "Audit", scope: { status: "resolved", kind: "literal", value: "writes" }, source: { primitiveIndex: 0 } },
      { kind: "mutate", target: { status: "resolved", expression: receiver, path: [] }, source: { primitiveIndex: 1 } },
    ]);
    expect(events[0]!.source.symbol).toEqual({ module: "lib.es", export: "Array#push" });
  });

  it("keeps unsupported dynamic inputs as attributed unknown projections", () => {
    const call = callOf("run()"), semantics: BuiltinSemantics = {
      schema: "uneffect-semantic-primitives/v1",
      primitives: [{ kind: "mutate", target: { kind: "argument", index: 0 } }],
    };
    expect(interpretBuiltinCallSemantics(semantics, call, {
      symbol: { module: "test", export: "run" }, span: { start: 0, end: 5 },
    })).toMatchObject([{ kind: "unknown", reason: "missing argument 0", source: { primitiveIndex: 0 } }]);
  });

  it("selects property-direction primitives without an analyzer-specific branch", () => {
    const call = callOf("box.set()"), semantics: BuiltinSemantics = {
      schema: "uneffect-semantic-primitives/v1",
      primitives: [{ kind: "property", read: [{ kind: "effect", capability: "Read" }], write: [{ kind: "effect", capability: "Write" }] }],
    };
    const source = { symbol: { module: "test", export: "Box#value" }, span: { start: 0, end: 9 } };
    expect(interpretBuiltinCallSemantics(semantics, call, source, "read")).toMatchObject([{ kind: "effect", capability: "Read" }]);
    expect(interpretBuiltinCallSemantics(semantics, call, source, "write")).toMatchObject([{ kind: "effect", capability: "Write" }]);
  });

  it("interprets directional property semantics against the property receiver", () => {
    const access = propertyOf("node.textContent"), semantics: BuiltinSemantics = {
      schema: "uneffect-semantic-primitives/v1",
      primitives: [{ kind: "property", read: [
        { kind: "effect", capability: "Dom", scope: { kind: "region", member: "TextRead", target: { kind: "receiver" } } },
      ], write: [
        { kind: "mutate", target: { kind: "receiver" } },
        { kind: "invoke-user-code" },
      ] }],
    };
    const source = { symbol: { module: "lib.dom", export: "Node#textContent" }, span: { start: 0, end: access.end } };
    expect(interpretBuiltinPropertySemantics(semantics, access, source, "read")).toMatchObject([
      { kind: "effect", capability: "Dom", scope: { kind: "region", member: "TextRead", target: { status: "resolved", expression: access.expression } } },
    ]);
    expect(interpretBuiltinPropertySemantics(semantics, access, source, "write")).toMatchObject([
      { kind: "mutate", target: { status: "resolved", expression: access.expression } },
      { kind: "invoke-user-code" },
    ]);
  });
});
