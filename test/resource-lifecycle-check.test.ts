import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkFiles } from "../src/check.js";
import { verifyUneffectProject } from "../src/project-verification.js";

describe("general resource lifecycle check", () => {
  it("surfaces valid, leaked, and post-release user-defined lifecycles through checkFiles", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-resource-check-"));
    try {
      const fileName = join(directory, "entry.ts");
      writeFileSync(fileName, `
        interface Handle { readonly fd: number }
        /* uneffect:acquire return */
        declare function acquireHandle(): Handle
        /* uneffect:use handle */
        declare function inspectHandle(handle: Handle): void
        /* uneffect:release handle */
        declare function releaseHandle(handle: Handle): void
        export function valid() {
          const handle = acquireHandle()
          inspectHandle(handle)
          releaseHandle(handle)
        }
        export function leaked() { const handle = acquireHandle(); inspectHandle(handle) }
        export function invalid() { const handle = acquireHandle(); releaseHandle(handle); inspectHandle(handle) }
      `);
      const result = await checkFiles([fileName]);
      expect(result.resourceProtocols).toMatchObject([
        { owner: "valid", status: "satisfied", evidence: "trusted" },
        { owner: "leaked", status: "unsatisfied", evidence: "trusted" },
        { owner: "invalid", status: "unknown", evidence: "trusted" },
      ]);
      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ domain: "resource", kind: "unclosed", functionName: "leaked", severity: "error" }),
        expect.objectContaining({ domain: "resource", kind: "invalid-transition", functionName: "invalid", severity: "error" }),
      ]));
      expect(result.assumptions.entries.filter((entry) => entry.domain === "resource-callable")).toHaveLength(3);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("keeps the lifecycle visible in project verification and assurance", async () => {
    const fileName = "/entry.ts";
    const result = await verifyUneffectProject({ files: { [fileName]: `
      interface Handle {}
      /* uneffect:acquire return */ declare function acquireHandle(): Handle
      /* uneffect:release handle */ declare function releaseHandle(handle: Handle): void
      export function main() { const handle = acquireHandle(); releaseHandle(handle) }
    ` } });
    expect(result.resourceProtocols).toMatchObject([{ owner: "main", status: "satisfied", evidence: "trusted" }]);
    expect(result.assurance).toMatchObject({ status: "assumed", blockers: [] });
    expect(result.assumptions.entries).toMatchObject([{ domain: "resource-callable", owner: "source declaration" }]);
  });

  it("downgrades lifecycle evidence when TypeScript has errors", async () => {
    const fileName = "/invalid.ts";
    const result = await verifyUneffectProject({ files: { [fileName]: `
      interface Handle {}
      /* uneffect:acquire return */ declare function acquireHandle(): Handle
      /* uneffect:release handle */ declare function releaseHandle(handle: Handle): void
      export function main() { const handle = acquireHandle(); releaseHandle(handle); const broken: string = 1 }
    ` } });
    expect(result.resourceProtocols).toMatchObject([{ owner: "main", status: "unknown", evidence: "unknown" }]);
    expect(result.assumptions.entries.filter((entry) => entry.domain === "resource-callable")).toEqual([]);
  });
});
