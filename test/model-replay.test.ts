import { describe, expect, it } from "vitest";
import { createModelCounterexample, replayModelCounterexample } from "../src/model-replay.js";

interface LeaseState {
  realNow: number;
  leaseExpiryA: number;
  localDeadlineA: number;
  ownerEpoch: number;
  residentEpochA: number;
  residentEpochB: number;
  ownerIsA: boolean;
}

class LeaseRuntime {
  constructor(public state: LeaseState) {}
  takeoverB() { this.state.ownerIsA = false; this.state.ownerEpoch++; }
  publishB() { this.state.residentEpochB = this.state.ownerEpoch; }
}

const initial: LeaseState = { realNow: 9, leaseExpiryA: 10, localDeadlineA: 10, ownerEpoch: 1, residentEpochA: 1, residentEpochB: 0, ownerIsA: true };
const afterTakeover: LeaseState = { ...initial, ownerEpoch: 2, ownerIsA: false };
const afterPublish: LeaseState = { ...afterTakeover, residentEpochB: 2 };

describe("model counterexample refinement replay", () => {
  it("replays a Node Lease counterexample against TypeScript and observes the same violation", async () => {
    const trace = createModelCounterexample({ backend: "quint", modelHash: "node-lease-broken", initialState: initial, steps: [
      { action: "takeoverB", before: initial, after: afterTakeover },
      { action: "publishB", before: afterTakeover, after: afterPublish },
    ] });
    const result = await replayModelCounterexample(trace, {
      schema: "uneffect-refinement-adapter/v1",
      name: "node-lease-runtime",
      version: "1",
      create: (state) => new LeaseRuntime(state as unknown as LeaseState),
      observe: (runtime) => runtime.state,
      actions: {
        takeoverB: (runtime) => runtime.takeoverB(),
        publishB: (runtime) => runtime.publishB(),
      },
      invariants: {
        singleWriter: (runtime) => !(runtime.state.residentEpochA > 0 && runtime.state.realNow < runtime.state.localDeadlineA && runtime.state.residentEpochB > 0),
      },
    });
    expect(result).toMatchObject({ status: "replayed", matchedSteps: 2, violations: [{ invariant: "singleWriter", step: 2 }] });
    expect(result.adapterDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(result.traceDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reports the first implementation/model state mismatch without claiming replay", async () => {
    const trace = createModelCounterexample({ backend: "quint", modelHash: "node-lease-broken", initialState: initial, steps: [
      { action: "takeoverB", before: initial, after: afterTakeover },
    ] });
    const result = await replayModelCounterexample(trace, {
      schema: "uneffect-refinement-adapter/v1",
      name: "broken-runtime",
      version: "1",
      create: (state) => new LeaseRuntime(state as unknown as LeaseState),
      observe: (runtime) => runtime.state,
      actions: { takeoverB: (runtime) => { runtime.state.ownerIsA = false; runtime.state.ownerEpoch += 2; } },
    });
    expect(result).toMatchObject({ status: "state-mismatch", matchedSteps: 0, mismatch: { step: 1, action: "takeoverB", expected: afterTakeover } });
  });
});
