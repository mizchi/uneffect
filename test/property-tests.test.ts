import { mkdtempSync, rmSync } from "node:fs";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { checkUneffectProperty, generateUneffectPropertyTests, generateUneffectPropertyTestsWithZ3 } from "../src/property-tests.js";

const execFileAsync = promisify(execFile);

describe("property-test generation", () => {
  it("rejects unsupported parameter boundaries without pretending to generate coverage", () => {
    const result = generateUneffectPropertyTests({ files: { "value.ts": `/* uneffect: ensures result === value */ function identity(value: string) { return value }` } });
    expect(result.generatedFiles).toEqual({});
    expect(result.diagnostics[0]?.message).toContain("currently supports");
  });

  it("shrinks, persists, and prioritizes a replayable counterexample", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-property-"));
    const path = join(directory, "failure.json");
    try {
      const options = { functionName: "broken", domains: ["Int"] as const, cases: 20, counterexamplePath: path, property: async (value: number) => value <= 0 };
      const first = await checkUneffectProperty(options);
      expect(first).toMatchObject({ status: "counterexample", replayed: false, counterexample: { arguments: [1] } });
      expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ version: "uneffect-counterexample/v1", arguments: [1] });
      const replay = await checkUneffectProperty(options);
      expect(replay).toMatchObject({ status: "counterexample", replayed: true, tested: 1 });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("derives bounded typed-array and literal-union domains from TypeScript syntax", () => {
    const result = generateUneffectPropertyTests({ files: { "packet.ts": `
      import type { BoundedUint8Array } from "@mizchi/uneffect"
      /* uneffect: ensures result >= 0 */
      export function score(bytes: BoundedUint8Array<4>, mode: "fast" | "safe"): number {
        return bytes.length + mode.length
      }
    ` } });
    expect(result.diagnostics).toEqual([]);
    expect(result.boundaries[0]?.generators).toEqual([
      { kind: "bounded-array", element: "U8", maximum: 4 },
      { kind: "union", members: [{ kind: "literal", value: "fast" }, { kind: "literal", value: "safe" }] },
    ]);
    expect(result.generatedFiles["packet.uneffect.test.ts"]).toContain("new Uint8Array(value)");
  });

  it("shrinks a bounded array by structure and then by element value", async () => {
    const result = await checkUneffectProperty({
      functionName: "broken-bytes",
      domains: [{ kind: "bounded-array", element: "U8", maximum: 4 }],
      cases: 20,
      property: (value) => (value as Uint8Array).length === 0,
    });
    expect(result).toMatchObject({
      status: "counterexample",
      counterexample: { version: "uneffect-counterexample/v2", arguments: [[0]] },
    });
  });

  it("executes the generated typed-array and union property with Vitest", async () => {
    const directory = mkdtempSync(join(process.cwd(), ".tmp-uneffect-property-"));
    try {
      const source = `
        type BoundedUint8Array<N extends number> = Uint8Array
        /* uneffect: ensures result >= 0 */
        export function score(bytes: BoundedUint8Array<4>, mode: "fast" | "safe"): number {
          return bytes.length + mode.length
        }
      `;
      const generated = generateUneffectPropertyTests({ files: { [`${directory}/packet.ts`]: source }, cases: 12 });
      const generatedName = `${directory}/packet.uneffect.test.ts`;
      await writeFile(`${directory}/packet.ts`, source);
      await writeFile(generatedName, generated.generatedFiles[generatedName]!);
      const result = await execFileAsync("pnpm", ["vitest", "run", generatedName], { cwd: process.cwd() });
      expect(result.stdout).toContain("1 passed");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 15_000);

  it("persists a minimized generated-test counterexample and replays it first", async () => {
    const directory = mkdtempSync(join(process.cwd(), ".tmp-uneffect-replay-"));
    const artifactDirectory = join(directory, "counterexamples");
    try {
      const source = `
        /* uneffect: ensures result <= 0 */
        export function positive(value: Int): number { return Math.abs(value) }
      `;
      const fileName = join(directory, "positive.ts"), generatedName = join(directory, "positive.uneffect.test.ts");
      const generated = generateUneffectPropertyTests({ files: { [fileName]: source }, cases: 20, counterexampleDirectory: artifactDirectory });
      await writeFile(fileName, `type Int = number\n${source}`);
      await writeFile(generatedName, generated.generatedFiles[generatedName]!);
      await expect(execFileAsync("pnpm", ["vitest", "run", generatedName], { cwd: process.cwd() })).rejects.toBeDefined();
      const artifact = join(artifactDirectory, "positive.uneffect-counterexample.json");
      expect(JSON.parse(await readFile(artifact, "utf8"))).toMatchObject({ functionName: "positive", arguments: [1] });
      try { await execFileAsync("pnpm", ["vitest", "run", generatedName], { cwd: process.cwd() }); }
      catch (cause) {
        const output = `${String((cause as { stdout?: string }).stdout)}\n${String((cause as { stderr?: string }).stderr)}`;
        expect(output).toContain('"replayed":true');
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 20_000);

  it("resource-bounds generated arrays unless the caller raises the cap", async () => {
    let largest = 0;
    await checkUneffectProperty({
      functionName: "bounded-memory",
      domains: [{ kind: "bounded-array", element: "U8", maximum: 1_000_000 }],
      arrayLengthCap: 32,
      cases: 8,
      property: (value) => { largest = Math.max(largest, (value as Uint8Array).length); return true; },
    });
    expect(largest).toBe(32);
  });

  it("derives executable boundary candidates from conjunctive numeric refinements", () => {
    const result = generateUneffectPropertyTests({ files: { "range.ts": `
      type Int = number
      /* uneffect: requires value >= 10 && value < 20 */
      /* uneffect: ensures result >= 10 */
      export function clamp(value: Int): Int { return value }
    ` } });
    expect(result.boundaries[0]?.generatorHints).toEqual([[10, 11, 18, 19]]);
    expect(result.generatedFiles["range.uneffect.test.ts"]).toContain("const refinementValues = [[10,11,18,19]]");
  });

  it("derives candidates from disjoint refinement branches", () => {
    const result = generateUneffectPropertyTests({ files: { "disjoint.ts": `
      type Int = number
      /* uneffect: requires (value >= 10 && value < 12) || (value >= 20 && value < 22) */
      /* uneffect: ensures result >= 10 */
      export function choose(value: Int): Int { return value }
    ` } });
    expect(result.boundaries[0]?.generatorHints).toEqual([[10, 11, 20, 21]]);
  });

  it("normalizes single-variable affine refinement boundaries", () => {
    const result = generateUneffectPropertyTests({ files: { "affine.ts": `
      type Int = number
      /* uneffect: requires value + 2 < 10 && 20 <= 3 + value */
      /* uneffect: ensures result >= 17 */
      export function affine(value: Int): Int { return value }
    ` } });
    expect(result.boundaries[0]?.generatorHints).toEqual([[6, 7, 17, 18]]);
  });

  it("derives aligned boundary candidates from a positive modulo refinement", () => {
    const result = generateUneffectPropertyTests({ files: { "shard.ts": `
      type Nat = number
      /* uneffect: requires shard >= 0 && shard < 1024 && shard % 16 === 0 */
      /* uneffect: ensures result >= 0 */
      export function alignedShard(shard: Nat): Nat { return shard }
    ` } });
    expect(result.boundaries[0]?.generatorHints).toEqual([[0, 16, 1008]]);
    expect(result.generatedFiles["shard.uneffect.test.ts"]).toContain("const refinementValues = [[0,16,1008]]");
  });

  it("keeps range and modulo constraints local to each disjunctive branch", () => {
    const result = generateUneffectPropertyTests({ files: { "tenant-shard.ts": `
      type Nat = number
      /* uneffect: requires (shard >= 0 && shard < 32 && shard % 16 === 0) || (shard >= 100 && shard < 132 && shard % 16 === 4) */
      /* uneffect: ensures result >= 0 */
      export function tenantShard(shard: Nat): Nat { return shard }
    ` } });
    expect(result.boundaries[0]?.generatorHints).toEqual([[0, 16, 100, 116]]);
  });

  it("bounds DNF hint expansion and falls back without losing scalar seeds", () => {
    const alternatives = Array.from({ length: 6 }, () => "(value === 0 || value === 1)").join(" && ");
    const result = generateUneffectPropertyTests({ files: { "bounded-dnf.ts": `
      type Int = number
      /* uneffect: requires ${alternatives} */
      /* uneffect: ensures result >= 0 */
      export function bounded(value: Int): Int { return value }
    ` } });
    expect(result.boundaries[0]?.generatorHints).toEqual([[0, 1]]);
  });

  it("derives correlated tuples from affine parameter equalities", () => {
    const result = generateUneffectPropertyTests({ files: { "dependent.ts": `
      type Int = number
      /* uneffect: requires x >= 10 && x < 12 && y === x + 1 */
      /* uneffect: ensures result === y */
      export function dependent(x: Int, y: Int): Int { return y }
    ` } });
    expect(result.boundaries[0]?.generatorTuples).toEqual([[10, 11], [11, 12]]);
    expect(result.generatedFiles["dependent.uneffect.test.ts"]).toContain("const refinementTuples = [[10,11],[11,12]]");
  });

  it("composes a chain of affine parameter equalities", () => {
    const result = generateUneffectPropertyTests({ files: { "chain.ts": `
      type Int = number
      /* uneffect: requires x >= 10 && x < 12 && y === x + 1 && z === y + 2 */
      /* uneffect: ensures result === z */
      export function chain(x: Int, y: Int, z: Int): Int { return z }
    ` } });
    expect(result.boundaries[0]?.generatorTuples).toEqual([[10, 11, 13], [11, 12, 14]]);
  });

  it("derives valid correlated tuples for a nonlinear refinement with Z3", async () => {
    const result = await generateUneffectPropertyTestsWithZ3({ files: { "circle.ts": `
      type Int = number
      /* uneffect: requires x >= 0 && y >= 0 && x * x + y * y === 25 */
      /* uneffect: ensures result >= 0 */
      export function radius(x: Int, y: Int): Int { return x + y }
    ` }, solverCases: 8 });
    const tuples = result.boundaries[0]?.generatorTuples ?? [];
    expect(tuples.length).toBeGreaterThanOrEqual(2);
    expect(tuples.every(([x, y]) => Number(x) >= 0 && Number(y) >= 0 && Number(x) ** 2 + Number(y) ** 2 === 25)).toBe(true);
    expect(result.generatedFiles["circle.uneffect.test.ts"]).toContain(`const refinementTuples = ${JSON.stringify(tuples)}`);
    expect(result.generatedFiles["circle.uneffect.test.ts"]).toContain("for (const joint of refinementTuples");
    expect(result.solverDiagnostics).toEqual([]);
  });

  it("synthesizes a minimum-size constraint-preserving shrink tuple first", async () => {
    const result = await generateUneffectPropertyTestsWithZ3({ files: { "factor.ts": `
      type Nat = number
      /* uneffect: requires x >= 1 && y >= 1 && x * y === 36 */
      /* uneffect: ensures result === 36 */
      export function factor(x: Nat, y: Nat): Nat { return x * y }
    ` }, solverCases: 1 });
    expect(result.boundaries[0]?.generatorTuples).toEqual([[6, 6]]);
    expect(result.solverDiagnostics).toEqual([]);
  });

  it("derives solver-backed bounded-array inputs and constraint-preserving shrink tuples", async () => {
    const result = await generateUneffectPropertyTestsWithZ3({ files: { "packet.ts": `
      type U8 = number
      type BoundedUint8Array<N extends number> = Uint8Array
      /* uneffect: requires bytes.length === 2 && bytes[0] + bytes[1] === 300 */
      /* uneffect: ensures result === 300 */
      export function checksum(bytes: BoundedUint8Array<2>): number { return bytes[0]! + bytes[1]! }
    ` }, solverCases: 6 });
    const tuples = result.boundaries[0]?.generatorTuples ?? [];
    expect(tuples.length).toBeGreaterThanOrEqual(2);
    expect(tuples.every(([bytes]) => Array.isArray(bytes) && bytes.length === 2 && bytes[0]! + bytes[1]! === 300)).toBe(true);
    expect(result.generatedFiles["packet.uneffect.test.ts"]).toContain(`const refinementTuples = ${JSON.stringify(tuples)}`);
    expect(result.solverDiagnostics).toEqual([]);

    const shrunk = await checkUneffectProperty({
      functionName: "packet-failure",
      domains: [{ kind: "bounded-array", element: "U8", maximum: 2 }],
      refinementTuples: tuples,
      precondition: (bytes: Uint8Array) => bytes.length === 2 && bytes[0]! + bytes[1]! === 300,
      property: () => false,
    });
    expect(shrunk.status).toBe("counterexample");
    const bytes = shrunk.counterexample?.arguments[0];
    expect(Array.isArray(bytes) && bytes.length === 2 && bytes[0]! + bytes[1]! === 300).toBe(true);
  });

  it("derives bounded-array inputs through a dynamic finite index", async () => {
    const result = await generateUneffectPropertyTestsWithZ3({ files: { "lookup.ts": `
      type U8 = number
      type BoundedUint8Array<N extends number> = Uint8Array
      /* uneffect: requires bytes.length === 2 && index < bytes.length && bytes[index] === 255 */
      /* uneffect: ensures result === 255 */
      export function lookup(bytes: BoundedUint8Array<2>, index: U8): number { return bytes[index]! }
    ` }, solverCases: 6 });
    const tuples = result.boundaries[0]?.generatorTuples ?? [];
    expect(tuples.length).toBeGreaterThanOrEqual(2);
    expect(tuples.every(([bytes, index]) => Array.isArray(bytes) && typeof index === "number"
      && index < bytes.length && bytes[index] === 255)).toBe(true);
    expect(result.solverDiagnostics).toEqual([]);
  });

  it("derives solver-backed closed-record inputs", async () => {
    const result = await generateUneffectPropertyTestsWithZ3({ files: { "pixel.ts": `
      type U8 = number
      /* uneffect: requires pixel.red + pixel.green === 300 */
      /* uneffect: ensures result === 300 */
      export function intensity(pixel: { red: U8; green: U8 }): number { return pixel.red + pixel.green }
    ` }, solverCases: 6 });
    const tuples = result.boundaries[0]?.generatorTuples ?? [];
    expect(tuples.length).toBeGreaterThanOrEqual(2);
    expect(tuples.every(([pixel]) => pixel !== null && typeof pixel === "object" && !Array.isArray(pixel)
      && Number(pixel.red) + Number(pixel.green) === 300)).toBe(true);
    expect(result.solverDiagnostics).toEqual([]);

    const shrunk = await checkUneffectProperty({
      functionName: "pixel-failure",
      domains: [{ kind: "record", fields: { red: "U8", green: "U8" } }],
      refinementTuples: tuples,
      precondition: (pixel: { red: number; green: number }) => pixel.red + pixel.green === 300,
      property: () => false,
    });
    expect(shrunk.status).toBe("counterexample");
    const pixel = shrunk.counterexample?.arguments[0];
    expect(pixel !== null && typeof pixel === "object" && !Array.isArray(pixel)
      && Number(pixel.red) + Number(pixel.green) === 300).toBe(true);
  });

  it("derives and shrinks solver-backed nested-record inputs", async () => {
    const result = await generateUneffectPropertyTestsWithZ3({ files: { "nested-pixel.ts": `
      type U8 = number
      /* uneffect: requires pixel.color.red + pixel.color.green === 300 && pixel.alpha === 255 */
      /* uneffect: ensures result === 555 */
      export function intensity(pixel: { color: { red: U8; green: U8 }; alpha: U8 }): number {
        return pixel.color.red + pixel.color.green + pixel.alpha
      }
    ` }, solverCases: 6 });
    const [domain] = result.boundaries[0]?.generators ?? [];
    expect(domain).toEqual({ kind: "record", fields: {
      color: { kind: "record", fields: { red: "U8", green: "U8" } }, alpha: "U8",
    } });
    const tuples = result.boundaries[0]?.generatorTuples ?? [];
    expect(tuples.length).toBeGreaterThanOrEqual(2);
    expect(tuples.every(([pixel]) => pixel !== null && typeof pixel === "object" && !Array.isArray(pixel)
      && pixel.color !== null && typeof pixel.color === "object" && !Array.isArray(pixel.color)
      && Number(pixel.color.red) + Number(pixel.color.green) === 300 && pixel.alpha === 255)).toBe(true);
    expect(result.solverDiagnostics).toEqual([]);

    const shrunk = await checkUneffectProperty({
      functionName: "nested-pixel-failure",
      domains: [domain!],
      refinementTuples: tuples,
      precondition: (pixel: { color: { red: number; green: number }; alpha: number }) =>
        pixel.color.red + pixel.color.green === 300 && pixel.alpha === 255,
      property: () => false,
    });
    expect(shrunk.status).toBe("counterexample");
    const pixel = shrunk.counterexample?.arguments[0];
    expect(pixel !== null && typeof pixel === "object" && !Array.isArray(pixel)
      && pixel.color !== null && typeof pixel.color === "object" && !Array.isArray(pixel.color)
      && Number(pixel.color.red) + Number(pixel.color.green) === 300 && pixel.alpha === 255).toBe(true);
  });

  it("distinguishes absent optional fields from present zero values", async () => {
    const result = await generateUneffectPropertyTestsWithZ3({ files: { "optional.ts": `
      type U8 = number
      /* uneffect: requires config.limit === undefined || config.limit >= 10 */
      /* uneffect: ensures result >= 0 */
      export function limit(config: { limit?: U8 }): number { return config.limit ?? 0 }
    ` }, solverCases: 8 });
    expect(result.boundaries[0]?.generators).toEqual([
      { kind: "record", fields: { limit: "U8" }, optional: ["limit"] },
    ]);
    const values = (result.boundaries[0]?.generatorTuples ?? []).map(([value]) => value);
    expect(values).toContainEqual({});
    expect(values.some((value) => value !== null && typeof value === "object" && !Array.isArray(value)
      && Object.hasOwn(value, "limit") && Number(value.limit) >= 10)).toBe(true);
    expect(result.solverDiagnostics).toEqual([]);
  });

  it("uses one shared presence bit for an optional object-valued field", async () => {
    const result = await generateUneffectPropertyTestsWithZ3({ files: { "optional-object.ts": `
      type U8 = number
      /* uneffect: requires config.range === undefined || config.range.min + config.range.max === 300 */
      /* uneffect: ensures result >= 0 */
      export function width(config: { range?: { min: U8; max: U8 } }): number {
        return config.range === undefined ? 0 : config.range.max - config.range.min
      }
    ` }, solverCases: 8 });
    expect(result.boundaries[0]?.generators).toEqual([{ kind: "record", fields: {
      range: { kind: "record", fields: { min: "U8", max: "U8" } },
    }, optional: ["range"] }]);
    const values = (result.boundaries[0]?.generatorTuples ?? []).map(([value]) => value);
    expect(values).toContainEqual({});
    expect(values.some((value) => value !== null && typeof value === "object" && !Array.isArray(value)
      && value.range !== null && typeof value.range === "object" && !Array.isArray(value.range)
      && Number(value.range.min) + Number(value.range.max) === 300)).toBe(true);
    expect(values.every((value) => value !== null && typeof value === "object" && !Array.isArray(value)
      && (!Object.hasOwn(value, "range") || value.range !== null && typeof value.range === "object"
        && !Array.isArray(value.range) && Object.hasOwn(value.range, "min") && Object.hasOwn(value.range, "max")))).toBe(true);
    expect(result.solverDiagnostics).toEqual([]);
  });

  it("derives bounded Set domains and materializes them as native Sets", async () => {
    const source = `
      type U8 = number
      type BoundedSet<T, N extends number> = Set<T>
      /* uneffect: ensures result >= 0 */
      export function total(values: BoundedSet<U8, 3>): number {
        return [...values].reduce((sum, value) => sum + value, 0)
      }
    `;
    const generated = generateUneffectPropertyTests({ files: { "set.ts": source }, cases: 8 });
    expect(generated.boundaries[0]?.generators).toEqual([
      { kind: "bounded-set", element: "U8", maximum: 3 },
    ]);
    expect(generated.generatedFiles["set.uneffect.test.ts"]).toContain("new Set(value)");

    let sawSet = false;
    await checkUneffectProperty({
      functionName: "set-materialization",
      domains: [{ kind: "bounded-set", element: "U8", maximum: 3 }],
      cases: 8,
      property: (values) => { sawSet ||= values instanceof Set; return values instanceof Set; },
    });
    expect(sawSet).toBe(true);
  });

  it("generates finite Set inputs satisfying size and membership refinements", async () => {
    const result = await generateUneffectPropertyTestsWithZ3({ files: { "set-refined.ts": `
      type U8 = number
      type BoundedSet<T, N extends number> = Set<T>
      /* uneffect: requires values.size === 2 && values.has(10) && !values.has(0) */
      /* uneffect: ensures result === true */
      export function containsTen(values: BoundedSet<U8, 3>): boolean { return values.has(10) }
    ` }, solverCases: 6 });
    const tuples = result.boundaries[0]?.generatorTuples ?? [];
    expect(tuples.length).toBeGreaterThan(0);
    expect(tuples.every(([values]) => Array.isArray(values) && values.length === 2
      && values.includes(10) && !values.includes(0))).toBe(true);
    expect(result.solverDiagnostics).toEqual([]);
  });

  it("derives bounded Map domains and materializes JSON-safe entries as native Maps", async () => {
    const source = `
      type U8 = number
      type BoundedMap<K, V, N extends number> = Map<K, V>
      /* uneffect: ensures result >= 0 */
      export function total(values: BoundedMap<U8, U8, 3>): number {
        return [...values.values()].reduce((sum, value) => sum + value, 0)
      }
    `;
    const generated = generateUneffectPropertyTests({ files: { "map.ts": source }, cases: 8 });
    expect(generated.boundaries[0]?.generators).toEqual([
      { kind: "bounded-map", key: "U8", value: "U8", maximum: 3 },
    ]);
    expect(generated.generatedFiles["map.uneffect.test.ts"]).toContain("new Map(value.keys.map");

    let sawMap = false;
    await checkUneffectProperty({
      functionName: "map-materialization",
      domains: [{ kind: "bounded-map", key: "U8", value: "U8", maximum: 3 }],
      cases: 8,
      property: (values) => { sawMap ||= values instanceof Map; return values instanceof Map; },
    });
    expect(sawMap).toBe(true);
  });

  it("generates finite Map inputs satisfying size, membership, and lookup refinements", async () => {
    const result = await generateUneffectPropertyTestsWithZ3({ files: { "map-refined.ts": `
      type U8 = number
      type BoundedMap<K, V, N extends number> = Map<K, V>
      /* uneffect: requires values.size === 2 && values.get(1) === 10 && values.has(2) */
      /* uneffect: ensures result === 10 */
      export function lookup(values: BoundedMap<U8, U8, 3>): number { return values.get(1)! }
    ` }, solverCases: 6 });
    const tuples = result.boundaries[0]?.generatorTuples ?? [];
    expect(tuples.length).toBeGreaterThan(0);
    expect(tuples.every(([encoded]) => {
      if (encoded === null || typeof encoded !== "object" || Array.isArray(encoded)
        || !Array.isArray(encoded.keys) || !Array.isArray(encoded.values)) return false;
      const keys = encoded.keys, entries = encoded.values;
      const values = new Map(keys.map((key, index) => [key, entries[index]]));
      return values.size === 2 && values.get(1) === 10 && values.has(2);
    })).toBe(true);
    expect(result.solverDiagnostics).toEqual([]);
  });

  it("reports an unsatisfiable property precondition instead of inventing inputs", async () => {
    const result = await generateUneffectPropertyTestsWithZ3({ files: { "empty.ts": `
      type Int = number
      /* uneffect: requires x > 0 && x < 0 */
      /* uneffect: ensures result === x */
      export function impossible(x: Int): Int { return x }
    ` } });
    expect(result.boundaries[0]?.generatorTuples).toEqual([]);
    expect(result.solverDiagnostics).toContainEqual(expect.objectContaining({
      functionName: "impossible", status: "unsat", message: expect.stringContaining("no scalar model"),
    }));
  });

  it("uses refinement candidates before broad scalar edges", async () => {
    const seen: number[] = [];
    const result = await checkUneffectProperty({
      functionName: "range",
      domains: ["Int"],
      refinementValues: [[10, 11, 18, 19]],
      cases: 4,
      precondition: (value) => value >= 10 && value < 20,
      property: (value) => { seen.push(value); return true; },
    });
    expect(result).toMatchObject({ status: "passed", tested: 4 });
    expect(seen).toEqual([10, 11, 18, 19]);
  });

  it("uses correlated refinement tuples before the Cartesian product", async () => {
    const seen: number[][] = [];
    const result = await checkUneffectProperty({
      functionName: "dependent",
      domains: ["Int", "Int"],
      refinementTuples: [[10, 11], [11, 12]],
      cases: 2,
      precondition: (x, y) => y === x + 1,
      property: (x, y) => { seen.push([x, y]); return true; },
    });
    expect(result).toMatchObject({ status: "passed", tested: 2 });
    expect(seen).toEqual([[10, 11], [11, 12]]);
  });

  it("shrinks dependent inputs jointly while preserving their precondition", async () => {
    const result = await checkUneffectProperty({
      functionName: "dependent-failure",
      domains: ["Int", "Int"],
      refinementTuples: [[100, 101], [10, 11], [1, 2]],
      cases: 3,
      precondition: (x, y) => y === x + 1,
      property: () => false,
    });
    expect(result).toMatchObject({
      status: "counterexample",
      counterexample: { version: "uneffect-counterexample/v1", arguments: [1, 2] },
    });
  });
});
