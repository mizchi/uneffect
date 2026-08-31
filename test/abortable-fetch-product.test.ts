import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { analyzeAbortableFetchesInProgram, generateAbortableFetchProductQuint } from "../src/abortable-fetch-product.js";

describe("abortable fetch product", () => {
  it("connects fetch completion, rejection, and a conditional controller abort", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-abortable-fetch-"));
    try {
      const fileName = join(directory, "entry.ts");
      writeFileSync(fileName, `
        export async function main(cancel: boolean) {
          const controller = new AbortController()
          const request = fetch("https://api.example.com/data", { signal: controller.signal })
          if (cancel) controller.abort("stop")
          return await request
        }
        const local = { fetch(_url: string, _options: object) { return Promise.resolve("local") } }
        local.fetch("local", {})
      `);
      const program = ts.createProgram([fileName], {
        target: ts.ScriptTarget.ES2024, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], noEmit: true,
      });
      const analysis = analyzeAbortableFetchesInProgram(program, program.getSourceFile(fileName)!);
      expect(analysis.fetches).toEqual([
        expect.objectContaining({ owner: "main", binding: "request", url: '"https://api.example.com/data"', controller: "controller", evidence: "exact" }),
      ]);
      expect(analysis.unknown).toEqual([]);
      const quint = generateAbortableFetchProductQuint("abortable_fetch", analysis);
      expect(quint).toContain("action abort_0");
      expect(quint).toContain("action fulfill_fetch_0");
      expect(quint).toContain("action reject_fetch_0");
      expect(quint).toContain("fetch_0_state' = 3");
      const quintFile = join(directory, "model.qnt");
      writeFileSync(quintFile, quint);
      expect(spawnSync("quint", ["typecheck", quintFile], { encoding: "utf8" })).toMatchObject({ status: 0 });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("resolves stable signal aliases and AbortSignal.any compositions", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-abortable-fetch-any-"));
    try {
      const fileName = join(directory, "entry.ts");
      writeFileSync(fileName, `
        export function directAlias(cancel: boolean) {
          const controller = new AbortController()
          const signal = controller.signal
          const request = fetch("https://api.example.com/alias", { signal })
          if (cancel) controller.abort("alias-stop")
          return request
        }
        export function composed(controller: AbortController) {
          const local = new AbortController()
          const signal = AbortSignal.any([controller.signal, local.signal, AbortSignal.timeout(25)])
          const request = fetch("https://api.example.com/any", { signal })
          return request
        }
        export function preAborted() {
          const signal = AbortSignal.any([AbortSignal.abort("already"), AbortSignal.timeout(25)])
          const request = fetch("https://api.example.com/pre-aborted", { signal })
          return request
        }
        class LocalAbortSignal { static any(signals: AbortSignal[]) { return signals[0] } }
        export function lookalike(controller: AbortController) {
          const signal = LocalAbortSignal.any([controller.signal])
          const request = fetch("https://api.example.com/local", { signal })
          return request
        }
      `);
      const program = ts.createProgram([fileName], {
        target: ts.ScriptTarget.ES2024, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], noEmit: true,
      });
      const analysis = analyzeAbortableFetchesInProgram(program, program.getSourceFile(fileName)!);
      expect(analysis.fetches).toEqual([
        expect.objectContaining({ owner: "directAlias", binding: "request", controller: "controller", signalKind: "controller-alias" }),
        expect.objectContaining({ owner: "composed", binding: "request", signalKind: "abort-any", abortComposition: 0 }),
        expect.objectContaining({ owner: "preAborted", binding: "request", signalKind: "abort-any", abortComposition: 1, abortReason: '"already"', abortConditional: false }),
      ]);
      expect(analysis.unknown).toEqual([
        expect.objectContaining({ expression: expect.stringContaining("api.example.com/local"), reason: expect.stringContaining("statically resolved") }),
      ]);
      const quint = generateAbortableFetchProductQuint("abortable_fetch_any", analysis);
      expect(quint).toContain("action abort_1");
      expect(quint).toContain("fetch_2_state' = 3");
      const quintFile = join(directory, "model.qnt");
      writeFileSync(quintFile, quint);
      expect(spawnSync("quint", ["typecheck", quintFile], { encoding: "utf8" })).toMatchObject({ status: 0 });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("accepts a single-use const RequestInit alias and rejects mutated options", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-abortable-fetch-options-"));
    try {
      const fileName = join(directory, "entry.ts");
      writeFileSync(fileName, `
        export function exact() {
          const controller = new AbortController()
          const init = { signal: controller.signal }
          const request = fetch("https://api.example.com/exact", init)
          return request
        }
        export function mutated(other: AbortSignal) {
          const controller = new AbortController()
          const init = { signal: controller.signal }
          init.signal = other
          const request = fetch("https://api.example.com/mutated", init)
          return request
        }
      `);
      const program = ts.createProgram([fileName], {
        target: ts.ScriptTarget.ES2024, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], noEmit: true,
      });
      const analysis = analyzeAbortableFetchesInProgram(program, program.getSourceFile(fileName)!);
      expect(analysis.fetches).toEqual([
        expect.objectContaining({ owner: "exact", binding: "request", controller: "controller", optionsKind: "single-use-const-alias" }),
      ]);
      expect(analysis.unknown).toEqual([
        expect.objectContaining({ expression: expect.stringContaining("api.example.com/mutated"), reason: expect.stringContaining("RequestInit") }),
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("connects abortable fetch state to Promise ownership", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-abortable-fetch-ownership-"));
    try {
      const fileName = join(directory, "entry.ts");
      writeFileSync(fileName, `
        export function returned() {
          const controller = new AbortController()
          const request = fetch("https://api.example.com/returned", { signal: controller.signal })
          return request
        }
        export function floating() {
          const controller = new AbortController()
          const request = fetch("https://api.example.com/floating", { signal: controller.signal })
          console.log("forgot", request instanceof Promise)
        }
      `);
      const program = ts.createProgram([fileName], {
        target: ts.ScriptTarget.ES2024, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], noEmit: true,
      });
      const analysis = analyzeAbortableFetchesInProgram(program, program.getSourceFile(fileName)!);
      expect(analysis.fetches).toEqual([
        expect.objectContaining({ owner: "returned", promiseStatus: "observed", promiseObservations: ["return"] }),
        expect.objectContaining({ owner: "floating", promiseStatus: "floating", promiseObservations: [] }),
      ]);
      const quint = generateAbortableFetchProductQuint("abortable_fetch_ownership", analysis);
      expect(quint).toContain("val abortableFetchObserved = false");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("tracks direct Response body consumption", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-abortable-fetch-body-"));
    try {
      const fileName = join(directory, "entry.ts");
      writeFileSync(fileName, `
        export async function consumed() {
          const controller = new AbortController()
          const request = fetch("https://api.example.com/consumed", { signal: controller.signal })
          const response = await request
          return await response.json()
        }
        export async function unconsumed() {
          const controller = new AbortController()
          const request = fetch("https://api.example.com/unconsumed", { signal: controller.signal })
          const response = await request
          return response.status
        }
        export async function conditional(flag: boolean) {
          const controller = new AbortController()
          const request = fetch("https://api.example.com/conditional", { signal: controller.signal })
          const response = await request
          if (flag) await response.text()
          return response.status
        }
      `);
      const program = ts.createProgram([fileName], {
        target: ts.ScriptTarget.ES2024, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], noEmit: true,
      });
      const analysis = analyzeAbortableFetchesInProgram(program, program.getSourceFile(fileName)!);
      expect(analysis.fetches).toEqual([
        expect.objectContaining({ owner: "consumed", responseBinding: "response", responseBodyStatus: "consumed", responseBodyOperation: "json" }),
        expect.objectContaining({ owner: "unconsumed", responseBinding: "response", responseBodyStatus: "unconsumed" }),
        expect.objectContaining({ owner: "conditional", responseBinding: "response", responseBodyStatus: "unknown", responseBodyOperation: "text" }),
      ]);
      const quint = generateAbortableFetchProductQuint("abortable_fetch_body", analysis);
      expect(quint).toContain("val abortableFetchBodiesConsumed = false");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("tracks immutable Response aliases and direct stream readers", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-abortable-fetch-stream-"));
    try {
      const fileName = join(directory, "entry.ts");
      writeFileSync(fileName, `
        export async function aliased() {
          const controller = new AbortController()
          const request = fetch("https://api.example.com/alias-body", { signal: controller.signal })
          const response = await request
          const payload = response
          return await payload.text()
        }
        export async function streamed() {
          const controller = new AbortController()
          const request = fetch("https://api.example.com/stream", { signal: controller.signal })
          const response = await request
          const reader = response.body?.getReader()
          return reader
        }
        export async function cancelled() {
          const controller = new AbortController()
          const request = fetch("https://api.example.com/cancel-stream", { signal: controller.signal })
          const response = await request
          const reader = response.body!.getReader()
          await reader.cancel("unused")
        }
        export async function released() {
          const controller = new AbortController()
          const request = fetch("https://api.example.com/release-stream", { signal: controller.signal })
          const response = await request
          const reader = response.body!.getReader()
          reader.releaseLock()
        }
      `);
      const program = ts.createProgram([fileName], {
        target: ts.ScriptTarget.ES2024, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], noEmit: true,
      });
      const analysis = analyzeAbortableFetchesInProgram(program, program.getSourceFile(fileName)!);
      expect(analysis.fetches).toEqual([
        expect.objectContaining({ owner: "aliased", responseBodyStatus: "consumed", responseBodyOperation: "text" }),
        expect.objectContaining({ owner: "streamed", responseBodyStatus: "stream-owned", responseBodyOperation: "getReader" }),
        expect.objectContaining({ owner: "cancelled", responseBodyStatus: "consumed", responseBodyOperation: "getReader", responseStreamDischarge: "cancel" }),
        expect.objectContaining({ owner: "released", responseBodyStatus: "unconsumed", responseBodyOperation: "getReader", responseStreamDischarge: "release-lock" }),
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("recognizes one canonical reader drain loop without accepting early exit", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-abortable-fetch-drain-"));
    try {
      const fileName = join(directory, "entry.ts");
      writeFileSync(fileName, `
        export async function drained() {
          const controller = new AbortController()
          const request = fetch("https://api.example.com/drained", { signal: controller.signal })
          const response = await request
          const reader = response.body!.getReader()
          while (true) {
            const { done } = await reader.read()
            if (done) break
          }
        }
        export async function earlyExit(stop: boolean) {
          const controller = new AbortController()
          const request = fetch("https://api.example.com/early", { signal: controller.signal })
          const response = await request
          const reader = response.body!.getReader()
          while (true) {
            const { done } = await reader.read()
            if (stop) break
            if (done) break
          }
        }
        export async function skippedRead(skip: boolean) {
          const controller = new AbortController()
          const request = fetch("https://api.example.com/skipped", { signal: controller.signal })
          const response = await request
          const reader = response.body!.getReader()
          while (true) {
            if (skip) continue
            const { done } = await reader.read()
            if (done) break
          }
        }
      `);
      const program = ts.createProgram([fileName], {
        target: ts.ScriptTarget.ES2024, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], noEmit: true,
      });
      const analysis = analyzeAbortableFetchesInProgram(program, program.getSourceFile(fileName)!);
      expect(analysis.fetches).toEqual([
        expect.objectContaining({ owner: "drained", responseBodyStatus: "consumed", responseStreamDischarge: "drain" }),
        expect.objectContaining({ owner: "earlyExit", responseBodyStatus: "unknown" }),
        expect.objectContaining({ owner: "skippedRead", responseBodyStatus: "unknown" }),
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("recognizes awaited builtin pipeTo without accepting floating or conditional pipes", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-abortable-fetch-pipe-"));
    try {
      const fileName = join(directory, "entry.ts");
      writeFileSync(fileName, `
        export async function piped(sink: WritableStream<Uint8Array>) {
          const controller = new AbortController()
          const request = fetch("https://api.example.com/piped", { signal: controller.signal })
          const response = await request
          await response.body!.pipeTo(sink)
        }
        export async function floating(sink: WritableStream<Uint8Array>) {
          const controller = new AbortController()
          const request = fetch("https://api.example.com/floating-pipe", { signal: controller.signal })
          const response = await request
          response.body!.pipeTo(sink)
        }
        export async function conditional(sink: WritableStream<Uint8Array>, enabled: boolean) {
          const controller = new AbortController()
          const request = fetch("https://api.example.com/conditional-pipe", { signal: controller.signal })
          const response = await request
          if (enabled) await response.body!.pipeTo(sink)
        }
        export async function configured(sink: WritableStream<Uint8Array>) {
          const controller = new AbortController()
          const request = fetch("https://api.example.com/configured-pipe", { signal: controller.signal })
          const response = await request
          await response.body!.pipeTo(sink, { preventClose: true })
        }
      `);
      const program = ts.createProgram([fileName], {
        target: ts.ScriptTarget.ES2024, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], noEmit: true,
      });
      const analysis = analyzeAbortableFetchesInProgram(program, program.getSourceFile(fileName)!);
      expect(analysis.fetches).toEqual([
        expect.objectContaining({ owner: "piped", responseBodyStatus: "consumed", responseBodyOperation: "pipeTo", responseStreamDischarge: "pipe-to", responseResourceEvaluation: expect.objectContaining({ status: "satisfied" }) }),
        expect.objectContaining({ owner: "floating", responseBodyStatus: "unknown", responseBodyOperation: "pipeTo", responseResourceEvaluation: expect.objectContaining({ status: "unknown" }) }),
        expect.objectContaining({ owner: "conditional", responseBodyStatus: "unknown", responseBodyOperation: "pipeTo" }),
        expect.objectContaining({ owner: "configured", responseBodyStatus: "unknown", responseBodyOperation: "pipeTo" }),
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("recognizes one direct awaited builtin pipeThrough-to-pipeTo chain", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-abortable-fetch-pipe-through-"));
    try {
      const fileName = join(directory, "entry.ts");
      writeFileSync(fileName, `
        export async function transformed(
          transform: TransformStream<Uint8Array, Uint8Array>,
          sink: WritableStream<Uint8Array>,
        ) {
          const controller = new AbortController()
          const request = fetch("https://api.example.com/transformed", { signal: controller.signal })
          const response = await request
          await response.body!.pipeThrough(transform).pipeTo(sink)
        }
        export async function floating(
          transform: TransformStream<Uint8Array, Uint8Array>,
          sink: WritableStream<Uint8Array>,
        ) {
          const controller = new AbortController()
          const request = fetch("https://api.example.com/floating-transform", { signal: controller.signal })
          const response = await request
          response.body!.pipeThrough(transform).pipeTo(sink)
        }
      `);
      const program = ts.createProgram([fileName], {
        target: ts.ScriptTarget.ES2024, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], noEmit: true,
      });
      const analysis = analyzeAbortableFetchesInProgram(program, program.getSourceFile(fileName)!);
      expect(analysis.fetches).toEqual([
        expect.objectContaining({ owner: "transformed", responseBodyStatus: "consumed", responseBodyOperation: "pipeThroughTo", responseStreamDischarge: "pipe-through-to" }),
        expect.objectContaining({ owner: "floating", responseBodyStatus: "unknown", responseBodyOperation: "pipeThroughTo" }),
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("tracks one immutable single-use transformed pipeline alias", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-abortable-fetch-pipeline-alias-"));
    try {
      const fileName = join(directory, "entry.ts");
      writeFileSync(fileName, `
        export async function aliased(
          transform: TransformStream<Uint8Array, Uint8Array>,
          sink: WritableStream<Uint8Array>,
        ) {
          const controller = new AbortController()
          const request = fetch("https://api.example.com/aliased-pipeline", { signal: controller.signal })
          const response = await request
          const pipeline = response.body!.pipeThrough(transform)
          await pipeline.pipeTo(sink)
        }
        export async function reused(
          transform: TransformStream<Uint8Array, Uint8Array>,
          sink: WritableStream<Uint8Array>,
        ) {
          const controller = new AbortController()
          const request = fetch("https://api.example.com/reused-pipeline", { signal: controller.signal })
          const response = await request
          const pipeline = response.body!.pipeThrough(transform)
          console.log(pipeline.locked)
          await pipeline.pipeTo(sink)
        }
        export async function renamed(
          transform: TransformStream<Uint8Array, Uint8Array>,
          sink: WritableStream<Uint8Array>,
        ) {
          const aborter = new AbortController()
          const pending = fetch("https://api.example.com/renamed-pipeline", { signal: aborter.signal })
          const incoming = await pending
          const transformedBytes = incoming.body!.pipeThrough(transform)
          await transformedBytes.pipeTo(sink)
        }
        export async function conditional(
          transform: TransformStream<Uint8Array, Uint8Array>,
          sink: WritableStream<Uint8Array>,
          enabled: boolean,
        ) {
          const controller = new AbortController()
          const request = fetch("https://api.example.com/conditional-pipeline", { signal: controller.signal })
          const response = await request
          const pipeline = response.body!.pipeThrough(transform)
          if (enabled) await pipeline.pipeTo(sink)
        }
      `);
      const program = ts.createProgram([fileName], {
        target: ts.ScriptTarget.ES2024, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], noEmit: true,
      });
      const analysis = analyzeAbortableFetchesInProgram(program, program.getSourceFile(fileName)!);
      expect(analysis.fetches).toEqual([
        expect.objectContaining({ owner: "aliased", responseBodyStatus: "consumed", responseBodyOperation: "pipeThroughTo", responseStreamDischarge: "pipe-through-to" }),
        expect.objectContaining({ owner: "reused", responseBodyStatus: "unknown", responseBodyOperation: "pipeThroughTo" }),
        expect.objectContaining({ owner: "renamed", responseBodyStatus: "consumed", responseBodyOperation: "pipeThroughTo", responseStreamDischarge: "pipe-through-to" }),
        expect.objectContaining({ owner: "conditional", responseBodyStatus: "unknown", responseBodyOperation: "pipeThroughTo" }),
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("requires both branches of one immutable Response clone to be consumed", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-abortable-fetch-clone-"));
    try {
      const fileName = join(directory, "entry.ts");
      writeFileSync(fileName, `
        export async function both() {
          const controller = new AbortController()
          const request = fetch("https://api.example.com/clone-both", { signal: controller.signal })
          const response = await request
          const copy = response.clone()
          await response.text()
          await copy.arrayBuffer()
        }
        export async function leaked() {
          const controller = new AbortController()
          const request = fetch("https://api.example.com/clone-leaked", { signal: controller.signal })
          const response = await request
          const copy = response.clone()
          await copy.text()
        }
        export async function conditional(readOriginal: boolean) {
          const controller = new AbortController()
          const request = fetch("https://api.example.com/clone-conditional", { signal: controller.signal })
          const response = await request
          const copy = response.clone()
          if (readOriginal) await response.text()
          await copy.text()
        }
        export async function unbound() {
          const controller = new AbortController()
          const request = fetch("https://api.example.com/clone-unbound", { signal: controller.signal })
          const response = await request
          response.clone()
          await response.text()
        }
        export async function multiple() {
          const controller = new AbortController()
          const request = fetch("https://api.example.com/clone-multiple", { signal: controller.signal })
          const response = await request
          const first = response.clone()
          const second = response.clone()
          await response.text()
          await first.text()
          await second.text()
        }
      `);
      const program = ts.createProgram([fileName], {
        target: ts.ScriptTarget.ES2024, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], noEmit: true,
      });
      const analysis = analyzeAbortableFetchesInProgram(program, program.getSourceFile(fileName)!);
      expect(analysis.fetches).toEqual([
        expect.objectContaining({
          owner: "both", responseBodyStatus: "consumed", responseBodyOperation: "clone",
          responseResourceEvaluation: expect.objectContaining({ status: "satisfied" }),
          responseBodyBranches: [
            { binding: "response", operation: "text", status: "consumed" },
            { binding: "copy", operation: "arrayBuffer", status: "consumed" },
          ],
        }),
        expect.objectContaining({
          owner: "leaked", responseBodyStatus: "unconsumed", responseBodyOperation: "clone",
          responseResourceEvaluation: expect.objectContaining({ status: "unsatisfied" }),
          responseBodyBranches: [
            { binding: "response", status: "unconsumed" },
            { binding: "copy", operation: "text", status: "consumed" },
          ],
        }),
        expect.objectContaining({ owner: "conditional", responseBodyStatus: "unknown", responseBodyOperation: "clone", responseResourceEvaluation: expect.objectContaining({ status: "unknown" }) }),
        expect.objectContaining({ owner: "unbound", responseBodyStatus: "unknown", responseBodyOperation: "clone" }),
        expect.objectContaining({ owner: "multiple", responseBodyStatus: "unknown", responseBodyOperation: "clone" }),
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("requires both branches of one builtin body tee to be piped", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-abortable-fetch-tee-"));
    try {
      const fileName = join(directory, "entry.ts");
      writeFileSync(fileName, `
        export async function both(
          firstSink: WritableStream<Uint8Array>,
          secondSink: WritableStream<Uint8Array>,
        ) {
          const controller = new AbortController()
          const request = fetch("https://api.example.com/tee-both", { signal: controller.signal })
          const response = await request
          const [left, right] = response.body!.tee()
          await left.pipeTo(firstSink)
          await right.pipeTo(secondSink)
        }
        export async function leaked(sink: WritableStream<Uint8Array>) {
          const controller = new AbortController()
          const request = fetch("https://api.example.com/tee-leaked", { signal: controller.signal })
          const response = await request
          const [kept, forgotten] = response.body!.tee()
          await kept.pipeTo(sink)
          console.log(forgotten.locked)
        }
        export async function conditional(
          firstSink: WritableStream<Uint8Array>,
          secondSink: WritableStream<Uint8Array>,
          enabled: boolean,
        ) {
          const controller = new AbortController()
          const request = fetch("https://api.example.com/tee-conditional", { signal: controller.signal })
          const response = await request
          const [left, right] = response.body!.tee()
          if (enabled) await left.pipeTo(firstSink)
          await right.pipeTo(secondSink)
        }
        export async function reusedSource(
          firstSink: WritableStream<Uint8Array>,
          secondSink: WritableStream<Uint8Array>,
        ) {
          const controller = new AbortController()
          const request = fetch("https://api.example.com/tee-reused-source", { signal: controller.signal })
          const response = await request
          const [left, right] = response.body!.tee()
          await response.text()
          await left.pipeTo(firstSink)
          await right.pipeTo(secondSink)
        }
      `);
      const program = ts.createProgram([fileName], {
        target: ts.ScriptTarget.ES2024, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], noEmit: true,
      });
      const analysis = analyzeAbortableFetchesInProgram(program, program.getSourceFile(fileName)!);
      expect(analysis.fetches).toEqual([
        expect.objectContaining({
          owner: "both", responseBodyStatus: "consumed", responseBodyOperation: "tee",
          responseResourceEvaluation: expect.objectContaining({ status: "satisfied" }),
          responseBodyBranches: [
            { binding: "left", operation: "pipeTo", status: "consumed" },
            { binding: "right", operation: "pipeTo", status: "consumed" },
          ],
        }),
        expect.objectContaining({
          owner: "leaked", responseBodyStatus: "unconsumed", responseBodyOperation: "tee",
          responseResourceEvaluation: expect.objectContaining({ status: "unsatisfied" }),
          responseBodyBranches: [
            { binding: "kept", operation: "pipeTo", status: "consumed" },
            { binding: "forgotten", status: "unconsumed" },
          ],
        }),
        expect.objectContaining({ owner: "conditional", responseBodyStatus: "unknown", responseBodyOperation: "tee", responseResourceEvaluation: expect.objectContaining({ status: "unknown" }) }),
        expect.objectContaining({ owner: "reusedSource", responseBodyStatus: "unknown", responseBodyOperation: "tee", responseResourceEvaluation: expect.objectContaining({ status: "unknown" }) }),
      ]);
      expect(analysis.fetches[0]!.responseResourceProtocol?.transitions.map((transition) => transition.kind)).toEqual([
        "acquire", "split", "consume", "consume",
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
