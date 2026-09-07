import { describe, expect, it } from "vitest";
import { initializationRule, lintPrerequisites } from "../src/lint/prerequisites.js";
import type { RuleCfg } from "../src/lint/contracts.js";
import { generatedRuleCfg, referenceMissingUses } from "../bench/cfg-lint/oracle.js";

const event = (operation: string, subject = "client", start = 0) => ({
  operation, subject, location: { fileName: "test.ts", start, end: start + 1 },
});
const graph = (blocks: RuleCfg["blocks"]): RuleCfg => ({ entry: "entry", blocks });

describe("CFG prerequisite rules", () => {
  it("matches exhaustive concrete-state exploration on 256 cyclic and branching graphs", () => {
    for (let seed = 1; seed <= 256; seed++) {
      const cfg = generatedRuleCfg(seed), expected = referenceMissingUses(cfg);
      const result = lintPrerequisites(cfg, initializationRule);
      if (result.status === "unknown") throw new Error(result.detail);
      expect(result.diagnostics.map(diagnostic => diagnostic.location.start).sort((a, b) => a - b), `seed ${seed}`)
        .toEqual(expected.missing);
    }
  });
  it("checks operations in order within a block and reports the use location", () => {
    const result = lintPrerequisites(graph([
      { id: "entry", successors: [], events: [event("initialize"), event("use"), event("reset"), event("use", "client", 30)] },
    ]), initializationRule);
    expect(result).toMatchObject({ status: "findings", diagnostics: [{
      ruleId: "initialization-before-use", subject: "client", missing: ["initialized"],
      location: { fileName: "test.ts", start: 30, end: 31 },
    }] });
  });

  it("requires initialization on both incoming paths", () => {
    const blocks: RuleCfg["blocks"] = [
      { id: "entry", successors: ["yes", "no"], events: [] },
      { id: "yes", successors: ["join"], events: [event("initialize")] },
      { id: "no", successors: ["join"], events: [] },
      { id: "join", successors: [], events: [event("use")] },
    ];
    expect(lintPrerequisites(graph(blocks), initializationRule).status).toBe("findings");
    expect(lintPrerequisites(graph(blocks.map(block => block.id === "no"
      ? { ...block, events: [event("initialize")] } : block)), initializationRule).status).toBe("clean");
  });

  it("does not mistake an unreachable use for a violation", () => {
    expect(lintPrerequisites(graph([
      { id: "entry", successors: [], events: [] },
      { id: "dead", successors: [], events: [event("use")] },
    ]), initializationRule)).toMatchObject({ status: "clean", diagnostics: [] });
  });

  it("does not confuse facts belonging to different subjects", () => {
    expect(lintPrerequisites(graph([
      { id: "entry", successors: [], events: [event("initialize", "a"), event("use", "b")] },
    ]), initializationRule)).toMatchObject({ status: "findings", diagnostics: [{ subject: "b" }] });
  });

  it("supports a different prerequisite rule without changing the engine", () => {
    const result = lintPrerequisites(graph([
      { id: "entry", successors: [], events: [event("compile"), event("publish")] },
    ]), { id: "publish-after-check", operations: {
      compile: { provides: ["compiled"] }, check: { provides: ["checked"] },
      publish: { requires: ["compiled", "checked"] },
    } });
    expect(result).toMatchObject({ status: "findings", diagnostics: [{ missing: ["checked"] }] });
  });

  it("keeps exhausted analysis separate from diagnostics", () => {
    const result = lintPrerequisites(graph([
      { id: "entry", successors: [], events: [event("initialize"), event("use")] },
    ]), initializationRule, { budget: 1 });
    expect(result).toMatchObject({ status: "unknown", reason: "proof-budget-exhausted" });
    expect(result).not.toHaveProperty("diagnostics");
  });

  it.each([
    graph([{ id: "entry", successors: ["absent"], events: [] }]),
    graph([{ id: "entry", successors: [], events: [event("typo")] }]),
    graph([{ id: "entry", successors: [], events: [] }, { id: "entry", successors: [], events: [] }]),
  ])("rejects invalid references and operation names", input => {
    expect(lintPrerequisites(input, initializationRule)).toMatchObject({ status: "unknown", reason: "invalid-input" });
  });
});
