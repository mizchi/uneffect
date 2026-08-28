import ts from "typescript";
import { describe, expect, it } from "vitest";
import { findHandlerJoinCandidates, runHandlerJoinFixedPoint } from "../src/refinement-handler-flow.js";

function bodyOf(source: string): ts.Block {
  const file = ts.createSourceFile("handler.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declaration = file.statements.find(ts.isFunctionDeclaration);
  if (!declaration?.body) throw new Error("fixture has no function body");
  return declaration.body;
}

describe("refinement handler flow", () => {
  it("joins direct switch completions through catch and mandatory finally", () => {
    const [candidate] = findHandlerJoinCandidates(bodyOf(`
      function route(kind: number) {
        try {
          switch (kind) {
            case 0: return
            case 1: throw kind
            default: break
          }
        } catch { kind += 1 } finally { kind += 1 }
        kind += 1
      }
    `));
    const result = runHandlerJoinFixedPoint(candidate!, 32);
    expect(result).toMatchObject({
      converged: true,
      incoming: ["normal", "return", "throw"],
      outgoing: ["normal", "return"],
      blockCompletions: {
        catch: ["throw"],
        "handler-join": ["normal", "return"],
        finally: ["normal", "return"],
        exit: ["normal", "return"],
      },
    });
    expect(runHandlerJoinFixedPoint(candidate!, 1)).toMatchObject({
      converged: false,
      iterations: 1,
      outgoing: [],
    });
  });

  it("lowers nested conditionals into reusable basic blocks", () => {
    const [candidate] = findHandlerJoinCandidates(bodyOf(`
      function route(kind: number, armed: boolean) {
        try {
          if (armed) {
            if (kind > 0) throw kind
          }
        } catch { kind += 1 }
        kind += 1
      }
    `));
    expect(candidate).toMatchObject({ controlShape: "if" });
    const result = runHandlerJoinFixedPoint(candidate!, 32);
    expect(result).toMatchObject({
      converged: true,
      outgoing: ["normal"],
      blockCompletions: expect.objectContaining({
        catch: ["throw"],
        "handler-join": ["normal"],
        exit: ["normal"],
      }),
    });
    expect(Object.keys(result.blockCompletions).filter((id) => id.startsWith("if:"))).toHaveLength(2);
  });

  it("retains attempted-family lowering failures as unsupported", () => {
    for (const source of [
      `function route(kind: number) { try { switch (kind) { default: break } } catch {} finally { return } }`,
      `function route(kind: number) { try { switch (kind) { case 0: break } } catch {} finally {} }`,
      `function route(kind: number) { try { if (kind) while (kind) kind -= 1 } catch {} }`,
    ]) {
      const [candidate] = findHandlerJoinCandidates(bodyOf(source));
      expect(candidate?.lowering).toBe("unsupported");
      expect(runHandlerJoinFixedPoint(candidate!, 32)).toMatchObject({
        converged: false,
        iterations: 0,
        incoming: [],
        outgoing: [],
      });
    }
  });

  it("does not claim roots outside the selected handler family", () => {
    for (const source of [
      `function route(kind: number) { try { while (kind) kind -= 1 } catch {} }`,
      `function route(kind: number) { try { label: if (kind) break label } catch {} }`,
      `function route(kind: number) { try { try { throw kind } finally {} } catch {} }`,
    ]) expect(findHandlerJoinCandidates(bodyOf(source))).toEqual([]);
  });
});
