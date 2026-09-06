import * as v from "valibot";
import type { ResourceError } from "../../async/async-safety.js";

const id = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const offset = v.pipe(id, v.maxValue(0xffff_ffff));
const text = v.string();
const nonEmpty = v.pipe(text, v.minLength(1));
const span = v.pipe(v.object({ start: offset, end: offset }), v.check((s) => s.start <= s.end, "invalid source span"));
const condition = v.object({ id: v.pipe(text, v.check((s) => s.trim().length > 0, "empty control condition")), expected: v.boolean() });
const control = { controlConditions: v.array(condition), controlPaths: v.array(v.array(condition)) };
const protocolKind = v.picklist(["sync", "async"]);
const resourceError: v.GenericSchema<ResourceError> = v.lazy(() => v.variant("kind", [
  v.object({ kind: v.literal("error"), errorType: text, source: text }),
  v.object({ kind: v.literal("suppressed"), error: resourceError, suppressed: resourceError }),
]));

// Keep the v8 wire contract separate from normalization. As with the former
// serde consumer, extra fields are ignored and optional record lists default
// to empty; malformed required fields are rejected before following IDs.
const schema = v.object({
  schemaVersion: v.literal(8, "unsupported Corsa frontend schema"),
  fileId: offset, compilerRevision: text,
  provenance: v.pipe(v.object({ producer: v.picklist(["typescript-reference", "corsa-checker"]), checkerBacked: v.boolean() }),
    v.check((p) => p.checkerBacked === (p.producer === "corsa-checker"), "frontend provenance producer and checkerBacked disagree")),
  symbols: v.array(v.object({
    id, name: text, kind: v.picklist(["function", "method", "arrow", "callback", "overload"]), typeRepr: text,
    overloads: v.array(text), effectParameters: v.array(id), span,
    inferredEffects: v.optional(v.array(v.object({
      effect: text, builtin: v.object({ module: nonEmpty, export: nonEmpty }), symbolIdentity: nonEmpty,
      declaration: v.pipe(v.object({ fileName: nonEmpty, start: offset, end: offset }), v.check((s) => s.start <= s.end, "invalid declaration span")), span,
    })), []),
  })),
  calls: v.array(v.object({ caller: id, callee: id, overloadIndex: v.nullish(id, null),
    callbackTiming: v.picklist(["none", "inline", "deferred", "unknown"]), span })),
  trivia: v.array(v.object({ owner: id, text, span })),
  protocolSymbols: v.array(v.object({ id, kind: protocolKind, fileName: text, span })),
  promiseObservations: v.optional(v.array(v.object({ owner: id, source: text, observation: text,
    catchesRejection: v.boolean(), conditional: v.boolean(), ...control, span })), []),
  rejectionOwnership: v.optional(v.array(v.object({ owner: id, binding: text, status: text, observations: v.array(text), span })), []),
  resourceScopes: v.optional(v.array(v.object({
    owner: id, binding: text, ownerAsync: v.boolean(), asynchronous: v.boolean(), conditional: v.boolean(), ...control,
    acquisitionIndex: id, scopeId: text, scopeDepth: id, scopeEnd: offset, catchesFailure: v.boolean(), disposalFailureType: text,
    protocolSymbol: v.nullish(id, null), protocolKind: v.nullish(protocolKind, null), span,
  })), []),
  disposals: v.optional(v.array(v.object({
    owner: id, binding: text, order: id, asynchronous: v.boolean(), scopeId: text, scopeDepth: id, disposalPoint: offset,
    failureKind: text, failureType: text, catchesFailure: v.boolean(), escapingFailure: text, exits: v.array(text),
  })), []),
  suppressedErrors: v.optional(v.array(v.object({ owner: id, payload: resourceError })), []),
});

export type CorsaSemanticFacts = v.InferOutput<typeof schema>;

export function parseCorsaSemanticFacts(input: unknown): CorsaSemanticFacts {
  return v.parse(schema, input);
}
