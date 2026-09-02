import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { parseEffectSet } from "../src/capabilities.js";
import { analyzeCallableSummaries, callbackArgumentKey, instantiateCallableSummary } from "../src/callable-summary.js";

describe("backend-neutral callable summaries", () => {
  it("summarizes callback cardinality, effect bounds, and completion conversion", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-callable-summary-"));
    try {
      const fileName = join(directory, "entry.ts");
      writeFileSync(fileName, `
        /* uneffect:effect_parameter callback extends Console | Fetch */
        function once(callback: () => void) {
          const stable = callback
          stable()
        }
        function maybe(callback: () => void, enabled: boolean) {
          if (enabled) callback()
        }
        function optional(callback: (() => void) | undefined) {
          callback?.()
        }
        function shortCircuitAnd(callback: () => void, enabled: boolean) {
          enabled && callback()
        }
        function shortCircuitOr(callback: () => void, enabled: boolean) {
          enabled || callback()
        }
        function nullish(callback: () => void, value: unknown) {
          value ?? callback()
        }
        function eagerLeft(callback: () => boolean, enabled: boolean) {
          callback() && enabled
        }
        function optionalLoop(callback: (() => void) | undefined, values: number[]) {
          for (const value of values) callback?.()
        }
        function condition(callback: () => boolean) {
          if (callback()) return true
          return false
        }
        function ternaryCondition(callback: () => boolean) {
          return callback() ? 1 : 0
        }
        function defaultInitializer(callback: () => number, value = callback()) {
          return value
        }
        /* uneffect:effect_parameter callback extends Console */
        function objectCallback({ callback }: { callback: () => void }) {
          callback()
        }
        function tupleCallback([callback]: readonly [() => void]) {
          callback()
        }
        function defaultedObjectCallback({ callback = () => undefined }: { callback?: () => void } = {}) {
          callback()
        }
        function renamedObjectCallback({ onDone: callback }: { onDone: () => void }) {
          const stable = callback
          stable()
        }
        function callbackPair({ success, failure }: { success: () => void; failure: () => void }, ok: boolean) {
          if (ok) success()
          else failure()
        }
        function either(callback: () => void, ok: boolean) {
          if (ok) callback()
          else callback()
        }
        function conditionalEither(callback: () => void, enabled: boolean, ok: boolean) {
          if (enabled) {
            if (ok) callback()
            else callback()
          }
        }
        function independent(callback: () => void, left: boolean, right: boolean) {
          if (left) callback()
          if (right) callback()
        }
        function exhaustiveSwitch(callback: () => void, kind: "a" | "b") {
          switch (kind) {
            case "a": callback(); break
            case "b": callback(); break
            default: callback()
          }
        }
        function fallthroughSwitch(callback: () => void, kind: "a" | "b") {
          switch (kind) {
            case "a": callback()
            case "b": callback(); break
            default: callback()
          }
        }
        function deferredEither(left: Promise<number>, right: Promise<number>, callback: (value: number) => void, first: boolean) {
          if (first) left.then(callback)
          else right.then(callback)
        }
        function microtaskEither(callback: () => void, first: boolean) {
          if (first) queueMicrotask(callback)
          else queueMicrotask(callback)
        }
        function mixedLane(callback: () => void, promise: Promise<void>, deferred: boolean) {
          if (deferred) promise.then(callback)
          else callback()
        }
        function makeCallback() { return () => console.log("made") }
        function chooseCallback(ok: boolean) {
          if (ok) return () => console.log("left")
          return () => console.log("right")
        }
        function mutableCallback() {
          let callback = () => console.log("mutable")
          return callback
        }
        function createClient() {
          return {
            report(message: string) { console.log(message) },
            audit: (message: string) => console.log(message),
            label: "client",
          }
        }
        function spreadClient(extra: object) {
          return { ...extra, report() { console.log("report") } }
        }
        function accessorClient() {
          return { get report() { return () => console.log("report") } }
        }
        function unsupportedCallbackRest({ ...callbacks }: Record<string, () => void>) {
          return callbacks
        }
        function many(callback: () => void, values: number[]) {
          for (const value of values) callback()
        }
        function builtins(values: number[], callback: (value: number) => void, promise: Promise<number>) {
          values.map(callback)
          promise.then(callback)
          setTimeout(callback, 0)
        }
        function fromAsync(values: AsyncIterable<number>, callback: (value: number, index: number) => number) {
          return Array.fromAsync(values, callback)
        }
        function promiseTry(callback: (value: number) => number) { return Promise.try(callback, 1) }
        function socketEvents(socket: WebSocket, callback: (event: MessageEvent) => void) {
          socket.addEventListener("message", callback)
        }
        function socketOnce(socket: WebSocket, callback: (event: MessageEvent) => void) {
          socket.addEventListener("message", callback, { once: true })
        }
        function socketExplicitlyRepeating(socket: WebSocket, callback: (event: MessageEvent) => void) {
          socket.addEventListener("message", callback, { once: false })
        }
        function socketDynamic(socket: WebSocket, callback: (event: MessageEvent) => void, options: AddEventListenerOptions) {
          socket.addEventListener("message", callback, options)
        }
        function socketAbortable(socket: WebSocket, callback: (event: MessageEvent) => void, signal: AbortSignal) {
          socket.addEventListener("message", callback, { signal })
        }
        interface ListenerLike { addEventListener(type: string, callback: () => void): void }
        function lookalike(target: ListenerLike, callback: () => void) {
          target.addEventListener("message", callback)
        }
      `);
      const program = ts.createProgram([fileName], {
        target: ts.ScriptTarget.ESNext, lib: ["lib.esnext.d.ts", "lib.dom.d.ts"], noEmit: true,
      });
      const analysis = analyzeCallableSummaries(program);

      expect(analysis.diagnostics).toEqual([]);
      const once = analysis.summaries.find(({ name }) => name === "once");
      expect(once).toMatchObject({
        evidence: "inferred",
        callbackParameters: [{
          name: "callback", cardinality: "exactly-1", timing: "inline",
          completion: "propagate-throw", effectBound: ["Console", "Fetch"],
        }],
      });
      expect(instantiateCallableSummary(once!, new Map([[0, parseEffectSet("Console")]]))).toMatchObject({
        evidence: "inferred", violations: [], effects: [{ kind: "capability", name: "Console" }],
      });
      expect(instantiateCallableSummary(once!, new Map([[0, parseEffectSet("Clock")]]))).toMatchObject({
        evidence: "unknown", violations: [{ parameter: "callback", effect: "Clock" }],
      });
      expect(analysis.summaries.find(({ name }) => name === "maybe")?.callbackParameters)
        .toContainEqual(expect.objectContaining({ name: "callback", cardinality: "0..1", timing: "inline" }));
      for (const name of ["optional", "shortCircuitAnd", "shortCircuitOr", "nullish"]) {
        expect(analysis.summaries.find((summary) => summary.name === name)?.callbackParameters)
          .toContainEqual(expect.objectContaining({ name: "callback", cardinality: "0..1", timing: "inline" }));
      }
      expect(analysis.summaries.find(({ name }) => name === "eagerLeft")?.callbackParameters)
        .toContainEqual(expect.objectContaining({ name: "callback", cardinality: "exactly-1" }));
      expect(analysis.summaries.find(({ name }) => name === "optionalLoop")?.callbackParameters)
        .toContainEqual(expect.objectContaining({ name: "callback", cardinality: "0..n" }));
      for (const name of ["condition", "ternaryCondition"]) {
        expect(analysis.summaries.find((summary) => summary.name === name)?.callbackParameters)
          .toContainEqual(expect.objectContaining({ name: "callback", cardinality: "exactly-1" }));
      }
      expect(analysis.summaries.find(({ name }) => name === "defaultInitializer")?.callbackParameters)
        .toContainEqual(expect.objectContaining({ name: "callback", cardinality: "0..1" }));
      expect(analysis.summaries.find(({ name }) => name === "objectCallback")?.callbackParameters)
        .toContainEqual(expect.objectContaining({ index: 0, name: "callback", path: ["callback"], cardinality: "exactly-1" }));
      expect(instantiateCallableSummary(analysis.summaries.find(({ name }) => name === "objectCallback")!, new Map([
        [callbackArgumentKey(0, ["callback"]), parseEffectSet("Console")],
      ]))).toMatchObject({ evidence: "inferred", violations: [], effects: [{ kind: "capability", name: "Console" }] });
      expect(analysis.summaries.find(({ name }) => name === "tupleCallback")?.callbackParameters)
        .toContainEqual(expect.objectContaining({ index: 0, name: "callback", path: [0], cardinality: "exactly-1" }));
      expect(analysis.summaries.find(({ name }) => name === "defaultedObjectCallback")?.callbackParameters)
        .toContainEqual(expect.objectContaining({ index: 0, name: "callback", path: ["callback"], cardinality: "exactly-1" }));
      expect(analysis.summaries.find(({ name }) => name === "renamedObjectCallback")?.callbackParameters)
        .toContainEqual(expect.objectContaining({ index: 0, name: "callback", path: ["onDone"], cardinality: "exactly-1" }));
      expect(analysis.summaries.find(({ name }) => name === "callbackPair")?.callbackParameters).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "success", path: ["success"], cardinality: "0..1" }),
        expect.objectContaining({ name: "failure", path: ["failure"], cardinality: "0..1" }),
      ]));
      expect(analysis.summaries.find(({ name }) => name === "either")?.callbackParameters)
        .toContainEqual(expect.objectContaining({ name: "callback", cardinality: "exactly-1", timing: "inline" }));
      expect(analysis.summaries.find(({ name }) => name === "conditionalEither")?.callbackParameters)
        .toContainEqual(expect.objectContaining({ name: "callback", cardinality: "0..1", timing: "inline" }));
      expect(analysis.summaries.find(({ name }) => name === "independent")?.callbackParameters)
        .toContainEqual(expect.objectContaining({ name: "callback", cardinality: "unknown", timing: "unknown" }));
      expect(analysis.summaries.find(({ name }) => name === "exhaustiveSwitch")?.callbackParameters)
        .toContainEqual(expect.objectContaining({ name: "callback", cardinality: "exactly-1", timing: "inline" }));
      expect(analysis.summaries.find(({ name }) => name === "fallthroughSwitch")?.callbackParameters)
        .toContainEqual(expect.objectContaining({ name: "callback", cardinality: "unknown", timing: "unknown" }));
      expect(analysis.summaries.find(({ name }) => name === "deferredEither")?.callbackParameters)
        .toContainEqual(expect.objectContaining({ name: "callback", cardinality: "0..1", timing: "promise-reaction", completion: "convert-throw-to-rejection" }));
      expect(analysis.summaries.find(({ name }) => name === "microtaskEither")?.callbackParameters)
        .toContainEqual(expect.objectContaining({ name: "callback", cardinality: "exactly-1", timing: "deferred", completion: "host-report-throw" }));
      expect(analysis.summaries.find(({ name }) => name === "mixedLane")?.callbackParameters)
        .toContainEqual(expect.objectContaining({ name: "callback", cardinality: "unknown", timing: "unknown", completion: "unknown" }));
      expect(analysis.summaries.find(({ name }) => name === "makeCallback")?.returnCallable).toMatchObject({
        effects: [{ kind: "capability", name: "Console" }], evidence: "inferred",
      });
      expect(analysis.summaries.find(({ name }) => name === "chooseCallback")?.returnCallable).toBeUndefined();
      expect(analysis.summaries.find(({ name }) => name === "mutableCallback")?.returnCallable).toBeUndefined();
      expect(analysis.summaries.find(({ name }) => name === "createClient")?.returnMembers).toEqual([
        expect.objectContaining({ key: "report", effects: [expect.objectContaining({ name: "Console" })] }),
        expect.objectContaining({ key: "audit", effects: [expect.objectContaining({ name: "Console" })] }),
      ]);
      expect(analysis.summaries.find(({ name }) => name === "spreadClient")?.returnMembers).toBeUndefined();
      expect(analysis.summaries.find(({ name }) => name === "accessorClient")?.returnMembers).toBeUndefined();
      expect(analysis.summaries.find(({ name }) => name === "unsupportedCallbackRest")).toMatchObject({
        evidence: "unknown", unknownReasons: ["unsupported-callback-binding"],
      });
      expect(analysis.summaries.find(({ name }) => name === "many")?.callbackParameters)
        .toContainEqual(expect.objectContaining({ name: "callback", cardinality: "0..n", timing: "inline" }));
      expect(analysis.summaries.find(({ name }) => name === "builtins")?.callbackInvocations).toEqual(expect.arrayContaining([
        expect.objectContaining({ api: "Array.prototype.map", cardinality: "0..n", timing: "inline", completion: "propagate-throw" }),
        expect.objectContaining({ api: "Promise.prototype.then", cardinality: "0..1", timing: "promise-reaction", completion: "convert-throw-to-rejection" }),
        expect.objectContaining({ api: "setTimeout", cardinality: "0..1", timing: "deferred", completion: "host-report-throw" }),
      ]));
      expect(analysis.summaries.find(({ name }) => name === "fromAsync")?.callbackInvocations)
        .toContainEqual(expect.objectContaining({
          api: "ArrayConstructor#fromAsync", callback: "callback", cardinality: "0..n",
          timing: "promise-reaction", completion: "convert-throw-to-rejection",
        }));
      expect(analysis.summaries.find(({ name }) => name === "promiseTry")?.callbackInvocations)
        .toContainEqual(expect.objectContaining({
          api: "PromiseConstructor#try", callback: "callback", cardinality: "exactly-1",
          timing: "inline", completion: "convert-throw-to-rejection",
        }));
      expect(analysis.summaries.find(({ name }) => name === "socketEvents")?.callbackInvocations)
        .toContainEqual(expect.objectContaining({ api: "EventTarget.prototype.addEventListener", callback: "callback", cardinality: "0..n", timing: "deferred", completion: "host-report-throw" }));
      expect(analysis.summaries.find(({ name }) => name === "socketOnce")?.callbackInvocations)
        .toContainEqual(expect.objectContaining({ api: "EventTarget.prototype.addEventListener", callback: "callback", cardinality: "0..1" }));
      expect(analysis.summaries.find(({ name }) => name === "socketExplicitlyRepeating")?.callbackInvocations)
        .toContainEqual(expect.objectContaining({ api: "EventTarget.prototype.addEventListener", callback: "callback", cardinality: "0..n" }));
      expect(analysis.summaries.find(({ name }) => name === "socketDynamic")?.callbackInvocations)
        .toContainEqual(expect.objectContaining({ api: "EventTarget.prototype.addEventListener", callback: "callback", cardinality: "0..n" }));
      expect(analysis.summaries.find(({ name }) => name === "socketAbortable")?.callbackInvocations)
        .toContainEqual(expect.objectContaining({ api: "EventTarget.prototype.addEventListener", callback: "callback", cancellation: expect.objectContaining({ kind: "abort-signal" }) }));
      expect(analysis.summaries.find(({ name }) => name === "lookalike")?.callbackInvocations).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails closed for mutable callable aliases and dynamic callback dispatch", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-callable-unknown-"));
    try {
      const fileName = join(directory, "entry.ts");
      writeFileSync(fileName, `
        function unsafe(callback: () => void, alternate: () => void, enabled: boolean) {
          let selected = callback
          selected = alternate
          selected()
          ;(enabled ? callback : alternate)()
        }
      `);
      const program = ts.createProgram([fileName], { target: ts.ScriptTarget.ES2024, noEmit: true });
      const summary = analyzeCallableSummaries(program).summaries.find(({ name }) => name === "unsafe");
      expect(summary).toMatchObject({ evidence: "unknown" });
      expect(summary?.unknownReasons).toEqual(expect.arrayContaining(["mutable-callable-alias", "dynamic-callback-dispatch"]));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
