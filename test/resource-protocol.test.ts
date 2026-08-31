import { describe, expect, it } from "vitest";
import { evaluateResourceProtocol, evaluateResourceProtocolCfg, type ResourceProtocolCfg, type ResourceProtocolModel } from "../src/resource-protocol.js";

describe("resource protocol IR", () => {
  it("discharges an acquired resource through a protocol terminal state", () => {
    const model: ResourceProtocolModel = {
      schema: "uneffect-resource-protocol/v1",
      resources: [{ id: "body", label: "response.body", kind: "ReadableStream", initialState: "absent", requiredTerminalStates: ["consumed"] }],
      transitions: [
        { kind: "acquire", resource: "body", at: 1 },
        { kind: "consume", resource: "body", at: 2 },
      ],
    };
    expect(evaluateResourceProtocol(model)).toMatchObject({
      status: "satisfied",
      states: new Map([["body", "consumed"]]),
      diagnostics: [],
    });
  });

  it("requires every child introduced by a split", () => {
    const base: ResourceProtocolModel = {
      schema: "uneffect-resource-protocol/v1",
      resources: [
        { id: "source", label: "response.body", kind: "ReadableStream", initialState: "absent" },
        { id: "left", label: "left", kind: "ReadableStream", initialState: "absent", requiredTerminalStates: ["consumed"] },
        { id: "right", label: "right", kind: "ReadableStream", initialState: "absent", requiredTerminalStates: ["consumed"] },
      ],
      transitions: [
        { kind: "acquire", resource: "source", at: 1 },
        { kind: "split", resource: "source", targets: ["left", "right"], at: 2 },
        { kind: "consume", resource: "left", at: 3 },
      ],
    };
    expect(evaluateResourceProtocol(base)).toMatchObject({ status: "unsatisfied" });
    expect(evaluateResourceProtocol({
      ...base,
      transitions: [...base.transitions, { kind: "consume", resource: "right", at: 4 }],
    })).toMatchObject({ status: "satisfied" });
  });

  it("joins conditional state changes to unknown instead of proving discharge", () => {
    const model: ResourceProtocolModel = {
      schema: "uneffect-resource-protocol/v1",
      resources: [{ id: "body", label: "body", kind: "ReadableStream", initialState: "available", requiredTerminalStates: ["consumed"] }],
      transitions: [{ kind: "consume", resource: "body", conditional: true, at: 1 }],
    };
    expect(evaluateResourceProtocol(model)).toMatchObject({
      status: "unknown",
      states: new Map([["body", "unknown"]]),
    });
  });

  it("reports use after transfer without treating it as a valid terminal path", () => {
    const model: ResourceProtocolModel = {
      schema: "uneffect-resource-protocol/v1",
      resources: [{ id: "port", label: "port", kind: "MessagePort", initialState: "available", requiredTerminalStates: ["transferred"] }],
      transitions: [
        { kind: "transfer", resource: "port", at: 1 },
        { kind: "use", resource: "port", at: 2 },
      ],
    };
    expect(evaluateResourceProtocol(model)).toMatchObject({
      status: "unknown",
      diagnostics: [expect.objectContaining({ code: "invalid-transition", resource: "port", state: "transferred" })],
    });
  });

  it("keeps equal branch terminal states and joins unequal states to unknown", () => {
    const model: ResourceProtocolModel = {
      schema: "uneffect-resource-protocol/v1",
      resources: [{ id: "body", label: "body", kind: "ResponseBody", initialState: "absent", requiredTerminalStates: ["consumed"] }],
      transitions: [],
    };
    const complete: ResourceProtocolCfg = {
      schema: "uneffect-resource-protocol-cfg/v1",
      model,
      entry: "entry",
      exits: ["exit"],
      budget: { name: "resource-test", limit: 32 },
      blocks: [
        { id: "entry", transitions: [{ kind: "acquire", resource: "body", at: 0 }], successors: ["then", "else"] },
        { id: "then", transitions: [{ kind: "consume", resource: "body", at: 1 }], successors: ["exit"] },
        { id: "else", transitions: [{ kind: "consume", resource: "body", at: 2 }], successors: ["exit"] },
        { id: "exit", transitions: [], successors: [] },
      ],
    };
    expect(evaluateResourceProtocolCfg(complete)).toMatchObject({ status: "satisfied", states: new Map([["body", "consumed"]]) });

    const partial: ResourceProtocolCfg = {
      ...complete,
      blocks: complete.blocks.map((block) => block.id === "else" ? { ...block, transitions: [] } : block),
    };
    expect(evaluateResourceProtocolCfg(partial)).toMatchObject({ status: "unknown", states: new Map([["body", "unknown"]]) });
  });

  it("routes normal and exceptional paths through one mandatory finally block", () => {
    const cfg: ResourceProtocolCfg = {
      schema: "uneffect-resource-protocol-cfg/v1",
      model: {
        schema: "uneffect-resource-protocol/v1",
        resources: [{ id: "handle", label: "handle", kind: "Disposable", initialState: "absent", requiredTerminalStates: ["released"] }],
        transitions: [],
      },
      entry: "entry",
      exits: ["exit"],
      budget: { name: "resource-finally-test", limit: 32 },
      blocks: [
        { id: "entry", transitions: [{ kind: "acquire", resource: "handle", at: 0 }], successors: ["try-normal", "try-throw"] },
        { id: "try-normal", transitions: [{ kind: "use", resource: "handle", at: 1 }], successors: ["finally"] },
        { id: "try-throw", transitions: [], successors: ["finally"] },
        { id: "finally", transitions: [{ kind: "release", resource: "handle", at: 2 }], successors: ["exit"] },
        { id: "exit", transitions: [], successors: [] },
      ],
    };
    expect(evaluateResourceProtocolCfg(cfg)).toMatchObject({
      status: "satisfied",
      states: new Map([["handle", "released"]]),
      diagnostics: [],
    });
  });

  it("computes a resource-state fixed point across a loop without claiming termination", () => {
    const cfg: ResourceProtocolCfg = {
      schema: "uneffect-resource-protocol-cfg/v1",
      model: {
        schema: "uneffect-resource-protocol/v1",
        resources: [{ id: "reader", label: "reader", kind: "Reader", initialState: "absent", requiredTerminalStates: ["released"] }],
        transitions: [],
      },
      entry: "entry",
      exits: ["exit"],
      budget: { name: "resource-loop-test", limit: 32 },
      blocks: [
        { id: "entry", transitions: [{ kind: "acquire", resource: "reader", at: 0 }], successors: ["loop"] },
        { id: "loop", transitions: [{ kind: "use", resource: "reader", at: 1 }], successors: ["loop", "finally"] },
        { id: "finally", transitions: [{ kind: "release", resource: "reader", at: 2 }], successors: ["exit"] },
        { id: "exit", transitions: [], successors: [] },
      ],
    };
    const result = evaluateResourceProtocolCfg(cfg);
    expect(result).toMatchObject({ status: "satisfied", states: new Map([["reader", "released"]]) });
    expect(result.iterations).toBeGreaterThan(0);
  });
});
