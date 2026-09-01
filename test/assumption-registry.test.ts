import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AssumptionRegistryError,
  loadAssumptionRegistry,
  parseAssumptionRegistry,
  resolveAssumptionRecord,
} from "../src/assumption-registry.js";
import { verifyUneffectProject } from "../src/project-verification.js";

const digest = "a".repeat(64);

describe("authenticated assumption registry", () => {
  it("accepts versioned, review-bound metadata and resolves an exact domain ID", () => {
    const registry = parseAssumptionRegistry({
      schema: "uneffect-assumption-registry/v1",
      records: [{
        id: "wire-format-v1",
        domain: "typed-array",
        reason: "validated against the wire format",
        owner: "binary-platform",
        expiresOn: "2027-01-31",
        reviewDigest: digest,
      }],
    });

    expect(resolveAssumptionRecord(registry, "wire-format-v1", "typed-array")).toEqual({
      id: "wire-format-v1",
      domain: "typed-array",
      reason: "validated against the wire format",
      owner: "binary-platform",
      expiresOn: "2027-01-31",
      reviewDigest: digest,
    });
    expect(resolveAssumptionRecord(registry, "wire-format-v1", "dispatch-sealing")).toBeUndefined();
  });

  it.each([
    ["duplicate IDs", [{ id: "same", domain: "typed-array", reason: "one", owner: "a", reviewDigest: digest }, { id: "same", domain: "builtin", reason: "two", owner: "b", reviewDigest: digest }], /duplicate assumption ID/],
    ["unknown domains", [{ id: "bad", domain: "everything", reason: "bad", owner: "a", reviewDigest: digest }], /unsupported domain/],
    ["invalid review digests", [{ id: "bad", domain: "typed-array", reason: "bad", owner: "a", reviewDigest: "source-authored" }], /lowercase SHA-256/],
    ["invalid dates", [{ id: "bad", domain: "typed-array", reason: "bad", owner: "a", expiresOn: "2027-02-30", reviewDigest: digest }], /valid calendar date/],
  ])("rejects %s", (_name, records, message) => {
    expect(() => parseAssumptionRegistry({ schema: "uneffect-assumption-registry/v1", records }))
      .toThrow(message);
  });

  it("rejects unknown schema fields", () => {
    expect(() => parseAssumptionRegistry({
      schema: "uneffect-assumption-registry/v1", records: [], trustEverything: true,
    })).toThrow(AssumptionRegistryError);
  });

  it("loads the same strict contract from a caller-owned JSON file", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-assumptions-"));
    const fileName = join(directory, "assumptions.json");
    try {
      writeFileSync(fileName, JSON.stringify({ schema: "uneffect-assumption-registry/v1", records: [] }));
      await expect(loadAssumptionRegistry(fileName)).resolves.toEqual({
        schema: "uneffect-assumption-registry/v1", records: [],
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("carries registry-authenticated metadata into the project assumption ledger", async () => {
    const fileName = "src/registry-trusted.ts";
    const registry = parseAssumptionRegistry({
      schema: "uneffect-assumption-registry/v1",
      records: [{
        id: "wire-format-v1", domain: "typed-array", reason: "reviewed wire format",
        owner: "binary-platform", expiresOn: "2027-01-31", reviewDigest: digest,
      }],
    });
    const result = await verifyUneffectProject({
      files: { [fileName]: `
        type BoundedUint8Array<N extends number> = Uint8Array
        /* uneffect:trust trust typed-array wire-format-v1 */
        function decode(output: BoundedUint8Array<1>, value: number) { output[0] = value }
      ` },
      assumptionRegistry: registry,
      assumptionPolicy: { requireOwner: true, requireExpiration: true, asOf: "2026-09-02" },
    });
    expect(result.assumptions.entries).toContainEqual(expect.objectContaining({
      id: "wire-format-v1", domain: "typed-array", owner: "binary-platform",
      expiresOn: "2027-01-31", reviewDigest: digest,
    }));
    expect(result.assumptions.violations).toEqual([]);
  });

  it("binds temporal and dispatch references to domain-matched review records", async () => {
    const registry = parseAssumptionRegistry({
      schema: "uneffect-assumption-registry/v1",
      records: [
        { id: "runtime-summary-v1", domain: "temporal-contract", reason: "reviewed runtime summary", owner: "runtime-team", reviewDigest: "b".repeat(64) },
        { id: "closed-runtime-v1", domain: "dispatch-sealing", reason: "reviewed closed class graph", owner: "runtime-team", reviewDigest: "c".repeat(64) },
      ],
    });
    const result = await verifyUneffectProject({
      files: { "src/runtime.ts": `
        /* uneffect:temporal_contract ensures ready' = true */
        /* uneffect:trust trust assumption runtime-summary-v1 */
        function start() {}
        /* uneffect:trust trust dispatch-sealing closed-runtime-v1 */
        export class Runtime { run() {} }
      ` },
      assumptionRegistry: registry,
      assumptionPolicy: { requireOwner: true, asOf: "2026-09-02" },
    });
    expect(result.assumptions.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "runtime-summary-v1", domain: "temporal-contract", reason: "reviewed runtime summary" }),
      expect.objectContaining({ id: "closed-runtime-v1", domain: "dispatch-sealing", reason: "reviewed closed class graph" }),
    ]));
    expect(result.assumptions.violations).toEqual([]);
  });

  it("does not trust an unresolved typed-array assumption ID", async () => {
    const result = await verifyUneffectProject({
      files: { "src/unresolved.ts": `
        type BoundedUint8Array<N extends number> = Uint8Array
        /* uneffect:trust trust typed-array missing-review */
        function decode(output: BoundedUint8Array<1>, value: number) { output[0] = value }
      ` },
      assumptionRegistry: parseAssumptionRegistry({ schema: "uneffect-assumption-registry/v1", records: [] }),
    });
    expect(result.typedArrays.obligations).toContainEqual(expect.objectContaining({
      functionName: "decode", result: "counterexample",
    }));
    expect(result.assumptions.entries).not.toContainEqual(expect.objectContaining({ id: "missing-review" }));
    expect(result.assurance.passed).toBe(false);
  });
});
