import { describe, expect, it } from "vitest";
import { evaluateResourceProtocol, type ResourceProtocolModel } from "../src/resource-protocol.js";

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
});
