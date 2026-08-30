import { describe, expect, expectTypeOf, it } from "vitest";
import { parseBoundedArrayBuffer, parseBoundedDataView, parseBoundedUint32Array, parseBoundedUint8Array, parseFixedArrayBuffer, parseU32, parseU8, toU32, u32Table, u8Table, verifyTypedArraySafety, verifyTypedArraySafetyInProgram } from "../src/index.js";
import type { BoundedArrayBuffer, BoundedDataView, BoundedUint32Array, BoundedUint8Array, FixedArrayBuffer, U32, U8 } from "../src/index.js";

describe("bounded Uint8Array safety", () => {
  it("fails closed when a legacy numeric scope contains shadowed bindings", async () => {
    const result = await verifyTypedArraySafety("shadowed-array.ts", `
      type BoundedUint8Array<N extends number> = Uint8Array
      function write() {
        const bytes: BoundedUint8Array<10> = new Uint8Array(10)
        {
          const bytes: BoundedUint8Array<1> = new Uint8Array(1)
          bytes[5] = 0
        }
      }
    `);
    expect(result.obligations).toContainEqual(expect.objectContaining({
      functionName: "write", kind: "index-bounds", result: "unknown",
    }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      message: expect.stringContaining("same-spelled bindings"),
    }));
  });

  it("provides optional runtime refinements", () => {
    expect(parseU8(255)).toBe(255);
    expect(() => parseU8(256)).toThrow();
    expect(() => parseU8(1.5)).toThrow();
    const bytes = parseBoundedUint8Array(new Uint8Array(4), 4);
    expectTypeOf(bytes).toEqualTypeOf<BoundedUint8Array<4>>();
    expect(() => parseBoundedUint8Array(new Uint8Array(5), 4)).toThrow();
    expectTypeOf(parseU8(1)).toEqualTypeOf<U8>();
    expect(parseU32(0xffff_ffff)).toBe(0xffff_ffff);
    expect(() => parseU32(0x1_0000_0000)).toThrow();
    expect(toU32(-1)).toBe(0xffff_ffff);
    expectTypeOf(toU32(-1)).toEqualTypeOf<U32>();
    const words = parseBoundedUint32Array(new Uint32Array(64), 64);
    expectTypeOf(words).toEqualTypeOf<BoundedUint32Array<64>>();
    expect(() => parseBoundedUint32Array(new Uint32Array(65), 64)).toThrow();
    const view = parseBoundedDataView(new DataView(new ArrayBuffer(4)), 4);
    expectTypeOf(view).toEqualTypeOf<BoundedDataView<4>>();
    expect(() => parseBoundedDataView(new DataView(new ArrayBuffer(5)), 4)).toThrow();
    const resizable = parseBoundedArrayBuffer(new ArrayBuffer(4, { maxByteLength: 8 }), 8);
    expectTypeOf(resizable).toEqualTypeOf<BoundedArrayBuffer<8>>();
    expect(() => parseBoundedArrayBuffer(new ArrayBuffer(4, { maxByteLength: 8 }), 7)).toThrow();
    expect(() => parseBoundedArrayBuffer(new ArrayBuffer(5), 4)).toThrow();
    const fixed = parseFixedArrayBuffer(new ArrayBuffer(12), 12);
    expectTypeOf(fixed).toEqualTypeOf<FixedArrayBuffer<12>>();
    expect(() => parseFixedArrayBuffer(new ArrayBuffer(11), 12)).toThrow();
    expect(() => parseFixedArrayBuffer(new ArrayBuffer(12, { maxByteLength: 16 }), 12)).toThrow();
    expect(u8Table([0, 255] as const)).toEqual([0, 255]);
    expect(u32Table([0, 0xffff_ffff] as const)).toEqual([0, 0xffff_ffff]);
    expect(() => u8Table([256])).toThrow();
    expect(() => u32Table([-1])).toThrow();
    expectTypeOf(u32Table([1, 2] as const)).toEqualTypeOf<readonly [U32, U32]>();
  });

  it("finds literal overflow and does not ignore compound writes", async () => {
    const result = await verifyTypedArraySafety("writes.ts", `
      function overflow(bytes: Uint8Array) { bytes[0] = 256 }
      function compound(bytes: Uint8Array) { bytes[0] += 1; bytes[1]++ }
    `);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ functionName: "overflow", kind: "u8-write" }),
      expect.objectContaining({ functionName: "compound", kind: "u8-write" }),
    ]));
    expect(result.obligations.filter((item) => item.functionName === "compound")).toHaveLength(2);
  });

  it("does not bypass an explicitly unavailable native Z3 backend", async () => {
    const result = await verifyTypedArraySafety("native-unavailable.ts", `
      import type { Nat, U8 } from "@mizchi/uneffect"
      /* uneffect:contract requires value * 2 <= 255 */
      function write(bytes: Uint8Array, value: Nat) { bytes[0] = value }
    `, { preference: "native", nativeExecutable: "/uneffect/missing/z3" });
    expect(result.obligations).toContainEqual(expect.objectContaining({
      functionName: "write",
      kind: "u8-write",
      result: "unknown",
    }));
  });

  it("checks DataView byte offsets and rejects implicit value coercion", async () => {
    const result = await verifyTypedArraySafety("data-view.ts", `
      import type { BoundedDataView, Nat, U8, U32 } from "@mizchi/uneffect"
      /* uneffect:contract requires offset <= 60 */
      function safe(view: BoundedDataView<64>, offset: Nat, byte: U8, word: U32) {
        view.setUint8(offset, byte)
        view.setUint32(offset, word)
      }
      function unsafe(view: BoundedDataView<4>, offset: number) {
        view.setUint8(offset, 256)
        view.setUint32(1, -1)
      }
    `);
    expect(result.obligations).toEqual(expect.arrayContaining([
      expect.objectContaining({ functionName: "safe", kind: "dataview-bounds", result: "verified", goal: expect.stringContaining("+ 4 <= 64") }),
      expect.objectContaining({ functionName: "safe", kind: "u8-write", result: "verified" }),
      expect.objectContaining({ functionName: "safe", kind: "u32-write", result: "verified" }),
    ]));
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ functionName: "unsafe", kind: "dataview-bounds" }),
      expect.objectContaining({ functionName: "unsafe", kind: "u8-write" }),
      expect.objectContaining({ functionName: "unsafe", kind: "u32-write" }),
    ]));
    expectTypeOf<BoundedDataView<64>>().toMatchTypeOf<DataView>();
  });

  it("tracks const DataView aliases and byte widths for standard accessors", async () => {
    const result = await verifyTypedArraySafety("data-view-codec.ts", `
      import type { BoundedDataView, Nat } from "@mizchi/uneffect"
      /* uneffect:contract requires offset <= 8 */
      function decode(view: BoundedDataView<16>, offset: Nat) {
        const cursor = view
        const alias = cursor
        const tag = alias.getUint8(offset)
        const length = alias.getUint16(offset + 1, false)
        const timestamp = alias.getFloat64(offset, false)
        alias.setInt16(offset + 2, -32768, false)
        return { tag, length, timestamp }
      }
      function broken(view: BoundedDataView<8>) {
        const cursor = view
        cursor.getBigUint64(1, false)
        cursor.setUint16(7, 65536, false)
      }
    `);
    expect(result.obligations.filter((item) => item.functionName === "decode" && item.kind === "dataview-bounds")).toHaveLength(4);
    expect(result.obligations).toEqual(expect.arrayContaining([
      expect.objectContaining({ functionName: "decode", kind: "dataview-bounds", result: "verified", goal: expect.stringContaining("+ 8 <= 16") }),
      expect.objectContaining({ functionName: "decode", kind: "dataview-value", result: "verified", goal: expect.stringContaining(">= -32768") }),
    ]));
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ functionName: "broken", kind: "dataview-bounds" }),
      expect.objectContaining({ functionName: "broken", kind: "dataview-value" }),
    ]));
  });

  it("tracks local DataView byte offsets and view lengths", async () => {
    const result = await verifyTypedArraySafety("data-view-offset.ts", `
      import type { FixedArrayBuffer } from "@mizchi/uneffect"
      function safe(buffer: FixedArrayBuffer<16>) {
        const view = new DataView(buffer, 4, 8)
        const alias = view
        return alias.getUint32(4, false)
      }
      function outsideView(buffer: FixedArrayBuffer<16>) {
        const view = new DataView(buffer, 4, 8)
        return view.getUint32(6, false)
      }
      function outsideBacking(buffer: FixedArrayBuffer<8>) {
        const view = new DataView(buffer, 4, 8)
        return view.getUint8(0)
      }
    `);

    expect(result.obligations).toEqual(expect.arrayContaining([
      expect.objectContaining({ functionName: "safe", kind: "dataview-backing-bounds", result: "verified" }),
      expect.objectContaining({ functionName: "safe", kind: "dataview-bounds", result: "verified" }),
      expect.objectContaining({ functionName: "outsideView", kind: "dataview-bounds", result: "counterexample" }),
      expect.objectContaining({ functionName: "outsideBacking", kind: "dataview-backing-bounds", result: "counterexample" }),
    ]));
  });

  it("tracks bounded subarray and slice windows", async () => {
    const result = await verifyTypedArraySafety("typed-array-windows.ts", `
      import type { BoundedUint8Array } from "@mizchi/uneffect"
      function windows(bytes: BoundedUint8Array<16>) {
        const shared = bytes.subarray(4, 12)
        const sharedAlias = shared
        sharedAlias[7] = 255
        const copied = bytes.slice(4, 12)
        copied[8] = 0
      }
      function dynamic(bytes: BoundedUint8Array<16>, start: number) {
        const window = bytes.subarray(start)
        window[0] = 1
      }
    `);

    expect(result.obligations).toEqual(expect.arrayContaining([
      expect.objectContaining({ functionName: "windows", kind: "index-bounds", goal: expect.stringContaining("7 < 8"), result: "verified" }),
      expect.objectContaining({ functionName: "windows", kind: "index-bounds", goal: expect.stringContaining("8 < 8"), result: "counterexample" }),
      expect.objectContaining({ functionName: "dynamic", kind: "index-bounds", result: "unknown" }),
    ]));
  });

  it("derives integer intervals from strict and reversed requires bounds", async () => {
    const result = await verifyTypedArraySafety("data-view-interval.ts", `
      import type { BoundedDataView, Int } from "@mizchi/uneffect"
      /* uneffect:contract requires -32768 <= value && value < 32768 */
      function write(view: BoundedDataView<2>, value: Int) {
        view.setInt16(0, value, false)
      }
    `);
    expect(result.diagnostics).toEqual([]);
    expect(result.statistics.solverQueries).toBe(0);
    expect(result.obligations).toContainEqual(expect.objectContaining({
      functionName: "write", kind: "dataview-value", result: "verified",
    }));
  });

  it("checks DataView constructor length against its view and backing buffer", async () => {
    const result = await verifyTypedArraySafety("data-view-constructor.ts", `
      import type { BoundedArrayBuffer, BoundedDataView, FixedArrayBuffer, Nat } from "@mizchi/uneffect"
      /* uneffect:contract requires length <= 16 && offset + length <= 64 */
      function slice(buffer: FixedArrayBuffer<64>, offset: Nat, length: Nat): BoundedDataView<16> {
        return new DataView(buffer, offset, length)
      }
      function backingOverflow(buffer: FixedArrayBuffer<64>): BoundedDataView<8> {
        return new DataView(buffer, 60, 8)
      }
      function viewOverflow(buffer: FixedArrayBuffer<64>): BoundedDataView<4> {
        return new DataView(buffer, 0, 8)
      }
      function inferredLength(buffer: FixedArrayBuffer<64>): BoundedDataView<16> {
        return new DataView(buffer, 48)
      }
      function inferredOverflow(buffer: FixedArrayBuffer<64>): BoundedDataView<16> {
        return new DataView(buffer, 47)
      }
      function unbounded(buffer: ArrayBuffer): BoundedDataView<8> {
        return new DataView(buffer, 0, 8)
      }
      function resizableUpperBoundOnly(buffer: BoundedArrayBuffer<8>): BoundedDataView<8> {
        return new DataView(buffer, 0, 8)
      }
      function aliasedBacking(buffer: FixedArrayBuffer<64>): BoundedDataView<8> {
        const root = buffer
        const backing = root
        return new DataView(backing, 8, 8)
      }
    `);
    expect(result.obligations).toEqual(expect.arrayContaining([
      expect.objectContaining({ functionName: "slice", kind: "dataview-backing-bounds", result: "verified" }),
      expect.objectContaining({ functionName: "aliasedBacking", kind: "dataview-backing-bounds", result: "verified" }),
      expect.objectContaining({ functionName: "slice", kind: "max-length", result: "verified" }),
    ]));
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ functionName: "backingOverflow", kind: "dataview-backing-bounds" }),
      expect.objectContaining({ functionName: "viewOverflow", kind: "max-length" }),
      expect.objectContaining({ functionName: "inferredOverflow", kind: "max-length" }),
      expect.objectContaining({ functionName: "unbounded", kind: "dataview-backing-bounds" }),
      expect.objectContaining({ functionName: "resizableUpperBoundOnly", kind: "dataview-backing-bounds" }),
    ]));
    expect(result.diagnostics).not.toContainEqual(expect.objectContaining({ functionName: "inferredLength" }));
  });

  it("checks SHA-256 style shifts, masks, rotations, and u32 normalization", async () => {
    const result = await verifyTypedArraySafety("sha256-words.ts", `
      import type { BoundedUint8Array, BoundedUint32Array, U32 } from "@mizchi/uneffect"
      function emitByte(output: BoundedUint8Array<32>, word: U32) {
        output[0] = word >>> 24
        output[1] = (word >>> 16) & 0xff
        output[2] = word >>> 16
        output[3] = u8(word >>> 8)
      }
      function rotate(words: BoundedUint32Array<64>, word: U32) {
        words[0] = ((word >>> 7) | (word << 25)) >>> 0
        words[1] = (word >>> 7) | (word << 25)
        words[2] = toU32(word + 0xffff_ffff)
      }
    `);
    expect(result.obligations).toEqual(expect.arrayContaining([
      expect.objectContaining({ functionName: "emitByte", kind: "u8-write", result: "verified" }),
      expect.objectContaining({ functionName: "rotate", kind: "u32-write", result: "verified" }),
    ]));
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ functionName: "emitByte", kind: "u8-write" }),
      expect.objectContaining({ functionName: "rotate", kind: "u32-write" }),
    ]));
    expect(result.obligations).toContainEqual(expect.objectContaining({ functionName: "rotate", kind: "u32-write", goal: expect.stringContaining("toU32"), result: "verified" }));
    expect(result.obligations).toContainEqual(expect.objectContaining({ functionName: "emitByte", kind: "u8-write", goal: expect.stringContaining("u8"), result: "verified" }));
  });

  it("proves bounded indices and rejects JavaScript shift-count masking", async () => {
    const result = await verifyTypedArraySafety("indices.ts", `
      import type { BoundedUint8Array, Nat, U32 } from "@mizchi/uneffect"
      /* uneffect:contract requires index < 32 && shift <= 31 */
      function safe(bytes: BoundedUint8Array<32>, index: Nat, word: U32, shift: Nat) {
        bytes[index] = (word >>> shift) & 0xff
      }
      function unchecked(bytes: BoundedUint8Array<32>, index: number, word: U32, shift: number) {
        bytes[index] = (word >>> shift) & 0xff
      }
    `);
    expect(result.obligations).toEqual(expect.arrayContaining([
      expect.objectContaining({ functionName: "safe", kind: "index-bounds", result: "verified" }),
      expect.objectContaining({ functionName: "safe", kind: "shift-count", result: "verified" }),
    ]));
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ functionName: "unchecked", kind: "index-bounds" }),
      expect.objectContaining({ functionName: "unchecked", kind: "shift-count" }),
    ]));
  });

  it("derives SHA-256 word-schedule index bounds from a canonical for loop", async () => {
    const result = await verifyTypedArraySafety("schedule.ts", `
      import type { BoundedUint32Array } from "@mizchi/uneffect"
      function schedule(words: BoundedUint32Array<64>) {
        for (let i = 16; i < 64; i++) {
          words[i] = (words[i - 16]! + words[i - 15]! + words[i - 7]! + words[i - 2]!) >>> 0
        }
      }
      function offByOne(words: BoundedUint32Array<64>) {
        for (let i = 16; i < 64; i++) words[i + 1] = 0
      }
    `);
    const scheduleBounds = result.obligations.filter((item) => item.functionName === "schedule" && item.kind === "index-bounds");
    expect(scheduleBounds).toHaveLength(5);
    expect(scheduleBounds.every((item) => item.result === "verified")).toBe(true);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ functionName: "offByOne", kind: "index-bounds" }));
  });

  it("checks SHA-256 padding copies through TypedArray.set bounds", async () => {
    const result = await verifyTypedArraySafety("padding-copy.ts", `
      import type { BoundedUint8Array, Nat } from "@mizchi/uneffect"
      /* uneffect:contract requires offset <= 64 */
      function copyIntoPadding(target: BoundedUint8Array<1048640>, input: BoundedUint8Array<1048576>, offset: Nat) {
        target.set(input, offset)
      }
      function tooSmall(target: BoundedUint8Array<32>, input: BoundedUint8Array<64>) {
        target.set(input, 0)
      }
      function unknownSource(target: BoundedUint8Array<64>, input: Uint8Array) {
        target.set(input, 0)
      }
      function narrowsValues(target: BoundedUint8Array<64>, input: BoundedUint32Array<64>) {
        target.set(input, 0)
      }
    `);
    expect(result.obligations).toContainEqual(expect.objectContaining({ functionName: "copyIntoPadding", kind: "bulk-copy-bounds", result: "verified" }));
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ functionName: "tooSmall", kind: "bulk-copy-bounds" }),
      expect.objectContaining({ functionName: "unknownSource", kind: "bulk-copy-bounds" }),
      expect.objectContaining({ functionName: "narrowsValues", kind: "bulk-copy-values" }),
    ]));
  });

  it("derives the SHA-256 padded allocation bound from input.length", async () => {
    const result = await verifyTypedArraySafety("padding-length.ts", `
      import type { BoundedUint8Array } from "@mizchi/uneffect"
      function allocatePadding(input: BoundedUint8Array<1048576>): BoundedUint8Array<1048640> {
        return new Uint8Array((input.length + 9 + 63) & ~63)
      }
      function oneByteTooSmall(input: BoundedUint8Array<1048576>): BoundedUint8Array<1048639> {
        return new Uint8Array((input.length + 9 + 63) & ~63)
      }
    `);
    expect(result.obligations).toContainEqual(expect.objectContaining({ functionName: "allocatePadding", kind: "max-length", result: "verified" }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ functionName: "oneByteTooSmall", kind: "max-length" }));
  });

  it("folds user constants and builtin numeric limits into obligations", async () => {
    const result = await verifyTypedArraySafety("constants.ts", `
      import type { BoundedUint8Array, U32 } from "@mizchi/uneffect"
      import { U8_MAX, U32_BITS } from "@mizchi/uneffect"
      const MAX_INPUT_BYTES = 1 << 20
      const MAX_PADDED_BYTES = MAX_INPUT_BYTES + 64
      const BLOCK_BYTES = 64
      function pad(input: BoundedUint8Array<typeof MAX_INPUT_BYTES>): BoundedUint8Array<typeof MAX_PADDED_BYTES> {
        return new Uint8Array((input.length + 9 + BLOCK_BYTES - 1) & ~(BLOCK_BYTES - 1))
      }
      function emit(output: BoundedUint8Array<32>, word: U32) {
        output[0] = (word >>> (U32_BITS - 8)) & U8_MAX
      }
    `);
    expect(result.diagnostics).toEqual([]);
    expect(result.obligations).toEqual(expect.arrayContaining([
      expect.objectContaining({ functionName: "pad", kind: "max-length", result: "verified" }),
      expect.objectContaining({ functionName: "emit", kind: "shift-count", result: "verified" }),
      expect.objectContaining({ functionName: "emit", kind: "u8-write", result: "verified" }),
    ]));
  });

  it("validates readonly machine-domain tables and proves their indexed reads", async () => {
    const result = await verifyTypedArraySafety("constant-tables.ts", `
      import type { BoundedUint32Array, Nat, U32 } from "@mizchi/uneffect"
      import { U32_MAX } from "@mizchi/uneffect"
      const ROUND = u32Table([0x428a2f98, U32_MAX, 0x71374491] as const)
      const INVALID = u32Table([0, U32_MAX + 1] as const)
      /* uneffect:contract requires index < ROUND.length */
      function useRound(output: BoundedUint32Array<1>, index: Nat) {
        output[0] = ROUND[index]!
      }
      function unchecked(index: number) {
        return ROUND[index]
      }
    `);
    expect(result.obligations).toEqual(expect.arrayContaining([
      expect.objectContaining({ functionName: "<module>", kind: "constant-table-values", result: "verified", goal: expect.stringContaining("ROUND") }),
      expect.objectContaining({ functionName: "<module>", kind: "constant-table-values", result: "counterexample", goal: expect.stringContaining("INVALID") }),
      expect.objectContaining({ functionName: "useRound", kind: "constant-table-index", result: "verified" }),
    ]));
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ functionName: "<module>", kind: "constant-table-values" }),
      expect.objectContaining({ functionName: "unchecked", kind: "constant-table-index" }),
    ]));
    expect(result.diagnostics).not.toContainEqual(expect.objectContaining({ functionName: "useRound", kind: "u32-write" }));
  });

  it("resolves constant tables through imports, aliases, and barrel re-exports", async () => {
    const result = await verifyTypedArraySafetyInProgram({
      "/src/constants.ts": `
        export const SHA_K = u32Table([0x428a2f98, 0x71374491] as const)
      `,
      "/src/barrel.ts": `export { SHA_K as ROUND_CONSTANTS } from "./constants.js"`,
      "/src/round.ts": `
        import { ROUND_CONSTANTS as K } from "./barrel.js"
        import type { BoundedUint32Array, Nat } from "@mizchi/uneffect"
        /* uneffect:contract requires round < K.length */
        export function round(output: BoundedUint32Array<1>, round: Nat) {
          output[0] = K[round]!
        }
      `,
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.files["/src/round.ts"]?.obligations).toEqual(expect.arrayContaining([
      expect.objectContaining({ functionName: "round", kind: "constant-table-index", result: "verified" }),
      expect.objectContaining({ functionName: "round", kind: "u32-write", result: "verified" }),
    ]));
  });

  it("resolves constant tables through namespace imports", async () => {
    const result = await verifyTypedArraySafetyInProgram({
      "/src/constants.ts": `export const SHA_K = u32Table([0x428a2f98, 0x71374491] as const)`,
      "/src/round.ts": `
        import * as Tables from "./constants.js"
        import type { BoundedUint32Array, Nat } from "@mizchi/uneffect"
        /* uneffect:contract requires round < Tables.SHA_K.length */
        export function round(output: BoundedUint32Array<1>, round: Nat) {
          output[0] = Tables.SHA_K[round]!
        }
      `,
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.files["/src/round.ts"]?.obligations).toEqual(expect.arrayContaining([
      expect.objectContaining({ functionName: "round", kind: "constant-table-index", result: "verified" }),
      expect.objectContaining({ functionName: "round", kind: "u32-write", result: "verified" }),
    ]));
  });

  it("resolves constant tables through package exports", async () => {
    const result = await verifyTypedArraySafetyInProgram({
      "/node_modules/@fixtures/sha/package.json": JSON.stringify({
        name: "@fixtures/sha",
        exports: { ".": { types: "./dist/index.ts", default: "./dist/index.js" } },
      }),
      "/node_modules/@fixtures/sha/dist/index.ts": `export { SHA_K } from "./tables.js"`,
      "/node_modules/@fixtures/sha/dist/tables.ts": `export const SHA_K = u32Table([0x428a2f98, 0x71374491] as const)`,
      "/src/round.ts": `
        import { SHA_K } from "@fixtures/sha"
        import type { BoundedUint32Array, Nat } from "@mizchi/uneffect"
        /* uneffect:contract requires round < SHA_K.length */
        export function round(output: BoundedUint32Array<1>, round: Nat) {
          output[0] = SHA_K[round]!
        }
      `,
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.files["/src/round.ts"]?.obligations).toEqual(expect.arrayContaining([
      expect.objectContaining({ functionName: "round", kind: "constant-table-index", result: "verified" }),
      expect.objectContaining({ functionName: "round", kind: "u32-write", result: "verified" }),
    ]));
  });

  it("composes generated constant tables from verified spreads", async () => {
    const result = await verifyTypedArraySafety("generated-table.ts", `
      import type { Nat, U32 } from "@mizchi/uneffect"
      const PREFIX = u32Table([1, 2] as const)
      const SUFFIX = u32Table([3, 4] as const)
      const ROUND = u32Table([...PREFIX, ...SUFFIX, 5] as const)
      /* uneffect:contract requires index < ROUND.length */
      function read(index: Nat): U32 { return ROUND[index]! }
    `);
    expect(result.diagnostics).toEqual([]);
    expect(result.obligations).toEqual(expect.arrayContaining([
      expect.objectContaining({ functionName: "<module>", kind: "constant-table-values", goal: "ROUND elements are U32", result: "verified" }),
      expect.objectContaining({ functionName: "read", kind: "constant-table-index", goal: expect.stringContaining("< 5"), result: "verified" }),
    ]));
  });

  it("evaluates bounded Array.from constant-table generators", async () => {
    const result = await verifyTypedArraySafety("generated-array-from.ts", `
      import type { Nat, U32 } from "@mizchi/uneffect"
      const ROUNDS = 4
      const ROUND = u32Table(Array.from({ length: ROUNDS }, (_, index) => index * 0x01010101))
      const INVALID = u8Table(Array.from({ length: 2 }, (_, index) => index * 256))
      /* uneffect:contract requires index < ROUND.length */
      function read(index: Nat): U32 { return ROUND[index]! }
    `);
    expect(result.obligations).toEqual(expect.arrayContaining([
      expect.objectContaining({ functionName: "<module>", kind: "constant-table-values", goal: "ROUND elements are U32", result: "verified" }),
      expect.objectContaining({ functionName: "<module>", kind: "constant-table-values", goal: "INVALID elements are U8", result: "counterexample" }),
      expect.objectContaining({ functionName: "read", kind: "constant-table-index", result: "verified" }),
    ]));
  });

  it("tracks semantic integer casts through inferred local variables", async () => {
    const result = await verifyTypedArraySafety("integer-casts.ts", `
      import type { BoundedUint8Array, U8 } from "@mizchi/uneffect"
      function writeFloor(output: BoundedUint8Array<1>, value: U8) {
        const integer = Math.floor(value)
        output[0] = integer
      }
      function writeRound(output: BoundedUint8Array<1>, value: U8) {
        output[0] = Math.round(value)
      }
      function fractional(output: BoundedUint8Array<1>) {
        output[0] = 1.5
      }
      function shadowed(output: BoundedUint8Array<1>, value: U8, Math: { floor(value: number): number }) {
        output[0] = Math.floor(value)
      }
    `);
    expect(result.obligations).toEqual(expect.arrayContaining([
      expect.objectContaining({ functionName: "writeFloor", kind: "u8-write", result: "verified" }),
      expect.objectContaining({ functionName: "writeRound", kind: "u8-write", result: "verified" }),
      expect.objectContaining({ functionName: "fractional", kind: "u8-write", result: "counterexample" }),
    ]));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ functionName: "fractional", kind: "u8-write" }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ functionName: "shadowed", kind: "u8-write" }));
  });

  it("models reviewed Math.imul and Math.clz32 integer domains", async () => {
    const result = await verifyTypedArraySafety("math-int32.ts", `
      import type { BoundedDataView, U32 } from "@mizchi/uneffect"
      function multiply(view: BoundedDataView<4>, left: U32, right: U32) {
        view.setInt32(0, Math.imul(left, right))
      }
      function leadingZeros(view: BoundedDataView<1>, value: U32) {
        view.setUint8(0, Math.clz32(value))
      }
      function roundedByte(view: BoundedDataView<1>, value: U8) {
        view.setUint8(0, Math.fround(value))
      }
      function shadowed(view: BoundedDataView<4>, left: U32, right: U32, Math: { imul(a: number, b: number): number }) {
        view.setInt32(0, Math.imul(left, right))
      }
    `);
    expect(result.obligations).toEqual(expect.arrayContaining([
      expect.objectContaining({ functionName: "multiply", kind: "dataview-value", result: "verified" }),
      expect.objectContaining({ functionName: "leadingZeros", kind: "u8-write", result: "verified" }),
      expect.objectContaining({ functionName: "roundedByte", kind: "u8-write", result: "verified" }),
    ]));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ functionName: "shadowed", kind: "dataview-value" }));
  });

  it("keeps an explicit proof escape hatch visible as trusted evidence", async () => {
    const result = await verifyTypedArraySafety("trusted.ts", `
      import type { BoundedUint8Array } from "@mizchi/uneffect"
      /* uneffect:trust trust typed-array externally validated binary format */
      function decode(output: BoundedUint8Array<1>, value: number) {
        output[0] = value
      }
    `);
    expect(result.diagnostics).toEqual([]);
    expect(result.obligations).toContainEqual(expect.objectContaining({
      functionName: "decode", kind: "u8-write", result: "trusted",
      trustReason: "externally validated binary format",
    }));
    expect(result.obligations).not.toContainEqual(expect.objectContaining({ functionName: "decode", kind: "u8-write", result: "verified" }));
  });

  it("limits statement and obligation trust to the annotated typed-array operation", async () => {
    const result = await verifyTypedArraySafety("narrow-trust.ts", `
      type BoundedUint8Array<N extends number> = Uint8Array
      function decode(output: BoundedUint8Array<2>, first: number, second: number) {
        /* uneffect:trust trust typed-array externally checked first byte */
        /* uneffect:trust trust_owner packet-team */
        /* uneffect:trust trust_expires 2027-06-30 */
        output[0] = first
        output[1] = second
      }
      function writeView(view: BoundedDataView<1>, value: number) {
        /* uneffect:trust trust typed-array:u8-write external value validation */
        view.setUint8(2, value)
      }
    `);
    expect(result.obligations).toEqual(expect.arrayContaining([
      expect.objectContaining({ functionName: "decode", kind: "u8-write", goal: expect.stringContaining("first"), result: "trusted", trustOwner: "packet-team", trustExpiresOn: "2027-06-30" }),
      expect.objectContaining({ functionName: "decode", kind: "u8-write", goal: expect.stringContaining("second"), result: "counterexample" }),
      expect.objectContaining({ functionName: "writeView", kind: "u8-write", result: "trusted", trustReason: "external value validation" }),
      expect.objectContaining({ functionName: "writeView", kind: "dataview-bounds", result: "counterexample" }),
    ]));
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ functionName: "decode", kind: "u8-write", message: expect.stringContaining("second") }),
      expect.objectContaining({ functionName: "writeView", kind: "dataview-bounds" }),
    ]));
    expect(result.diagnostics).not.toContainEqual(expect.objectContaining({ functionName: "writeView", kind: "u8-write" }));
  });
});
