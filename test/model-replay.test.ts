import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createModelCounterexample, parseQuintItfCounterexample, parseTlcCounterexample, readModelCounterexample, replayModelCounterexample, writeModelCounterexample } from "../src/model-replay.js";
import { parseSpec } from "../src/spec-ir.js";

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
  it("normalizes a scalar TLC trace and recovers actions from the temporal IR", () => {
    const spec = parseSpec("counter.ts", `/* uneffect:temporal state value: int */ /* uneffect:temporal state ready: bool */ /* uneffect:temporal init value = 0 */ /* uneffect:temporal init ready = false */ /* uneffect:temporal action increment: value' = value + 1 */ /* uneffect:temporal action finish: ready' = true */ /* uneffect:temporal action_when finish: value >= 2 && !ready */ /* uneffect:temporal invariant unfinished: !ready */`).temporal;
    const trace = parseTlcCounterexample(`
Error: Invariant q_inv is violated.
State 1: <Initial predicate>
/\\ value = 0
/\\ ready = FALSE

State 2: <q_step line 1, col 1 to line 1, col 1 of module counter>
/\\ value = 1
/\\ ready = FALSE

State 3: <q_step line 1, col 1 to line 1, col 1 of module counter>
/\\ value = 2
/\\ ready = FALSE

State 4: <q_step line 1, col 1 to line 1, col 1 of module counter>
/\\ value = 2
/\\ ready = TRUE
3 states generated, 3 distinct states found, 0 states left on queue.
Finished in 00s [violation] Found an issue.
`, spec, "tlc-model-sha256");
    expect(trace).toMatchObject({
      backend: "tlc", initialState: { value: 0, ready: false },
      steps: [
        { action: "increment", after: { value: 1, ready: false } },
        { action: "increment", after: { value: 2, ready: false } },
        { action: "finish", after: { value: 2, ready: true } },
      ],
    });
  });

  it("normalizes finite Set, Map, and record TLC values and recovers collection actions", () => {
    const spec = parseSpec("collections.ts", `/* uneffect:temporal state writers: Set<int> */ /* uneffect:temporal state epochs: Map<int, int> */ /* uneffect:temporal state lease: { owner: int, valid: bool } */ /* uneffect:temporal init writers = Set(1) */ /* uneffect:temporal init epochs = Map([[1, 1]]) */ /* uneffect:temporal init lease = { owner: 1, valid: true } */ /* uneffect:temporal action publish: writers' = writers.union(Set(2)), epochs' = epochs.put(2, 1), lease' = { ...lease, owner: 2 } */ /* uneffect:temporal invariant oneWriter: writers.size() <= 1 */`).temporal;
    const trace = parseTlcCounterexample(`
Error: Invariant q_inv is violated.
State 1: <Initial predicate>
/\\ writers = {1}
/\\ epochs = [1 |-> 1]
/\\ lease = [owner |-> 1, valid |-> TRUE]

State 2: <q_step>
/\\ writers = {
  2,
  1
}
/\\ epochs = [
  2 |-> 1,
  1 |-> 1
]
/\\ lease = [
  owner |-> 2,
  valid |-> TRUE
]
3 states generated, 3 distinct states found, 0 states left on queue.
Finished in 00s [violation] Found an issue.
`, spec, "collections-model");
    expect(trace).toMatchObject({
      initialState: { writers: [1], epochs: [[1, 1]], lease: { owner: 1, valid: true } },
      steps: [{ action: "publish", after: { writers: [1, 2], epochs: [[1, 1], [2, 1]], lease: { owner: 2, valid: true } } }],
    });
  });

  it("rejects non-violations and ambiguous TLC action recovery", () => {
    const spec = parseSpec("ambiguous.ts", `/* uneffect:temporal state value: int */ /* uneffect:temporal init value = 0 */ /* uneffect:temporal action first: value' = value + 1 */ /* uneffect:temporal action second: value' = value + 1 */ /* uneffect:temporal invariant zero: value === 0 */`).temporal;
    const states = `State 1: <Initial predicate>\nvalue = 0\nState 2: <q_step>\nvalue = 1\n`;
    expect(() => parseTlcCounterexample(states, spec, "model")).toThrow(/does not report a property violation/);
    expect(() => parseTlcCounterexample(`Error: Invariant q_inv is violated.\n${states}`, spec, "model"))
      .toThrow(/actions are ambiguous: first, second/);
  });

  it("normalizes Quint MBT ITF output into actions and JSON-safe state", () => {
    const trace = parseQuintItfCounterexample(JSON.stringify({
      "#meta": { format: "ITF", status: "violation" },
      vars: ["epoch", "ready", "mbt::actionTaken"],
      states: [
        { "#meta": { index: 0 }, epoch: { "#bigint": "0" }, ready: false, "mbt::actionTaken": "init" },
        { "#meta": { index: 1 }, epoch: { "#bigint": "1" }, ready: true, "mbt::actionTaken": "advance" },
      ],
    }), "model-sha256");
    expect(trace).toEqual({
      schema: "uneffect-model-counterexample/v1", backend: "quint", modelHash: "model-sha256",
      initialState: { epoch: 0, ready: false },
      steps: [{ action: "advance", before: { epoch: 0, ready: false }, after: { epoch: 1, ready: true } }],
    });
  });

  it("keeps unsafe ITF big integers tagged instead of losing precision", () => {
    const trace = parseQuintItfCounterexample(JSON.stringify({
      "#meta": { format: "ITF", status: "violation" },
      states: [{ value: { "#bigint": "9007199254740993" }, "mbt::actionTaken": "init" }],
    }), "model-sha256");
    expect(trace.initialState).toEqual({ value: { "#bigint": "9007199254740993" } });
  });

  it("rejects successful and non-MBT ITF artifacts as counterexamples", () => {
    expect(() => parseQuintItfCounterexample(JSON.stringify({
      "#meta": { format: "ITF", status: "ok" }, states: [{}],
    }), "model-sha256")).toThrow(/not a violation/);
    expect(() => parseQuintItfCounterexample(JSON.stringify({
      "#meta": { format: "ITF", status: "violation" }, states: [{}, { value: 1 }],
    }), "model-sha256")).toThrow(/run Quint with --mbt/);
  });

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

  it("persists normalized model counterexamples and rejects stale or malformed artifacts", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-model-counterexample-"));
    const path = join(directory, "lease.json");
    const trace = createModelCounterexample({ backend: "z3", modelHash: "lease-v1", initialState: initial, steps: [
      { action: "takeoverB", before: initial, after: afterTakeover },
    ] });
    try {
      writeModelCounterexample(path, trace);
      expect(readModelCounterexample(path, { expectedModelHash: "lease-v1" })).toEqual(trace);
      expect(() => readModelCounterexample(path, { expectedModelHash: "lease-v2" })).toThrow(/model hash mismatch/);
      writeFileSync(path, JSON.stringify({ ...trace, schema: "uneffect-model-counterexample/v0" }));
      expect(() => readModelCounterexample(path)).toThrow(/unsupported counterexample schema/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
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
