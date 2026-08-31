import { describe, expect, it } from "vitest";
import { extractAnnotations, extractLocatedAnnotations, validateUneffectAnnotations } from "../src/annotations.js";

describe("Uneffect annotation marker", () => {
  it("requires an explicit annotation dialect", () => {
    expect(validateUneffectAnnotations("/* uneffect:effect Console */")).toMatchObject([{ kind: "unknown-dialect", directive: "effect" }]);
  });
  it("separates contract and temporal invariant syntax by dialect", () => {
    const source = `/* uneffect:contract requires value >= 0 */\n/* uneffect:temporal state phase: int */\n/* uneffect:temporal invariant safe: phase >= 0 */`;
    expect(extractAnnotations(source, "requires")).toEqual(["value >= 0"]);
    expect(extractAnnotations(source, "temporal")).toEqual(["safe: phase >= 0"]);
    expect(validateUneffectAnnotations(source)).toEqual([]);
  });
  it("uses react-component as an unambiguous semantic marker", () => {
    expect(extractAnnotations("/* uneffect:react-component */", "react")).toEqual(["component"]);
  });
  it("rejects directives from another dialect", () => {
    expect(validateUneffectAnnotations("/* uneffect:contract state phase: int */")).toMatchObject([{ kind: "wrong-dialect", directive: "state", dialect: "contract" }]);
  });
  it("accepts module-level effect upper bounds without using JSDoc semantics", () => {
    const source = `/* uneffect:capability module_effect Console | Env<\"PLUGIN\"> */\nawait main()`;
    expect(extractAnnotations(source, "module_effect")).toEqual([`Console | Env<"PLUGIN">`]);
    expect(validateUneffectAnnotations(source)).toEqual([]);
  });

  it("extracts a canonical single-line directive", () => {
    expect(extractAnnotations("/* uneffect:capability effect Console | app.Audit */", "effect"))
      .toEqual(["Console | app.Audit"]);
    expect(extractAnnotations("/* uneffect:capability effect_parameter iterator extends Console | Fetch */", "effect_parameter"))
      .toEqual(["iterator extends Console | Fetch"]);
  });

  it("extracts multiple directives from one non-JSDoc block", () => {
    const comment = `
      /* uneffect:capability effect Console | Throw<Error> */ /* uneffect:contract requires value >= 0 */
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
    const source = "/* uneffect:async consumes_rejection 0, 2 */";
    expect(extractAnnotations(source, "consumes_rejection")).toEqual(["0, 2"]);
    expect(validateUneffectAnnotations(source)).toEqual([]);
  });

  it("recognizes explicit resource retention boundaries", () => {
    const source = "/* uneffect:async retains_resource 0, 2 */";
    expect(extractAnnotations(source, "retains_resource")).toEqual(["0, 2"]);
    expect(validateUneffectAnnotations(source)).toEqual([]);
  });

  it("recognizes callable resource boundary operations", () => {
    const source = `/* uneffect:resource
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
    const source = "/* uneffect:async retains_resource_when 0: enabled */";
    expect(extractAnnotations(source, "retains_resource_when")).toEqual(["0: enabled"]);
    expect(validateUneffectAnnotations(source)).toEqual([]);
  });

  it("recognizes Promise-returning callback ownership", () => {
    const source = "/* uneffect:async consumes_callback_rejection 0 */";
    expect(extractAnnotations(source, "consumes_callback_rejection")).toEqual(["0"]);
    expect(validateUneffectAnnotations(source)).toEqual([]);
  });

  it("recognizes guarded ownership transfer", () => {
    const source = "/* uneffect:async consumes_rejection_when 1: enabled */";
    expect(extractAnnotations(source, "consumes_rejection_when")).toEqual(["1: enabled"]);
    expect(validateUneffectAnnotations(source)).toEqual([]);
  });

  it("preserves the exact payload source span", () => {
    const source = `before\n/* uneffect:capability effect Console | Fetch */\nafter`;
    const [annotation] = extractLocatedAnnotations(source, "effect");
    expect(annotation).toEqual({ value: "Console | Fetch", span: { start: 37, end: 52 } });
    expect(source.slice(annotation!.span.start, annotation!.span.end)).toBe(annotation!.value);
  });

  it("reports unknown directives and missing payloads only inside Uneffect blocks", () => {
    const source = `
      /** @returns ordinary JSDoc */
      /* uneffect:temporal effects Console */ /* uneffect:capability effect */
    `;
    expect(validateUneffectAnnotations(source)).toMatchObject([
      { kind: "wrong-dialect", directive: "effects", dialect: "temporal" },
      { kind: "missing-payload", directive: "effect" },
    ]);
  });

  it("recognizes a decreases clause for termination arguments", () => {
    const source = `/* uneffect:contract decreases hi - lo */`;
    expect(extractLocatedAnnotations(source, "decreases").map((item) => item.value))
      .toEqual(["hi - lo"]);
    expect(validateUneffectAnnotations(source)).toEqual([]);
  });

  it("recognizes an action guard without adding Quint syntax", () => {
    const source = `/* uneffect:temporal action_when tick: clock < deadline */`;
    expect(extractAnnotations(source, "action_when")).toEqual(["tick: clock < deadline"]);
    expect(validateUneffectAnnotations(source)).toEqual([]);
  });

  it("recognizes structured clock and standalone action fairness", () => {
    const source = `/* uneffect:temporal clock clock: 1 */ /* uneffect:temporal action_fair tick_clock: weak */`;
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
