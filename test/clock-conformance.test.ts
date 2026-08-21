import { describe, expect, it } from "vitest";
import {
  checkClockConformance,
  createBrowserClockObserver,
  createDenoClockObserver,
  createNodeClockObserver,
} from "../src/clock-conformance.js";

describe("physical-clock host conformance", () => {
  it("accepts variable rates and a bounded backward wall-clock jump", () => {
    const result = checkClockConformance([
      { monotonic: 0, wall: 0 },
      { monotonic: 1, wall: 2 },
      { monotonic: 3, wall: 1 },
    ], {
      monotonicRate: { minimum: 1, maximum: 2 },
      wallRate: { minimum: 1, maximum: 3 },
      wallBackwardJump: { minimum: 1, maximum: 2 },
      maximumSkew: 2,
    });
    expect(result).toEqual({ status: "conformant", diagnostics: [] });
  });

  it("reports monotonic rollback, excessive wall jumps, and skew", () => {
    const result = checkClockConformance([
      { monotonic: 0, wall: 0 },
      { monotonic: 2, wall: 2 },
      { monotonic: 1, wall: -2 },
    ], {
      monotonicRate: { minimum: 1, maximum: 2 },
      wallRate: { minimum: 1, maximum: 2 },
      wallBackwardJump: { minimum: 1, maximum: 2 },
      maximumSkew: 1,
    });
    expect(result.status).toBe("nonconformant");
    expect(result.diagnostics.map((item) => item.kind)).toEqual(expect.arrayContaining([
      "monotonic-rate", "wall-backward-jump", "clock-skew",
    ]));
  });

  it("normalizes injectable Node, browser, and Deno host clocks to a common origin", () => {
    for (const create of [createNodeClockObserver, createBrowserClockObserver, createDenoClockObserver]) {
      let monotonic = 100.9, wall = 1_000.9;
      const observe = create({ monotonicNow: () => monotonic, wallNow: () => wall });
      expect(observe()).toEqual({ monotonic: 0, wall: 0 });
      monotonic += 2.2;
      wall += 3.2;
      expect(observe()).toEqual({ monotonic: 2, wall: 3 });
    }
  });
});
