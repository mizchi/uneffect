import ts from "typescript";
import { describe, expect, it } from "vitest";
import { findDirectHandlerJoinCandidates, runDirectHandlerJoinFixedPoint } from "../src/refinement-handler-flow.js";

function bodyOf(source: string): ts.Block {
  const file = ts.createSourceFile("handler.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declaration = file.statements.find(ts.isFunctionDeclaration);
  if (!declaration?.body) throw new Error("fixture has no function body");
  return declaration.body;
}

describe("refinement handler flow", () => {
  it("joins direct switch completions through catch and mandatory finally", () => {
    const [candidate] = findDirectHandlerJoinCandidates(bodyOf(`
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
    expect(candidate?.incoming).toEqual(["normal", "return", "throw"]);
    const result = runDirectHandlerJoinFixedPoint(candidate!, 16);
    expect(result).toMatchObject({
      converged: true,
      iterations: 6,
      outgoing: ["normal", "return"],
      blockCompletions: {
        catch: ["throw"],
        "handler-join": ["normal", "return"],
        finally: ["normal", "return"],
        exit: ["normal", "return"],
      },
    });
    expect(runDirectHandlerJoinFixedPoint(candidate!, 1)).toMatchObject({
      converged: false,
      iterations: 1,
      outgoing: [],
    });
  });

  it("does not classify nested or non-normal finally control as the direct seed", () => {
    for (const source of [
      `function route(kind: number) { try { switch (kind) { default: if (kind) return } } catch {} finally {} }`,
      `function route(kind: number) { try { switch (kind) { default: break } } catch {} finally { return } }`,
      `function route(kind: number) { try { switch (kind) { case 0: break } } catch {} finally {} }`,
    ]) expect(findDirectHandlerJoinCandidates(bodyOf(source))).toEqual([]);
  });
});
