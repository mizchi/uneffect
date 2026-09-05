import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "@typescript/typescript6";
import { describe, expect, it } from "vitest";
import { analyzeModuleInitializationOrder } from "../src/module-initialization.js";
import { analyzeModuleInitializationOrderV2 } from "../src/module-initialization-v2.js";

function program(files: Readonly<Record<string, string>>): ts.Program {
  for (const [fileName, source] of Object.entries(files)) writeFileSync(fileName, source);
  return ts.createProgram(Object.keys(files), {
    target: ts.ScriptTarget.ES2024,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    lib: ["lib.es2024.d.ts", "lib.dom.d.ts"],
    types: ["node"],
    noEmit: true,
  });
}

describe("ESM module initialization order v2", () => {
  it("joins a runtime-real immutable Boolean false path with await resume before importer start", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-module-v2-conditional-"));
    try {
      const dependency = join(directory, "dependency.mts"), entry = join(directory, "entry.mts");
      const input = program({
        [dependency]: readFileSync("examples/dogfood/module-conditional-tla.ts", "utf8"),
        [entry]: 'import { cacheState } from "./dependency.mjs"; console.log(cacheState)',
      });

      const v1 = analyzeModuleInitializationOrder(input, entry);
      const result = analyzeModuleInitializationOrderV2(input, entry);
      const flow = result.modules.find((item) => item.fileName === dependency)?.controlFlow;

      expect(v1).toMatchObject({ schema: "uneffect-module-order/v1", evidence: "unknown" });
      expect(v1.unknowns).toContainEqual(expect.objectContaining({ kind: "conditional-top-level-await" }));
      expect(result).toMatchObject({
        schema: "uneffect-module-order/v2", schemaVersion: 2, evidence: "verified", unknowns: [],
      });
      expect(flow).toMatchObject({
        entry: `${dependency}#start`, completion: `${dependency}#complete`,
        proof: {
          status: "converged",
          budget: { name: "module-control-flow-iterations", limit: 32 },
          reachableBy: {
            [`${dependency}#join:0`]: ["branch-false", "await-resume"],
            [`${dependency}#complete`]: ["branch-false", "await-resume"],
            [`${dependency}#reject:0`]: ["await-reject"],
          },
        },
      });
      expect(flow?.edges).toEqual(expect.arrayContaining([
        expect.objectContaining({
          from: `${dependency}#branch:0`, to: `${dependency}#join:0`, role: "branch-false",
        }),
        expect.objectContaining({
          from: `${dependency}#branch:0`, to: `${dependency}#suspend:0`, role: "branch-true",
        }),
        expect.objectContaining({
          from: `${dependency}#suspend:0`, to: `${dependency}#resume:0`, role: "await-resume",
        }),
        expect.objectContaining({
          from: `${dependency}#suspend:0`, to: `${dependency}#reject:0`, role: "await-reject",
          completion: "throw",
        }),
        expect.objectContaining({
          from: `${dependency}#resume:0`, to: `${dependency}#join:0`, role: "sequence",
        }),
      ]));
      expect(flow?.edges).not.toContainEqual(expect.objectContaining({
        from: `${dependency}#suspend:0`, to: `${dependency}#complete`,
      }));
      expect(result.constraints).toContainEqual(expect.objectContaining({
        before: `${dependency}#complete`, after: `${entry}#start`,
        reason: "static-dependency-completes",
      }));
      expect(result.claims).toContain("a conditional top-level await completes only through its false or await-resume path");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("fails closed for erased, mutable, nested, and multi-await selector shapes", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-module-v2-unsupported-"));
    try {
      const cases = {
        ambient: `declare const enabled: boolean; if (enabled) await Promise.resolve()`,
        mutable: `let enabled = Date.now() > 0; if (enabled) await Promise.resolve()`,
        suppressedWrite: `const enabled = Date.now() > 0; // @ts-ignore\n enabled = false; if (enabled) await Promise.resolve()`,
        property: `const flags = { enabled: Date.now() > 0 }; if (flags.enabled) await Promise.resolve()`,
        elseBranch: `const enabled = Date.now() > 0; if (enabled) await Promise.resolve(); else console.log("skip")`,
        nested: `const enabled = Date.now() > 0; if (enabled) { if (enabled) await Promise.resolve() }`,
        nestedExpression: `const enabled = Date.now() > 0; if (enabled) enabled ? await Promise.resolve() : undefined`,
        multiple: `const enabled = Date.now() > 0; if (enabled) { await Promise.resolve(); await Promise.resolve() }`,
        straightAndConditional: `const enabled = Date.now() > 0; await Promise.resolve(); if (enabled) await Promise.resolve()`,
        throwAfterJoin: `const enabled = Date.now() > 0; if (enabled) await Promise.resolve(); throw new Error("stop")`,
      } as const;
      for (const [name, source] of Object.entries(cases)) {
        const entry = join(directory, `${name}.mts`);
        const result = analyzeModuleInitializationOrderV2(program({ [entry]: source }), entry);
        expect(result.evidence, name).toBe("unknown");
        expect(result.unknowns, name).toContainEqual(expect.objectContaining({
          kind: "conditional-top-level-await",
        }));
        expect(result.modules.find((item) => item.fileName === entry)?.controlFlow, name).toBeUndefined();
      }

      const config = join(directory, "config.mts"), imported = join(directory, "imported.mts");
      const importedResult = analyzeModuleInitializationOrderV2(program({
        [config]: `export const enabled = Date.now() > 0`,
        [imported]: `import { enabled } from "./config.mjs"; if (enabled) await Promise.resolve()`,
      }), imported);
      expect(importedResult.evidence).toBe("unknown");
      expect(importedResult.unknowns).toContainEqual(expect.objectContaining({ kind: "conditional-top-level-await" }));
      expect(importedResult.modules.find((item) => item.fileName === imported)?.controlFlow).toBeUndefined();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("fails closed when the named CFG proof budget cannot reach completion", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-module-v2-budget-"));
    try {
      const entry = join(directory, "entry.mts");
      const result = analyzeModuleInitializationOrderV2(program({
        [entry]: `const enabled = Date.now() > 0; if (enabled) await Promise.resolve()`,
      }), entry, { proofBudget: { moduleControlFlowIterations: 1 } });
      expect(result.evidence).toBe("unknown");
      expect(result.unknowns).toContainEqual(expect.objectContaining({
        kind: "module-control-flow-proof",
        detail: expect.stringContaining("exhausted"),
      }));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("publishes a distinct schema while locking the v1 schema bytes", () => {
    const v1 = readFileSync("schemas/uneffect-module-order-v1.schema.json");
    expect(createHash("sha256").update(v1).digest("hex"))
      .toBe("69ecd88c2a8d52de7eb89cbd5eec4df36fb8f9ac0e4085db3d9c62933317bb70");
    expect(JSON.parse(readFileSync("schemas/uneffect-module-order-v2.schema.json", "utf8"))).toMatchObject({
      properties: {
        schema: { const: "uneffect-module-order/v2" },
        schemaVersion: { const: 2 },
      },
      $defs: {
        controlFlow: { required: expect.arrayContaining(["blocks", "edges", "proof"]) },
      },
    });
  });
});
