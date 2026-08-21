import { createHash } from "node:crypto";
import type { TemporalExpression, TemporalValueType } from "./temporal-expressions.js";
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

type TemporalScalarState = ModelState;

function evaluateTemporalExpression(expression: TemporalExpression, state: TemporalScalarState): ModelValue {
  if (expression.kind === "name") {
    const value = state[expression.name];
    if (value === undefined) throw new Error(`missing temporal state value: ${expression.name}`);
    return value;
  }
  if (expression.kind === "integer") return Number(expression.value);
  if (expression.kind === "boolean") return expression.value;
  if (expression.kind === "array") return expression.elements.map((item) => evaluateTemporalExpression(item, state));
  if (expression.kind === "record") {
    const base = expression.base ? evaluateTemporalExpression(expression.base, state) : {};
    if (!base || typeof base !== "object" || Array.isArray(base)) throw new Error("temporal record spread did not evaluate to a record");
    return { ...base, ...Object.fromEntries(Object.entries(expression.fields).map(([name, value]) => [name, evaluateTemporalExpression(value, state)])) };
  }
  if (expression.kind === "field") {
    const receiver = evaluateTemporalExpression(expression.receiver, state);
    if (!receiver || typeof receiver !== "object" || Array.isArray(receiver) || !(expression.name in receiver)) throw new Error(`missing temporal record field: ${expression.name}`);
    return receiver[expression.name]!;
  }
  if (expression.kind === "call") {
    if (expression.name === "Set") return [...new Map(expression.arguments.map((item) => evaluateTemporalExpression(item, state)).map((item) => [stable(item), item])).values()].sort((a, b) => stable(a).localeCompare(stable(b)));
    const entries = evaluateTemporalExpression(expression.arguments[0]!, state) as ModelValue[];
    return entries.map((entry) => entry as ModelValue[]).sort((a, b) => stable(a[0]).localeCompare(stable(b[0])));
  }
  if (expression.kind === "method") {
    const receiver = evaluateTemporalExpression(expression.receiver, state) as ModelValue[];
    if (expression.name === "put") {
      const key = evaluateTemporalExpression(expression.arguments[0]!, state), value = evaluateTemporalExpression(expression.arguments[1]!, state);
      return [...receiver.filter((entry) => !same((entry as ModelValue[])[0], key)), [key, value] as ModelValue].sort((a, b) => stable((a as ModelValue[])[0]).localeCompare(stable((b as ModelValue[])[0])));
    }
    if (expression.name === "keys") return receiver.map((entry) => (entry as ModelValue[])[0]!);
    if (expression.name === "values") return [...new Map(receiver.map((entry) => (entry as ModelValue[])[1]!).map((item) => [stable(item), item])).values()].sort((a, b) => stable(a).localeCompare(stable(b)));
    if (expression.name === "size") return receiver.length;
    if (expression.name === "contains") return receiver.some((item) => same(item, evaluateTemporalExpression(expression.arguments[0]!, state)));
    if (expression.name === "union") return [...new Map([...receiver, ...(evaluateTemporalExpression(expression.arguments[0]!, state) as ModelValue[])].map((item) => [stable(item), item])).values()].sort((a, b) => stable(a).localeCompare(stable(b)));
    const predicate = expression.arguments[0]!;
    if (predicate.kind !== "lambda") throw new Error("temporal forall requires a lambda");
    return receiver.every((item) => evaluateTemporalExpression(predicate.body, { ...state, [predicate.parameter]: item }) === true);
  }
  if (expression.kind === "unary") {
    const operand = evaluateTemporalExpression(expression.operand, state);
    if (expression.operator === "not") return !operand;
    return -Number(operand);
  }
  if (expression.kind === "lambda") throw new Error("temporal lambda cannot be evaluated outside a quantifier");
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

function splitTlcItems(source: string): string[] {
  const items: string[] = [];
  let start = 0, depth = 0;
  for (let index = 0; index < source.length; index++) {
    const char = source[index]!;
    if (char === "{" || char === "[") depth++;
    else if (char === "}" || char === "]") depth--;
    else if (char === "," && depth === 0) { items.push(source.slice(start, index).trim()); start = index + 1; }
  }
  const tail = source.slice(start).trim();
  if (tail) items.push(tail);
  return items;
}

function parseTlcValue(raw: string, type: TemporalValueType, name: string): ModelValue {
  if (typeof type === "string") return parseTlcScalar(raw, type, name);
  const value = raw.trim();
  if (type.kind === "set") {
    if (!value.startsWith("{") || !value.endsWith("}")) throw new Error(`TLC state ${name} is not a finite Set: ${value}`);
    if (type.element === "never") return [];
    return splitTlcItems(value.slice(1, -1)).map((item) => parseTlcValue(item, type.element as TemporalValueType, name)).sort((a, b) => stable(a).localeCompare(stable(b)));
  }
  if (!value.startsWith("[") || !value.endsWith("]")) throw new Error(`TLC state ${name} is not a record/function value: ${value}`);
  const entries = splitTlcItems(value.slice(1, -1)).map((item) => {
    const separator = item.indexOf("|->");
    if (separator < 0) throw new Error(`TLC state ${name} has an invalid mapping entry: ${item}`);
    return [item.slice(0, separator).trim(), item.slice(separator + 3).trim()] as const;
  });
  if (type.kind === "record") {
    return Object.fromEntries(entries.map(([field, item]) => {
      const fieldType = type.fields[field];
      if (!fieldType) throw new Error(`TLC state ${name} has unknown record field ${field}`);
      return [field, parseTlcValue(item, fieldType, `${name}.${field}`)];
    }));
  }
  if (type.value === "never") return [];
  return entries.map(([key, item]) => [parseTlcScalar(key, type.key === "never" ? "int" : type.key, name), parseTlcValue(item, type.value as TemporalValueType, name)] as ModelValue)
    .sort((a, b) => stable((a as ModelValue[])[0]).localeCompare(stable((b as ModelValue[])[0])));
}

function recoverTemporalAction(spec: TemporalSpec, before: TemporalScalarState, after: TemporalScalarState, step: number): string {
  const candidates = spec.actions.filter((action) => {
    if (action.guard && evaluateTemporalExpression(action.guard.expressionAst, before) !== true) return false;
    const assignments = new Map(action.assignments.map((assignment) => [assignment.target, assignment]));
    return spec.states.every((state) => {
      const assignment = assignments.get(state.name);
      const expected = assignment ? evaluateTemporalExpression(assignment.expressionAst, before) : before[state.name];
      return same(expected, after[state.name]);
    });
  });
  if (candidates.length !== 1) {
    const detail = candidates.length === 0 ? "no action matches" : `actions are ambiguous: ${candidates.map((action) => action.name).join(", ")}`;
    throw new Error(`cannot recover TLC action at step ${step}: ${detail}`);
  }
  return candidates[0]!.name;
}

/** Parses TLC's console trace and recovers action names from the neutral temporal IR. */
export function parseTlcCounterexample(text: string, spec: TemporalSpec, modelHash: string): ModelCounterexample {
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
      return [state.name, parseTlcValue(raw, state.type, state.name)];
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
