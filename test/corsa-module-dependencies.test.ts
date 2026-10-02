import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkCorsaProject } from "../src/frontends/corsa/corsa-check.js";
import { formatEffect } from "../src/effects/capabilities.js";

type Result = Awaited<ReturnType<typeof checkCorsaProject>>;

async function project(
  files: Record<string, string>,
  run: (result: Result, directory: string) => void,
  selected?: readonly string[],
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "uneffect-corsa-deps-"));
  try {
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(directory, name)), { recursive: true });
      writeFileSync(join(directory, name), text);
    }
    const configFile = join(directory, "tsconfig.json");
    writeFileSync(configFile, JSON.stringify({
      compilerOptions: { strict: true, target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", lib: ["ES2022", "DOM"] },
      files: Object.keys(files),
    }));
    run(await checkCorsaProject({
      configFile,
      ...(selected === undefined ? {} : { fileNames: selected.map((name) => join(directory, name)) }),
    }), directory);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

const modules = (result: Result, directory: string) => Object.fromEntries(result.summaries
  .filter((item) => item.functionName === "<module>")
  .map((item) => [(item.fileName ?? "").slice(directory.length + 1), {
    effects: item.effects.map(formatEffect).sort(),
    evidence: item.evidence,
    reasons: (item.unknownReasons ?? []).map((reason) => reason.code).sort(),
  }]));

describe("module dependencies on the native check", () => {
  it("inherits what an analyzed dependency evaluates, through a bare import and a barrel", async () => {
    await project({
      "boot.ts": 'console.log("boot");\nexport const ready = true;\n',
      "barrel.ts": 'export * from "./boot.js";\n',
      "main.ts": 'import "./barrel.js";\nexport function run(): number { return 1; }\n',
    }, (result, directory) => {
      const rows = modules(result, directory);
      expect(rows["boot.ts"]?.effects).toEqual(["Console"]);
      expect(rows["barrel.ts"]?.effects).toEqual(["Console"]);
      expect(rows["main.ts"]?.effects).toEqual(["Console"]);
      // The Console it inherits came from a reviewed contract, so the inherited claim rests on one too.
      expect(rows["main.ts"]?.evidence).toBe("trusted");
    });
  });

  it("converges on a dependency cycle", async () => {
    await project({
      "left.ts": 'import "./right.js";\nconsole.log("left");\nexport const l = 1;\n',
      "right.ts": 'import "./left.js";\nexport const r = 1;\n',
    }, (result, directory) => {
      const rows = modules(result, directory);
      expect(rows["left.ts"]?.effects).toEqual(["Console"]);
      expect(rows["right.ts"]?.effects).toEqual(["Console"]);
    });
  });

  it("says so when it did not follow a dependency, instead of claiming the module is clean", async () => {
    await project({
      "boot.ts": 'console.log("boot");\nexport const ready = true;\n',
      "main.ts": 'import "./boot.js";\nexport function run(): number { return 1; }\n',
    }, (result, directory) => {
      const rows = modules(result, directory);
      // Only main.ts was analyzed, so what importing boot.ts evaluates is not a fact this run established.
      expect(rows["main.ts"]?.evidence).toBe("unknown");
      expect(rows["main.ts"]?.reasons).toEqual(["unknown-dependency"]);
      expect(rows["boot.ts"]).toBeUndefined();
    }, ["main.ts"]);
  });

  it("discharges a package import through its reviewed initialization contract", async () => {
    await project({
      "main.ts": 'import { join } from "node:path";\nexport function under(base: string): string { return join(base, "x"); }\n',
    }, (result, directory) => {
      const rows = modules(result, directory);
      // `node:*` carries a reviewed module-initialization contract, so importing it is answered rather than
      // left open, and the ledger records the review the answer rests on.
      expect(rows["main.ts"]).toEqual({ effects: [], evidence: "inferred", reasons: [] });
      expect(result.assumptions.entries.filter((entry) => entry.domain === "module-initialization"))
        .toHaveLength(1);
    });
  });

  it("reports an unreviewed package import rather than passing over it", async () => {
    await project({
      "main.ts": 'import { thing } from "unreviewed-package";\nexport function use(): unknown { return thing; }\n',
      "shim.d.ts": 'declare module "unreviewed-package" { export const thing: number }\n',
    }, (result, directory) => {
      const rows = modules(result, directory);
      expect(rows["main.ts"]?.evidence).toBe("unknown");
      expect(rows["main.ts"]?.reasons).toEqual(["unreviewed-external-module"]);
    });
  });

  it("leaves a type-only import out of what a module evaluates", async () => {
    await project({
      "shapes.ts": 'console.log("shapes");\nexport interface Shape { size: number }\n',
      "main.ts": 'import type { Shape } from "./shapes.js";\nexport function size(shape: Shape): number { return shape.size; }\n',
    }, (result, directory) => {
      // A type-only import is elided, so it evaluates nothing and the module has nothing to report.
      expect(modules(result, directory)["main.ts"]).toBeUndefined();
    });
  });
});

describe("a dynamic import inside a function", () => {
  const summary = (result: Result, name: string) => result.summaries.find((item) => item.functionName === name);
  const files = {
    "noisy.ts": 'console.log("evaluated");\nexport function quiet() { return 1; }\n',
    "silent.ts": "export function quiet() { return 1; }\n",
    "main.ts": `export async function loadNoisy() { await import("./noisy.js"); }
export async function loadSilent() { await import("./silent.js"); }
export async function loadComputed(path: string) { await import(path); }
export async function loadPackage() { await import("node:fs"); }
`,
  };

  it("charges the function that runs it for what a literal specifier evaluates", async () => {
    await project(files, (result, directory) => {
      // The import runs the target module when the function runs, so its initialization is this boundary's.
      expect(summary(result, "loadNoisy")?.effects.map(formatEffect)).toEqual(["Console"]);
      expect(summary(result, "loadNoisy")?.evidence).not.toBe("unknown");
      expect([summary(result, "loadSilent")?.effects, summary(result, "loadSilent")?.evidence]).toEqual([[], "inferred"]);
      // A specifier the checker cannot resolve to one analyzed implementation is still outside the model.
      expect(summary(result, "loadComputed")?.evidence).toBe("unknown");
      expect(summary(result, "loadPackage")?.evidence).toBe("unknown");
      // Nothing is evaluated until the function runs, so the importing module is not charged for it.
      expect(modules(result, directory)["main.ts"]?.effects ?? []).toEqual([]);
    });
  });

  it("follows a member of the imported namespace to the exported body", async () => {
    await project({
      "leaf.ts": 'export function report() { console.log("leaf"); }\nexport function quiet() { return 1; }\n',
      "main.ts": `export async function viaBinding() { const leaf = await import("./leaf.js"); leaf.report(); }
export async function viaInline() { (await import("./leaf.js")).report(); }
export async function viaDestructure() { const { report } = await import("./leaf.js"); report(); }
export async function viaQuiet() { const { quiet: renamed } = await import("./leaf.js"); return renamed(); }
export async function reassigned(other: { report(): void }) {
  let leaf: { report(): void } = await import("./leaf.js"); leaf = other; leaf.report();
}
export async function computed(path: string) { const leaf = await import(path); leaf.report(); }
`,
    }, (result) => {
      // The namespace object an import resolves to is frozen and holds the module's own exports.
      for (const name of ["viaBinding", "viaInline", "viaDestructure"]) {
        expect([name, summary(result, name)?.effects.map(formatEffect), summary(result, name)?.evidence])
          .toEqual([name, ["Console"], "trusted"]);
      }
      expect([summary(result, "viaQuiet")?.effects, summary(result, "viaQuiet")?.evidence]).toEqual([[], "inferred"]);
      // A binding that is reassigned, or a namespace of a module the checker cannot name, is not that.
      expect(summary(result, "reassigned")?.evidence).toBe("unknown");
      expect(summary(result, "computed")?.evidence).toBe("unknown");
    });
  });

  it("does not borrow what a module outside the selected files evaluates", async () => {
    await project(files, (result) => {
      expect(summary(result, "loadSilent")?.evidence).toBe("unknown");
    }, ["main.ts"]);
  });
});
