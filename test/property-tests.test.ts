import { mkdtempSync, rmSync } from "node:fs";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { checkUneffectProperty, generateUneffectPropertyTests } from "../src/property-tests.js";

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
});
