import { describe, expect, it } from "vitest";
import { joinFlowValues } from "../src/refinement-flow.js";

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
});
