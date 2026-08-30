import { describe, expect, it } from "vitest";
import {
  catchCompletions,
  completionSet,
  consumeLoopCompletions,
  finallyCompletions,
  sequenceCompletions,
} from "../src/completion-flow.js";

const kinds = (values: ReturnType<typeof completionSet>): string[] => [...values]
  .map((value) => value.completion === "break" || value.completion === "continue"
    ? `${value.completion}:${value.target?.kind === "label" ? value.target.label : ""}`
    : value.completion)
  .sort();

describe("shared JavaScript completion algebra", () => {
  it("sequences the right side only from normal predecessors", () => {
    const result = sequenceCompletions(
      completionSet({ completion: "normal" }, { completion: "return" }),
      () => completionSet({ completion: "throw" }),
    );

    expect(kinds(result)).toEqual(["return", "throw"]);
  });

  it("routes thrown paths through catch while preserving other completions", () => {
    const result = catchCompletions(
      completionSet({ completion: "normal" }, { completion: "return" }, { completion: "throw" }),
      () => completionSet({ completion: "normal" }, { completion: "throw" }),
    );

    expect(kinds(result)).toEqual(["normal", "return", "throw"]);
  });

  it("lets abrupt finally completions override every incoming path", () => {
    const preserved = finallyCompletions(
      completionSet({ completion: "normal" }, { completion: "return" }),
      completionSet({ completion: "normal" }, { completion: "throw" }),
    );
    expect(kinds(preserved)).toEqual(["normal", "return", "throw"]);

    const overridden = finallyCompletions(
      completionSet({ completion: "normal" }, { completion: "return" }),
      completionSet({ completion: "throw" }),
    );
    expect(kinds(overridden)).toEqual(["throw"]);
  });

  it("consumes only break/continue transfers owned by the lexical loop", () => {
    const result = consumeLoopCompletions(completionSet(
      { completion: "break", target: { kind: "nearest-breakable" } },
      { completion: "continue", target: { kind: "label", label: "outer" } },
      { completion: "break", target: { kind: "label", label: "other" } },
      { completion: "return" },
    ), "outer");

    expect(kinds(result)).toEqual(["break:other", "normal", "return"]);
  });
});
