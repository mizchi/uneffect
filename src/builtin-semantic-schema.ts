/** Versioned, data-only contract interpreted by every builtin analysis domain. */
export interface BuiltinSemantics {
  schema: "uneffect-semantic-primitives/v1";
  primitives: readonly SemanticPrimitive[];
}

export type ValueProjector =
  | { kind: "receiver" }
  | { kind: "assigned-value" }
  | { kind: "argument"; index: number; optional?: boolean }
  | { kind: "argument-from-end"; offset: number; minimumArguments?: number }
  | { kind: "result" }
  | { kind: "runtime-value"; role: string }
  | { kind: "array-elements"; target: ValueProjector }
  | { kind: "property"; target: ValueProjector; key: string }
  | { kind: "region"; target: ValueProjector; region: "parentNode" | "buffer" };

export type ScopeProjector =
  | { kind: "literal"; value: string }
  | { kind: "value"; target: ValueProjector }
  | { kind: "literal-key"; target: ValueProjector; format?: "cookie-assignment" }
  | { kind: "filesystem-path"; target: ValueProjector }
  | { kind: "run-program"; target: ValueProjector }
  | { kind: "url"; target: ValueProjector; methodArgument?: number; methodFrom?: "value" | "request-init" }
  | { kind: "region"; target: ValueProjector; member: string }
  | {
      kind: "network";
      target: ValueProjector;
      format: "host" | "connect" | "http-request" | "websocket";
      defaultPort?: number;
      hostArgument?: number;
    };

export type CallbackTiming = "sync" | "deferred";
export type CallbackCompletion = "propagate-throw" | "convert-throw-to-rejection" | "host-report-throw";
export type CallbackQueue = "current" | "microtask" | "next-tick" | "timer" | "animation-frame" | "scheduler-task" | "poll" | "check" | "close" | "external";
export type CallbackCardinality = "0..1" | "1" | "0..n" | "1..n";

export type ResultRefinement =
  | { kind: "fresh" }
  | { kind: "alias"; target: ValueProjector }
  | { kind: "path"; pattern: string }
  | { kind: "resource"; family: string }
  | { kind: "css-selector"; target: ValueProjector };

export type SemanticPrimitive =
  | { kind: "effect"; capability: string; scope?: ScopeProjector }
  | { kind: "mutate"; target: ValueProjector }
  | { kind: "callback"; target: ValueProjector; timing: CallbackTiming; queue: CallbackQueue; cardinality: CallbackCardinality; completion?: CallbackCompletion; callable?: "required" | "optional"; returnDepth?: number; once?: ValueProjector; abortSignal?: ValueProjector; invocationArguments?: readonly ValueProjector[]; invocationRestArguments?: { from: number }; thisArgument?: ValueProjector }
  | { kind: "invoke-user-code" }
  | { kind: "result"; refinement: ResultRefinement }
  | { kind: "clone"; target: ValueProjector }
  | { kind: "transfer"; target: ValueProjector; optional?: boolean }
  | { kind: "acquire"; resource: string; target?: ValueProjector }
  | { kind: "use"; resource: string; target: ValueProjector }
  | { kind: "release"; resource: string; target?: ValueProjector }
  | { kind: "throw"; error: string; condition?: string }
  | { kind: "property"; read: readonly SemanticPrimitive[]; write: readonly SemanticPrimitive[] }
  | { kind: "protocol"; name: string; transition: string; inputs?: Readonly<Record<string, ValueProjector>> };

function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${context} must be an object`);
  return value as Record<string, unknown>;
}

function fields(item: Record<string, unknown>, allowed: readonly string[], context: string): void {
  const unknown = Object.keys(item).find((key) => !allowed.includes(key));
  if (unknown !== undefined) throw new Error(`${context} has unknown field: ${unknown}`);
}

function text(value: unknown, context: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${context} must be a non-empty string`);
  return value;
}

function index(value: unknown, context: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) throw new Error(`${context} must be a non-negative integer`);
  return value as number;
}

function oneOf<T extends string>(value: unknown, choices: readonly T[], context: string): T {
  if (typeof value !== "string" || !choices.includes(value as T)) throw new Error(`${context} is unsupported: ${String(value)}`);
  return value as T;
}

