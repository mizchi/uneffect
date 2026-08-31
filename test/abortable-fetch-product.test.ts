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
      `);
      const program = ts.createProgram([fileName], {
        target: ts.ScriptTarget.ES2024, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], noEmit: true,
      });
      const analysis = analyzeAbortableFetchesInProgram(program, program.getSourceFile(fileName)!);
      expect(analysis.fetches).toEqual([
        expect.objectContaining({ owner: "piped", responseBodyStatus: "consumed", responseBodyOperation: "pipeTo", responseStreamDischarge: "pipe-to" }),
        expect.objectContaining({ owner: "floating", responseBodyStatus: "unknown", responseBodyOperation: "pipeTo" }),
        expect.objectContaining({ owner: "conditional", responseBodyStatus: "unknown", responseBodyOperation: "pipeTo" }),
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
