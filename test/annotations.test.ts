import { describe, expect, it } from "vitest";
import { extractAnnotations, extractLocatedAnnotations, validateUneffectAnnotations } from "../src/annotations.js";

describe("Uneffect annotation marker", () => {
  it("accepts the unified one-line directive surface", () => {
    const source = [
      "/* uneffect:effect Console */",
      "/* uneffect:requires n >= 0 */",
      "/* uneffect:loop_invariant i >= 0 */",
      "/* uneffect:always nonnegative: count >= 0 */",
      "/* uneffect:consumes_rejection 0 */",
    ].join("\n");

    expect(extractAnnotations(source, "effect")).toEqual(["Console"]);
    expect(extractAnnotations(source, "requires")).toEqual(["n >= 0"]);
    expect(extractAnnotations(source, "invariant")).toEqual(["i >= 0"]);
    expect(extractAnnotations(source, "temporal")).toEqual(["nonnegative: count >= 0"]);
    expect(extractAnnotations(source, "consumes_rejection")).toEqual(["0"]);
    expect(validateUneffectAnnotations(source)).toEqual([]);
  });

  it("accepts a unified multiline block", () => {
    const source = `/* uneffect:
      effect Console | Fetch
      requires n >= 0
      ensures result >= n
    */`;

    expect(extractAnnotations(source, "effect")).toEqual(["Console | Fetch"]);
    expect(extractAnnotations(source, "requires")).toEqual(["n >= 0"]);
    expect(extractAnnotations(source, "ensures")).toEqual(["result >= n"]);
    expect(validateUneffectAnnotations(source)).toEqual([]);
  });

  it("rejects an unknown unified directive", () => {
    expect(validateUneffectAnnotations("/* uneffect:not_a_directive value */")).toMatchObject([{ kind: "unknown-dialect", directive: "not_a_directive" }]);
  });
  it("accepts registered plugin directives in one-line and multiline unified forms", () => {
    const source = `/* uneffect:queue_depth pending */\n/* uneffect:\n      queue_depth running\n    */`;
    expect(extractAnnotations(source, "queue_depth")).toEqual(["pending", "running"]);
    expect(validateUneffectAnnotations(source, 0, ["queue_depth"])).toEqual([]);
  });
  it("requires a payload for a registered one-line plugin directive", () => {
    expect(validateUneffectAnnotations("/* uneffect:queue_depth */", 0, ["queue_depth"]))
      .toMatchObject([{ kind: "missing-payload", directive: "queue_depth" }]);
  });
  it("separates contract and temporal invariant syntax by dialect", () => {
    const source = `/* uneffect:requires value >= 0 */\n/* uneffect: state phase: int */\n/* uneffect:always safe: phase >= 0 */`;
    expect(extractAnnotations(source, "requires")).toEqual(["value >= 0"]);
    expect(extractAnnotations(source, "temporal")).toEqual(["safe: phase >= 0"]);
    expect(validateUneffectAnnotations(source)).toEqual([]);
  });
  it("uses react-component as an unambiguous semantic marker", () => {
    expect(extractAnnotations("/* uneffect:react-component */", "react")).toEqual(["component"]);
  });
  it("rejects removed capability, contract, and temporal dialect headers", () => {
    for (const dialect of ["capability", "contract", "temporal"]) {
      expect(validateUneffectAnnotations(`/* uneffect:${dialect} state phase: int */`))
        .toMatchObject([{ kind: "unknown-dialect", directive: dialect }]);
    }
  });
  it("accepts module-level effect upper bounds without using JSDoc semantics", () => {
    const source = `/* uneffect:module_effect Console | Env<\"PLUGIN\"> */\nawait main()`;
    expect(extractAnnotations(source, "module_effect")).toEqual([`Console | Env<"PLUGIN">`]);
    expect(validateUneffectAnnotations(source)).toEqual([]);
  });

  it("extracts a canonical single-line directive", () => {
    expect(extractAnnotations("/* uneffect:effect Console | app.Audit */", "effect"))
      .toEqual(["Console | app.Audit"]);
    expect(extractAnnotations("/* uneffect:effect_parameter iterator extends Console | Fetch */", "effect_parameter"))
      .toEqual(["iterator extends Console | Fetch"]);
  });

  it("extracts multiple directives from one non-JSDoc block", () => {
    const comment = `
      /* uneffect:effect Console | Throw<Error> */ /* uneffect:requires value >= 0 */
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
    expect(extractAnnotations('/* uneffect:runtime returns Path<"$TEMP"> */', "returns"))
      .toEqual(['Path<"$TEMP">']);
  });

  it("recognizes a versioned abstraction relation", () => {
    const source = "/* uneffect:refinement abstraction routing@1 subscribers = activeSubscriberIds */";
    expect(extractAnnotations(source, "abstraction")).toEqual(["routing@1 subscribers = activeSubscriberIds"]);
    expect(validateUneffectAnnotations(source)).toEqual([]);
  });

  it("recognizes gradual React semantic roles", () => {
    const source = `/* uneffect:react-component */\n/* uneffect:react-hook */\n/* uneffect:react-resource acquire Subscription */`;
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

  it("recognizes callable resource boundary operations", () => {
    const source = `/* uneffect:
      borrow input
      consume body
      transfer port -> return
      escape callback
    */`;
    expect(extractAnnotations(source, "borrow")).toEqual(["input"]);
    expect(extractAnnotations(source, "transfer")).toEqual(["port -> return"]);
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

  it("rejects the removed async and resource dialects", () => {
    expect(validateUneffectAnnotations("/* uneffect:async consumes_rejection 0 */"))
      .toContainEqual(expect.objectContaining({ kind: "unknown-dialect", directive: "async" }));
    expect(validateUneffectAnnotations("/* uneffect:resource consume body */"))
      .toContainEqual(expect.objectContaining({ kind: "unknown-dialect", directive: "resource" }));
  });

  it("preserves the exact payload source span", () => {
    const source = `before\n/* uneffect:effect Console | Fetch */\nafter`;
    const [annotation] = extractLocatedAnnotations(source, "effect");
    const start = source.indexOf("Console | Fetch");
    expect(annotation).toEqual({ value: "Console | Fetch", span: { start, end: start + "Console | Fetch".length } });
    expect(source.slice(annotation!.span.start, annotation!.span.end)).toBe(annotation!.value);
  });

  it("reports unknown directives and missing payloads only inside Uneffect blocks", () => {
    const source = `
      /** @returns ordinary JSDoc */
      /* uneffect: effects Console */ /* uneffect:effect */
    `;
    expect(validateUneffectAnnotations(source)).toMatchObject([
      { kind: "unknown-dialect", directive: "effects" },
      { kind: "missing-payload", directive: "effect" },
    ]);
  });

  it("recognizes a decreases clause for termination arguments", () => {
    const source = `/* uneffect:decreases hi - lo */`;
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
    const source = `/* uneffect: clock clock: 1 */ /* uneffect: action_fair tick_clock: weak */`;
    expect(extractAnnotations(source, "clock")).toEqual(["clock: 1"]);
    expect(extractAnnotations(source, "action_fair")).toEqual(["tick_clock: weak"]);
    expect(validateUneffectAnnotations(source)).toEqual([]);
  });

  it("recognizes assumption review owner and expiration metadata", () => {
    const source = `/* uneffect:trust trust typed-array reviewed against the wire format */ /* uneffect:trust trust_owner binary-platform */ /* uneffect:trust trust_expires 2027-06-30 */`;
    expect(extractAnnotations(source, "trust_owner")).toEqual(["binary-platform"]);
    expect(extractAnnotations(source, "trust_expires")).toEqual(["2027-06-30"]);
    expect(validateUneffectAnnotations(source)).toEqual([]);
  });
});