function validateTarget(value: unknown, context: string, depth = 0): ValueProjector {
  if (depth > 16) throw new Error(`${context} exceeds the projector nesting limit`);
  const item = record(value, context);
  switch (item.kind) {
    case "receiver": case "assigned-value": case "result": fields(item, ["kind"], context); return item as ValueProjector;
    case "runtime-value": fields(item, ["kind", "role"], context); text(item.role, `${context}.role`); return item as ValueProjector;
    case "argument":
      fields(item, ["kind", "index", "optional"], context); index(item.index, `${context}.index`);
      if (item.optional !== undefined && typeof item.optional !== "boolean") throw new Error(`${context}.optional must be a boolean`);
      return item as ValueProjector;
    case "argument-from-end":
      fields(item, ["kind", "offset", "minimumArguments"], context);
      index(item.offset, `${context}.offset`);
      if (item.minimumArguments !== undefined) index(item.minimumArguments, `${context}.minimumArguments`);
      return item as ValueProjector;
    case "property":
      fields(item, ["kind", "target", "key"], context);
      validateTarget(item.target, `${context}.target`, depth + 1); text(item.key, `${context}.key`); return item as ValueProjector;
    case "region":
      fields(item, ["kind", "target", "region"], context);
      validateTarget(item.target, `${context}.target`, depth + 1);
      oneOf(item.region, ["parentNode", "buffer"] as const, `${context}.region`);
      return item as ValueProjector;
    case "array-elements":
      fields(item, ["kind", "target"], context); validateTarget(item.target, `${context}.target`, depth + 1); return item as ValueProjector;
    default: throw new Error(`unsupported target projector: ${String(item.kind)}`);
  }
}

function validateScope(value: unknown, context: string): ScopeProjector {
  const item = record(value, context);
  switch (item.kind) {
    case "literal": fields(item, ["kind", "value"], context); text(item.value, `${context}.value`); break;
    case "value": case "filesystem-path": case "run-program": fields(item, ["kind", "target"], context); validateTarget(item.target, `${context}.target`); break;
    case "literal-key":
      fields(item, ["kind", "target", "format"], context); validateTarget(item.target, `${context}.target`);
      if (item.format !== undefined) oneOf(item.format, ["cookie-assignment"] as const, `${context}.format`);
      break;
    case "region":
      fields(item, ["kind", "target", "member"], context);
      validateTarget(item.target, `${context}.target`); text(item.member, `${context}.member`); break;
    case "url":
      fields(item, ["kind", "target", "methodArgument", "methodFrom"], context);
      validateTarget(item.target, `${context}.target`);
      if (item.methodArgument !== undefined) index(item.methodArgument, `${context}.methodArgument`);
      if (item.methodFrom !== undefined) oneOf(item.methodFrom, ["value", "request-init"] as const, `${context}.methodFrom`);
      break;
    case "network":
      fields(item, ["kind", "target", "format", "defaultPort", "hostArgument"], context);
      validateTarget(item.target, `${context}.target`);
      oneOf(item.format, ["host", "connect", "http-request", "websocket"] as const, `${context}.format`);
      if (item.defaultPort !== undefined) index(item.defaultPort, `${context}.defaultPort`);
      if (item.hostArgument !== undefined) index(item.hostArgument, `${context}.hostArgument`);
      break;
    default: throw new Error(`unsupported scope projector: ${String(item.kind)}`);
  }
  return item as ScopeProjector;
}

