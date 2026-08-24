import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildVerifiedOwnership, buildVerifiedOwnershipCached, instrumentOwnershipAssertions, instrumentRuntimeAssertions, optimizeOwnershipAssertions } from "../src/instrument.js";
import { verifyOwnershipObligationWithZ3 } from "../src/evidence.js";

describe("runtime assertion instrumenter", () => {
  it("injects a named numeric assertion into a function", () => {
    const source = `
      import type { Nat } from "@mizchi/uneffect";
      /* uneffect: assert value: Nat */
      function double(value: Nat) { return value * 2 }
    `;
    const result = instrumentRuntimeAssertions("input.ts", source);
    expect(result.diagnostics).toEqual([]);
    expect(result.code).toContain(`import * as __uneffect_v from "valibot";`);
    expect(result.code).toContain(`__uneffect_v.parse(__uneffect_v.pipe(__uneffect_v.number(), __uneffect_v.safeInteger(), __uneffect_v.minValue(0)), value);`);
  });

  it("embeds an explicit Valibot schema expression", () => {
    const source = `
      /* uneffect: assert name: v.pipe(v.string(), v.nonEmpty()) */
      function greet(name: string) { return name }
    `;
    const result = instrumentRuntimeAssertions("input.ts", source);
    expect(result.diagnostics).toEqual([]);
    expect(result.code).toContain(`__uneffect_v.parse(__uneffect_v.pipe(__uneffect_v.string(), __uneffect_v.nonEmpty()), name);`);
  });

  it("rejects assertions for unknown parameters", () => {
    const result = instrumentRuntimeAssertions("input.ts", `
      /* uneffect: assert missing: Nat */
      function f(value: number) { return value }
    `);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ kind: "unknown-parameter", parameter: "missing" }));
  });

  it("inserts unresolved ownership checks and elides them only with matching verifier evidence", async () => {
    const names = Array.from({ length: 13 }, (_, index) => `b${index}`);
    const guard = names.join(" && "), parameters = names.map((name) => `${name}: boolean`).join(", ");
    const arguments_ = names.join(", ");
    const source = `
      declare function task(): Promise<void>
      /* uneffect: consumes_rejection_when 13: ${guard} */
      declare function consume(${parameters}, value: Promise<void>): void
      /* uneffect: requires ${guard} */
      async function run(${parameters}) {
        const pending = task()
        consume(${arguments_}, pending)
      }
    `;
    const instrumented = instrumentOwnershipAssertions("ownership.ts", source);
    expect(instrumented.diagnostics).toEqual([]);
    expect(instrumented.assertions).toHaveLength(1);
    expect(instrumented.assertions[0]?.obligation).toMatchObject({ owner: "run", status: "unresolved" });
    expect(instrumented.code).toContain("uneffectAssertOwnership(");
    expect(optimizeOwnershipAssertions(instrumented, []).code).toBe(instrumented.code);
    const artifact = await verifyOwnershipObligationWithZ3(instrumented.assertions[0]!.obligation);
    expect(artifact.result).toBe("verified");
    const optimized = optimizeOwnershipAssertions(instrumented, [artifact]);
    expect(optimized.code).not.toContain(instrumented.assertions[0]!.assertion);
    expect(optimized.code).not.toContain("function uneffectAssertOwnership");
    expect(optimized.code).toContain("consume(");
    const verifiedBuild = await buildVerifiedOwnership("ownership.ts", source);
    expect(verifiedBuild.artifacts).toHaveLength(1);
    expect(verifiedBuild.artifacts[0]).toMatchObject({ backend: "z3", result: "verified", evidence: "verified" });
    expect(verifiedBuild.unresolved).toEqual([]);
    expect(verifiedBuild.code).not.toContain("uneffectAssertOwnership");
    expect(verifiedBuild.code).toContain("consume(");
  });

  it("persists and reuses matching ownership evidence while reporting stale entries", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-cache-test-"));
    const evidencePath = join(directory, "ownership.json");
    const source = (last: string) => `
      declare function task(): Promise<void>
      /* uneffect: consumes_rejection_when 13: b0 && b1 && b2 && b3 && b4 && b5 && b6 && b7 && b8 && b9 && b10 && b11 && ${last} */
      declare function consume(b0: boolean, b1: boolean, b2: boolean, b3: boolean, b4: boolean, b5: boolean, b6: boolean, b7: boolean, b8: boolean, b9: boolean, b10: boolean, b11: boolean, b12: boolean, value: Promise<void>): void
      /* uneffect: requires b0 && b1 && b2 && b3 && b4 && b5 && b6 && b7 && b8 && b9 && b10 && b11 && b12 */
      async function run(b0: boolean, b1: boolean, b2: boolean, b3: boolean, b4: boolean, b5: boolean, b6: boolean, b7: boolean, b8: boolean, b9: boolean, b10: boolean, b11: boolean, b12: boolean) {
        consume(b0, b1, b2, b3, b4, b5, b6, b7, b8, b9, b10, b11, b12, task())
      }
    `;
    try {
      const first = await buildVerifiedOwnershipCached("ownership.ts", source("b12"), evidencePath);
      expect(first.cache).toMatchObject({ reused: 0, verified: 1, stale: [] });
      expect(JSON.parse(readFileSync(evidencePath, "utf8"))).toMatchObject({ schema: "ownership-evidence-cache/v1", entries: [expect.any(Object)] });

      const second = await buildVerifiedOwnershipCached("ownership.ts", source("b12"), evidencePath);
      expect(second.cache).toMatchObject({ reused: 1, verified: 0, stale: [] });

      const changed = await buildVerifiedOwnershipCached("ownership.ts", source("!b12"), evidencePath);
      expect(changed.cache.reused).toBe(0);
      expect(changed.cache.stale).toHaveLength(1);
      expect(changed.unresolved).toHaveLength(1);
      expect(changed.code).toContain("uneffectAssertOwnership");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
