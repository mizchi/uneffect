import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { optimizeUneffectProject } from "../src/project-optimizer.js";

describe("project optimization evidence", () => {
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
