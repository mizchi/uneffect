import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { analyzeOwnership, checkOwnership, generateOwnershipQuint, type OwnershipEvent } from "../src/ownership.js";
import { invalidateTransferredTypedArrayEvidence } from "../src/project-verification.js";
import { verifyTypedArraySafety, type TypedArrayProgramSafetyResult } from "../src/typed-array-safety.js";

const span = { start: 0, end: 1 };
function run(events: OwnershipEvent[]) {
  const directory = mkdtempSync(join(tmpdir(), "uneffect-owner-"));
  const file = join(directory, "owner.qnt");
  writeFileSync(file, generateOwnershipQuint("ownership", events));
  return spawnSync("pnpm", ["exec", "quint", "run", file, "--invariant=ownershipSafe", "--max-steps=8", "--max-samples=50", "--seed=0x1234", "--verbosity=1"], { encoding: "utf8", timeout: 30_000 });
}

describe("Transferable ownership", () => {
  it("rejects reads, mutation, and a second transfer after definite transfer", () => {
    const events: OwnershipEvent[] = [
      { operation: "transfer", resource: "buffer", transferState: "detached", span },
      { operation: "read", resource: "buffer", span },
      { operation: "mutate", resource: "buffer", span },
      { operation: "transfer", resource: "buffer", transferState: "detached", span },
    ];
    expect(checkOwnership(events)).toHaveLength(3);
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
      statistics: typed.statistics,
    };
    const ownership = analyzeOwnership(program, program.getSourceFile(fileName)!).map((diagnostic) => ({
      ...diagnostic, fileName, kind: "ownership" as const,
    }));

    invalidateTransferredTypedArrayEvidence(program, { [fileName]: source }, aggregate, ownership);

    expect(typed.obligations).toContainEqual(expect.objectContaining({ kind: "dataview-backing-bounds", result: "counterexample" }));
  });
});
