import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "@typescript/typescript6";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  analyzeModuleInitializationOrder,
  analyzeModuleInitializationOrderV2,
  DEFAULT_MODULE_CONTROL_FLOW_PROOF_BUDGET,
  type ModuleInitializationV2Options,
} from "../src/modules/module-order-api.js";

describe("module-order public contract", () => {
  let directory: string, entry: string, input: ts.Program;
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2024,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    types: [], noEmit: true,
  };
  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "uneffect-module-api-"));
    entry = join(directory, "entry.mts");
    writeFileSync(entry, "export const ready = true;\n");
    input = ts.createProgram([entry], compilerOptions);
  });
  afterAll(() => rmSync(directory, { recursive: true, force: true }));

  it.each([
    null, [], 1, { typo: 1 }, { proofBudget: null }, { proofBudget: [] },
    { proofBudget: { moduleControlFlowIteration: 1 } },
    { proofBudget: { moduleControlFlowIterations: "32" } },
    { proofBudget: { moduleControlFlowIterations: null } },
  ].map((options) => [options]))("rejects malformed options even without a conditional await: %j", (options) => {
    expect(() => analyzeModuleInitializationOrderV2(input, entry, options as ModuleInitializationV2Options))
      .toThrow(TypeError);
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects an invalid proof budget before deciding whether a proof is needed: %s", (limit) => {
      expect(() => analyzeModuleInitializationOrderV2(input, entry, {
        proofBudget: { moduleControlFlowIterations: limit },
      })).toThrow(RangeError);
    },
  );

  it("keeps defaults immutable across callers", () => {
    expect(Reflect.set(DEFAULT_MODULE_CONTROL_FLOW_PROOF_BUDGET, "moduleControlFlowIterations", 1)).toBe(false);
    expect(DEFAULT_MODULE_CONTROL_FLOW_PROOF_BUDGET.moduleControlFlowIterations).toBe(32);
  });

  for (const analyze of [analyzeModuleInitializationOrder, analyzeModuleInitializationOrderV2]) {
    describe(analyze.name, () => {
      it("reports compiler option errors as unknown even without file coordinates", () => {
        const invalid = ts.createProgram([entry], { ...compilerOptions, moduleResolution: ts.ModuleResolutionKind.Bundler });
        expect(invalid.getOptionsDiagnostics().some((item) => item.category === ts.DiagnosticCategory.Error)).toBe(true);
        expect(analyze(invalid, entry)).toMatchObject({
          evidence: "unknown", unknowns: expect.arrayContaining([
            expect.objectContaining({ kind: "typescript-error", fileName: entry }),
          ]),
        });
      });

      it("reports missing global types as unknown", () => {
        const invalid = ts.createProgram([entry], { ...compilerOptions, noLib: true });
        expect(invalid.getGlobalDiagnostics().length).toBeGreaterThan(0);
        expect(analyze(invalid, entry)).toMatchObject({
          evidence: "unknown", unknowns: expect.arrayContaining([
            expect.objectContaining({ kind: "typescript-error", fileName: entry }),
          ]),
        });
        expect(analyze(invalid, entry).unknowns.filter((item) => item.kind === "typescript-error"))
          .toHaveLength(invalid.getGlobalDiagnostics().length);
      });

      it("retains configuration parsing errors", () => {
        const config = ts.parseJsonConfigFileContent({ compilerOptions: { strict: "invalid" } }, ts.sys, directory);
        expect(config.errors.length).toBeGreaterThan(0);
        const invalid = ts.createProgram({ rootNames: [entry], options: compilerOptions, configFileParsingDiagnostics: config.errors });
        expect(analyze(invalid, entry)).toMatchObject({
          evidence: "unknown", unknowns: expect.arrayContaining([
            expect.objectContaining({ kind: "typescript-error", detail: expect.stringContaining("strict") }),
          ]),
        });
      });

      it.each(["", "  ", null, 3])("rejects malformed entry identities: %j", (fileName) => {
        expect(() => analyze(input, fileName as string)).toThrow("entryFile must be a nonempty string");
      });

      it("keeps the source diagnostic scope at the entry's static dependency closure", () => {
        const other = join(directory, "unreachable.mts");
        writeFileSync(other, "export const broken: number = 'wrong';\n");
        const isolated = ts.createProgram([entry, other], compilerOptions);
        expect(isolated.getSemanticDiagnostics().length).toBeGreaterThan(0);
        expect(analyze(isolated, entry)).toMatchObject({ evidence: "verified", unknowns: [] });
      });

      it("keeps a missing source entry as unknown", () => {
        expect(analyze(input, join(directory, "missing.mts"))).toMatchObject({
          evidence: "unknown", unknowns: expect.arrayContaining([
            expect.objectContaining({ kind: "entry-not-found" }),
          ]),
        });
      });
    });
  }
});
