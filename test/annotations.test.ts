import { describe, expect, it } from "vitest";
import { extractAnnotations, extractLocatedAnnotations, validateUneffectAnnotations } from "../src/annotations.js";

describe("Uneffect annotation marker", () => {
  it("extracts a canonical single-line directive", () => {
    expect(extractAnnotations("/* uneffect: effect Console | app.Audit */", "effect"))
      .toEqual(["Console | app.Audit"]);
  });

  it("extracts multiple directives from one non-JSDoc block", () => {
    const comment = `
      /*
       * uneffect:
       * effect Console | Throw<Error>
       * requires value >= 0
       */
    `;
    expect(extractAnnotations(comment, "effect")).toEqual(["Console | Throw<Error>"]);
    expect(extractAnnotations(comment, "requires")).toEqual(["value >= 0"]);
  });

  it("does not interpret ordinary JSDoc tags as Uneffect directives", () => {
    const comment = `/** @throws {Error} bad input\n * @returns {number} value\n */`;
    expect(extractAnnotations(comment, "effect")).toEqual([]);
  });

  it("ignores pre-design marker variants", () => {
    expect(extractAnnotations("/* @effect Console */", "effect")).toEqual([]);
    expect(extractAnnotations("/* effect Console */", "effect")).toEqual([]);
    expect(extractAnnotations("/* with Console */", "effect")).toEqual([]);
  });

  it("extracts a return path refinement", () => {
    expect(extractAnnotations('/* uneffect: returns Path<"$TEMP"> */', "returns"))
      .toEqual(['Path<"$TEMP">']);
  });

  it("recognizes a versioned abstraction relation", () => {
    const source = "/* uneffect: abstraction routing@1 subscribers = activeSubscriberIds */";
    expect(extractAnnotations(source, "abstraction")).toEqual(["routing@1 subscribers = activeSubscriberIds"]);
    expect(validateUneffectAnnotations(source)).toEqual([]);
  });

  it("recognizes gradual React semantic roles", () => {
    const source = `/* uneffect: react component */\n/* uneffect: react hook */\n/* uneffect: react acquire Subscription */`;
    expect(extractAnnotations(source, "react")).toEqual(["component", "hook", "acquire Subscription"]);
    expect(validateUneffectAnnotations(source)).toEqual([]);
  });

  it("recognizes explicit Promise rejection ownership transfer", () => {
    const source = "/* uneffect: consumes_rejection 0, 2 */";
    expect(extractAnnotations(source, "consumes_rejection")).toEqual(["0, 2"]);
    expect(validateUneffectAnnotations(source)).toEqual([]);
  });

  it("recognizes explicit resource retention boundaries", () => {
    const source = "/* uneffect: retains_resource 0, 2 */";
    expect(extractAnnotations(source, "retains_resource")).toEqual(["0, 2"]);
    expect(validateUneffectAnnotations(source)).toEqual([]);
  });

  it("recognizes guarded resource retention boundaries", () => {
    const source = "/* uneffect: retains_resource_when 0: enabled */";
    expect(extractAnnotations(source, "retains_resource_when")).toEqual(["0: enabled"]);
    expect(validateUneffectAnnotations(source)).toEqual([]);
  });

  it("recognizes Promise-returning callback ownership", () => {
    const source = "/* uneffect: consumes_callback_rejection 0 */";
    expect(extractAnnotations(source, "consumes_callback_rejection")).toEqual(["0"]);
    expect(validateUneffectAnnotations(source)).toEqual([]);
  });

  it("recognizes guarded ownership transfer", () => {
    const source = "/* uneffect: consumes_rejection_when 1: enabled */";
    expect(extractAnnotations(source, "consumes_rejection_when")).toEqual(["1: enabled"]);
    expect(validateUneffectAnnotations(source)).toEqual([]);
  });

  it("preserves the exact payload source span", () => {
    const source = `before\n/* uneffect: effect Console | Fetch */\nafter`;
    const [annotation] = extractLocatedAnnotations(source, "effect");
    expect(annotation).toEqual({ value: "Console | Fetch", span: { start: 27, end: 42 } });
    expect(source.slice(annotation!.span.start, annotation!.span.end)).toBe(annotation!.value);
  });

  it("reports unknown directives and missing payloads only inside Uneffect blocks", () => {
    const source = `
      /** @returns ordinary JSDoc */
      /*
       * uneffect:
       * effects Console
       * effect
       */
    `;
    expect(validateUneffectAnnotations(source)).toMatchObject([
      { kind: "unknown-directive", directive: "effects" },
      { kind: "missing-payload", directive: "effect" },
    ]);
  });

  it("recognizes a decreases clause for termination arguments", () => {
    const source = `/*
     * uneffect:
     * decreases hi - lo
     */`;
    expect(extractLocatedAnnotations(source, "decreases").map((item) => item.value))
      .toEqual(["hi - lo"]);
    expect(validateUneffectAnnotations(source)).toEqual([]);
  });

  it("recognizes an action guard without adding Quint syntax", () => {
    const source = `/* uneffect: action_when tick: clock < deadline */`;
    expect(extractAnnotations(source, "action_when")).toEqual(["tick: clock < deadline"]);
    expect(validateUneffectAnnotations(source)).toEqual([]);
  });

  it("recognizes structured clock and standalone action fairness", () => {
    const source = `/*
     * uneffect:
     * clock clock: 1
     * action_fair tick_clock: weak
     */`;
    expect(extractAnnotations(source, "clock")).toEqual(["clock: 1"]);
    expect(extractAnnotations(source, "action_fair")).toEqual(["tick_clock: weak"]);
    expect(validateUneffectAnnotations(source)).toEqual([]);
  });

  it("recognizes assumption review owner and expiration metadata", () => {
    const source = `/*
     * uneffect:
     * trust typed-array reviewed against the wire format
     * trust_owner binary-platform
     * trust_expires 2027-06-30
     */`;
    expect(extractAnnotations(source, "trust_owner")).toEqual(["binary-platform"]);
    expect(extractAnnotations(source, "trust_expires")).toEqual(["2027-06-30"]);
    expect(validateUneffectAnnotations(source)).toEqual([]);
  });
});
