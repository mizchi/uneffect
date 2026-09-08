import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { checkCorsaProject } from "../src/frontends/corsa/corsa-check.js";
import { createCorsaCheckJsonReport, formatCorsaCheckEvidence } from "../src/frontends/corsa/corsa-check-report.js";
import { verifyCorsaContracts } from "../src/contracts/corsa-contracts.js";
import { solveContractObligations } from "../src/contracts/contract-solver.js";
import { obligationFromSpec } from "../src/contracts/obligations.js";

const coverageSchema = JSON.parse(readFileSync("schemas/uneffect-check-v1.schema.json", "utf8")).$defs.contract.properties.native.properties.coverage;
const publishedCoverage: string[] = coverageSchema.enum ?? [coverageSchema.const];

async function project(text: string, run: (file: string, configFile: string) => Promise<void>, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "uneffect-native-body-"));
  const file = join(directory, "input.ts"), configFile = join(directory, "tsconfig.json");
  writeFileSync(file, text);
  writeFileSync(configFile, JSON.stringify({ compilerOptions: { strict: true, target: "ES2024", module: "NodeNext", types: [], ...options }, files: [file] }));
  try { await run(file, configFile); } finally { rmSync(directory, { recursive: true, force: true }); }
}

describe("native contract bodies through check", () => {
  it.each([
    ['value: -2 | 0 | 3', 'return value + 2;', 'result >= 0', ["verified"]],
    ['value: -2 | 0 | 3', 'if (value < 0) return -value; return value;', 'result >= 0', ["verified", "verified"]],
    ['value: 1 | 2 | 3', 'return value * value;', 'result >= 1 && result <= 9', ["verified"]],
    ['left: 1 | 2 | 3, right: 0 | 1', 'return left - right;', 'result >= 0', ["verified"]],
    ['value: 0 | 1 | 2', 'return value + 1;', 'result >= 2', ["counterexample"]],
    ['', 'return 2 + 3 * 4;', 'result === 14', ["verified"]],
    ['', 'return -0;', 'result === 0', ["verified"]],
  ] as const)("proves bounded numeric bodies: %s / %s", async (parameters, body, clause, statuses) => {
    await project(`/* uneffect:ensures ${clause} */\nexport function checked(${parameters}) { ${body} }`, async (_file, configFile) => {
      const result = await checkCorsaProject({ configFile });
      expect(result.artifacts.map(item => item.status)).toEqual(statuses);
      expect(result.artifacts.every(item => item.native?.coverage === "safe-integer-arithmetic")).toBe(true);
      if (statuses[0] === "counterexample") expect(result.artifacts[0]!.counterexample?.assignments.value).toBe("0");
    });
  });

  it.each([
    ['value: number', 'return value + 1;', 'result > value'],
    ['value: 0.5 | 1', 'return value + 1;', 'result > value'],
    ['value: 9007199254740992', 'return value;', 'result > 0'],
    ['value: 9007199254740991', 'return (value + 2) - 2;', 'result === value'],
    ['value: 9007199254740991', 'return value * 2;', 'result > value'],
    ['value: 9007199254740991', 'return value;', 'result + 1 > result'],
    ['value: 1 | 2', 'return value / 2;', 'result >= 0'],
    ['value: 1 | 2', 'return value % 2;', 'result >= 0'],
    ['', 'return 1e999;', 'result > 0'],
  ])("does not replace unsafe Number semantics by mathematical integers: %s / %s", async (parameters, body, clause) => {
    await project(`/* uneffect:ensures ${clause} */\nexport function checked(${parameters}) { ${body} }`, async (_file, configFile) => {
      const result = await checkCorsaProject({ configFile });
      expect(result.artifacts).toEqual([expect.objectContaining({ status: "unsupported", evidence: "unknown" })]);
    });
  });

  it("does not assume a broad number is integral from bounds in requires", async () => {
    await project(`/* uneffect:requires value >= 0 && value <= 3 */\n/* uneffect:ensures result > value */
export function checked(value: number) { return value + 1; }`, async (_file, configFile) => {
      const result = await checkCorsaProject({ configFile });
      expect(result.artifacts).toEqual([expect.objectContaining({ status: "unsupported", evidence: "unknown" })]);
    });
  });

  it("preserves numeric preconditions on an imported finite type alias", async () => {
    await project(`import type { Count } from "./types.js";
/* uneffect:requires value > 0 */\n/* uneffect:ensures result >= 2 */
export function checked(value: Count) { return value + 1; }`, async (file, configFile) => {
      writeFileSync(join(file, "..", "types.ts"), "export type Count = 0 | 1 | 2;");
      const result = await checkCorsaProject({ configFile });
      expect(result.errors).toBe(0);
      expect(result.artifacts).toEqual([expect.objectContaining({ status: "verified", native: expect.objectContaining({ coverage: "safe-integer-arithmetic" }) })]);
      expect(result.artifacts[0]!.controlFlow?.pathConditions).toHaveLength(2);
    });
  });
  const parity = JSON.parse(readFileSync("test/fixtures/corsa-contract-body-parity.json", "utf8")) as {
    cases: Array<{ name: string; source: string; expected: unknown[] }>;
  };
  it.each(parity.cases)("preserves the frozen Program result: $name", async ({ source, expected }) => {
    await project(source, async (_file, configFile) => {
      const result = await checkCorsaProject({ configFile });
      expect(result.artifacts.map(artifact => ({ status: artifact.status, evidence: artifact.evidence,
        span: artifact.source.span, obligation: artifact.obligation }))).toEqual(expected);
    });
  });

  it("emits actual solver evidence for a Boolean body and a constant numeric return", async () => {
    const text = `// 😀\r\n/* uneffect:requires enabled */\r\n/* uneffect:ensures result === false */
export function invert(enabled: boolean): boolean { return !enabled; }
/* uneffect:ensures result > 0 */
export function positive(): number { return 7; }`;
    await project(text, async (file, configFile) => {
      const result = await checkCorsaProject({ configFile });
      expect(result.errors).toBe(0);
      expect(result.artifacts).toHaveLength(2);
      for (const [index, artifact] of result.artifacts.entries()) {
        expect(artifact).toMatchObject({ status: "verified", evidence: "verified", solver: { backend: expect.any(String) },
          native: { coverage: index === 0 ? "boolean-and-constant-return" : "safe-integer-arithmetic", sourceDigest: expect.stringMatching(/^[a-f0-9]{64}$/) } });
        expect(artifact.source.fileName).toBe(file);
        expect(publishedCoverage).toContain(artifact.native!.coverage);
        expect(text.slice(artifact.source.span.start, artifact.source.span.end)).toMatch(/^return /);
      }
      expect(createCorsaCheckJsonReport(result).contracts).toEqual(result.artifacts);
      expect(formatCorsaCheckEvidence(result)).toContain("contract invert: verified");
      // Contract proof alone does not promote the independent effect analysis.
      expect(result.summaries.every(summary => summary.evidence === "inferred")).toBe(true);
    });
  });

  it("reports a violated postcondition with a counterexample instead of an empty success", async () => {
    await project(`/* uneffect:ensures result === enabled */
export function invert(enabled: boolean) { return !enabled; }`, async (_file, configFile) => {
      const result = await checkCorsaProject({ configFile });
      expect(result.errors).toBe(1);
      expect(result.artifacts).toEqual([expect.objectContaining({ status: "counterexample", counterexample: expect.any(Object) })]);
      expect(result.diagnostics).toContainEqual(expect.objectContaining({ domain: "contract", functionName: "invert", severity: "error" }));
      expect(createCorsaCheckJsonReport(result).outcome).toBe("failed");
      expect(createCorsaCheckJsonReport(result).diagnostics[0]).toMatchObject({ code: "contract/contract", notes: expect.any(Array) });
      expect(createCorsaCheckJsonReport(result).diagnostics[0]!.notes.length).toBeGreaterThan(0);
    });
  });

  it.each([
    "export function checked(value: number) { return value + 1; }",
    "export function checked(value: any) { return value; }",
    "export function checked(value: boolean = true) { return value; }",
    "export async function checked() { return true; }",
    "export function checked(value: boolean) { if (value) return true; }",
    "export function checked(value: boolean) { if (1) return value; return false; }",
    "export function checked(value: boolean) { value = !value; return value; }",
    "export function checked(value: boolean) { if (value) return true; else return Boolean(true); }",
    "export function checked(value: boolean) { try { return value; } finally { value = false; } }",
    "export function checked(value: boolean) { while (value) { return true; } return false; }",
    "export function checked() { return Boolean(true); }",
    "export const checked = () => true;",
    "export class Checked { checked() { return true; } }",
    "export function checked() { function nested() { return true; } return true; }",
  ])("makes unsupported bodies explicit: %s", async body => {
    await project(`/* uneffect:ensures result === true */\n${body}`, async (_file, configFile) => {
      const result = await checkCorsaProject({ configFile });
      expect(result.errors).toBeGreaterThan(0);
      expect(result.artifacts).toContainEqual(expect.objectContaining({ status: "unsupported", evidence: "unknown" }));
      expect(result.artifacts.some(artifact => artifact.status === "verified")).toBe(false);
    });
  });

  it("keeps a separate valid function when another body is unsupported", async () => {
    await project(`/* uneffect:ensures result */
export function bad() { return Boolean(true); }
/* uneffect:ensures result */
export function good() { return true; }`, async (_file, configFile) => {
      const result = await checkCorsaProject({ configFile });
      expect(result.artifacts).toEqual(expect.arrayContaining([
        expect.objectContaining({ status: "unsupported" }),
        expect.objectContaining({ status: "verified", obligation: expect.objectContaining({ functionName: "good" }) }),
      ]));
    });
  });

  it("retains distinct return paths and counterexample inputs for a broken branch", async () => {
    const text = `/* uneffect:ensures result === enabled */
export function checked(enabled: boolean) { if (enabled) return false; return false; }`;
    await project(text, async (_file, configFile) => {
      const result = await checkCorsaProject({ configFile });
      expect(result.artifacts.map(item => item.status)).toEqual(["counterexample", "verified"]);
      expect(result.artifacts[0]!.counterexample?.assignments.enabled).toBe("true");
      for (const artifact of result.artifacts) {
        expect(artifact.native?.coverage).toBe("boolean-branching");
        expect(publishedCoverage).toContain(artifact.native!.coverage);
        expect(artifact.controlFlow?.completion).toBe("return");
        expect(artifact.controlFlow?.pathConditions).toHaveLength(1);
      }
      expect(result.artifacts[0]!.controlFlow?.blockId).not.toBe(result.artifacts[1]!.controlFlow?.blockId);
      expect(result.artifacts[1]!.controlFlow?.pathConditions[0]).toMatchObject({ kind: "unary", operator: "not" });
    });
  });

  it("excludes returns after unconditional termination", async () => {
    await project(`/* uneffect:ensures result */
export function checked(): boolean { if (true) return true; return false; }`, async (_file, configFile) => {
      const result = await checkCorsaProject({ configFile });
      expect(result.errors).toBe(0);
      expect(result.artifacts).toEqual([expect.objectContaining({ status: "verified", native: expect.objectContaining({ coverage: "boolean-branching" }) })]);
    });
  });

  it("joins paths without dropping a branch reaching the same return", async () => {
    await project(`/* uneffect:ensures result */
export function checked(enabled: boolean) { if (enabled) {} return enabled; }`, async (_file, configFile) => {
      const result = await checkCorsaProject({ configFile });
      expect(result.artifacts.map(item => item.status).sort()).toEqual(["counterexample", "verified"]);
      expect(new Set(result.artifacts.map(item => item.obligationId)).size).toBe(2);
    });
  });

  it("returns a non-proof when Boolean path enumeration exceeds its bound", async () => {
    await project(`/* uneffect:ensures result */
export function checked(enabled: boolean) { ${"if (enabled) {} ".repeat(10)} return true; }`, async (_file, configFile) => {
      const result = await checkCorsaProject({ configFile });
      expect(result.artifacts).toEqual([expect.objectContaining({ status: "unsupported", evidence: "unknown", message: expect.stringMatching(/budget/), native: expect.objectContaining({ coverage: "boolean-branching" }) })]);
    });
  });

  it.each(["true", "false"])("preserves a native Boolean literal parameter: %s", async literal => {
    await project(`type Flag = ${literal};\n/* uneffect:ensures result === ${literal} */
export function checked(value: Flag) { return value; }`, async (_file, configFile) => {
      const result = await checkCorsaProject({ configFile });
      expect(result.errors).toBe(0);
      expect(result.artifacts).toEqual([expect.objectContaining({ status: "verified" })]);
    });
  });

  it("ignores annotation-looking text in strings", async () => {
    await project('export const sample = "/* uneffect:ensures result */";', async (_file, configFile) => {
      const result = await checkCorsaProject({ configFile });
      expect(result.errors).toBe(0);
      expect(result.artifacts).toEqual([]);
    });
  });

  it.each(["/* uneffect:ensures */", "/* uneffect:requires */", "/* uneffect:contract_from */"])("rejects an empty contract directive: %s", async annotation => {
    await project(`${annotation}\nexport function checked() { return true; }`, async (_file, configFile) => {
      const result = await checkCorsaProject({ configFile });
      expect(result.errors).toBeGreaterThan(0);
      expect(result.artifacts).toContainEqual(expect.objectContaining({ status: "unsupported" }));
    });
  });

  it.each(["result === missing", "result + 1 > 0", "result === 1", "1"])("rejects ill-sorted or unsupported clauses: %s", async clause => {
    await project(`/* uneffect:ensures ${clause} */\nexport function checked() { return true; }`, async (_file, configFile) => {
      const result = await checkCorsaProject({ configFile });
      expect(result.errors).toBeGreaterThan(0);
      expect(result.artifacts).toEqual([expect.objectContaining({ status: "unsupported" })]);
    });
  });

  it("rejects native diagnostics before proving a body", async () => {
    await project(`/* uneffect:ensures result */
export function checked(): boolean { return 7; }`, async (_file, configFile) => {
      await expect(checkCorsaProject({ configFile })).rejects.toThrow(/TS2322/);
    });
  });

  it("rejects source text that differs from the native snapshot", async () => {
    const text = '/* uneffect:ensures result */\nexport function checked() { return true; }';
    await project(text, async (file, configFile) => {
      await expect(verifyCorsaContracts({ configFile, files: new Map([[file, text.replace("return true", "return false")]]) }))
        .rejects.toThrow(/snapshot/);
    });
  });

  it("checks imported-file diagnostics before proving a selected body", async () => {
    const text = 'import "./helper.js";\n/* uneffect:ensures result */\nexport function checked() { return true; }';
    await project(text, async (file, configFile) => {
      writeFileSync(join(file, "..", "helper.ts"), 'export const invalid: boolean = 7;');
      await expect(checkCorsaProject({ configFile })).rejects.toThrow(/TS2322/);
    });
  });

  it("keeps solver infrastructure failure as unknown with its attempts", async () => {
    const obligation = obligationFromSpec({ functionName: "checked", parameters: [], requires: [], ensures: ["result"], result: "true", resultDomain: "bool" });
    const result = await solveContractObligations("<spec>", [obligation], () => 1,
      { preference: "native", nativeExecutable: resolve("missing-native-contract-solver") });
    expect(result.artifacts).toEqual([expect.objectContaining({ status: "unknown", evidence: "unknown", solver: {
      backend: "native", version: expect.any(String), attempts: [expect.objectContaining({ status: "error", failureKind: "unavailable" })],
    } })]);
    expect(result.diagnostics).toHaveLength(1);
  });

  it("rejects noCheck before proving a body", async () => {
    await project(`/* uneffect:ensures result */
export function checked() { return true; }`, async (_file, configFile) => {
      await expect(checkCorsaProject({ configFile })).rejects.toThrow(/noCheck/);
    }, { noCheck: true });
  });

  it("reports native contract results through the compiler-free CLI", async () => {
    await project(`/* uneffect:ensures result */
export function checked() { return false; }`, async (_file, configFile) => {
      const result = spawnSync(process.execPath, ["--import", resolve("test/hooks/install-reject-js-typescript.mjs"),
        "--import", "tsx", resolve("src/cli/index.ts"), "check", "--project", configFile, "--json"], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(1);
      const report = JSON.parse(result.stdout);
      expect(report.contracts).toEqual([expect.objectContaining({ status: "counterexample" })]);
      expect(report.diagnostics[0].domain).toBe("contract");
    });
  });
});
