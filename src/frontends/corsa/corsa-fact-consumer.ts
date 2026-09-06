import { extractAnnotations } from "../../support/annotations.js";
import { formatEffect, parseEffectSet } from "../../effects/capabilities.js";
import { parseCorsaSemanticFacts } from "./corsa-fact-schema.js";
import type { NormalizedFrontendIr } from "../frontend-parity.js";

type Condition = { id: string; expected: boolean };
function validateConditions(conditions: readonly Condition[]): void {
  const seen = new Map<string, boolean>();
  for (const condition of conditions) {
    if (seen.has(condition.id)) throw new Error(`${seen.get(condition.id) === condition.expected ? "duplicate" : "contradictory"} control condition ${condition.id}`);
    seen.set(condition.id, condition.expected);
  }
}

function validateControl(record: { controlConditions: Condition[]; controlPaths: Condition[][] }): void {
  validateConditions(record.controlConditions);
  if (record.controlPaths.length === 0) throw new Error("control paths are empty");
  for (const path of record.controlPaths) validateConditions(path);
  if (JSON.stringify(record.controlConditions) !== JSON.stringify(record.controlPaths[0])) {
    throw new Error("primary control conditions do not match the first control path");
  }
}

function uniqueById<T extends { id: number }>(records: readonly T[], label: string): Map<number, T> {
  const result = new Map<number, T>();
  for (const record of [...records].sort((a, b) => a.id - b.id)) {
    if (result.has(record.id)) throw new Error(`duplicate ${label} ${record.id}`);
    result.set(record.id, record);
  }
  return result;
}

function canonicalEffects(text: string): string[] {
  return [...new Set(parseEffectSet(text).map(formatEffect))];
}

/** Consume facts independently of the TypeScript reference projection.
 * This validates serialized evidence; authentication remains the exporter's
 * in-process responsibility, never a claim established by a producer label.
 */
export function normalizeCorsaFacts(input: unknown): NormalizedFrontendIr {
  const facts = parseCorsaSemanticFacts(input);
  const symbols = uniqueById(facts.symbols, "Corsa symbol");
  const protocols = uniqueById(facts.protocolSymbols, "disposal protocol symbol");
  const name = (id: number): string => {
    const symbol = symbols.get(id);
    if (!symbol) throw new Error(`record references an unknown symbol ${id}`);
    return symbol.name;
  };
  const effects = new Map<number, Set<string>>();
  for (const symbol of symbols.values()) {
    const values = new Set<string>();
    for (const inferred of symbol.inferredEffects) {
      const parsed = canonicalEffects(inferred.effect);
      if (parsed.length !== 1) throw new Error(`checker-inferred effect for symbol ${symbol.id} must contain exactly one effect`);
      values.add(parsed[0]!);
    }
    effects.set(symbol.id, values);
  }
  for (const trivia of facts.trivia) {
    name(trivia.owner);
    for (const payload of extractAnnotations(trivia.text, "effect")) {
      for (const effect of canonicalEffects(payload)) effects.get(trivia.owner)!.add(effect);
    }
  }
  for (const call of facts.calls) {
    name(call.caller); name(call.callee);
    if (call.overloadIndex !== null && call.overloadIndex >= symbols.get(call.callee)!.overloads.length) throw new Error(`invalid overload index ${call.overloadIndex}`);
  }
  for (const resource of facts.resourceScopes) {
    validateControl(resource);
    if (resource.protocolSymbol === null && resource.protocolKind === null) continue;
    const protocol = resource.protocolSymbol === null ? undefined : protocols.get(resource.protocolSymbol);
    if (!protocol) throw new Error("resource references unknown disposal protocol symbol");
    if (protocol.kind !== resource.protocolKind) throw new Error("resource disposal protocol kind does not match its symbol");
  }
  for (const observation of facts.promiseObservations) validateControl(observation);
  for (const records of [facts.promiseObservations, facts.rejectionOwnership, facts.resourceScopes, facts.disposals, facts.suppressedErrors]) {
    for (const record of records) name(record.owner);
  }

  // Finite monotone closure: only the input's finite effect atoms can be added.
  // A worklist revisits callers only when a callee acquires another effect.
  const callers = new Map<number, Set<number>>();
  for (const call of facts.calls) {
    const incoming = callers.get(call.callee) ?? new Set<number>();
    incoming.add(call.caller); callers.set(call.callee, incoming);
  }
  const queue = [...symbols.keys()];
  const pending = new Set(queue);
  for (let index = 0; index < queue.length; index++) {
    const callee = queue[index]!; pending.delete(callee);
    for (const caller of callers.get(callee) ?? []) {
      const target = effects.get(caller)!;
      const before = target.size;
      for (const effect of effects.get(callee)!) target.add(effect);
      if (target.size !== before && !pending.has(caller)) { pending.add(caller); queue.push(caller); }
    }
  }

  const withOwner = <T extends { owner: number }>(record: T) => ({ ...record, owner: name(record.owner) });
  const flattenSpan = <T extends { span: { start: number; end: number } }>(record: T) => {
    const { span, ...rest } = record;
    return { ...rest, ...span };
  };
  return {
    schemaVersion: 8,
    provenance: { ...facts.provenance, compilerRevision: facts.compilerRevision },
    functions: [...symbols.values()].map((s) => ({ name: s.name, effects: [...effects.get(s.id)!].sort() })),
    calls: facts.calls.map((call) => ({ caller: name(call.caller), callee: name(call.callee), callbackTiming: call.callbackTiming })),
    orderedEvents: facts.calls.map((call) => ({ kind: "call" as const, caller: name(call.caller), callee: name(call.callee), ...call.span }))
      .sort((a, b) => a.start - b.start || a.end - b.end),
    protocolSymbols: [...protocols.values()].map(flattenSpan),
    promiseObservations: facts.promiseObservations.map((r) => flattenSpan(withOwner(r))),
    rejectionOwnership: facts.rejectionOwnership.map((r) => flattenSpan(withOwner(r))),
    resourceScopes: facts.resourceScopes.map((r) => flattenSpan(withOwner(r))),
    disposals: facts.disposals.map(withOwner),
    suppressedErrors: facts.suppressedErrors.map(withOwner),
  };
}
