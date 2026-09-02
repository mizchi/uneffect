import { describe, expect, it } from "vitest";
import {
  stableSerializeBuiltinSemantics,
  validateBuiltinSemantics,
  type BuiltinSemantics,
} from "../src/builtin-semantic-schema.js";

describe("generic builtin semantic schema", () => {
  const semantics: BuiltinSemantics = {
    schema: "uneffect-semantic-primitives/v1",
    primitives: [
      { kind: "effect", capability: "Console" },
      { kind: "mutate", target: { kind: "receiver" } },
      {
        kind: "callback",
        target: { kind: "argument", index: 0 },
        timing: "sync",
        queue: "current",
        cardinality: "0..n",
        invocationArguments: [{ kind: "runtime-value", role: "item" }],
        invocationRestArguments: { from: 2 },
        thisArgument: { kind: "argument", index: 1, optional: true },
      },
    ],
  };

  it("accepts a versioned composition of orthogonal primitives", () => {
    expect(validateBuiltinSemantics(semantics)).toEqual(semantics);
  });

  it("types network authority projection independently from the API symbol", () => {
    const network: BuiltinSemantics = {
      schema: "uneffect-semantic-primitives/v1",
      primitives: [{
        kind: "effect", capability: "Net",
        scope: { kind: "network", format: "connect", target: { kind: "argument", index: 0 }, hostArgument: 1 },
      }],
    };
    expect(validateBuiltinSemantics(network)).toEqual(network);

    const region: BuiltinSemantics = {
      schema: "uneffect-semantic-primitives/v1",
      primitives: [{ kind: "effect", capability: "Dom", scope: { kind: "region", member: "NodeRead", target: { kind: "receiver" } } }],
    };
    expect(validateBuiltinSemantics(region)).toEqual(region);
  });

  it.each([
    [{ schema: "uneffect-semantic-primitives/v2", primitives: [] }, "unsupported builtin semantics schema"],
    [{ schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "mutate", target: { kind: "argument", index: -1 } }] }, "non-negative integer"],
    [{ schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "effect", capability: "" }] }, "non-empty capability"],
    [{ schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "unknown" }] }, "unsupported semantic primitive"],
    [{ schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "effect", capability: "Console", scope: { kind: "mystery" } }] }, "unsupported scope projector"],
    [{ schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "effect", capability: "Net", scope: { kind: "network", format: "socket", target: { kind: "argument", index: 0 } } }] }, "format is unsupported"],
    [{ schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "effect", capability: "Console", scpoe: { kind: "literal", value: "x" } }] }, "unknown field"],
    [{ schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "callback", target: { kind: "argument", index: 0 }, timing: "sync", queue: "current", cardinality: "1", invocationArguments: [{ kind: "runtime-value", role: "" }] }] }, "non-empty string"],
    [{ schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "callback", target: { kind: "argument", index: 0 }, timing: "sync", queue: "current", cardinality: "1", invocationRestArguments: { from: -1 } }] }, "non-negative integer"],
    [{ schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "callback", target: { kind: "argument", index: 0 }, timing: "sync", queue: "current", cardinality: "1", completion: "swallow" }] }, "completion is unsupported"],
    [{ schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "release", resource: "handle", target: { kind: "receiver" }, completion: "settlement" }] }, "completion is unsupported"],
    [{ schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "effect", capability: "FsRead", when: { kind: "argument-literal-in", index: 1, values: [] } }] }, "non-empty array"],
    [{ schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "effect", capability: "Console" }, { capability: "Console", kind: "effect" }] }, "duplicate semantic primitive"],
  ])("fails closed for invalid semantic data %#", (value, message) => {
    expect(() => validateBuiltinSemantics(value)).toThrow(message);
  });

  it("serializes object keys canonically without reordering semantic execution", () => {
    const reordered = {
      primitives: [
        { capability: "Console", kind: "effect" },
        { target: { index: 0, kind: "argument" }, kind: "mutate" },
      ],
      schema: "uneffect-semantic-primitives/v1",
    };
    const canonical = {
      schema: "uneffect-semantic-primitives/v1",
      primitives: [
        { kind: "effect", capability: "Console" },
        { kind: "mutate", target: { kind: "argument", index: 0 } },
      ],
    };
    expect(stableSerializeBuiltinSemantics(reordered)).toBe(stableSerializeBuiltinSemantics(canonical));
    expect(JSON.parse(stableSerializeBuiltinSemantics(reordered)).primitives.map((item: { kind: string }) => item.kind))
      .toEqual(["effect", "mutate"]);
  });
});
