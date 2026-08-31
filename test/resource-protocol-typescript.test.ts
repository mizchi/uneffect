import ts from "typescript";
import { describe, expect, it } from "vitest";
import { evaluateResourceProtocolCfg, type ResourceProtocolModel } from "../src/resource-protocol.js";
import { lowerResourceProtocolCfgInFunction, type ResourceTransitionSite } from "../src/resource-protocol-typescript.js";

function fixture(text: string): { source: ts.SourceFile; fn: ts.FunctionDeclaration; sites: ResourceTransitionSite[] } {
  const source = ts.createSourceFile("/entry.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const fn = source.statements.find(ts.isFunctionDeclaration)!;
  const sites: ResourceTransitionSite[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "consume") {
      sites.push({ node, transitions: [{ kind: "consume", resource: "body", at: node.getStart(source) }] });
    }
    ts.forEachChild(node, visit);
  };
  visit(fn);
  return { source, fn, sites };
}

const model: ResourceProtocolModel = {
  schema: "uneffect-resource-protocol/v1",
  resources: [{ id: "body", label: "body", kind: "Body", initialState: "available", requiredTerminalStates: ["consumed"] }],
  transitions: [],
};

describe("TypeScript resource protocol CFG lowering", () => {
  it("proves the same terminal transition in both if branches", () => {
    const { source, fn, sites } = fixture(`
      function main(flag: boolean) {
        if (flag) consume(body)
        else consume(body)
      }
    `);
    const lowered = lowerResourceProtocolCfgInFunction(source, fn, model, sites);
    expect(lowered.status).toBe("exact");
    if (lowered.status !== "exact") return;
    expect(evaluateResourceProtocolCfg(lowered.cfg)).toMatchObject({ status: "satisfied", states: new Map([["body", "consumed"]]) });
  });

  it("joins one missing branch transition to unknown", () => {
    const { source, fn, sites } = fixture(`
      function main(flag: boolean) {
        if (flag) consume(body)
      }
    `);
    const lowered = lowerResourceProtocolCfgInFunction(source, fn, model, sites);
    expect(lowered.status).toBe("exact");
    if (lowered.status !== "exact") return;
    expect(evaluateResourceProtocolCfg(lowered.cfg)).toMatchObject({ status: "unknown", states: new Map([["body", "unknown"]]) });
  });

  it("keeps unsupported loops explicit instead of flattening them", () => {
    const { source, fn, sites } = fixture(`
      function main(flag: boolean) {
        while (flag) consume(body)
      }
    `);
    expect(lowerResourceProtocolCfgInFunction(source, fn, model, sites)).toMatchObject({
      status: "unknown",
      reason: "unsupported-control-flow",
    });
  });
});
