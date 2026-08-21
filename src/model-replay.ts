import { createHash } from "node:crypto";

export type ModelScalar = null | boolean | number | string;
export type ModelValue = ModelScalar | ModelValue[] | { [name: string]: ModelValue };
export type ModelState = Record<string, ModelValue>;

export interface ModelCounterexampleStep<State extends object = ModelState> {
  action: string;
  before: State;
  after: State;
}

export interface ModelCounterexample<State extends object = ModelState> {
  schema: "uneffect-model-counterexample/v1";
  backend: "quint" | "z3" | "manual";
  modelHash: string;
  initialState: State;
  steps: ModelCounterexampleStep<State>[];
}

export interface ModelRefinementAdapter<Runtime, State extends object = ModelState> {
  schema: "uneffect-refinement-adapter/v1";
  name: string;
  version: string;
  create(initialState: State): Runtime | Promise<Runtime>;
  observe(runtime: Runtime): State | Promise<State>;
  actions: Record<string, (runtime: Runtime, step: ModelCounterexampleStep<State>) => void | Promise<void>>;
  invariants?: Record<string, (runtime: Runtime) => boolean | Promise<boolean>>;
}

export interface ReplayViolation { invariant: string; step: number }
export interface ReplayMismatch<State extends object = ModelState> { step: number; action?: string; expected: State; actual: State }
export interface ModelReplayResult<State extends object = ModelState> {
  status: "replayed" | "state-mismatch" | "missing-action" | "adapter-error";
  matchedSteps: number;
  violations: ReplayViolation[];
  traceDigest: string;
  adapterDigest: string;
  mismatch?: ReplayMismatch<State>;
  missingAction?: string;
  error?: string;
}

function orderedObject(item: Record<string, unknown>): Record<string, unknown> {
  const entries = Object.entries(item);
  entries.sort(([left], [right]) => left.localeCompare(right));
  return Object.fromEntries(entries);
}
const stable = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? orderedObject(item) : item);
const digest = (value: unknown): string => createHash("sha256").update(stable(value)).digest("hex");
const clone = <Value>(value: Value): Value => structuredClone(value);
const same = (left: unknown, right: unknown): boolean => stable(left) === stable(right);

function assertModelValue(value: unknown, path: string): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path} must contain only finite numbers`);
    return;
  }
  if (Array.isArray(value)) { value.forEach((item, index) => assertModelValue(item, `${path}[${index}]`)); return; }
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [name, item] of Object.entries(value)) assertModelValue(item, `${path}.${name}`);
    return;
  }
  throw new Error(`${path} is not a JSON-safe model value`);
}

export function createModelCounterexample<State extends object>(input: Omit<ModelCounterexample<State>, "schema">): ModelCounterexample<State> {
  assertModelValue(input.initialState, "initialState");
  input.steps.forEach((step, index) => { assertModelValue(step.before, `steps[${index}].before`); assertModelValue(step.after, `steps[${index}].after`); });
  const trace: ModelCounterexample<State> = { schema: "uneffect-model-counterexample/v1", ...clone(input) };
  let expectedBefore = trace.initialState;
  for (let index = 0; index < trace.steps.length; index++) {
    const step = trace.steps[index]!;
    if (!step.action) throw new Error(`counterexample step ${index + 1} has an empty action`);
    if (!same(step.before, expectedBefore)) throw new Error(`counterexample step ${index + 1} does not continue the previous state`);
    expectedBefore = step.after;
  }
  return trace;
}

/** Replays a normalized model trace against an explicit implementation refinement adapter. */
export async function replayModelCounterexample<State extends object, Runtime>(trace: ModelCounterexample<State>, adapter: ModelRefinementAdapter<Runtime, State>): Promise<ModelReplayResult<State>> {
  if (trace.schema !== "uneffect-model-counterexample/v1") throw new Error(`unsupported counterexample schema: ${(trace as { schema: string }).schema}`);
  if (adapter.schema !== "uneffect-refinement-adapter/v1") throw new Error(`unsupported refinement adapter schema: ${(adapter as { schema: string }).schema}`);
  const traceDigest = digest(trace);
  const adapterDigest = digest({ schema: adapter.schema, name: adapter.name, version: adapter.version, actions: Object.keys(adapter.actions).sort(), invariants: Object.keys(adapter.invariants ?? {}).sort() });
  const violations: ReplayViolation[] = [];
  let matchedSteps = 0;
  let runtime: Runtime;
  try { runtime = await adapter.create(clone(trace.initialState)); }
  catch (cause) { return { status: "adapter-error", matchedSteps: 0, violations, traceDigest, adapterDigest, error: cause instanceof Error ? cause.message : String(cause) }; }
  const observe = async () => clone(await adapter.observe(runtime));
  const checkInvariants = async (step: number): Promise<void> => {
    for (const [name, invariant] of Object.entries(adapter.invariants ?? {})) if (!await invariant(runtime)) violations.push({ invariant: name, step });
  };
  try {
    const initial = await observe();
    if (!same(initial, trace.initialState)) return { status: "state-mismatch", matchedSteps: 0, violations, traceDigest, adapterDigest, mismatch: { step: 0, expected: trace.initialState, actual: initial } };
    await checkInvariants(0);
    for (let index = 0; index < trace.steps.length; index++) {
      const step = trace.steps[index]!, number = index + 1;
      const before = await observe();
      if (!same(before, step.before)) return { status: "state-mismatch", matchedSteps: index, violations, traceDigest, adapterDigest, mismatch: { step: number, action: step.action, expected: step.before, actual: before } };
      const action = adapter.actions[step.action];
      if (!action) return { status: "missing-action", matchedSteps: index, violations, traceDigest, adapterDigest, missingAction: step.action };
      await action(runtime, clone(step));
      const after = await observe();
      if (!same(after, step.after)) return { status: "state-mismatch", matchedSteps: index, violations, traceDigest, adapterDigest, mismatch: { step: number, action: step.action, expected: step.after, actual: after } };
      await checkInvariants(number);
      matchedSteps = number;
    }
    return { status: "replayed", matchedSteps: trace.steps.length, violations, traceDigest, adapterDigest };
  } catch (cause) {
    return { status: "adapter-error", matchedSteps, violations, traceDigest, adapterDigest, error: cause instanceof Error ? cause.message : String(cause) };
  }
}
