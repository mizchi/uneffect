import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "@typescript/typescript6";
import { describe, expect, it } from "vitest";
import { analyzeAsyncIteratorCleanup, analyzeAsyncIteratorCleanupInProgram, analyzeIteratorCleanupInProgram } from "../src/async-iterator-cleanup.js";
import { checkFiles } from "../src/check.js";
import { assessCheckAssurance } from "../src/assurance.js";
import { verifyUneffectProject } from "../src/project-verification.js";
import { evaluateResourceProtocol } from "../src/resource-protocol.js";

function analyze(text: string) {
  return analyzeAsyncIteratorCleanup(ts.createSourceFile("entry.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS));
}

function analyzeProgram(text: string) {
  const fileName = "/entry.ts";
  const host = ts.createCompilerHost({ target: ts.ScriptTarget.ESNext, lib: ["lib.esnext.d.ts"] });
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) => name === fileName
    ? ts.createSourceFile(name, text, languageVersion, true, ts.ScriptKind.TS)
    : original(name, languageVersion, onError, shouldCreateNewSourceFile);
  host.fileExists = ((originalFileExists) => (name: string) => name === fileName || originalFileExists(name))(host.fileExists.bind(host));
  host.readFile = ((originalReadFile) => (name: string) => name === fileName ? text : originalReadFile(name))(host.readFile.bind(host));
  const program = ts.createProgram([fileName], { target: ts.ScriptTarget.ESNext, lib: ["lib.esnext.d.ts"], noEmit: true }, host);
  return analyzeAsyncIteratorCleanupInProgram(program, program.getSourceFile(fileName)!);
}

function analyzeAllIterators(text: string) {
  const fileName = "/entry.ts";
  const host = ts.createCompilerHost({ target: ts.ScriptTarget.ESNext, lib: ["lib.esnext.d.ts"] });
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) => name === fileName
    ? ts.createSourceFile(name, text, languageVersion, true, ts.ScriptKind.TS)
    : original(name, languageVersion, onError, shouldCreateNewSourceFile);
  host.fileExists = ((originalFileExists) => (name: string) => name === fileName || originalFileExists(name))(host.fileExists.bind(host));
  host.readFile = ((originalReadFile) => (name: string) => name === fileName ? text : originalReadFile(name))(host.readFile.bind(host));
  const program = ts.createProgram([fileName], { target: ts.ScriptTarget.ESNext, lib: ["lib.esnext.d.ts"], noEmit: true }, host);
  return analyzeIteratorCleanupInProgram(program, program.getSourceFile(fileName)!);
}

