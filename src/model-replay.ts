import { createHash } from "node:crypto";
import type { TemporalExpression } from "./temporal-expressions.js";
import type { TemporalSpec } from "./spec-ir.js";

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
  backend: "quint" | "tlc" | "z3" | "manual";
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

function normalizeItfValue(value: unknown): ModelValue {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) return value.map(normalizeItfValue);
  if (typeof value !== "object") throw new Error(`unsupported ITF value: ${String(value)}`);
  const record = value as Record<string, unknown>;
  if (typeof record["#bigint"] === "string") {
    const bigint = BigInt(record["#bigint"]);
    const number = Number(bigint);
    return Number.isSafeInteger(number) ? number : { "#bigint": bigint.toString() };
  }
  return Object.fromEntries(Object.entries(record).map(([name, item]) => [name, normalizeItfValue(item)]));
}

/** Parses Quint's `run --mbt --out-itf=...` violation artifact. */
export function parseQuintItfCounterexample(text: string, modelHash: string): ModelCounterexample {
  const document = JSON.parse(text) as { "#meta"?: { format?: string; status?: string }; states?: unknown[] };
  if (document["#meta"]?.format !== "ITF") throw new Error("Quint counterexample is not an ITF document");
  if (document["#meta"]?.status !== "violation") throw new Error(`Quint ITF status is not a violation: ${document["#meta"]?.status ?? "missing"}`);
  if (!Array.isArray(document.states) || document.states.length === 0) throw new Error("Quint ITF counterexample has no states");
  const states = document.states.map((raw, index): { state: ModelState; action?: string } => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`Quint ITF state ${index} is not an object`);
    const record = raw as Record<string, unknown>, action = record["mbt::actionTaken"];
    const state = Object.fromEntries(Object.entries(record).filter(([name]) => !name.startsWith("#") && !name.startsWith("mbt::")).map(([name, value]) => [name, normalizeItfValue(value)]));
    return { state, ...(typeof action === "string" ? { action } : {}) };
  });
  const steps = states.slice(1).map((entry, index): ModelCounterexampleStep => {
    if (!entry.action) throw new Error(`Quint ITF state ${index + 1} has no mbt::actionTaken; run Quint with --mbt`);
    return { action: entry.action, before: states[index]!.state, after: entry.state };
  });
  return createModelCounterexample({ backend: "quint", modelHash, initialState: states[0]!.state, steps });
}

type TemporalScalarState = Record<string, number | boolean>;

function evaluateTemporalExpression(expression: TemporalExpression, state: TemporalScalarState): number | boolean {
  if (expression.kind === "name") {
    const value = state[expression.name];
    if (value === undefined) throw new Error(`missing temporal state value: ${expression.name}`);
    return value;
  }
  if (expression.kind === "integer") return Number(expression.value);
  if (expression.kind === "boolean") return expression.value;
  if (expression.kind === "unary") {
    const operand = evaluateTemporalExpression(expression.operand, state);
    if (expression.operator === "not") return !operand;
    return -Number(operand);
  }
  if (expression.kind === "array" || expression.kind === "record" || expression.kind === "field" || expression.kind === "lambda" || expression.kind === "call" || expression.kind === "method") throw new Error("collection temporal expressions are not supported by scalar trace replay");
  const left = evaluateTemporalExpression(expression.left, state), right = evaluateTemporalExpression(expression.right, state);
  switch (expression.operator) {
    case "eq": return left === right;
    case "neq": return left !== right;
    case "and": return Boolean(left) && Boolean(right);
    case "or": return Boolean(left) || Boolean(right);
    case "lt": return Number(left) < Number(right);
    case "lte": return Number(left) <= Number(right);
    case "gt": return Number(left) > Number(right);
    case "gte": return Number(left) >= Number(right);
    case "add": return Number(left) + Number(right);
    case "subtract": return Number(left) - Number(right);
    case "multiply": return Number(left) * Number(right);
    case "divide": {
      if (Number(right) === 0) throw new Error("cannot evaluate temporal division by zero while recovering a TLC action");
      return Math.trunc(Number(left) / Number(right));
    }
    case "modulo": {
      if (Number(right) === 0) throw new Error("cannot evaluate temporal modulo by zero while recovering a TLC action");
      return Number(left) % Number(right);
    }
  }
}

function parseTlcScalar(raw: string, type: "int" | "bool", name: string): number | boolean {
  const value = raw.trim();
  if (type === "bool") {
    if (value === "TRUE") return true;
    if (value === "FALSE") return false;
    throw new Error(`TLC state ${name} is not a scalar boolean: ${value}`);
  }
  if (!/^-?\d+$/.test(value)) throw new Error(`TLC state ${name} is not a scalar integer: ${value}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`TLC state ${name} exceeds JavaScript's safe integer range: ${value}`);
  return parsed;
}

function recoverTemporalAction(spec: TemporalSpec, before: TemporalScalarState, after: TemporalScalarState, step: number): string {
  const candidates = spec.actions.filter((action) => {
    if (action.guard && evaluateTemporalExpression(action.guard.expressionAst, before) !== true) return false;
    const assignments = new Map(action.assignments.map((assignment) => [assignment.target, assignment]));
    return spec.states.every((state) => {
      const assignment = assignments.get(state.name);
      const expected = assignment ? evaluateTemporalExpression(assignment.expressionAst, before) : before[state.name];
      return expected === after[state.name];
    });
  });
  if (candidates.length !== 1) {
    const detail = candidates.length === 0 ? "no action matches" : `actions are ambiguous: ${candidates.map((action) => action.name).join(", ")}`;
    throw new Error(`cannot recover TLC action at step ${step}: ${detail}`);
  }
  return candidates[0]!.name;
}

/** Parses TLC's scalar console trace and recovers action names from the neutral temporal IR. */
export function parseTlcCounterexample(text: string, spec: TemporalSpec, modelHash: string): ModelCounterexample {
  if (spec.states.some((state) => typeof state.type !== "string")) throw new Error("collection-valued TLC trace replay is not implemented");
  if (!/(?:Invariant.+violated|Temporal properties were violated)/i.test(text)) throw new Error("TLC output does not report a property violation");
  const headers = [...text.matchAll(/^State\s+(\d+):\s*<[^\n]*>\s*$/gm)];
  if (headers.length === 0) throw new Error("TLC counterexample has no states");
  const states = headers.map((header, index): TemporalScalarState => {
    const start = header.index! + header[0].length, end = headers[index + 1]?.index ?? text.length;
    const block = text.slice(start, end);
    const assignments = new Map([...block.matchAll(/^(?:\/\\\s+)?([A-Za-z_$][\w$]*)\s*=\s*([^\n\r]+)$/gm)].map((match) => [match[1]!, match[2]!]));
    return Object.fromEntries(spec.states.map((state) => {
      const raw = assignments.get(state.name);
      if (raw === undefined) throw new Error(`TLC state ${index + 1} is missing ${state.name}; parsed assignments: ${[...assignments.keys()].join(", ") || "<none>"}; block: ${JSON.stringify(block.trim())}`);
      return [state.name, parseTlcScalar(raw, state.type as "int" | "bool", state.name)];
    }));
  });
  const steps = states.slice(1).map((after, index): ModelCounterexampleStep => ({
    action: recoverTemporalAction(spec, states[index]!, after, index + 1), before: states[index]!, after,
  }));
  return createModelCounterexample({ backend: "tlc", modelHash, initialState: states[0]!, steps });
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
