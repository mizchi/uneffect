import ts from "typescript";
import { describe, expect, it } from "vitest";
import { evaluateResourceProtocolCfg, type ResourceProtocolModel } from "../src/resource-protocol.js";
import { lowerResourceProtocolCfgInFunction, type ResourceTransitionSite } from "../src/resource-protocol-typescript.js";

function fixture(text: string): { source: ts.SourceFile; fn: ts.FunctionDeclaration; sites: ResourceTransitionSite[] } {
  const source = ts.createSourceFile("/entry.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const fn = source.statements.find(ts.isFunctionDeclaration)!;
  const sites: ResourceTransitionSite[] = [];
  const visit = (node: ts.Node): void => {
    if (node !== fn && ts.isFunctionLike(node)) return;
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

  it("keeps a conditional loop consumption unknown without claiming an iteration", () => {
    const { source, fn, sites } = fixture(`
      function main(flag: boolean) {
        while (flag) consume(body)
      }
    `);
    const lowered = lowerResourceProtocolCfgInFunction(source, fn, model, sites);
    expect(lowered.status).toBe("exact");
    if (lowered.status !== "exact") return;
    expect(evaluateResourceProtocolCfg(lowered.cfg)).toMatchObject({ status: "unknown" });
  });

  it("lowers loop exits before a trailing terminal transition", () => {
    const { source, fn, sites } = fixture(`
      function main(flag: boolean) {
        while (flag) { if (flag) continue; else break }
        consume(body)
      }
    `);
    const lowered = lowerResourceProtocolCfgInFunction(source, fn, model, sites);
    expect(lowered.status).toBe("exact");
    if (lowered.status !== "exact") return;
    expect(evaluateResourceProtocolCfg(lowered.cfg)).toMatchObject({ status: "satisfied" });
  });

  it("preserves switch breaks and requires every selected clause", () => {
    const { source, fn, sites } = fixture(`
      function main(kind: "a" | "b") {
        switch (kind) {
          case "a": consume(body); break
          case "b": consume(body); break
          default: consume(body)
        }
      }
    `);
    const lowered = lowerResourceProtocolCfgInFunction(source, fn, model, sites);
    expect(lowered.status).toBe("exact");
    if (lowered.status !== "exact") return;
    expect(evaluateResourceProtocolCfg(lowered.cfg)).toMatchObject({ status: "satisfied" });
  });

  it("routes labeled break without executing the skipped suffix", () => {
    const { source, fn, sites } = fixture(`
      function main() {
        selected: {
          consume(body)
          break selected
          consume(body)
        }
      }
    `);
    const lowered = lowerResourceProtocolCfgInFunction(source, fn, model, sites);
    expect(lowered.status).toBe("exact");
    if (lowered.status !== "exact") return;
    expect(evaluateResourceProtocolCfg(lowered.cfg)).toMatchObject({ status: "satisfied" });
  });

  it("keeps nested declarations outside the enclosing resource owner", () => {
    const { source, fn, sites } = fixture(`
      function main() {
        function later() { consume(body) }
        consume(body)
      }
    `);
    const lowered = lowerResourceProtocolCfgInFunction(source, fn, model, sites);
    expect(lowered.status).toBe("exact");
    if (lowered.status !== "exact") return;
    expect(evaluateResourceProtocolCfg(lowered.cfg)).toMatchObject({ status: "satisfied" });
  });

  it("routes normal and explicit throw paths through mandatory finally", () => {
    const { source, fn, sites } = fixture(`
      function main(fail: boolean) {
        try {
          if (fail) throw new Error("stop")
        } catch (error) {
          console.log(error)
        } finally {
          consume(body)
        }
      }
    `);
    const lowered = lowerResourceProtocolCfgInFunction(source, fn, model, sites);
    expect(lowered.status).toBe("exact");
    if (lowered.status !== "exact") return;
    expect(evaluateResourceProtocolCfg(lowered.cfg)).toMatchObject({ status: "satisfied" });
  });

  it("routes return completion through mandatory finally", () => {
    const { source, fn, sites } = fixture(`
      function main(done: boolean) {
        try {
          if (done) return
        } finally {
          consume(body)
        }
      }
    `);
    const lowered = lowerResourceProtocolCfgInFunction(source, fn, model, sites);
    expect(lowered.status).toBe("exact");
    if (lowered.status !== "exact") return;
    expect(evaluateResourceProtocolCfg(lowered.cfg)).toMatchObject({ status: "satisfied" });
  });

  it("routes loop break through mandatory finally", () => {
    const { source, fn, sites } = fixture(`
      function main() {
        while (true) {
          try { break }
          finally { consume(body) }
        }
      }
    `);
    const lowered = lowerResourceProtocolCfgInFunction(source, fn, model, sites);
    expect(lowered.status).toBe("exact");
    if (lowered.status !== "exact") return;
    expect(evaluateResourceProtocolCfg(lowered.cfg)).toMatchObject({ status: "satisfied" });
  });
});
