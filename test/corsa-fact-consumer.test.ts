import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizeCorsaFacts } from "../src/frontends/corsa/corsa-fact-consumer.js";

const symbol = (id: number, name: string) => ({ id, name, kind: "function", typeRepr: "() => void", overloads: [], effectParameters: [], span: { start: 0, end: 10 } });
function fixture() {
  return {
    schemaVersion: 8, fileId: 1, compilerRevision: "corsa-checker@test",
    provenance: { producer: "corsa-checker", checkerBacked: true },
    symbols: [symbol(1, "main"), symbol(2, "emit")],
    calls: [{ caller: 1, callee: 2, overloadIndex: null as number | null, callbackTiming: "none", span: { start: 1, end: 2 } }],
    trivia: [{ owner: 2, text: "/* uneffect:effect Console */", span: { start: 0, end: 1 } }],
    protocolSymbols: [{ id: 7, kind: "sync", fileName: "resource.ts", span: { start: 0, end: 1 } }],
    promiseObservations: [{ owner: 1, source: "task()", observation: "await", catchesRejection: false, conditional: true,
      controlConditions: [{ id: "if:1", expected: true }], controlPaths: [[{ id: "if:1", expected: true }]], span: { start: 2, end: 3 } }],
    resourceScopes: [{ owner: 1, binding: "resource", ownerAsync: false, asynchronous: false, conditional: false,
      controlConditions: [], controlPaths: [[]], acquisitionIndex: 0, scopeId: "scope", scopeDepth: 0, scopeEnd: 10,
      catchesFailure: false, disposalFailureType: "Error", protocolSymbol: 7, protocolKind: "sync", span: { start: 4, end: 5 } }],
  };
}

describe("Corsa semantic fact consumer", () => {
  it("matches frozen outputs captured from the retired Rust normalizer", () => {
    const cases = JSON.parse(readFileSync("test/fixtures/corsa-normalization-v8.json", "utf8")) as Array<{ input: unknown; expected: unknown }>;
    expect(cases.length).toBeGreaterThan(10);
    for (const { input, expected } of cases) expect(normalizeCorsaFacts(input)).toEqual(expected);
  });

  it("propagates effects through cycles and preserves call/event identity", () => {
    const input = fixture();
    input.calls.push({ ...input.calls[0]!, caller: 2, callee: 1 });
    const result = normalizeCorsaFacts(input);
    expect(result.functions).toEqual([{ name: "main", effects: ["Console"] }, { name: "emit", effects: ["Console"] }]);
    expect(result.calls).toEqual([{ caller: "main", callee: "emit", callbackTiming: "none" }, { caller: "emit", callee: "main", callbackTiming: "none" }]);
    expect(result.orderedEvents[0]).toEqual({ kind: "call", caller: "main", callee: "emit", start: 1, end: 2 });
  });

  it.each([
    ["schema", (f: ReturnType<typeof fixture>) => { f.schemaVersion = 9; }],
    ["provenance", (f: ReturnType<typeof fixture>) => { f.provenance.checkerBacked = false; }],
    ["duplicate symbol", (f: ReturnType<typeof fixture>) => { f.symbols.push(f.symbols[0]!); }],
    ["span", (f: ReturnType<typeof fixture>) => { f.symbols[0]!.span.start = 20; }],
    ["symbol ID", (f: ReturnType<typeof fixture>) => { f.symbols[0]!.id = -1; }],
    ["dangling call", (f: ReturnType<typeof fixture>) => { f.calls[0]!.callee = 99; }],
    ["overload", (f: ReturnType<typeof fixture>) => { f.calls[0]!.overloadIndex = 0; }],
    ["trivia owner", (f: ReturnType<typeof fixture>) => { f.trivia[0]!.owner = 99; }],
    ["malformed effect", (f: ReturnType<typeof fixture>) => { f.trivia[0]!.text = "/* uneffect:effect Fetch<GET */"; }],
    ["duplicate protocol", (f: ReturnType<typeof fixture>) => { f.protocolSymbols.push(f.protocolSymbols[0]!); }],
    ["unknown protocol", (f: ReturnType<typeof fixture>) => { f.resourceScopes[0]!.protocolSymbol = 99; }],
    ["protocol kind", (f: ReturnType<typeof fixture>) => { f.resourceScopes[0]!.protocolKind = "async"; }],
    ["async owner", (f: ReturnType<typeof fixture>) => { f.promiseObservations[0]!.owner = 99; }],
    ["empty condition", (f: ReturnType<typeof fixture>) => { f.promiseObservations[0]!.controlConditions[0]!.id = ""; }],
    ["duplicate condition", (f: ReturnType<typeof fixture>) => { f.promiseObservations[0]!.controlConditions.push({ id: "if:1", expected: true }); }],
    ["contradictory condition", (f: ReturnType<typeof fixture>) => { f.promiseObservations[0]!.controlConditions.push({ id: "if:1", expected: false }); }],
    ["empty paths", (f: ReturnType<typeof fixture>) => { f.promiseObservations[0]!.controlPaths = []; }],
    ["primary path mismatch", (f: ReturnType<typeof fixture>) => { f.promiseObservations[0]!.controlPaths[0]![0]!.expected = false; }],
  ] as const)("rejects %s", (_, mutate) => {
    const input = fixture(); mutate(input);
    expect(() => normalizeCorsaFacts(input)).toThrow();
  });

  it("validates checker-inferred effect identity and single-effect cardinality", () => {
    const inferred = { effect: "Console", builtin: { module: "global", export: "console.log" }, symbolIdentity: "checker:4",
      declaration: { fileName: "lib.dom.d.ts", start: 10, end: 20 }, span: { start: 1, end: 2 } };
    const input = { ...fixture(), trivia: [], symbols: [{ ...symbol(1, "main"), inferredEffects: [inferred] }, symbol(2, "emit")] };
    expect(normalizeCorsaFacts(input).functions[0]?.effects).toEqual(["Console"]);
    for (const mutation of [
      { symbolIdentity: "" }, { builtin: { module: "", export: "console.log" } },
      { declaration: { fileName: "", start: 10, end: 20 } }, { span: { start: 3, end: 2 } },
      { effect: "none" }, { effect: "Console | FsRead" },
    ]) {
      expect(() => normalizeCorsaFacts({ ...input, symbols: [{ ...input.symbols[0], inferredEffects: [{ ...inferred, ...mutation }] }, input.symbols[1]] })).toThrow();
    }
  });
});