describe("async iterator cleanup", () => {
  it("separates exhaustion from abrupt AsyncIteratorClose scenarios", () => {
    const [cleanup] = analyze(`
      async function main(mode: string, values: AsyncIterable<number>) {
        for await (const value of values) {
          if (mode === "break") break
          if (mode === "return") return value
          if (mode === "throw") throw new Error("stop")
        }
      }
    `);
    expect(cleanup).toMatchObject({ owner: "main", iterable: "values", coverage: "reviewed-explicit-completions", unknownReasons: [] });
    expect(cleanup!.scenarios.map(({ exit }) => exit)).toEqual(["exhausted", "break", "return", "throw"]);
    expect(cleanup!.scenarios[0]).not.toHaveProperty("close");
    for (const item of cleanup!.scenarios.slice(1)) expect(item).toMatchObject({
      close: {
        lookupLane: "inline", resultLane: "microtask-if-present", method: "return-if-present",
        propertyAccessMayInvokeUserCode: true, failure: "reject",
      },
    });
    expect(cleanup!.scenarios.map(({ model }) => evaluateResourceProtocol(model).status)).toEqual([
      "satisfied", "satisfied", "satisfied", "satisfied",
    ]);
  });

  it("does not invent close edges for nested breaks or locally caught throws", () => {
    const [cleanup] = analyze(`
      async function main(values: AsyncIterable<number>) {
        for await (const value of values) {
          while (value > 0) { break }
          try { throw new Error("handled") } catch {}
        }
      }
    `);
    expect(cleanup!.scenarios.map(({ exit }) => exit)).toEqual(["exhausted"]);
  });

  it("ignores synchronous for-of and nested callable exits", () => {
    expect(analyze(`
      async function main(values: AsyncIterable<number>, sync: number[]) {
        for (const value of sync) break
        for await (const value of values) {
          const later = () => { throw new Error("later") }
          void later
        }
      }
    `)).toMatchObject([{ scenarios: [{ exit: "exhausted" }] }]);
  });

  it("tracks labeled outer break and nested async iterators independently", () => {
    const cleanups = analyze(`
      async function main(outerValues: AsyncIterable<number>, innerValues: AsyncIterable<number>) {
        outer: for await (const outerValue of outerValues) {
          for await (const innerValue of innerValues) {
            if (innerValue > outerValue) break outer
          }
        }
      }
    `);
    expect(cleanups.map(({ iterable, scenarios }) => [iterable, scenarios.map(({ exit }) => exit)])).toEqual([
      ["outerValues", ["exhausted", "break"]],
      ["innerValues", ["exhausted", "break"]],
    ]);
  });

  it("fails closed when finally can override an observed abrupt completion", () => {
    const [cleanup] = analyze(`
      async function main(values: AsyncIterable<number>) {
        for await (const value of values) {
          try { break } finally { if (value > 0) continue }
        }
      }
    `);
    expect(cleanup).toMatchObject({
      unknownReasons: ["abrupt-through-finally"],
      scenarios: [{ exit: "exhausted" }],
    });
  });

  it("preserves abrupt IteratorClose through a normally completing finally", () => {
    const [cleanup] = analyze(`
      async function main(values: AsyncIterable<number>) {
        for await (const value of values) {
          try { if (value > 0) break } finally { console.log("cleanup") }
        }
      }
    `);
    expect(cleanup).toMatchObject({ unknownReasons: [] });
    expect(cleanup!.scenarios.map(({ exit }) => exit)).toEqual(["exhausted", "break", "throw"]);
  });

  it("models an uncaught implicit body call throw as AsyncIteratorClose", () => {
    const [cleanup] = analyze(`
      async function main(values: AsyncIterable<number>) {
        for await (const value of values) consume(value)
      }
      declare function consume(value: number): void
    `);
    expect(cleanup!.scenarios.map(({ exit }) => exit)).toEqual(["exhausted", "throw"]);
    expect(cleanup!.scenarios[1]).toMatchObject({
      close: { failure: "reject", resultLane: "microtask-if-present" },
    });
  });

  it("replaces an abrupt completion with an unconditional finally completion", () => {
    const cleanups = analyze(`
      async function returns(values: AsyncIterable<number>) {
        for await (const value of values) {
          try { break } finally { return value }
        }
      }
      async function throws(values: AsyncIterable<number>) {
        for await (const value of values) {
          try { break } finally { throw new Error(String(value)) }
        }
      }
    `);
    expect(cleanups.map(({ owner, unknownReasons, scenarios }) => ({
      owner, unknownReasons, exits: scenarios.map(({ exit }) => exit),
    }))).toEqual([
      { owner: "returns", unknownReasons: [], exits: ["exhausted", "return"] },
      { owner: "throws", unknownReasons: [], exits: ["exhausted", "throw"] },
    ]);
  });

  it("tracks awaited manual next and return through immutable iterator aliases", () => {
    const [cleanup] = analyzeProgram(`
      async function main(values: AsyncIterable<number>) {
        const cursor = values[Symbol.asyncIterator]()
        const renamed = cursor
        await renamed.next()
        await cursor.return!()
      }
    `);
    expect(cleanup).toMatchObject({
      owner: "main", iterable: "values[Symbol.asyncIterator]()",
      coverage: "reviewed-manual-protocol", unknownReasons: [],
      scenarios: [{
        exit: "manual-return",
        close: { method: "return", resultLane: "microtask" },
        model: { transitions: [
          { kind: "use", evidence: "exact" },
          { kind: "release", evidence: "exact" },
        ] },
      }],
    });
    expect(evaluateResourceProtocol(cleanup!.scenarios[0]!.model).status).toBe("satisfied");
  });

  it("tracks straight-line mutable aliases by assignment generation", () => {
    const cleanups = analyzeProgram(`
      async function same(values: AsyncIterable<number>) {
        const iterator = values[Symbol.asyncIterator]()
        let active = iterator
        await active.next()
        active = iterator
        await active.return!()
      }
      async function replaced(left: AsyncIterable<number>, right: AsyncIterable<number>) {
        const first = left[Symbol.asyncIterator]()
        const second = right[Symbol.asyncIterator]()
        let active = first
        await active.return!()
        active = second
        await active.next()
        await active.return!()
      }
    `);
    expect(cleanups.map(({ owner, iterable, unknownReasons, scenarios }) => ({
      owner, iterable, unknownReasons,
      transitions: scenarios[0]?.model.transitions.map(({ kind, evidence }) => [kind, evidence]),
      status: evaluateResourceProtocol(scenarios[0]!.model).status,
    }))).toEqual([
      { owner: "same", iterable: "values[Symbol.asyncIterator]()", unknownReasons: [], transitions: [["use", "exact"], ["release", "exact"]], status: "satisfied" },
      { owner: "replaced", iterable: "left[Symbol.asyncIterator]()", unknownReasons: [], transitions: [["release", "exact"]], status: "satisfied" },
      { owner: "replaced", iterable: "right[Symbol.asyncIterator]()", unknownReasons: [], transitions: [["use", "exact"], ["release", "exact"]], status: "satisfied" },
    ]);
  });

  it("keeps conditionally reassigned iterator aliases unknown for every candidate resource", () => {
    const cleanups = analyzeProgram(`
      async function main(left: AsyncIterable<number>, right: AsyncIterable<number>, choose: boolean) {
        const first = left[Symbol.asyncIterator]()
        const second = right[Symbol.asyncIterator]()
        let active = first
        if (choose) active = second
        await active.return!()
      }
    `);
    expect(cleanups.map(({ iterable, unknownReasons, scenarios }) => ({
      iterable, unknownReasons, status: evaluateResourceProtocol(scenarios[0]!.model).status,
    }))).toEqual([
      { iterable: "left[Symbol.asyncIterator]()", unknownReasons: ["unstable-iterator-alias"], status: "unknown" },
      { iterable: "right[Symbol.asyncIterator]()", unknownReasons: ["unstable-iterator-alias"], status: "unknown" },
    ]);
  });

  it("keeps a const snapshot on the mutable alias generation captured at declaration", () => {
    const cleanups = analyzeProgram(`
      async function main(left: AsyncIterable<number>, right: AsyncIterable<number>) {
        const first = left[Symbol.asyncIterator]()
        const second = right[Symbol.asyncIterator]()
        let active = first
        const snapshot = active
        active = second
        await snapshot.return!()
        await active.return!()
      }
    `);
    expect(cleanups.map(({ iterable, unknownReasons, scenarios }) => ({
      iterable, unknownReasons,
      transitions: scenarios[0]?.model.transitions.map(({ kind, evidence }) => [kind, evidence]),
      status: evaluateResourceProtocol(scenarios[0]!.model).status,
    }))).toEqual([
      { iterable: "left[Symbol.asyncIterator]()", unknownReasons: [], transitions: [["release", "exact"]], status: "satisfied" },
      { iterable: "right[Symbol.asyncIterator]()", unknownReasons: [], transitions: [["release", "exact"]], status: "satisfied" },
    ]);
  });

  it("does not classify unrelated same-spelled methods as an async iterator", () => {
    expect(analyzeProgram(`
      async function main(value: { next(): Promise<void>; return(): Promise<void> }) {
        const renamed = value
        await renamed.next()
        await renamed.return()
      }
    `)).toEqual([]);
  });

  it("keeps missing, unawaited, and post-close manual protocol obligations visible", () => {
    const cleanups = analyzeProgram(`
      async function missing(values: AsyncIterable<number>) {
        const iterator = values[Symbol.asyncIterator]()
        await iterator.next()
      }
      async function unawaited(values: AsyncIterable<number>) {
        const iterator = values[Symbol.asyncIterator]()
        await iterator.next()
        iterator.return!()
      }
      async function reused(values: AsyncIterable<number>) {
        const iterator = values[Symbol.asyncIterator]()
        await iterator.return!()
        await iterator.next()
      }
    `);
    expect(cleanups.map(({ owner, unknownReasons }) => [owner, unknownReasons])).toEqual([
      ["missing", ["manual-iterator-not-closed"]],
      ["unawaited", ["unawaited-iterator-operation"]],
      ["reused", []],
    ]);
    expect(cleanups.map(({ scenarios }) => evaluateResourceProtocol(scenarios[0]!.model).status)).toEqual([
      "unsatisfied", "satisfied", "unknown",
    ]);
  });

  it("fails closed instead of guessing conditional manual protocol order", () => {
    const [cleanup] = analyzeProgram(`
      async function main(values: AsyncIterable<number>, close: boolean) {
        const iterator = values[Symbol.asyncIterator]()
        await iterator.next()
        if (close) await iterator.return!()
      }
    `);
    expect(cleanup).toMatchObject({
      unknownReasons: ["conditional-manual-protocol"],
      scenarios: [{ model: { transitions: [
        { kind: "use", evidence: "exact" },
        { kind: "release", evidence: "unknown", conditional: true },
      ] } }],
    });
    expect(evaluateResourceProtocol(cleanup!.scenarios[0]!.model).status).toBe("unknown");
  });

  it("proves a direct if/else whose every branch closes the manual iterator", () => {
    const cleanups = analyzeAllIterators(`
      async function main(values: AsyncIterable<number>, first: boolean) {
        const iterator = values[Symbol.asyncIterator]()
        await iterator.next()
        if (first) await iterator.return!()
        else { await iterator.return!() }
      }
      function sync(values: Iterable<number>, first: boolean) {
        const iterator = values[Symbol.iterator]()
        iterator.next()
        if (first) iterator.return!()
        else { iterator.return!() }
      }
    `);
    expect(cleanups).toMatchObject([
      { protocol: "async", owner: "main", unknownReasons: [], scenarios: [{ exit: "manual-return", model: { transitions: [
        { kind: "use", evidence: "exact" }, { kind: "release", evidence: "exact" },
      ] } }] },
      { protocol: "sync", owner: "sync", unknownReasons: [], scenarios: [{ exit: "manual-return", model: { transitions: [
        { kind: "use", evidence: "exact" }, { kind: "release", evidence: "exact" },
      ] } }] },
    ]);
    expect(cleanups.map(({ scenarios }) => evaluateResourceProtocol(scenarios[0]!.model).status))
      .toEqual(["satisfied", "satisfied"]);
  });

  it("joins guard cleanup with the fallthrough close", () => {
    const cleanups = analyzeAllIterators(`
      async function asyncGuard(values: AsyncIterable<number>, stop: boolean) {
        const iterator = values[Symbol.asyncIterator]()
        if (stop) { await iterator.return!(); return }
        await iterator.next()
        await iterator.return!()
      }
      function syncGuard(values: Iterable<number>, stop: boolean) {
        const iterator = values[Symbol.iterator]()
        if (stop) { iterator.return!(); throw new Error("stop") }
        iterator.next()
        iterator.return!()
      }
    `);
    expect(cleanups.map(({ owner, unknownReasons, scenarios }) => ({
      owner, unknownReasons, transitions: scenarios[0]?.model.transitions.map(({ kind, evidence }) => [kind, evidence]),
      status: evaluateResourceProtocol(scenarios[0]!.model).status,
    }))).toEqual([
      { owner: "asyncGuard", unknownReasons: [], transitions: [["use", "exact"], ["release", "exact"]], status: "satisfied" },
      { owner: "syncGuard", unknownReasons: [], transitions: [["use", "exact"], ["release", "exact"]], status: "satisfied" },
    ]);
  });

  it("does not treat a fallthrough close as dominating an earlier unclosed return", () => {
    const [cleanup] = analyzeProgram(`
      async function main(values: AsyncIterable<number>, stop: boolean) {
        const iterator = values[Symbol.asyncIterator]()
        if (stop) return
        await iterator.next()
        await iterator.return!()
      }
    `);
    expect(cleanup).toMatchObject({
      unknownReasons: ["conditional-manual-protocol"],
      scenarios: [{ model: { transitions: [
        { kind: "use", evidence: "exact" },
        { kind: "release", evidence: "unknown", conditional: true },
      ] } }],
    });
    expect(evaluateResourceProtocol(cleanup!.scenarios[0]!.model).status).toBe("unknown");
  });

  it("keeps nested bypass and possible double close fail-closed", () => {
    const cleanups = analyzeProgram(`
      async function nested(values: AsyncIterable<number>, outer: boolean, inner: boolean) {
        const iterator = values[Symbol.asyncIterator]()
        if (outer) { if (inner) return }
        await iterator.return!()
      }
      async function duplicate(values: AsyncIterable<number>, close: boolean) {
        const iterator = values[Symbol.asyncIterator]()
        if (close) await iterator.return!()
        await iterator.return!()
      }
    `);
    expect(cleanups.map(({ owner, unknownReasons, scenarios }) => ({
      owner, unknownReasons, status: evaluateResourceProtocol(scenarios[0]!.model).status,
    }))).toEqual([
      { owner: "nested", unknownReasons: ["conditional-manual-protocol"], status: "unknown" },
      { owner: "duplicate", unknownReasons: ["conditional-manual-protocol"], status: "unknown" },
    ]);
  });

  it("joins guarded switch and catch exits with a fallthrough close", () => {
    const cleanups = analyzeProgram(`
      async function switched(values: AsyncIterable<number>, mode: string) {
        const iterator = values[Symbol.asyncIterator]()
        switch (mode) {
          case "return": await iterator.return!(); return
          case "throw": await iterator.return!(); throw new Error("stop")
          default: await iterator.next()
        }
        await iterator.return!()
      }
      async function caught(values: AsyncIterable<number>) {
        const iterator = values[Symbol.asyncIterator]()
        try { await iterator.next() }
        catch { await iterator.return!(); return }
        await iterator.return!()
      }
    `);
    expect(cleanups.map(({ owner, unknownReasons, scenarios }) => ({
      owner, unknownReasons, transitions: scenarios[0]?.model.transitions.map(({ kind, evidence }) => [kind, evidence]),
      status: evaluateResourceProtocol(scenarios[0]!.model).status,
    }))).toEqual([
      { owner: "switched", unknownReasons: [], transitions: [["use", "exact"], ["release", "exact"]], status: "satisfied" },
      { owner: "caught", unknownReasons: [], transitions: [["use", "exact"], ["release", "exact"]], status: "satisfied" },
    ]);
  });

  it("rejects unguarded switch, catch, and loop exits before a later close", () => {
    const cleanups = analyzeProgram(`
      async function switched(values: AsyncIterable<number>, stop: boolean) {
        const iterator = values[Symbol.asyncIterator]()
        switch (stop) { case true: return }
        await iterator.return!()
      }
      async function caught(values: AsyncIterable<number>) {
        const iterator = values[Symbol.asyncIterator]()
        try { await iterator.next() } catch { return }
        await iterator.return!()
      }
      async function looped(values: AsyncIterable<number>, stops: boolean[]) {
        const iterator = values[Symbol.asyncIterator]()
        for (const stop of stops) { if (stop) return }
        await iterator.return!()
      }
    `);
    expect(cleanups.map(({ owner, unknownReasons, scenarios }) => ({
      owner, unknownReasons, status: evaluateResourceProtocol(scenarios[0]!.model).status,
    }))).toEqual([
      { owner: "switched", unknownReasons: ["conditional-manual-protocol"], status: "unknown" },
      { owner: "caught", unknownReasons: ["conditional-manual-protocol"], status: "unknown" },
      { owner: "looped", unknownReasons: ["conditional-manual-protocol"], status: "unknown" },
    ]);
  });

  it("projects async generator yield-star exhaustion and consumer close", () => {
    const [cleanup] = analyzeProgram(`
      async function* forward(source: AsyncIterable<number>) {
        yield* source
      }
    `);
    expect(cleanup).toMatchObject({
      owner: "forward", iterable: "source", coverage: "reviewed-yield-star-delegation",
      unknownReasons: ["delegation-step-failure"],
    });
    expect(cleanup!.scenarios.map(({ exit }) => exit)).toEqual(["exhausted", "delegated-return", "delegated-throw"]);
    expect(cleanup!.scenarios[1]).toMatchObject({
      close: { method: "return-if-present", resultLane: "microtask-if-present" },
      model: { transitions: [{ kind: "release", evidence: "exact" }] },
    });
    expect(cleanup!.scenarios[2]).toMatchObject({ model: { transitions: [
      { kind: "escape", evidence: "unknown", conditional: true },
    ] } });
    expect(cleanup!.scenarios.map(({ model }) => evaluateResourceProtocol(model).status))
      .toEqual(["satisfied", "satisfied", "unknown"]);
  });

  it("transfers a manually acquired iterator returned to its caller", () => {
    const [cleanup] = analyzeProgram(`
      async function handoff(values: AsyncIterable<number>): Promise<AsyncIterator<number>> {
        const cursor = values[Symbol.asyncIterator]()
        const result = cursor
        await cursor.next()
        return result
      }
    `);
    expect(cleanup).toMatchObject({
      owner: "handoff", coverage: "reviewed-manual-protocol", unknownReasons: [],
      scenarios: [{
        exit: "manual-escape",
        model: {
          resources: [{ requiredTerminalStates: ["released", "escaped", "consumed", "transferred"] }],
          transitions: [{ kind: "use", evidence: "exact" }, { kind: "escape", evidence: "exact" }],
        },
      }],
    });
    expect(evaluateResourceProtocol(cleanup!.scenarios[0]!.model).status).toBe("satisfied");
  });

  it("keeps an iterator passed to an uncontracted call as an unknown escape", () => {
    const [cleanup] = analyzeProgram(`
      declare function consume(value: AsyncIterator<number>): void
      async function main(values: AsyncIterable<number>) {
        const cursor = values[Symbol.asyncIterator]()
        consume(cursor)
      }
    `);
    expect(cleanup).toMatchObject({
      owner: "main", unknownReasons: ["iterator-passed-to-call"],
      scenarios: [{ exit: "manual-escape", model: { transitions: [
        { kind: "escape", evidence: "unknown", conditional: true },
      ] } }],
    });
    expect(evaluateResourceProtocol(cleanup!.scenarios[0]!.model).status).toBe("unknown");
  });

  it("recognizes the authenticated Array.from builtin as a synchronous iterator consumer", () => {
    const [cleanup] = analyzeAllIterators(`
      function main() {
        const cursor = [1, 2, 3].values()
        const materialize = Array.from
        materialize(cursor)
      }
    `).filter(({ protocol }) => protocol === "sync");
    expect(cleanup).toMatchObject({ owner: "main", unknownReasons: [], scenarios: [{
      exit: "manual-consume",
      model: { transitions: [{ kind: "consume", evidence: "exact" }] },
    }] });
    expect(evaluateResourceProtocol(cleanup!.scenarios[0]!.model).status).toBe("satisfied");
  });

  it("does not trust a same-spelled mutable Array.from replacement", () => {
    const [cleanup] = analyzeAllIterators(`
      function main() {
        const cursor = [1, 2, 3].values()
        let materialize: typeof Array.from = Array.from
        materialize = ((value: Iterable<unknown>) => []) as typeof Array.from
        materialize(cursor)
      }
    `).filter(({ protocol }) => protocol === "sync");
    expect(cleanup).toMatchObject({ owner: "main", unknownReasons: ["iterator-passed-to-call"] });
  });

  it("transfers ownership through a returned inline closure without executing its body", () => {
    const [cleanup] = analyzeProgram(`
      function makeReader(values: AsyncIterable<number>) {
        const cursor = values[Symbol.asyncIterator]()
        return async () => cursor.next()
      }
    `);
    expect(cleanup).toMatchObject({
      owner: "makeReader", unknownReasons: [], scenarios: [{
        exit: "manual-escape",
        model: { transitions: [{ kind: "escape", evidence: "exact" }] },
      }],
    });
    expect(cleanup!.scenarios[0]!.model.transitions).toHaveLength(1);
    expect(evaluateResourceProtocol(cleanup!.scenarios[0]!.model).status).toBe("satisfied");
  });

  it("resolves a returned immutable closure alias as an iterator escape", () => {
    const [cleanup] = analyzeProgram(`
      function makeReader(values: AsyncIterable<number>) {
        const cursor = values[Symbol.asyncIterator]()
        const read = async () => cursor.next()
        const renamed = read
        return renamed
      }
    `);
    expect(cleanup).toMatchObject({ owner: "makeReader", unknownReasons: [], scenarios: [{
      exit: "manual-escape", model: { transitions: [{ kind: "escape", evidence: "exact" }] },
    }] });
  });

  it("uses a resource callable contract to classify iterator call ownership", () => {
    const [cleanup] = analyzeProgram(`
      /* uneffect: consume value */
      async function drain(value: AsyncIterator<number>) { await value.next() }
      async function main(values: AsyncIterable<number>) {
        const cursor = values[Symbol.asyncIterator]()
        drain(cursor)
      }
    `);
    expect(cleanup).toMatchObject({ owner: "main", unknownReasons: [], scenarios: [{
      exit: "manual-consume",
      model: {
        resources: [{ requiredTerminalStates: ["released", "escaped", "consumed", "transferred"] }],
        transitions: [{ kind: "consume", evidence: "trusted" }],
      },
    }] });
    expect(evaluateResourceProtocol(cleanup!.scenarios[0]!.model).status).toBe("satisfied");
  });

  it("uses a trusted resource contract declared on an ambient external API", () => {
    const [cleanup] = analyzeProgram(`
      /* uneffect: transfer value -> return */
      declare function handoff(value: AsyncIterator<number>): AsyncIterator<number>
      function main(values: AsyncIterable<number>) {
        const cursor = values[Symbol.asyncIterator]()
        const owned = handoff(cursor)
        return owned
      }
    `);
    expect(cleanup).toMatchObject({ owner: "main", unknownReasons: [], scenarios: [{
      exit: "manual-transfer",
      model: { transitions: [{ kind: "transfer", evidence: "trusted" }] },
    }] });
  });

  it("surfaces iterator obligations through checkFiles and strict diagnostics", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-iterator-check-"));
    try {
      const fileName = join(directory, "entry.ts");
      writeFileSync(fileName, `
        async function main(values: AsyncIterable<number>) {
          const iterator = values[Symbol.asyncIterator]()
          await iterator.next()
        }
      `);
      const result = await checkFiles([fileName], { mode: "strict", requireAnnotations: false });
      expect(result.asyncIterators).toMatchObject([{
        fileName, owner: "main", status: "unsatisfied", evidence: "unknown",
        unknownReasons: ["manual-iterator-not-closed"],
      }]);
      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        domain: "async-iterator", kind: "unclosed", severity: "error", fileName, functionName: "main",
      }));
      expect(result.errors).toBeGreaterThan(0);
      expect(assessCheckAssurance(result, "no-unknown")).toMatchObject({
        status: "violated", passed: false,
        coverage: { asyncIteratorObligations: 1 },
        blockers: expect.arrayContaining([expect.objectContaining({ kind: "async-iterator", classification: "violation", functionName: "main" })]),
      });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("records a used trusted iterator boundary in the assumption ledger", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-iterator-assumption-"));
    try {
      const fileName = join(directory, "entry.ts");
      writeFileSync(fileName, `
        /* uneffect: consume value */
        declare function drain(value: AsyncIterator<number>): void
        function main(values: AsyncIterable<number>) {
          const iterator = values[Symbol.asyncIterator]()
          drain(iterator)
        }
      `);
      const result = await checkFiles([fileName], { mode: "strict", requireAnnotations: false });
      expect(result.asyncIterators).toMatchObject([{ owner: "main", status: "satisfied", evidence: "trusted" }]);
      expect(result.assumptions.entries).toContainEqual(expect.objectContaining({
        domain: "resource-callable", evidence: "trusted", scope: { fileName, functionName: "main", span: expect.any(Object) },
      }));
      expect(assessCheckAssurance(result, "no-unknown")).toMatchObject({ status: "assumed", passed: true });
      expect(assessCheckAssurance(result, "verified")).toMatchObject({ status: "unknown", passed: false });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("proves an unconditional awaited return in finally across next rejection", () => {
    const [cleanup] = analyzeProgram(`
      async function main(values: AsyncIterable<number>, stop: boolean) {
        const iterator = values[Symbol.asyncIterator]()
        try {
          await iterator.next()
          if (stop) return
          await iterator.next()
        } finally {
          await iterator.return!()
        }
      }
    `);
    expect(cleanup).toMatchObject({
      owner: "main",
      coverage: "reviewed-manual-protocol", unknownReasons: [],
      scenarios: [{ exit: "manual-return", model: { transitions: [
        { kind: "use", evidence: "exact" },
        { kind: "use", evidence: "exact" },
        { kind: "release", evidence: "exact" },
      ] } }],
    });
    expect(evaluateResourceProtocol(cleanup!.scenarios[0]!.model).status).toBe("satisfied");
  });

  it("keeps close in try or a conditional finally close fail-closed", () => {
    const cleanups = analyzeProgram(`
      async function closeInTry(values: AsyncIterable<number>) {
        const iterator = values[Symbol.asyncIterator]()
        try { await iterator.next(); await iterator.return!() } catch {}
      }
      async function conditionalFinally(values: AsyncIterable<number>, close: boolean) {
        const iterator = values[Symbol.asyncIterator]()
        try { await iterator.next() } finally { if (close) await iterator.return!() }
      }
    `);
    expect(cleanups.map(({ owner, unknownReasons }) => [owner, unknownReasons])).toEqual([
      ["closeInTry", ["conditional-manual-protocol"]],
      ["conditionalFinally", ["conditional-manual-protocol"]],
    ]);
    expect(cleanups.map(({ scenarios }) => evaluateResourceProtocol(scenarios[0]!.model).status)).toEqual(["unknown", "unknown"]);
  });

  it("does not claim finally dominance across an intervening awaited operation", () => {
    const [cleanup] = analyzeProgram(`
      declare function before(): Promise<void>
      async function main(values: AsyncIterable<number>) {
        const iterator = values[Symbol.asyncIterator]()
        await before()
        try { await iterator.next() } finally { await iterator.return!() }
      }
    `);
    expect(cleanup).toMatchObject({ unknownReasons: ["conditional-manual-protocol"] });
    expect(cleanup!.scenarios[0]!.model.transitions).toContainEqual(expect.objectContaining({
      kind: "release", evidence: "unknown", conditional: true,
    }));
  });

  it("projects synchronous for-of exhaustion and abrupt IteratorClose", () => {
    const [cleanup] = analyzeAllIterators(`
      function main(mode: string, values: Iterable<number>) {
        for (const value of values) {
          if (mode === "break") break
          if (mode === "return") return value
          if (mode === "throw") throw new Error("stop")
        }
      }
    `);
    expect(cleanup).toMatchObject({
      protocol: "sync", owner: "main", iterable: "values",
      coverage: "reviewed-explicit-completions", unknownReasons: [],
    });
    expect(cleanup!.scenarios.map(({ exit }) => exit)).toEqual(["exhausted", "break", "return", "throw"]);
    for (const scenario of cleanup!.scenarios.slice(1)) expect(scenario.close).toMatchObject({
      lookupLane: "inline", resultLane: "inline", method: "return-if-present", failure: "throw",
    });
    expect(cleanup!.scenarios.map(({ model }) => evaluateResourceProtocol(model).status))
      .toEqual(["satisfied", "satisfied", "satisfied", "satisfied"]);
  });

  it("preserves labeled ownership and finally uncertainty for synchronous IteratorClose", () => {
    const cleanups = analyzeAllIterators(`
      function nested(outerValues: Iterable<number>, innerValues: Iterable<number>) {
        outer: for (const outerValue of outerValues) {
          for (const innerValue of innerValues) {
            if (innerValue > outerValue) break outer
          }
        }
      }
      function throughFinally(values: Iterable<number>) {
        for (const value of values) {
          try { break } finally { if (value > 0) continue }
        }
      }
    `);
    expect(cleanups.map(({ owner, iterable, scenarios, unknownReasons }) => ({
      owner, iterable, exits: scenarios.map(({ exit }) => exit), unknownReasons,
    }))).toEqual([
      { owner: "nested", iterable: "outerValues", exits: ["exhausted", "break"], unknownReasons: [] },
      { owner: "nested", iterable: "innerValues", exits: ["exhausted", "break"], unknownReasons: [] },
      { owner: "throughFinally", iterable: "values", exits: ["exhausted"], unknownReasons: ["abrupt-through-finally"] },
    ]);
  });

  it("models normal finally and implicit throws for synchronous IteratorClose", () => {
    const cleanups = analyzeAllIterators(`
      function normalFinally(values: Iterable<number>) {
        for (const value of values) {
          try { break } finally { console.log(value) }
        }
      }
      function implicitThrow(values: Iterable<number>) {
        for (const value of values) consume(value)
      }
      declare function consume(value: number): void
    `);
    expect(cleanups.map(({ owner, unknownReasons, scenarios }) => ({
      owner, unknownReasons, exits: scenarios.map(({ exit }) => exit),
    }))).toEqual([
      { owner: "normalFinally", unknownReasons: [], exits: ["exhausted", "break", "throw"] },
      { owner: "implicitThrow", unknownReasons: [], exits: ["exhausted", "throw"] },
    ]);
  });

  it("publishes synchronous IteratorClose through checkFiles", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-sync-iterator-check-"));
    try {
      const fileName = join(directory, "entry.ts");
      writeFileSync(fileName, `
        function main(values: Iterable<number>) {
          for (const value of values) { if (value > 0) break }
        }
      `);
      const result = await checkFiles([fileName], { mode: "strict", requireAnnotations: false });
      expect(result.asyncIterators).toMatchObject([{
        fileName, protocol: "sync", owner: "main", status: "satisfied", evidence: "exact",
      }]);
      expect(result.diagnostics).not.toContainEqual(expect.objectContaining({ domain: "async-iterator" }));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("tracks manual synchronous Generator next, aliases, and return", () => {
    const [cleanup] = analyzeAllIterators(`
      function* generate() { yield 1; yield 2 }
      function main() {
        const cursor = generate()
        const renamed = cursor
        renamed.next()
        cursor.return(undefined)
      }
    `);
    expect(cleanup).toMatchObject({
      protocol: "sync", owner: "main", iterable: "generate()",
      coverage: "reviewed-manual-protocol", unknownReasons: [],
      scenarios: [{ exit: "manual-return", close: {
        lookupLane: "inline", resultLane: "inline", method: "return", failure: "throw",
      }, model: { transitions: [
        { kind: "use", evidence: "exact" }, { kind: "release", evidence: "exact" },
      ] } }],
    });
    expect(evaluateResourceProtocol(cleanup!.scenarios[0]!.model).status).toBe("satisfied");
  });

  it("keeps same-spelled non-Iterator methods outside manual sync analysis", () => {
    expect(analyzeAllIterators(`
      function main(value: { next(): void; return(): void }) {
        value.next()
        value.return()
      }
    `)).toEqual([]);
  });

  it("projects synchronous generator yield-star consumer close", () => {
    const [cleanup] = analyzeAllIterators(`
      function* forward(source: Iterable<number>) { yield* source }
    `);
    expect(cleanup).toMatchObject({
      protocol: "sync", owner: "forward", iterable: "source",
      coverage: "reviewed-yield-star-delegation", unknownReasons: ["delegation-step-failure"],
      scenarios: [
        { exit: "exhausted" },
        { exit: "delegated-return", close: { resultLane: "inline", failure: "throw" } },
        { exit: "delegated-throw", model: { transitions: [{ kind: "escape", evidence: "unknown", conditional: true }] } },
      ],
    });
  });

  it("composes synchronous manual iterators with finally and callable contracts", () => {
    const cleanups = analyzeAllIterators(`
      function* generate() { yield 1 }
      /* uneffect: consume value */
      declare function drain(value: Iterator<number>): void
      function protectedRead() {
        const iterator = generate()
        try { iterator.next() } finally { iterator.return(undefined) }
      }
      function delegated() {
        const iterator = generate()
        drain(iterator)
      }
    `);
    expect(cleanups.map(({ owner, scenarios, unknownReasons }) => ({
      owner, exit: scenarios[0]?.exit, transitions: scenarios[0]?.model.transitions.map(({ kind, evidence }) => [kind, evidence]), unknownReasons,
    }))).toEqual([
      { owner: "protectedRead", exit: "manual-return", transitions: [["use", "exact"], ["release", "exact"]], unknownReasons: [] },
      { owner: "delegated", exit: "manual-consume", transitions: [["consume", "trusted"]], unknownReasons: [] },
    ]);
  });

  it("tracks iterator identity through a frozen object property and destructuring", () => {
    const [cleanup] = analyzeAllIterators(`
      function* generate() { yield 1 }
      function main() {
        const iterator = generate()
        const holder = Object.freeze({ iterator })
        holder.iterator.next()
        const { iterator: renamed } = holder
        renamed.return(undefined)
      }
    `);
    expect(cleanup).toMatchObject({
      protocol: "sync", owner: "main", unknownReasons: [], scenarios: [{ model: { transitions: [
        { kind: "use", evidence: "exact" }, { kind: "release", evidence: "exact" },
      ] } }],
    });
  });

  it("does not treat a mutable same-shaped object property as stable identity", () => {
    expect(analyzeAllIterators(`
      function main(holder: { iterator: Iterator<number> }) {
        holder.iterator.next()
        holder.iterator.return?.()
      }
    `)).toEqual([]);
  });

  it("tracks frozen object aliases and static string element access", () => {
    const [cleanup] = analyzeAllIterators(`
      function* generate() { yield 1 }
      function main() {
        const iterator = generate()
        const holder = Object.freeze({ iterator })
        const alias = holder
        alias["iterator"].next()
        holder["iterator"].return(undefined)
      }
    `);
    expect(cleanup?.scenarios[0]?.model.transitions.map(({ kind }) => kind)).toEqual(["use", "release"]);
  });

  it("tracks write-screened local object and array iterator slots", () => {
    const cleanups = analyzeAllIterators(`
      function* generate() { yield 1 }
      function objectSlot() {
        const iterator = generate()
        const holder = { iterator }
        const alias = holder
        alias.iterator.next()
        holder["iterator"].return(undefined)
      }
      function arraySlot() {
        const iterator = generate()
        const holder = [iterator]
        holder[0].next()
        holder[0].return(undefined)
      }
    `);
    expect(cleanups.map(({ owner, unknownReasons, scenarios }) => ({
      owner, unknownReasons, transitions: scenarios[0]?.model.transitions.map(({ kind, evidence }) => [kind, evidence]),
      status: evaluateResourceProtocol(scenarios[0]!.model).status,
    }))).toEqual([
      { owner: "objectSlot", unknownReasons: [], transitions: [["use", "exact"], ["release", "exact"]], status: "satisfied" },
      { owner: "arraySlot", unknownReasons: [], transitions: [["use", "exact"], ["release", "exact"]], status: "satisfied" },
    ]);
  });

  it("tracks const object and array destructuring from stable local slots", () => {
    const cleanups = analyzeAllIterators(`
      function* generate() { yield 1 }
      function objectPattern() {
        const iterator = generate()
        const holder = { iterator }
        const { iterator: active } = holder
        active.next()
        active.return(undefined)
      }
      function arrayPattern() {
        const iterator = generate()
        const holder = [iterator]
        const [active] = holder
        active.next()
        active.return(undefined)
      }
    `);
    expect(cleanups.map(({ owner, unknownReasons, scenarios }) => ({
      owner, unknownReasons, transitions: scenarios[0]?.model.transitions.map(({ kind, evidence }) => [kind, evidence]),
      status: evaluateResourceProtocol(scenarios[0]!.model).status,
    }))).toEqual([
      { owner: "objectPattern", unknownReasons: [], transitions: [["use", "exact"], ["release", "exact"]], status: "satisfied" },
      { owner: "arrayPattern", unknownReasons: [], transitions: [["use", "exact"], ["release", "exact"]], status: "satisfied" },
    ]);
  });

  it("retains destructured iterator candidates from mutable or unstable slots as unknown", () => {
    const cleanups = analyzeAllIterators(`
      function* generate() { yield 1 }
      function mutableBinding() {
        const iterator = generate()
        const holder = { iterator }
        let { iterator: active } = holder
        active.return(undefined)
      }
      function unstableSlot(other: Iterator<number>) {
        const iterator = generate()
        const holder = [iterator]
        holder[0] = other
        const [active] = holder
        active.return(undefined)
      }
    `);
    expect(cleanups.map(({ owner, unknownReasons, scenarios }) => ({
      owner, unknownReasons, status: evaluateResourceProtocol(scenarios[0]!.model).status,
    }))).toEqual([
      { owner: "mutableBinding", unknownReasons: ["unstable-iterator-alias"], status: "unknown" },
      { owner: "unstableSlot", unknownReasons: ["unstable-iterator-alias"], status: "unknown" },
    ]);
  });

  it("retains rest and computed destructuring candidates as unknown", () => {
    const cleanups = analyzeAllIterators(`
      function* generate() { yield 1 }
      function restPattern() {
        const iterator = generate()
        const holder = { iterator }
        const { ...rest } = holder
        rest.iterator.return(undefined)
      }
      function computedPattern(key: "iterator") {
        const iterator = generate()
        const holder = { iterator }
        const { [key]: active } = holder
        active.return(undefined)
      }
    `);
    expect(cleanups.map(({ owner, unknownReasons, scenarios }) => ({
      owner, unknownReasons, status: evaluateResourceProtocol(scenarios[0]!.model).status,
    }))).toEqual([
      { owner: "restPattern", unknownReasons: ["unstable-iterator-alias"], status: "unknown" },
      { owner: "computedPattern", unknownReasons: ["unstable-iterator-alias"], status: "unknown" },
    ]);
  });

  it("invalidates local slot identity on writes, dynamic reads, and container escape", () => {
    const cleanups = analyzeAllIterators(`
      function* generate() { yield 1 }
      function written(other: Iterator<number>) {
        const iterator = generate()
        const holder = { iterator }
        holder.iterator = other
        holder.iterator.return(undefined)
      }
      function dynamic(key: "iterator") {
        const iterator = generate()
        const holder = { iterator }
        holder[key].return(undefined)
      }
      function escaped() {
        const iterator = generate()
        const holder = { iterator }
        inspect(holder)
      }
      function assigned(sink: { value?: unknown }) {
        const iterator = generate()
        const holder = [iterator]
        sink.value = holder
      }
      declare function inspect(value: unknown): void
    `);
    expect(cleanups.map(({ owner, unknownReasons, scenarios }) => ({
      owner, unknownReasons, status: evaluateResourceProtocol(scenarios[0]!.model).status,
    }))).toEqual([
      { owner: "written", unknownReasons: ["unstable-iterator-property"], status: "unknown" },
      { owner: "dynamic", unknownReasons: ["unstable-iterator-property"], status: "unknown" },
      { owner: "escaped", unknownReasons: ["unstable-iterator-property"], status: "unknown" },
      { owner: "assigned", unknownReasons: ["unstable-iterator-property"], status: "unknown" },
    ]);
  });

  it("tracks iterator ownership captured through local aggregate properties", () => {
    const cleanups = analyzeAllIterators(`
      function* generate() { yield 1 }
      function stable() {
        const iterator = generate()
        const holder = { iterator }
        return () => holder.iterator.next()
      }
      function unstable(other: Iterator<number>) {
        const iterator = generate()
        const holder = { iterator }
        holder.iterator = other
        return () => holder.iterator.next()
      }
    `);
    expect(cleanups.map(({ owner, unknownReasons, scenarios }) => ({
      owner, exit: scenarios[0]?.exit, evidence: scenarios[0]?.model.transitions[0]?.evidence,
      unknownReasons, status: evaluateResourceProtocol(scenarios[0]!.model).status,
    }))).toEqual([
      { owner: "stable", exit: "manual-escape", evidence: "exact", unknownReasons: [], status: "satisfied" },
      { owner: "unstable", exit: "manual-escape", evidence: "unknown", unknownReasons: ["unstable-iterator-property"], status: "unknown" },
    ]);
  });

  it("rejects shadowed freeze and dynamically selected property identity", () => {
    const cleanups = analyzeAllIterators(`
      function* generate() { yield 1 }
      function shadowed() {
        const iterator = generate()
        const Object = { freeze<T>(value: T): T { return value } }
        const holder = Object.freeze({ iterator })
        holder.iterator.next()
        holder.iterator.return(undefined)
      }
      function dynamic(key: "iterator") {
        const iterator = generate()
        const holder = globalThis.Object.freeze({ iterator })
        holder[key].next()
        holder[key].return(undefined)
      }
    `);
    expect(cleanups.map(({ owner, unknownReasons, scenarios }) => ({
      owner, unknownReasons, status: evaluateResourceProtocol(scenarios[0]!.model).status,
    }))).toEqual([
      { owner: "shadowed", unknownReasons: ["unstable-iterator-property"], status: "unknown" },
      { owner: "dynamic", unknownReasons: ["unstable-iterator-property"], status: "unknown" },
    ]);
  });

  it("distinguishes returned frozen and mutable iterator aggregates", () => {
    const cleanups = analyzeAllIterators(`
      function* generate() { yield 1 }
      function frozen() {
        const iterator = generate()
        const holder = Object.freeze({ iterator })
        return holder
      }
      function mutable() {
        const iterator = generate()
        const holder = { iterator }
        return holder
      }
    `);
    expect(cleanups.map(({ owner, unknownReasons, scenarios }) => ({
      owner, exit: scenarios[0]?.exit, evidence: scenarios[0]?.model.transitions[0]?.evidence,
      unknownReasons, status: evaluateResourceProtocol(scenarios[0]!.model).status,
    }))).toEqual([
      { owner: "frozen", exit: "manual-escape", evidence: "exact", unknownReasons: [], status: "satisfied" },
      { owner: "mutable", exit: "manual-escape", evidence: "unknown", unknownReasons: ["unstable-iterator-property"], status: "unknown" },
    ]);
  });

  it("treats canonical sync and async done-condition loops as natural exhaustion", () => {
    const cleanups = analyzeAllIterators(`
      function* generate() { yield 1 }
      async function* generateAsync() { yield 1 }
      function sync() {
        const iterator = generate()
        while (iterator.next().done === false) { console.log("value") }
      }
      async function asynchronous() {
        const iterator = generateAsync()
        while (!(await iterator.next()).done) { console.log("value") }
      }
    `);
    expect(cleanups.map(({ protocol, owner, unknownReasons, scenarios }) => ({
      protocol, owner, unknownReasons,
      exit: scenarios[0]?.exit,
      transitions: scenarios[0]?.model.transitions.map(({ kind }) => kind),
      status: evaluateResourceProtocol(scenarios[0]!.model).status,
    }))).toEqual([
      { protocol: "sync", owner: "sync", unknownReasons: [], exit: "manual-exhausted", transitions: ["use", "consume"], status: "satisfied" },
      { protocol: "async", owner: "asynchronous", unknownReasons: [], exit: "manual-exhausted", transitions: ["use", "consume"], status: "satisfied" },
    ]);
  });

  it("does not claim natural exhaustion when the done loop has another abrupt exit", () => {
    const [cleanup] = analyzeAllIterators(`
      function* generate() { yield 1 }
      function main(stop: boolean) {
        const iterator = generate()
        while (!iterator.next().done) {
          if (stop) break
        }
      }
    `);
    expect(cleanup).toMatchObject({ owner: "main", unknownReasons: ["manual-iterator-not-closed"], scenarios: [{ exit: "manual-open" }] });
    expect(evaluateResourceProtocol(cleanup!.scenarios[0]!.model).status).toBe("unsatisfied");
  });

  it("tracks Generator throw as a non-terminal protocol use", () => {
    const cleanups = analyzeAllIterators(`
      function* syncGenerator() { try { yield 1 } catch {} }
      async function* asyncGenerator() { try { yield 1 } catch {} }
      function sync() {
        const iterator = syncGenerator()
        iterator.throw(new Error("retry"))
        iterator.return(undefined)
      }
      async function asynchronous() {
        const iterator = asyncGenerator()
        await iterator.throw(new Error("retry"))
        await iterator.return(undefined)
      }
    `);
    expect(cleanups.map(({ owner, unknownReasons, scenarios }) => ({
      owner, unknownReasons, transitions: scenarios[0]?.model.transitions.map(({ kind }) => kind),
    }))).toEqual([
      { owner: "sync", unknownReasons: [], transitions: ["use", "release"] },
      { owner: "asynchronous", unknownReasons: [], transitions: ["use", "release"] },
    ]);
  });

  it("proves canonical bound IteratorResult done-break loops", () => {
    const cleanups = analyzeAllIterators(`
      function* generate() { yield 1 }
      async function* generateAsync() { yield 1 }
      function sync() {
        const iterator = generate()
        while (true) {
          const step = iterator.next()
          if (step.done) break
          console.log(step.value)
        }
      }
      async function asynchronous() {
        const iterator = generateAsync()
        for (;;) {
          const { done, value } = await iterator.next()
          if (done === true) break
          console.log(value)
        }
      }
    `);
    expect(cleanups.map(({ protocol, owner, unknownReasons, scenarios }) => ({
      protocol, owner, unknownReasons, exit: scenarios[0]?.exit,
      transitions: scenarios[0]?.model.transitions.map(({ kind }) => kind),
      status: evaluateResourceProtocol(scenarios[0]!.model).status,
    }))).toEqual([
      { protocol: "sync", owner: "sync", unknownReasons: [], exit: "manual-exhausted", transitions: ["use", "consume"], status: "satisfied" },
      { protocol: "async", owner: "asynchronous", unknownReasons: [], exit: "manual-exhausted", transitions: ["use", "consume"], status: "satisfied" },
    ]);
  });

  it("rejects a bound done loop with an alternate break", () => {
    const [cleanup] = analyzeAllIterators(`
      function* generate() { yield 1 }
      function main(stop: boolean) {
        const iterator = generate()
        while (true) {
          const step = iterator.next()
          if (step.done) break
          if (stop) break
        }
      }
    `);
    expect(cleanup).toMatchObject({ unknownReasons: ["manual-iterator-not-closed"], scenarios: [{ exit: "manual-open" }] });
  });

  it("proves canonical for-loop IteratorResult generations", () => {
    const cleanups = analyzeAllIterators(`
      function* generate() { yield 1 }
      async function* generateAsync() { yield 1 }
      function sync() {
        const iterator = generate()
        for (let step = iterator.next(); !step.done; step = iterator.next()) {
          console.log(step.value)
        }
      }
      async function asynchronous() {
        const iterator = generateAsync()
        for (let step = await iterator.next(); step.done === false; step = await iterator.next()) {
          console.log(step.value)
        }
      }
    `);
    expect(cleanups.map(({ protocol, owner, unknownReasons, scenarios }) => ({
      protocol, owner, unknownReasons, exit: scenarios[0]?.exit,
      transitions: scenarios[0]?.model.transitions.map(({ kind }) => kind),
      status: evaluateResourceProtocol(scenarios[0]!.model).status,
    }))).toEqual([
      { protocol: "sync", owner: "sync", unknownReasons: [], exit: "manual-exhausted", transitions: ["use", "use", "consume"], status: "satisfied" },
      { protocol: "async", owner: "asynchronous", unknownReasons: [], exit: "manual-exhausted", transitions: ["use", "use", "consume"], status: "satisfied" },
    ]);
  });

  it("rejects a canonical-looking for loop with another exit", () => {
    const [cleanup] = analyzeAllIterators(`
      function* generate() { yield 1 }
      function main(stop: boolean) {
        const iterator = generate()
        for (let step = iterator.next(); !step.done; step = iterator.next()) {
          if (stop) break
        }
      }
    `);
    expect(cleanup).toMatchObject({ unknownReasons: ["manual-iterator-not-closed"], scenarios: [{ exit: "manual-open" }] });
  });

  it("rejects a for-loop result generation updated from another iterator", () => {
    const cleanups = analyzeAllIterators(`
      function* generate() { yield 1 }
      function main() {
        const left = generate()
        const right = generate()
        for (let result = left.next(); !result.done; result = right.next()) {}
      }
    `);
    expect(cleanups.map(({ iterable, unknownReasons, scenarios }) => ({ iterable, unknownReasons, exit: scenarios[0]?.exit }))).toEqual([
      { iterable: "generate()", unknownReasons: ["manual-iterator-not-closed"], exit: "manual-open" },
      { iterable: "generate()", unknownReasons: ["manual-iterator-not-closed"], exit: "manual-open" },
    ]);
  });

  it("surfaces iterator obligations through verifyUneffectProject assurance", async () => {
    const fileName = "/entry.ts";
    const result = await verifyUneffectProject({ files: { [fileName]: `
      async function main(values: AsyncIterable<number>) {
        const iterator = values[Symbol.asyncIterator]()
        await iterator.next()
      }
    ` } });
    expect(result.asyncIterators).toMatchObject([{
      fileName, protocol: "async", owner: "main", status: "unsatisfied", evidence: "unknown",
    }]);
    expect(result.assurance).toMatchObject({
      status: "violated", passed: false,
      coverage: { iteratorObligations: 1 },
      blockers: expect.arrayContaining([expect.objectContaining({ domain: "iterator", classification: "violation", subject: "main" })]),
    });
  });

  it("accounts for trusted iterator consumers in project assumption policy", async () => {
    const fileName = "/entry.ts";
    const files = { [fileName]: `
      /* uneffect: consume value */
      declare function drain(value: AsyncIterator<number>): void
      function main(values: AsyncIterable<number>) {
        const iterator = values[Symbol.asyncIterator]()
        drain(iterator)
      }
    ` };
    const trusted = await verifyUneffectProject({ files });
    expect(trusted.asyncIterators).toMatchObject([{
      fileName, protocol: "async", owner: "main", status: "satisfied", evidence: "trusted",
    }]);
    expect(trusted.assumptions.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ domain: "resource-callable", evidence: "trusted" }),
    ]));
    expect(trusted.assurance).toMatchObject({ status: "assumed", passed: true, assumptions: 1 });

    const governed = await verifyUneffectProject({ files, assumptionPolicy: { requireExpiration: true } });
    expect(governed.assumptions.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({ domain: "resource-callable", rule: "expiration-required" }),
    ]));
    expect(governed.assurance).toMatchObject({ status: "violated", passed: false });
  });

  it("does not claim exact iterator evidence for invalid TypeScript or specification modules", async () => {
    const result = await verifyUneffectProject({ files: {
      "/entry.ts": `
        function main(values: Iterable<number>) {
          const iterator = values[Symbol.iterator]()
          iterator.return()
          const invalid: string = 1
        }
      `,
      "/model.uneffect.ts": `
        export function ignored(values: Iterable<number>) {
          const iterator = values[Symbol.iterator]()
          iterator.next()
        }
      `,
    } });
    expect(result.asyncIterators).toMatchObject([{
      fileName: "/entry.ts", owner: "main", status: "unknown", evidence: "unknown",
    }]);
    expect(result.asyncIterators).toHaveLength(1);
    expect(result.assurance.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ domain: "iterator", classification: "unknown", subject: "main" }),
      expect.objectContaining({ domain: "typescript", classification: "violation" }),
    ]));
  });
});
