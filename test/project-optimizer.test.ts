import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { optimizeUneffectProject } from "../src/project-optimizer.js";

describe("project optimization evidence", () => {
  it("does not invent stable-read proof for an open parameter or intervening call", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-project-optimizer-boundary-"));
    try {
      const cases = {
        "parameter.ts": `function read(value: { n: number }) { return value.n + value.n }`,
        "call.ts": `function read() { const value = { n: 1 }; const first = value.n; unknown(value); return first + value.n }`,
        "getter.ts": `function read() { const value = { get n() { return Math.random() } }; return value.n + value.n }`,
        "alias.ts": `function read() { const value = { n: 1 }; const alias = value; alias.n++; return value.n + value.n }`,
      };
      for (const [fileName, source] of Object.entries(cases)) {
        const options = { files: { [fileName]: source }, evidencePath: join(directory, `${fileName}.json`), closedWorld: true };
        await optimizeUneffectProject(options);
        const result = await optimizeUneffectProject(options);
        expect(result.transformations).toContainEqual(expect.objectContaining({ fileName, applied: false, evidence: "unknown" }));
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("proves repeated reads only from a local const plain data object", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-project-optimizer-local-"));
    const options = {
      files: { "local.ts": `function read() { const value = { n: 1 }; return value.n + value.n }` },
      evidencePath: join(directory, "evidence.json"), closedWorld: true,
    };
    try {
      await optimizeUneffectProject(options);
      const result = await optimizeUneffectProject(options);
      expect(result.transformations).toContainEqual(expect.objectContaining({
        fileName: "local.ts", region: "value.n", applied: true, evidence: "verified",
      }));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("never authorizes a transformation from malformed or mismatched evidence", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-project-optimizer-"));
    const evidencePath = join(directory, "cache", "evidence.json");
    const options = { files: { "value.ts": "function read(value: { n: number }) { return value.n + value.n }" }, evidencePath, closedWorld: true };
    try {
      writeFileSync(join(directory, "invalid.json"), "not json");
      const malformed = await optimizeUneffectProject({ ...options, evidencePath: join(directory, "invalid.json") });
      expect(malformed.transformations.every((item) => !item.applied)).toBe(true);
      expect(malformed.staleEvidence).toEqual([{ path: join(directory, "invalid.json"), reason: "invalid-artifact" }]);

      await optimizeUneffectProject(options);
      const changed = await optimizeUneffectProject({ ...options, closedWorld: false });
      expect(changed.transformations.every((item) => !item.applied)).toBe(true);
      expect(changed.staleEvidence).toEqual([{ path: evidencePath, reason: "dependency-mismatch" }]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
