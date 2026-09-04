import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "@typescript/typescript6";
import { describe, expect, it } from "vitest";
import { analyzeOwnership, checkOwnership, checkOwnershipWithResourceProtocol, generateOwnershipQuint, lowerOwnershipEventsToResourceProtocol, type OwnershipEvent } from "../src/ownership.js";
import { invalidateTransferredTypedArrayEvidence } from "../src/project-verification.js";
import { verifyTypedArraySafety, type TypedArrayProgramSafetyResult } from "../src/typed-array-safety.js";
import { analyzeCallableSummaries } from "../src/callable-summary.js";

const span = { start: 0, end: 1 };
function run(events: OwnershipEvent[]) {
  const directory = mkdtempSync(join(tmpdir(), "uneffect-owner-"));
  const file = join(directory, "owner.qnt");
  writeFileSync(file, generateOwnershipQuint("ownership", events));
  return spawnSync("pnpm", ["exec", "quint", "run", file, "--invariant=ownershipSafe", "--max-steps=8", "--max-samples=50", "--seed=0x1234", "--verbosity=1"], { encoding: "utf8", timeout: 30_000 });
}

describe("Transferable ownership", () => {
  it("projects the supported ownership trace through the shared resource protocol", () => {
    const events: OwnershipEvent[] = [
      { operation: "clone", resource: "value", regionId: "value#1", span: { start: 1, end: 2 } },
      { operation: "read", resource: "value", regionId: "value#1", span: { start: 3, end: 4 } },
      { operation: "transfer", resource: "buffer", regionId: "buffer#1", transferState: "detached", span: { start: 5, end: 6 } },
      { operation: "read", resource: "buffer", regionId: "buffer#1", span: { start: 7, end: 8 } },
      { operation: "transfer", resource: "port", regionId: "port#1", transferState: "transferred", span: { start: 9, end: 10 } },
      { operation: "mutate", resource: "port", regionId: "port#1", span: { start: 11, end: 12 } },
    ];
    const projection = lowerOwnershipEventsToResourceProtocol(events);
    expect(projection.unsupported).toEqual([]);
    expect(projection.model.transitions.map((transition) => [transition.kind, "resource" in transition ? transition.resource : undefined])).toEqual([
      ["use", "value#1"], ["invalidate", "buffer#1"], ["use", "buffer#1"],
      ["transfer", "port#1"], ["use", "port#1"],
    ]);
    expect(checkOwnershipWithResourceProtocol(events)).toEqual(checkOwnership(events));
  });

  it("keeps shared-memory transfer outside the migrated exact fragment", () => {
    const events: OwnershipEvent[] = [
      { operation: "transfer", resource: "shared", transferState: "shared", span },
    ];
    expect(lowerOwnershipEventsToResourceProtocol(events).unsupported)
      .toEqual([{ event: 0, reason: "shared-memory-transfer" }]);
  });

  it("rejects reads, mutation, and a second transfer after definite transfer", () => {
    const events: OwnershipEvent[] = [
      { operation: "transfer", resource: "buffer", transferState: "detached", span },
      { operation: "read", resource: "buffer", span },
      { operation: "mutate", resource: "buffer", span },
      { operation: "transfer", resource: "buffer", transferState: "detached", span },
    ];
    expect(checkOwnership(events)).toHaveLength(3);
    expect(checkOwnershipWithResourceProtocol(events)).toEqual(checkOwnership(events));
    const result = run(events);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/Invariant.*violated|violation found/i);
  });

  it("preserves ownership after clone and keeps SharedArrayBuffer shared", () => {
    const events: OwnershipEvent[] = [
      { operation: "clone", resource: "value", span }, { operation: "read", resource: "value", span },
      { operation: "clone", resource: "shared", transferState: "shared", span }, { operation: "mutate", resource: "shared", span },
    ];
    expect(checkOwnership(events)).toEqual([]);
    const result = run(events);
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it("detects use after structuredClone transfer from TypeScript", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-owner-ts-"));
    const fileName = join(directory, "input.ts");
    writeFileSync(fileName, `function move(buffer: ArrayBuffer) { structuredClone({}, { transfer: [buffer] }); return buffer.byteLength }`);
    const program = ts.createProgram([fileName], { target: ts.ScriptTarget.ES2024, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"] });
    expect(analyzeOwnership(program, program.getSourceFile(fileName)!)).toContainEqual(expect.objectContaining({ resource: "buffer", state: "detached", operation: "read" }));
  });

  it("distinguishes possible from definite use after conditional transfer", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-owner-conditional-"));
    const fileName = join(directory, "input.ts");
    writeFileSync(fileName, `
      function maybe(buffer: ArrayBuffer, move: boolean) {
        if (move) structuredClone({}, { transfer: [buffer] })
        return buffer.byteLength
      }
      function always(buffer: ArrayBuffer, move: boolean) {
        if (move) structuredClone({}, { transfer: [buffer] })
        else structuredClone({}, { transfer: [buffer] })
        return buffer.byteLength
      }
    `);
    const program = ts.createProgram([fileName], { target: ts.ScriptTarget.ES2024, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"] });
    const diagnostics = analyzeOwnership(program, program.getSourceFile(fileName)!);
    expect(diagnostics).toContainEqual(expect.objectContaining({ resource: "buffer", state: "unknown", operation: "read", message: expect.stringContaining("conditional") }));
    expect(diagnostics).toContainEqual(expect.objectContaining({ resource: "buffer", state: "detached", operation: "read" }));
    expect(() => generateOwnershipQuint("conditional", [{
      operation: "transfer", resource: "buffer", transferState: "detached", span,
      controlPath: [{ id: 1, branch: true }],
    }])).toThrow(/CFG-aware/);
  });

  it("fails closed for zero-or-many loop transfers", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-owner-loop-"));
    const fileName = join(directory, "input.ts");
    writeFileSync(fileName, `
      function loop(buffer: ArrayBuffer, count: number) {
        for (let index = 0; index < count; index++) {
          structuredClone({}, { transfer: [buffer] })
        }
        return buffer.byteLength
      }
      function doOnce(buffer: ArrayBuffer, again: boolean) {
        do { structuredClone({}, { transfer: [buffer] }) } while (again)
        return buffer.byteLength
      }
    `);
    const program = ts.createProgram([fileName], { target: ts.ScriptTarget.ES2024, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"] });
    const diagnostics = analyzeOwnership(program, program.getSourceFile(fileName)!);
    expect(diagnostics).toContainEqual(expect.objectContaining({ resource: "buffer", operation: "transfer", state: "unknown", message: expect.stringContaining("repeat") }));
    expect(diagnostics).toContainEqual(expect.objectContaining({ resource: "buffer", operation: "read", state: "unknown" }));
    expect(diagnostics).toContainEqual(expect.objectContaining({ resource: "buffer", operation: "read", state: "detached" }));
  });

  it("joins switch selection while preserving fallthrough and break", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-owner-switch-"));
    const fileName = join(directory, "input.ts");
    writeFileSync(fileName, `
      function partial(buffer: ArrayBuffer, kind: number) {
        switch (kind) {
          case 0: structuredClone({}, { transfer: [buffer] }); break
          case 1: break
        }
        return buffer.byteLength
      }
      function complete(buffer: ArrayBuffer, kind: number) {
        switch (kind) {
          case 0:
          case 1: structuredClone({}, { transfer: [buffer] }); break
          default: structuredClone({}, { transfer: [buffer] })
        }
        return buffer.byteLength
      }
      function conditionalBreak(buffer: ArrayBuffer, kind: number, stop: boolean) {
        switch (kind) {
          case 0: if (stop) break
          case 1: structuredClone({}, { transfer: [buffer] }); break
          default: structuredClone({}, { transfer: [buffer] })
        }
        return buffer.byteLength
      }
    `);
    const program = ts.createProgram([fileName], { target: ts.ScriptTarget.ES2024, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"] });
    const diagnostics = analyzeOwnership(program, program.getSourceFile(fileName)!);
    expect(diagnostics).toContainEqual(expect.objectContaining({ resource: "buffer", operation: "read", state: "unknown" }));
    expect(diagnostics).toContainEqual(expect.objectContaining({ resource: "buffer", operation: "read", state: "detached" }));
    expect(diagnostics.filter((item) => item.operation === "read" && item.state === "unknown")).toHaveLength(2);
  });

  it("routes ownership through try, catch, and mandatory finally", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-owner-try-"));
    const fileName = join(directory, "input.ts");
    writeFileSync(fileName, `
      function caught(buffer: ArrayBuffer) {
        try { throw new Error("move") }
        catch { structuredClone({}, { transfer: [buffer] }) }
        return buffer.byteLength
      }
      function unreachableCatch(buffer: ArrayBuffer) {
        try { const value = 1; void value }
        catch { structuredClone({}, { transfer: [buffer] }) }
        return buffer.byteLength
      }
      function mandatory(buffer: ArrayBuffer, fail: boolean) {
        try { if (fail) throw new Error("fail") }
        finally { structuredClone({}, { transfer: [buffer] }) }
        return buffer.byteLength
      }
    `);
    const program = ts.createProgram([fileName], { target: ts.ScriptTarget.ES2024, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"] });
    const diagnostics = analyzeOwnership(program, program.getSourceFile(fileName)!);
    expect(diagnostics.filter((item) => item.operation === "read" && item.state === "detached")).toHaveLength(2);
    expect(diagnostics.filter((item) => item.operation === "read" && item.state === "unknown")).toEqual([]);
  });

  it("routes authenticated callable Throw summaries into ownership catch edges", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-owner-callable-throw-"));
    const fileName = join(directory, "input.ts");
    writeFileSync(fileName, `
      /* uneffect:effect Throw<Error> */
      function fail(): never { throw new Error("fail") }
      /* uneffect:effect Reject<Error> */
      async function reject(): Promise<never> { return Promise.reject(new Error("reject")) }
      function caught(buffer: ArrayBuffer) {
        try { fail() }
        catch { structuredClone({}, { transfer: [buffer] }) }
        return buffer.byteLength
      }
      async function caughtReject(buffer: ArrayBuffer) {
        try { await reject() }
        catch { structuredClone({}, { transfer: [buffer] }) }
        return buffer.byteLength
      }
    `);
    const program = ts.createProgram([fileName], { target: ts.ScriptTarget.ES2024, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"] });
    const summaries = analyzeCallableSummaries(program).summaries;
    expect(summaries.find((summary) => summary.name === "reject")?.rejects).toEqual(["Error"]);
    const diagnostics = analyzeOwnership(program, program.getSourceFile(fileName)!, summaries);
    expect(diagnostics).toContainEqual(expect.objectContaining({
      resource: "buffer", operation: "read", state: "unknown",
    }));
    expect(diagnostics.filter((item) => item.operation === "read" && item.state === "unknown")).toHaveLength(2);
  });

  it("does not merge same-spelled shadowed ownership bindings", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-owner-shadow-"));
    const fileName = join(directory, "input.ts");
    writeFileSync(fileName, `
      function move() {
        const buffer = new ArrayBuffer(8)
        structuredClone({}, { transfer: [buffer] })
        {
          const buffer = new ArrayBuffer(4)
          return buffer.byteLength
        }
      }
    `);
    const program = ts.createProgram([fileName], { target: ts.ScriptTarget.ES2024, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"] });
    expect(analyzeOwnership(program, program.getSourceFile(fileName)!)).toEqual([]);
  });

  it("recognizes builtin DataView construction by symbol identity", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-owner-dataview-"));
    const fileName = join(directory, "input.ts");
    writeFileSync(fileName, `
      function builtin(buffer: ArrayBuffer) {
        structuredClone({}, { transfer: [buffer] })
        return new DataView(buffer)
      }
      function shadowed(buffer: ArrayBuffer, DataView: new (value: ArrayBuffer) => object) {
        structuredClone({}, { transfer: [buffer] })
        return new DataView(buffer)
      }
    `);
    const program = ts.createProgram([fileName], { target: ts.ScriptTarget.ES2024, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"] });
    const diagnostics = analyzeOwnership(program, program.getSourceFile(fileName)!);
    expect(diagnostics.filter((item) => item.operation === "read" && item.resource === "buffer")).toHaveLength(1);
  });

  it("tracks transfer invalidation through immutable ArrayBuffer aliases", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-owner-region-alias-"));
    const fileName = join(directory, "input.ts");
    writeFileSync(fileName, `
      function move(buffer: ArrayBuffer) {
        const root = buffer
        const moved = root
        structuredClone({}, { transfer: [moved] })
        return new DataView(buffer)
      }
    `);
    const program = ts.createProgram([fileName], { target: ts.ScriptTarget.ES2024, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"] });
    expect(analyzeOwnership(program, program.getSourceFile(fileName)!)).toContainEqual(expect.objectContaining({
      resource: "buffer", state: "detached", operation: "read", regionId: expect.stringMatching(/^region:/),
    }));
  });

  it("shares ownership state with builtin subarray but not copied slice windows", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-owner-window-"));
    const fileName = join(directory, "input.ts");
    writeFileSync(fileName, `
      function move(bytes: Uint8Array) {
        const root = bytes
        const shared = root.subarray(0, 4)
        const nested = shared.subarray(1, 3)
        const sharedAlias = nested
        const copied = bytes.slice(0, 4)
        structuredClone({}, { transfer: [bytes] })
        sharedAlias[0] = 1
        copied[0] = 2
      }
    `);
    const program = ts.createProgram([fileName], { target: ts.ScriptTarget.ES2024, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"] });
    const diagnostics = analyzeOwnership(program, program.getSourceFile(fileName)!);
    expect(diagnostics).toContainEqual(expect.objectContaining({ resource: "sharedAlias", state: "transferred", operation: "mutate" }));
    expect(diagnostics).not.toContainEqual(expect.objectContaining({ resource: "copied" }));
  });

  it("invalidates typed-array backing evidence through a different immutable alias", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-owner-typed-region-"));
    const fileName = join(directory, "input.ts");
    const source = `
      type FixedArrayBuffer<N extends number> = ArrayBuffer
      type BoundedDataView<N extends number> = DataView
      function move(buffer: FixedArrayBuffer<16>): BoundedDataView<8> {
        const moved = buffer
        structuredClone({}, { transfer: [moved] })
        const backing = buffer
        return new DataView(backing, 0, 8) as BoundedDataView<8>
      }
    `;
    writeFileSync(fileName, source);
    const program = ts.createProgram([fileName], { target: ts.ScriptTarget.ES2024, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"] });
    const typed = await verifyTypedArraySafety(fileName, source);
    expect(typed.obligations).toContainEqual(expect.objectContaining({ kind: "dataview-backing-bounds", result: "verified" }));
    const aggregate: TypedArrayProgramSafetyResult = {
      files: { [fileName]: typed }, obligations: [...typed.obligations], diagnostics: [...typed.diagnostics],
      windows: [...typed.windows],
      statistics: typed.statistics,
    };
    const ownership = analyzeOwnership(program, program.getSourceFile(fileName)!).map((diagnostic) => ({
      ...diagnostic, fileName, kind: "ownership" as const,
    }));

    invalidateTransferredTypedArrayEvidence(program, { [fileName]: source }, aggregate, ownership);

    expect(typed.obligations).toContainEqual(expect.objectContaining({ kind: "dataview-backing-bounds", result: "counterexample" }));
  });

  it("downgrades backing evidence after a conditional transfer", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-owner-typed-conditional-"));
    const fileName = join(directory, "input.ts");
    const source = `
      type FixedArrayBuffer<N extends number> = ArrayBuffer
      type BoundedDataView<N extends number> = DataView
      function maybeMove(buffer: FixedArrayBuffer<16>, move: boolean): BoundedDataView<8> {
        if (move) structuredClone({}, { transfer: [buffer] })
        return new DataView(buffer, 0, 8) as BoundedDataView<8>
      }
    `;
    writeFileSync(fileName, source);
    const program = ts.createProgram([fileName], { target: ts.ScriptTarget.ES2024, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"] });
    const typed = await verifyTypedArraySafety(fileName, source);
    const aggregate: TypedArrayProgramSafetyResult = {
      files: { [fileName]: typed }, obligations: [...typed.obligations], diagnostics: [...typed.diagnostics],
      windows: [...typed.windows], statistics: typed.statistics,
    };
    const ownership = analyzeOwnership(program, program.getSourceFile(fileName)!).map((diagnostic) => ({
      ...diagnostic, fileName, kind: "ownership" as const,
    }));
    expect(ownership).toContainEqual(expect.objectContaining({ state: "unknown", operation: "read" }));
    invalidateTransferredTypedArrayEvidence(program, { [fileName]: source }, aggregate, ownership);
    expect(typed.obligations).toContainEqual(expect.objectContaining({ kind: "dataview-backing-bounds", result: "unknown" }));
  });
});
