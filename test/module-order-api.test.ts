import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  analyzeModuleInitializationOrder,
  analyzeModuleInitializationOrderV2,
  DEFAULT_MODULE_CONTROL_FLOW_PROOF_BUDGET,
  type ModuleOrderV2Options,
} from "../src/modules/module-order-api.js";

describe("native module-order public contract", () => {
  let directory: string;
  beforeAll(() => { directory = mkdtempSync(join(tmpdir(), "uneffect-module-api-")); });
  afterAll(() => rmSync(directory, { recursive: true, force: true }));
  function project(compilerOptions: Record<string, unknown> = {}, text = "export const ready = true;", extraFiles: Record<string, string> = {}) {
    const root = mkdtempSync(join(directory, "case-"));
    const entryFile = join(root, "entry.mts"), configFile = join(root, "tsconfig.json");
    writeFileSync(entryFile, text);
    for (const [name, source] of Object.entries(extraFiles)) writeFileSync(join(root, name), source);
    writeFileSync(configFile, JSON.stringify({ compilerOptions: {
      target: "ES2024", module: "NodeNext", types: [], noEmit: true, ...compilerOptions,
    }, files: [entryFile, ...Object.keys(extraFiles).map(name => join(root, name))] }));
    return { entryFile, configFile };
  }

  it.each([
    null, [], 1, { typo: 1 }, { entryFile: "x", proofBudget: null }, { entryFile: "x", proofBudget: [] },
    { entryFile: "x", proofBudget: { moduleControlFlowIteration: 1 } },
    { entryFile: "x", proofBudget: { moduleControlFlowIterations: "32" } },
    { entryFile: "x", proofBudget: { moduleControlFlowIterations: null } },
  ].map(options => [options]))("rejects malformed options before opening a project: %j", async options => {
    await expect(analyzeModuleInitializationOrderV2(options as ModuleOrderV2Options)).rejects.toThrow(TypeError);
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects an invalid proof budget before file access: %s", async limit => {
      await expect(analyzeModuleInitializationOrderV2({ entryFile: "missing.mts",
        proofBudget: { moduleControlFlowIterations: limit },
      })).rejects.toThrow(RangeError);
    },
  );

  it("keeps defaults immutable across callers", () => {
    expect(Reflect.set(DEFAULT_MODULE_CONTROL_FLOW_PROOF_BUDGET, "moduleControlFlowIterations", 1)).toBe(false);
    expect(DEFAULT_MODULE_CONTROL_FLOW_PROOF_BUDGET.moduleControlFlowIterations).toBe(32);
  });

  for (const analyze of [analyzeModuleInitializationOrder, analyzeModuleInitializationOrderV2]) {
    describe(analyze.name, () => {
      it("retains configuration diagnostics outside the source dependency closure", async () => {
        const options = project({ moduleResolution: "Bundler" });
        expect(await analyze(options)).toMatchObject({ evidence: "unknown", unknowns: expect.arrayContaining([
          expect.objectContaining({ kind: "typescript-error", fileName: options.configFile }),
        ]) });
      });
      it("reports missing global types as unknown", async () => {
        const options = project({ noLib: true });
        expect(await analyze(options)).toMatchObject({ evidence: "unknown", unknowns: expect.arrayContaining([
          expect.objectContaining({ kind: "typescript-error", fileName: options.entryFile }),
        ]) });
      });
      it("retains malformed configuration as unknown", async () => {
        const options = project({ strict: "invalid" });
        expect(await analyze(options)).toMatchObject({ evidence: "unknown", unknowns: expect.arrayContaining([
          expect.objectContaining({ kind: "typescript-error", fileName: options.configFile, detail: expect.stringContaining("strict") }),
        ]) });
      });
      it("retains errors in inherited configurations", async () => {
        const options = project();
        const base = join(options.entryFile, "..", "base.json");
        writeFileSync(base, JSON.stringify({ compilerOptions: { strict: "invalid" } }));
        writeFileSync(options.configFile, JSON.stringify({ extends: "./base.json", compilerOptions: { target: "ES2024", module: "NodeNext", types: [] }, files: [options.entryFile] }));
        expect(await analyze(options)).toMatchObject({ evidence: "unknown", unknowns: expect.arrayContaining([
          expect.objectContaining({ kind: "typescript-error", fileName: base, detail: expect.stringContaining("strict") }),
        ]) });
      });
      it.each(["", "  ", null, 3])("rejects malformed entry identities: %j", async entryFile => {
        await expect(analyze({ entryFile: entryFile as string })).rejects.toThrow("entryFile must be a nonempty string");
      });
      it("scopes source diagnostics to the entry's static dependency closure", async () => {
        const options = project({}, "export const ready = true;", { "unreachable.mts": "export const broken: number = 'wrong';" });
        expect(await analyze(options)).toMatchObject({ evidence: "verified", unknowns: [] });
      });
      it("rejects unreadable entry files", async () => {
        await expect(analyze({ entryFile: join(directory, "missing.mts") })).rejects.toMatchObject({ code: "ENOENT" });
      });
      it("rejects an entry outside the configured project", async () => {
        const options = project();
        const other = join(directory, "outside.mts");
        writeFileSync(other, "export {};");
        await expect(analyze({ ...options, entryFile: other })).rejects.toThrow("entryFile is not part");
      });
    });
  }

  it("exposes v1/v2 and bounded conditional proof through the public API without JS compilers", () => {
    const options = project({}, "const flag = Math.random() > .5; if (flag) await Promise.resolve(); export {};");
    const script = `
      import assert from "node:assert/strict";
      const { analyzeModuleInitializationOrder: v1, analyzeModuleInitializationOrderV2: v2 } = await import("./src/modules/module-order-api.ts");
      const options = JSON.parse(process.argv[1]);
      assert.equal((await v1(options)).evidence, "unknown");
      const result = await v2(options);
      assert.equal(result.evidence, "verified");
      assert.match(result.compiler.typescriptVersion, /^7[.]/);
      const bounded = await v2({ ...options, proofBudget: { moduleControlFlowIterations: 1 } });
      assert.equal(bounded.evidence, "unknown");
      assert(bounded.unknowns.some(item => item.kind === "module-control-flow-proof"));
    `;
    const child = spawnSync(process.execPath, ["--import", resolve("test/hooks/install-reject-js-typescript.mjs"), "--import", "tsx", "--input-type=module", "-e", script, JSON.stringify(options)], { encoding: "utf8", timeout: 30_000 });
    expect(child.error).toBeUndefined();
    expect(child.stderr).toBe("");
    expect(child.status).toBe(0);
  });
});