function validatePrimitive(value: unknown, context: string, depth = 0): SemanticPrimitive {
  if (depth > 16) throw new Error(`${context} exceeds the primitive nesting limit`);
  const item = record(value, context);
  switch (item.kind) {
    case "effect":
      fields(item, ["kind", "capability", "scope"], context);
      text(item.capability, `${context} has a non-empty capability`);
      if (item.scope !== undefined) validateScope(item.scope, `${context}.scope`);
      break;
    case "mutate": case "clone": fields(item, ["kind", "target"], context); validateTarget(item.target, `${context}.target`); break;
    case "transfer":
      fields(item, ["kind", "target", "optional"], context); validateTarget(item.target, `${context}.target`);
      if (item.optional !== undefined && typeof item.optional !== "boolean") throw new Error(`${context}.optional must be a boolean`);
      break;
    case "callback":
      fields(item, ["kind", "target", "timing", "queue", "cardinality", "completion", "callable", "returnDepth", "once", "abortSignal", "invocationArguments", "invocationRestArguments", "thisArgument"], context);
      validateTarget(item.target, `${context}.target`);
      oneOf(item.timing, ["sync", "deferred"] as const, `${context}.timing`);
      oneOf(item.queue, ["current", "microtask", "next-tick", "timer", "animation-frame", "scheduler-task", "poll", "check", "close", "external"] as const, `${context}.queue`);
      oneOf(item.cardinality, ["0..1", "1", "0..n", "1..n"] as const, `${context}.cardinality`);
      if (item.completion !== undefined) oneOf(item.completion, ["propagate-throw", "convert-throw-to-rejection", "host-report-throw"] as const, `${context}.completion`);
      if (item.callable !== undefined) oneOf(item.callable, ["required", "optional"] as const, `${context}.callable`);
      if (item.returnDepth !== undefined) index(item.returnDepth, `${context}.returnDepth`);
      if (item.once !== undefined) validateTarget(item.once, `${context}.once`);
      if (item.abortSignal !== undefined) validateTarget(item.abortSignal, `${context}.abortSignal`);
      if (item.invocationArguments !== undefined) {
        if (!Array.isArray(item.invocationArguments)) throw new Error(`${context}.invocationArguments must be an array`);
        item.invocationArguments.forEach((argument, index) => validateTarget(argument, `${context}.invocationArguments[${index}]`));
      }
      if (item.invocationRestArguments !== undefined) {
        const rest = record(item.invocationRestArguments, `${context}.invocationRestArguments`);
        fields(rest, ["from"], `${context}.invocationRestArguments`);
        index(rest.from, `${context}.invocationRestArguments.from`);
      }
      if (item.thisArgument !== undefined) validateTarget(item.thisArgument, `${context}.thisArgument`);
      break;
    case "invoke-user-code": fields(item, ["kind"], context); break;
    case "result": {
      fields(item, ["kind", "refinement"], context);
      const refinement = record(item.refinement, `${context}.refinement`);
      switch (refinement.kind) {
        case "fresh": fields(refinement, ["kind"], `${context}.refinement`); break;
        case "alias": fields(refinement, ["kind", "target"], `${context}.refinement`); validateTarget(refinement.target, `${context}.refinement.target`); break;
        case "path": fields(refinement, ["kind", "pattern"], `${context}.refinement`); text(refinement.pattern, `${context}.refinement.pattern`); break;
        case "resource": fields(refinement, ["kind", "family"], `${context}.refinement`); text(refinement.family, `${context}.refinement.family`); break;
        case "css-selector": fields(refinement, ["kind", "target"], `${context}.refinement`); validateTarget(refinement.target, `${context}.refinement.target`); break;
        default: throw new Error(`unsupported result refinement: ${String(refinement.kind)}`);
      }
      break;
    }
    case "acquire": case "use": case "release":
      fields(item, ["kind", "resource", "target"], context);
      text(item.resource, `${context}.resource`);
      if (item.kind === "use" && item.target === undefined) throw new Error(`${context}.target is required for use`);
      if (item.target !== undefined) validateTarget(item.target, `${context}.target`);
      break;
    case "throw":
      fields(item, ["kind", "error", "condition"], context);
      text(item.error, `${context}.error`);
      if (item.condition !== undefined) text(item.condition, `${context}.condition`);
      break;
    case "property":
      fields(item, ["kind", "read", "write"], context);
      if (!Array.isArray(item.read) || !Array.isArray(item.write)) throw new Error(`${context} property directions must be arrays`);
      item.read.forEach((primitive, i) => validatePrimitive(primitive, `${context}.read[${i}]`, depth + 1));
      item.write.forEach((primitive, i) => validatePrimitive(primitive, `${context}.write[${i}]`, depth + 1));
      break;
    case "protocol":
      fields(item, ["kind", "name", "transition", "inputs"], context);
      text(item.name, `${context}.name`); text(item.transition, `${context}.transition`);
      if (item.inputs !== undefined) for (const [name, target] of Object.entries(record(item.inputs, `${context}.inputs`))) {
        text(name, `${context}.inputs key`); validateTarget(target, `${context}.inputs.${name}`);
      }
      break;
    default: throw new Error(`unsupported semantic primitive: ${String(item.kind)}`);
  }
  return item as SemanticPrimitive;
}

/** Parse untrusted catalog/module data. Unsupported data is rejected rather than widened. */
export function validateBuiltinSemantics(value: unknown): BuiltinSemantics {
  const semantics = record(value, "builtin semantics");
  fields(semantics, ["schema", "primitives"], "builtin semantics");
  if (semantics.schema !== "uneffect-semantic-primitives/v1") {
    throw new Error(`unsupported builtin semantics schema: ${String(semantics.schema)}`);
  }
  if (!Array.isArray(semantics.primitives)) throw new Error("builtin semantics primitives must be an array");
  semantics.primitives.forEach((primitive, i) => validatePrimitive(primitive, `builtin semantics primitive[${i}]`));
  const seen = new Set<string>();
  for (const primitive of semantics.primitives) {
    const serialized = JSON.stringify(canonicalize(primitive));
    if (seen.has(serialized)) throw new Error(`duplicate semantic primitive: ${serialized}`);
    seen.add(serialized);
  }
  return semantics as unknown as BuiltinSemantics;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonicalize(item)]));
}

/** Stable artifact/digest representation. Primitive array order remains semantic. */
export function stableSerializeBuiltinSemantics(value: unknown): string {
  return JSON.stringify(canonicalize(validateBuiltinSemantics(value)));
}
