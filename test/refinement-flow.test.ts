import { describe, expect, it } from "vitest";
import { joinFlowValues, solveBasicBlockFixedPoint } from "../src/refinement-flow.js";

describe("refinement flow joins", () => {
  it("joins only visible bindings and avoids redundant phi values", () => {
    const before = new Map([["weight", "1"], ["stable", "7"]]);
    const whenTrue = new Map([...before, ["weight", "2"], ["trueLocal", "9"]]);
    const whenFalse = new Map([...before, ["weight", "3"], ["falseLocal", "10"]]);

    const joined = joinFlowValues({
      keys: before.keys(),
      condition: "urgent",
      original: (key) => before.get(key)!,
      whenTrue: (key) => whenTrue.get(key),
      whenFalse: (key) => whenFalse.get(key),
      equivalent: (left, right) => left === right,
      phi: (condition, left, right) => `${condition} ? ${left} : ${right}`,
    });

    expect([...joined]).toEqual([
      ["weight", "urgent ? 2 : 3"],
      ["stable", "7"],
    ]);
  });

  it("converges completion snapshots and a typed throw payload through a loop back-edge", () => {
    interface Value {
      normal: ReadonlySet<string>;
      throws: ReadonlyMap<string, string>;
    }
    const value = (normal: readonly string[] = [], throws: readonly (readonly [string, string])[] = []): Value => ({
      normal: new Set(normal),
      throws: new Map(throws),
    });
    const key = (item: Value): string => JSON.stringify({
      normal: [...item.normal].sort(),
      throws: [...item.throws].sort(([left], [right]) => left.localeCompare(right)),
    });
    const result = solveBasicBlockFixedPoint({
      entry: "header",
      initial: value(["entry"]),
      budget: { name: "cfg-fixed-point-iterations", limit: 32 },
      lattice: {
        bottom: () => value(),
        equivalent: (left, right) => key(left) === key(right),
        join: (left, right) => {
          const throws = new Map(left.throws);
          for (const [payload, snapshot] of right.throws) {
            const existing = throws.get(payload);
            if (existing !== undefined && existing !== snapshot) {
              return { status: "conflict", reason: `throw payload ${payload} has incompatible snapshots` };
            }
            throws.set(payload, snapshot);
          }
          return { status: "joined", value: value([...left.normal, ...right.normal], [...throws]) };
        },
      },
      blocks: [
        { id: "header", edges: [{ to: "try", completion: "normal" }], transfer: (input) => [{ to: "try", value: input }] },
        { id: "try", edges: [
          { to: "join", completion: "normal", role: "branch" },
          { to: "catch", completion: "throw", role: "branch" },
        ], transfer: () => [
          { to: "join", value: value(["delivered"]) },
          { to: "catch", value: value([], [["pending", "throw-entry"]]) },
        ] },
        { id: "catch", edges: [{ to: "join", completion: "normal" }], transfer: (input) => [{
          to: "join",
          value: value([...input.throws].map(([, snapshot]) => `caught:${snapshot}`)),
        }] },
        { id: "join", edges: [
          { to: "header", completion: "normal", role: "back-edge" },
          { to: "exit", completion: "normal", role: "branch" },
        ], transfer: (input) => [
          { to: "header", value: input },
          { to: "exit", value: input },
        ] },
        { id: "exit", edges: [], transfer: () => [] },
      ],
    });

    expect(result).toMatchObject({ status: "converged", budget: { name: "cfg-fixed-point-iterations", limit: 32 } });
    if (result.status !== "converged") return;
    expect(result.states.get("catch")?.throws).toEqual(new Map([["pending", "throw-entry"]]));
    expect(result.states.get("exit")?.normal).toEqual(new Set(["delivered", "caught:throw-entry"]));
    expect(result.iterations).toBeLessThanOrEqual(32);
  });

  it("fails closed on fixed-point budget exhaustion and lattice conflicts", () => {
    const budgeted = solveBasicBlockFixedPoint({
      entry: "a",
      initial: 1,
      budget: { name: "cfg-fixed-point-iterations", limit: 1 },
      lattice: {
        bottom: () => 0,
        equivalent: (left, right) => left === right,
        join: (left, right) => ({ status: "joined", value: Math.max(left, right) }),
      },
      blocks: [
        { id: "a", edges: [{ to: "b", completion: "normal" }], transfer: (input) => [{ to: "b", value: input }] },
        { id: "b", edges: [], transfer: () => [] },
      ],
    });
    expect(budgeted).toMatchObject({ status: "unknown", reason: "proof-budget-exhausted", iterations: 1 });

    const conflict = solveBasicBlockFixedPoint({
      entry: "a",
      initial: "left",
      budget: { name: "cfg-fixed-point-iterations", limit: 4 },
      lattice: {
        bottom: () => "left",
        equivalent: (left, right) => left === right,
        join: (left, right) => left === right
          ? { status: "joined", value: right }
          : { status: "conflict", reason: `${left} != ${right}` },
      },
      blocks: [
        { id: "a", edges: [{ to: "b", completion: "normal" }], transfer: () => [{ to: "b", value: "right" }] },
        { id: "b", edges: [], transfer: () => [] },
      ],
    });
    expect(conflict).toMatchObject({ status: "unknown", reason: "lattice-conflict", detail: "left != right" });
  });

  it("validates the whole declared CFG before scheduling reachable blocks", () => {
    const lattice = {
      bottom: () => 0,
      equivalent: (left: number, right: number) => left === right,
      join: (left: number, right: number) => ({ status: "joined" as const, value: Math.max(left, right) }),
    };
    const dangling = solveBasicBlockFixedPoint({
      entry: "entry",
      initial: 1,
      budget: { name: "cfg-fixed-point-iterations", limit: 4 },
      lattice,
      blocks: [
        { id: "entry", edges: [], transfer: () => [] },
        {
          id: "dead",
          edges: [{ to: "missing", completion: "normal" }],
          transfer: (input) => [{ to: "missing", value: input }],
        },
      ],
    });
    expect(dangling).toMatchObject({
      status: "unknown",
      reason: "invalid-cfg",
      detail: "basic block dead declares missing successor missing",
      iterations: 0,
    });

    const undeclared = solveBasicBlockFixedPoint({
      entry: "entry",
      initial: 1,
      budget: { name: "cfg-fixed-point-iterations", limit: 4 },
      lattice,
      blocks: [
        { id: "entry", edges: [], transfer: (input) => [{ to: "exit", value: input }] },
        { id: "exit", edges: [], transfer: () => [] },
      ],
    });
    expect(undeclared).toMatchObject({
      status: "unknown",
      reason: "invalid-cfg",
      detail: "basic block entry transfers through undeclared successor exit",
      iterations: 1,
    });
  });

  it("rejects ambiguous topology metadata before evaluating transfers", () => {
    const options = {
      entry: "entry",
      initial: 1,
      budget: { name: "cfg-fixed-point-iterations", limit: 4 },
      lattice: {
        bottom: () => 0,
        equivalent: (left: number, right: number) => left === right,
        join: (left: number, right: number) => ({ status: "joined" as const, value: Math.max(left, right) }),
      },
    };
    const duplicateEdge = solveBasicBlockFixedPoint({ ...options, blocks: [
      {
        id: "entry",
        edges: [
          { to: "exit", completion: "normal" },
          { to: "exit", completion: "normal" },
        ],
        transfer: () => [],
      },
      { id: "exit", edges: [], transfer: () => [] },
    ] });
    expect(duplicateEdge).toMatchObject({
      status: "unknown",
      reason: "invalid-cfg",
      detail: "basic block entry declares duplicate successor exit",
      iterations: 0,
    });

    const distinctCompletions = solveBasicBlockFixedPoint({ ...options, blocks: [
      {
        id: "entry",
        edges: [
          { to: "exit", completion: "normal" },
          { to: "exit", completion: "throw" },
        ],
        transfer: (input) => [{ to: "exit", value: input }],
      },
      { id: "exit", edges: [], transfer: () => [] },
    ] });
    expect(distinctCompletions).toMatchObject({ status: "converged" });

    const invalidSpan = solveBasicBlockFixedPoint({ ...options, blocks: [
      {
        id: "entry",
        edges: [{ to: "exit", completion: "normal", sourceSpan: { start: 8, end: 3 } }],
        transfer: () => [],
      },
      { id: "exit", edges: [], transfer: () => [] },
    ] });
    expect(invalidSpan).toMatchObject({
      status: "unknown",
      reason: "invalid-cfg",
      detail: "basic block entry declares invalid source span for successor exit",
      iterations: 0,
    });

    const duplicateBlock = solveBasicBlockFixedPoint({ ...options, blocks: [
      { id: "entry", edges: [], transfer: () => [] },
      { id: "entry", edges: [], transfer: () => [] },
    ] });
    expect(duplicateBlock).toMatchObject({
      status: "unknown",
      reason: "invalid-cfg",
      detail: "duplicate CFG basic block entry",
      iterations: 0,
    });
  });
});
