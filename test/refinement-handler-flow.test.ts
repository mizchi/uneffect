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

  it("preserves prefix, suffix, and abrupt unreachable flow around one control root", () => {
    const [candidate] = findHandlerJoinCandidates(bodyOf(`
      function route(kind: number, armed: boolean) {
        try {
          kind += 1
          if (armed) return kind
          kind += 2
          throw kind
        } catch { kind += 4 } finally { kind += 8 }
        kind += 16
      }
    `));
    const result = runHandlerJoinFixedPoint(candidate!, 32);
    expect(candidate).toMatchObject({ controlShape: "if", lowering: "supported" });
    expect(result).toMatchObject({
      converged: true,
      incoming: ["return", "throw"],
      outgoing: ["normal", "return"],
    });
    const returnBlock = Object.entries(result.blockCompletions)
      .find(([id]) => id.startsWith("return:"));
    const throwBlock = Object.entries(result.blockCompletions)
      .find(([id]) => id.startsWith("throw:"));
    expect(returnBlock?.[1]).toEqual(["normal"]);
    expect(throwBlock?.[1]).toEqual(["normal"]);
  });

  it("lowers return and throw overrides from an abrupt finally", () => {
    const [candidate] = findHandlerJoinCandidates(bodyOf(`
      function finalize(kind: number, stop: boolean, fail: boolean) {
        try { kind += 1 } finally {
          if (stop) return kind
          if (fail) throw kind
          kind += 2
        }
        kind += 4
      }
    `));
    expect(candidate).toMatchObject({
      controlRegion: "finally",
      mandatoryFinally: true,
      finallyOverrides: ["return", "throw"],
      lowering: "supported",
    });
    expect(runHandlerJoinFixedPoint(candidate!, 32)).toMatchObject({
      converged: true,
      incoming: ["normal"],
      outgoing: ["normal", "return", "throw"],
      blockCompletions: expect.objectContaining({
        finally: ["normal"],
        exit: ["normal", "return", "throw"],
      }),
    });
  });

  it("lowers exactly two sibling if roots under an explicit bound", () => {
    const [candidate] = findHandlerJoinCandidates(bodyOf(`
      function route(kind: number, armed: boolean) {
        try {
          if (armed) throw kind
          kind += 1
          if (kind < 0) throw kind
          kind += 2
        } catch { kind += 4 }
      }
    `));
    expect(candidate).toMatchObject({
      lowering: "supported",
      controlRegion: "try",
      controlStatements: [{}, {}],
    });
    expect(runHandlerJoinFixedPoint(candidate!, 32)).toMatchObject({
      converged: true,
      incoming: ["normal", "throw"],
      outgoing: ["normal"],
      blockCompletions: expect.objectContaining({
        catch: ["throw"],
        exit: ["normal"],
      }),
    });
  });

  it("unrolls a one-to-four element literal for-of with iteration-keyed blocks", () => {
    const [candidate] = findHandlerJoinCandidates(bodyOf(`
      function scan(total: number, reject: boolean) {
        try {
          for (const units of [1, 2] as const) {
            if (reject) throw units
            total += units
          }
        } catch { total += 1 }
      }
    `));
    expect(candidate).toMatchObject({
      lowering: "supported",
      controlShape: "for-of",
      finiteLoop: { kind: "for-of", iterations: 2 },
    });
    const result = runHandlerJoinFixedPoint(candidate!, 32);
    expect(result).toMatchObject({
      converged: true,
      incoming: ["normal", "throw"],
      outgoing: ["normal"],
    });
    expect(Object.keys(result.blockCompletions).filter((id) => id.startsWith("if:") && id.includes("@for-of:")))
      .toHaveLength(2);
  });

  it("lowers one nested try/catch under an explicit nesting budget", () => {
    const [candidate] = findHandlerJoinCandidates(bodyOf(`
      function recover(total: number, armed: boolean, invalid: boolean) {
        try {
          try {
            if (armed) throw 1
            total += 1
          } catch {
            total += 2
            if (invalid) throw 2
          }
          total += 4
        } catch { total += 8 }
      }
    `));
    expect(candidate).toMatchObject({
      lowering: "supported",
      controlShape: "try",
      handlerNesting: 2,
    });
    expect(runHandlerJoinFixedPoint(candidate!, 64)).toMatchObject({
      converged: true,
      incoming: ["normal", "throw"],
      outgoing: ["normal"],
      blockCompletions: expect.objectContaining({
        "nested-catch": ["throw"],
        "try-completion": ["normal", "throw"],
        exit: ["normal"],
      }),
    });
  });

  it("retains attempted-family lowering failures as unsupported", () => {
    for (const source of [
      `function route(kind: number) { try { switch (kind) { case 0: break } } catch {} finally {} }`,
      `function route(kind: number) { try { if (kind) while (kind) kind -= 1 } catch {} }`,
      `function route(a: boolean, b: boolean, c: boolean) { try { if (a) throw a; if (b) return; if (c) throw c } catch {} }`,
      `function route(kind: number, armed: boolean) { try { if (armed) throw kind; switch (kind) { default: break } } catch {} }`,
      `function route(kind: number, values: number[]) { try { for (const value of values) { if (value) throw value } } catch {} }`,
      `function route(kind: number) { try { for (const value of [1, 2, 3, 4, 5] as const) { if (value) throw value } } catch {} }`,
      `function route(kind: number) { try { for (const value of [1, 2] as const) { if (value) break } } catch {} }`,
      `function route(kind: number) { try { for (const value of [1, 2] as const) { using resource = acquire(); if (value) throw value } } catch {} }`,
      `function route(kind: number) { try { if (kind) throw kind } catch { for (const value of [1, 2] as const) kind += value } }`,
      `function route(kind: number) { try { kind += 1 } finally { for (const value of [1, 2] as const) { if (value) throw value } } }`,
      `function route(kind: number) { try { if (kind) { for (const value of [1, 2] as const) kind += value } } catch {} }`,
      `function route(kind: number) { try { if (kind) return } finally { while (kind) kind -= 1 } }`,
      `function route(kind: number) { try { try { try { if (kind) throw kind } catch {} } catch {} } catch {} }`,
      `function route(kind: number) { try { try { if (kind) throw kind } catch {} finally {} } catch {} }`,
      `function route(kind: number) { try { try { if (kind) return } catch {} } catch {} }`,
      `function route(kind: number) { try { try { while (kind) kind -= 1 } catch {} } catch {} }`,
      `function route(kind: number) { try { try { using resource = acquire(); if (kind) throw kind } catch {} } catch {} }`,
      `function route(kind: number) { try { if (kind) throw kind } catch { try { throw kind } catch {} } }`,
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
    const [overBudget] = findHandlerJoinCandidates(bodyOf(
      `function route(kind: number) { try { for (const value of [1, 2, 3, 4, 5] as const) { if (value) throw value } } catch {} }`,
    ));
    expect(overBudget?.finiteLoop).toEqual({ kind: "for-of", iterations: 5 });
  });

  it("does not claim roots outside the selected handler family", () => {
    for (const source of [
      `function route(kind: number) { try { while (kind) kind -= 1 } catch {} }`,
      `function route(kind: number) { try { label: if (kind) break label } catch {} }`,
    ]) expect(findHandlerJoinCandidates(bodyOf(source))).toEqual([]);
  });
});
