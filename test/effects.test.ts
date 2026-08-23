import { describe, expect, it } from "vitest";
import { analyzeEffects } from "../src/effects.js";

describe("effect checker", () => {
  it("propagates effects from implicit using disposal", () => {
    const source = `
      class Resource {
        /* uneffect: effect Console */
        [Symbol.dispose]() { console.log("disposed") }
      }
      /* uneffect: effect Console */
      function valid() { using resource = new Resource() }
      function invalid() { using resource = new Resource() }
    `;
    const diagnostics = analyzeEffects("using-effects.ts", source);
    expect(diagnostics.filter((item) => item.functionName === "valid")).toEqual([]);
    expect(diagnostics).toContainEqual(expect.objectContaining({ functionName: "invalid", kind: "missing", effect: "Console" }));
  });

  it("discharges a synchronous disposer throw caught around using", () => {
    const source = `
      class Resource {
        /* uneffect: effect Throw<RangeError> */
        [Symbol.dispose]() { throw new RangeError("dispose") }
      }
      function safe() { try { using resource = new Resource() } catch {} }
      function unsafe() { using resource = new Resource() }
    `;
    const diagnostics = analyzeEffects("using-throw.ts", source);
    expect(diagnostics).not.toContainEqual(expect.objectContaining({
      functionName: "safe", kind: "missing", effect: "Throw<RangeError>",
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      functionName: "unsafe", kind: "missing", effect: "Throw<RangeError>",
    }));
  });

  it("checks an in-place recursive quicksort as one reference-scoped mutation", () => {
    const source = `
      /* uneffect: effect Mutate<typeof values> */
      function partition(values: number[], lo: number, hi: number): number {
        const pivot = values[hi]!
        let p = lo
        for (let i = lo; i < hi; i++) {
          if (values[i]! <= pivot) {
            const value = values[i]!
            values[i] = values[p]!
            values[p] = value
            p++
          }
        }
        const value = values[p]!
        values[p] = values[hi]!
        values[hi] = value
        return p
      }
      /* uneffect: effect Mutate<typeof values> */
      function quicksort(values: number[], lo = 0, hi = values.length - 1): void {
        if (lo >= hi) return
        const pivot = partition(values, lo, hi)
        quicksort(values, lo, pivot - 1)
        quicksort(values, pivot + 1, hi)
      }
    `;
    expect(analyzeEffects("quicksort.ts", source)).toEqual([]);
  });

  it("infers direct and transitive effects", () => {
    const source = `
      /* uneffect: effect Console */ function log() { console.log("x") }
      /* uneffect: effect Console | Fetch | Net */ async function main() { log(); await fetch("/") }
    `;
    expect(analyzeEffects("ok.ts", source)).toEqual([]);
  });

  it("reports a missing transitive effect", () => {
    const source = `
      /* uneffect: effect Console */ function log() { console.log("x") }
      /* uneffect: effect Fetch | Net */ async function main() { log(); await fetch("/") }
    `;
    expect(analyzeEffects("bad.ts", source)).toMatchObject([
      { functionName: "main", effect: "Console", kind: "missing" },
    ]);
  });

  it("warns about an unused upper-bound effect", () => {
    const source = `/* uneffect: effect Console | Fetch */ function f() { console.log("x") }`;
    expect(analyzeEffects("ok.ts", source)).toEqual([
      expect.objectContaining({ functionName: "f", effect: "Fetch", kind: "unused", severity: "warning" }),
    ]);
  });

  it("treats timer scheduling and cancellation as the same Timer capability", () => {
    const source = `/* uneffect: effect Timer */ function f() { const h = setTimeout(() => {}, 1); clearTimeout(h); AbortSignal.timeout(10) }`;
    expect(analyzeEffects("timer.ts", source)).toEqual([]);
  });

  it("recognizes node:fs read/write APIs through aliases", () => {
    const source = `
      import { readFileSync as read, writeFileSync as write } from "node:fs";
      /* uneffect: effect FsRead | FsWrite */
      function copy() { write("b", read("a")) }
    `;
    expect(analyzeEffects("fs.ts", source)).toEqual([]);
  });

  it("checks an inferred literal fs path against a structured declaration", () => {
    const source = `
      import { readFileSync } from "node:fs";
      /* uneffect: effect FsRead<"$WORKSPACE_ROOT/data/**"> */
      function load() { return readFileSync("$WORKSPACE_ROOT/data/users.json") }
    `;
    expect(analyzeEffects("fs.ts", source)).toEqual([]);
  });

  it("models fs.read as a filesystem read that mutates its buffer", () => {
    const source = `
      import { read } from "node:fs";
      /* uneffect: effect FsRead */
      function fill(fd: number, buffer: Buffer) { read(fd, buffer, 0, buffer.length, 0, () => {}) }
    `;
    expect(analyzeEffects("fs.ts", source)).toContainEqual(
      expect.objectContaining({ functionName: "fill", effect: "Mutate<typeof buffer>" }),
    );
  });

  it("models copyFile as both a filesystem read and write", () => {
    const source = `
      import * as fs from "node:fs";
      /* uneffect: effect FsWrite */
      function copy() { fs.copyFile("a", "b", () => {}) }
    `;
    expect(analyzeEffects("fs.ts", source)).toContainEqual(
      expect.objectContaining({ functionName: "copy", effect: 'FsRead<"a">' }),
    );
  });

  it("tracks member mutation as a reference-scoped effect", () => {
    const source = `
      /* uneffect: effect Mutate<typeof value> */
      function increment(value: { count: number }) { value.count++ }
    `;
    expect(analyzeEffects("mutate.ts", source)).toEqual([]);
  });

  it("resolves mutating builtins by symbol and ignores a user method with the same name", () => {
    const source = `
      /* uneffect: effect Mutate<typeof values> */
      function builtin(values: number[]) { values.push(1) }
      class Queue { push(_value: number) {} }
      function user(queue: Queue) { queue.push(1) }
    `;
    expect(analyzeEffects("mutation-symbol.ts", source)).toEqual([]);
  });

  it("does not leak mutations of freshly allocated locals into the function summary", () => {
    const source = `function localOnly() { const values: number[] = []; values.push(1); values.sort() }`;
    expect(analyzeEffects("locals.ts", source)).toEqual([]);
  });

  it("supports inference-only adoption without weakening annotated boundaries", () => {
    expect(analyzeEffects("infer.ts", `function inferred() { console.log("x") }`, { requireAnnotations: false })).toEqual([]);
    expect(analyzeEffects("infer.ts", `/* uneffect: effect Timer */ function checked() { console.log("x") }`, { requireAnnotations: false }))
      .toContainEqual(expect.objectContaining({ functionName: "checked", effect: "Console", kind: "missing" }));
  });

  it("substitutes mutation regions through calls", () => {
    const source = `
      /* uneffect: effect Mutate<typeof value> */
      function increment(value: { count: number }) { value.count++ }
      /* uneffect: effect Mutate<typeof state> */
      function update(state: { count: number }) { increment(state) }
    `;
    expect(analyzeEffects("mutate.ts", source)).toEqual([]);
  });

  it("counts a narrower member mutation as use of a broad region", () => {
    const source = `
      /* uneffect: effect Mutate<typeof state> */
      function update(state: { nested: { count: number } }) { state.nested.count++ }
    `;
    expect(analyzeEffects("mutate.ts", source)).toEqual([]);
  });

  it("rejects mutation of a different reference", () => {
    const source = `
      /* uneffect: effect Mutate<typeof left> */
      function bad(left: { n: number }, right: { n: number }) { right.n = left.n }
    `;
    expect(analyzeEffects("mutate.ts", source)).toContainEqual(
      expect.objectContaining({ functionName: "bad", effect: "Mutate<typeof right>", kind: "missing" }),
    );
  });

  it("tracks the concrete Error constructed by a throw statement", () => {
    const source = `
      /* uneffect: effect Throw<RangeError> */
      function parse(value: number) { if (value < 0) throw new RangeError("negative") }
    `;
    expect(analyzeEffects("throw.ts", source)).toEqual([]);
  });

  it("propagates typed throw effects through local calls", () => {
    const source = `
      class ParseError extends Error {}
      /* uneffect: effect Throw<ParseError> */ function parse() { throw new ParseError() }
      /* uneffect: effect Throw<ParseError> */ function main() { parse() }
    `;
    expect(analyzeEffects("throw.ts", source)).toEqual([]);
  });

  it("allows Throw<Error> as an upper bound for concrete Error types", () => {
    const source = `/* uneffect: effect Throw<Error> */ function f() { throw new TypeError("bad") }`;
    expect(analyzeEffects("throw.ts", source)).toEqual([]);
  });

  it("preserves an Error-constrained type parameter", () => {
    const source = `
      /* uneffect: effect Throw<T> */
      function raise<T extends Error>(error: T): never { throw error }
    `;
    expect(analyzeEffects("throw.ts", source)).toEqual([]);
  });

  it("tracks non-Error JavaScript throws as Throw<unknown>", () => {
    const source = `/* uneffect: effect Throw<Error> */ function f() { throw "bad" }`;
    expect(analyzeEffects("throw.ts", source)).toContainEqual(
      expect.objectContaining({ functionName: "f", effect: "Throw<unknown>", kind: "missing" }),
    );
  });

  it("does not classify an async-function rejection as synchronous Throw", () => {
    const source = `
      /* uneffect: effect Throw<RangeError> */
      async function rejects() { throw new RangeError("async") }
      function starts() { rejects() }
    `;
    const diagnostics = analyzeEffects("async-rejection.ts", source);
    expect(diagnostics).toContainEqual(expect.objectContaining({
      functionName: "rejects", effect: "Throw<RangeError>", kind: "unused",
    }));
    expect(diagnostics).not.toContainEqual(expect.objectContaining({
      functionName: "starts", effect: "Throw<RangeError>", kind: "missing",
    }));
  });

  it("moves generator effects from construction to iterator consumption", () => {
    const source = `
      /* uneffect: effect Console | Throw<RangeError> */
      function* generate() { console.log("step"); throw new RangeError("step") }
      function constructOnly() { generate() }
      function buildIterator() { return generate() }
      function consumeNext() { generate().next() }
      function consumeLoop() { for (const value of generate()) void value }
      function consumeFactory() { for (const value of buildIterator()) void value }
      /* uneffect: effect Console */
      function* logOnly() { console.log("log") }
      /* uneffect: effect Throw<TypeError> */
      function* failOnly() { throw new TypeError("fail") }
      function chooseIterator(log: boolean) {
        if (log) return logOnly()
        return failOnly()
      }
      function consumeBranchingFactory(log: boolean) {
        for (const value of chooseIterator(log)) void value
      }
      /* uneffect: effect Console */
      function caughtConsumption() { try { generate().next() } catch {} }
      /* uneffect: effect Console | Throw<URIError> */
      async function* generateAsync() { console.log("async step"); throw new URIError("async step") }
      async function consumeAsync() { for await (const value of generateAsync()) void value }
    `;
    const diagnostics = analyzeEffects("generator-effects.ts", source);
    expect(diagnostics.filter((item) => item.functionName === "constructOnly")).toEqual([]);
    expect(diagnostics).toContainEqual(expect.objectContaining({
      functionName: "consumeNext", effect: "Console", kind: "missing",
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      functionName: "consumeNext", effect: "Throw<RangeError>", kind: "missing",
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      functionName: "consumeLoop", effect: "Console", kind: "missing",
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      functionName: "consumeFactory", effect: "Console", kind: "missing",
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      functionName: "consumeFactory", effect: "Throw<RangeError>", kind: "missing",
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      functionName: "consumeBranchingFactory", effect: "Console", kind: "missing",
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      functionName: "consumeBranchingFactory", effect: "Throw<TypeError>", kind: "missing",
    }));
    expect(diagnostics.filter((item) => item.functionName === "caughtConsumption")).toEqual([]);
    expect(diagnostics).toContainEqual(expect.objectContaining({
      functionName: "generateAsync", effect: "Throw<URIError>", kind: "unused",
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      functionName: "consumeAsync", effect: "Console", kind: "missing",
    }));
    expect(diagnostics).not.toContainEqual(expect.objectContaining({
      functionName: "consumeAsync", effect: "Throw<URIError>", kind: "missing",
    }));
  });

  it("does not admit a class that is not assignable to Error", () => {
    const source = `class NotAnError {} /* uneffect: effect Throw<Error> */ function f() { throw new NotAnError() }`;
    expect(analyzeEffects("throw.ts", source)).toContainEqual(expect.objectContaining({ functionName: "f", effect: "Throw<unknown>", kind: "missing" }));
  });

  it("discharges a direct typed throw caught by try/catch", () => {
    const source = `function f() { try { throw new RangeError("bad") } catch {} }`;
    expect(analyzeEffects("throw.ts", source)).toEqual([]);
  });

  it("discharges a transitive throw from a call in a try block", () => {
    const source = `
      /* uneffect: effect Throw<RangeError> */ function dangerous() { throw new RangeError("bad") }
      function safe() { try { dangerous() } catch {} }
    `;
    expect(analyzeEffects("throw.ts", source)).toEqual([]);
  });

  it("does not discharge a throw originating in the catch body", () => {
    const source = `
      /* uneffect: effect Throw<TypeError> */
      function translate() {
        try { throw new RangeError("bad") }
        catch { throw new TypeError("translated") }
      }
    `;
    expect(analyzeEffects("throw.ts", source)).toEqual([]);
  });

  it("preserves non-throw effects inside a caught try block", () => {
    const source = `
      /* uneffect: effect Console */
      function f() {
        try { console.log("before"); throw new Error("bad") } catch {}
      }
    `;
    expect(analyzeEffects("throw.ts", source)).toEqual([]);
  });

  it("warns when a declared throw is fully discharged", () => {
    const source = `
      /* uneffect: effect Throw<Error> */
      function f() { try { throw new Error("bad") } catch {} }
    `;
    expect(analyzeEffects("throw.ts", source)).toContainEqual(
      expect.objectContaining({ functionName: "f", effect: "Throw<Error>", kind: "unused" }),
    );
  });

  it("does not treat try/finally without catch as a discharge point", () => {
    const source = `
      /* uneffect: effect Throw<RangeError> */
      function f() { try { throw new RangeError("bad") } finally { console.log() } }
    `;
    expect(analyzeEffects("throw.ts", source)).toContainEqual(
      expect.objectContaining({ functionName: "f", effect: "Console", kind: "missing" }),
    );
    expect(analyzeEffects("throw.ts", source)).not.toContainEqual(
      expect.objectContaining({ functionName: "f", effect: "Throw<RangeError>", kind: "missing" }),
    );
  });

  it("propagates a new throw from finally after discharging the try body", () => {
    const source = `
      /* uneffect: effect Throw<TypeError> */
      function f() {
        try { throw new RangeError("caught") }
        catch {}
        finally { throw new TypeError("escapes") }
      }
    `;
    expect(analyzeEffects("throw.ts", source)).toEqual([]);
  });

  it("warns for an unknown user effect in gradual mode", () => {
    const source = `/* uneffect: effect app.Audit */ function f() {}`;
    expect(analyzeEffects("unknown.ts", source)).toContainEqual(
      expect.objectContaining({ functionName: "f", effect: "app.Audit", kind: "unknown", severity: "warning" }),
    );
  });

  it("rejects an unknown user effect in strict mode", () => {
    const source = `/* uneffect: effect app.Audit */ function f() {}`;
    expect(analyzeEffects("unknown.ts", source, { mode: "strict" })).toContainEqual(
      expect.objectContaining({ functionName: "f", effect: "app.Audit", kind: "unknown", severity: "error" }),
    );
  });

  it("infers scoped Fetch and its independent Net authority", () => {
    const source = `async function load() { await fetch("https://api.example.com/v1/users", { method: "POST" }) }`;
    expect(analyzeEffects("fetch.ts", source)).toEqual(expect.arrayContaining([
      expect.objectContaining({ effect: 'Fetch<POST, "https://api.example.com/v1/users">', kind: "missing" }),
      expect.objectContaining({ effect: 'Net<"api.example.com:443">', kind: "missing" }),
    ]));
  });

  it("degrades dynamic Fetch inputs to explicit unknown sets", () => {
    const source = `async function load(url: string, method: string) { await fetch(url, { method }) }`;
    expect(analyzeEffects("fetch.ts", source)).toEqual(expect.arrayContaining([
      expect.objectContaining({ effect: "Fetch<Unknown<dynamic-method>, Unknown<dynamic-url>>" }),
      expect.objectContaining({ effect: "Net<Unknown<dynamic-origin>>" }),
    ]));
  });

  it("infers a segment glob from a numerically constrained template substitution", () => {
    const source = "async function load(id: number) { await fetch(`https://api.example.com/users/${id as number}`) }";
    expect(analyzeEffects("fetch.ts", source)).toEqual(expect.arrayContaining([
      expect.objectContaining({ effect: 'Fetch<GET, "https://api.example.com/users/*">' }),
      expect.objectContaining({ effect: 'Net<"api.example.com:443">' }),
    ]));
  });
});
