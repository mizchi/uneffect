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
import { parseLogicExpression } from "../src/contracts/logic.js";
import { narrowNativeRanges } from "../src/contracts/native-ranges.js";
import { nativeInteger } from "../src/contracts/native-scalars.js";

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
  it("composes an authenticated one-argument affine callee", async () => {
    await project(`/* uneffect:ensures result === value + 1 */
export function inc(value: 0 | 1): number { return value + 1; }
/* uneffect:ensures result === 2 */
export function caller(): number { return inc(1); }`, async (_file, configFile) => {
      const result = await checkCorsaProject({ configFile });
      expect(result.artifacts.map(item => item.status)).toEqual(["verified", "verified"]);
      expect(result.artifacts.every(item => item.native?.coverage === "safe-integer-arithmetic")).toBe(true);
    });
  });

  it("preserves call resolution through parenthesized arguments", async () => {
    await project(`/* uneffect:ensures result === value + 1 */
export function inc(value: 0 | 1): number { return value + 1; }
/* uneffect:ensures result === 2 */
export function caller(): number { return inc((1)); }`, async (_file, configFile) => {
      const result = await checkCorsaProject({ configFile });
      expect(result.artifacts.map(item => item.status)).toEqual(["verified", "verified"]);
    });
  });

  it("composes an authenticated multi-argument affine callee", async () => {
    await project(`/* uneffect:ensures result === left + right */
export function add(left: 0 | 1, right: 0 | 1): number { return left + right; }
/* uneffect:ensures result === 2 */
export function caller(): number { return add(1, 1); }`, async (_file, configFile) => {
      const result = await checkCorsaProject({ configFile });
      expect(result.artifacts.map(item => item.status)).toEqual(["verified", "verified"]);
    });
  });

  it("accepts conjunctions of constant callee preconditions", async () => {
    await project(`/* uneffect:requires value > 0 && value < 2 */
/* uneffect:ensures result === value + 1 */
export function inc(value: 0 | 1): number { return value + 1; }
/* uneffect:ensures result === 2 */
export function caller(): number { return inc(1); }`, async (_file, configFile) => {
      const result = await checkCorsaProject({ configFile });
      expect(result.artifacts.map(item => item.status)).toEqual(["verified", "verified"]);
    });
  });

  it.each([["/", "2"], ["%", "0"]])("proves constant safe integer %s", async (operator, expected) => {
    await project(`/* uneffect:ensures result === ${expected} */\nexport function checked(): number { return 4 ${operator} 2; }`, async (_file, configFile) => {
      const result = await checkCorsaProject({ configFile });
      expect(result.artifacts[0]?.status).toBe("verified");
    });
  });

  it("proves division over a finite literal union", async () => {
    await project(`/* uneffect:ensures result >= 0 && result <= 2 */\nexport function checked(value: 0 | 2 | 4): number { return value / 2; }`, async (_file, configFile) => {
      const result = await checkCorsaProject({ configFile });
      expect(result.artifacts[0]?.status).toBe("verified");
    });
  });

  it("rejects a non-integral constant division", async () => {
    await project(`/* uneffect:ensures result === 2.5 */\nexport function checked(): number { return 5 / 2; }`, async (_file, configFile) => {
      const result = await checkCorsaProject({ configFile });
      expect(result.artifacts[0]?.status).toBe("unsupported");
    });
  });

  it("proves unary plus without widening the native scalar", async () => {
    await project(`/* uneffect:ensures result === 1 */\nexport function checked(): number { return +1; }`, async (_file, configFile) => {
      const result = await checkCorsaProject({ configFile });
      expect(result.artifacts[0]?.status).toBe("verified");
    });
  });

  it.each([["/", "0"], ["%", "0"]])("rejects zero divisor for %s", async (operator, divisor) => {
    await project(`/* uneffect:ensures result === 0 */\nexport function checked(): number { return 5 ${operator} ${divisor}; }`, async (_file, configFile) => {
      const result = await checkCorsaProject({ configFile });
      expect(result.artifacts[0]?.status).toBe("unsupported");
    });
  });

  it.each([
    `/* uneffect:requires value > 0 */\n/* uneffect:ensures result === value + 1 */\nexport function inc(value: 0 | 1): number { return value + 1; }\n/* uneffect:ensures result === 2 */\nexport function caller(): number { return inc(0); }`,
    `/* uneffect:ensures result === value + 1 */\nexport function inc(value: 0 | 1): number { return value + 1; }\n/* uneffect:ensures result === 2 */\nexport function caller(value: 0 | 1, other: 0 | 1): number { return inc(value + other); }`,
  ])("does not erase callee preconditions or unsafe argument shapes", async source => {
    await project(source, async (_file, configFile) => {
      try {
        const result = await checkCorsaProject({ configFile });
        expect(result.artifacts.some(item => item.status === "unsupported")).toBe(true);
      } catch (error) {
        expect(String(error)).toMatch(/TS2345|native contract/);
      }
    });
  });

  it("accepts a literal argument satisfying a callee requires", async () => {
    await project(`/* uneffect:requires value > 0 */
/* uneffect:ensures result === value + 1 */
export function inc(value: 0 | 1): number { return value + 1; }
/* uneffect:ensures result === 2 */
export function caller(): number { return inc(1); }`, async (_file, configFile) => {
      const result = await checkCorsaProject({ configFile });
      expect(result.artifacts.map(item => item.status)).toEqual(["verified", "verified"]);
    });
  });

  it("composes an authenticated zero-argument callee contract", async () => {
    await project(`/* uneffect:ensures result === 5 */
export function five(): number { return 5; }
/* uneffect:ensures result === 5 */
export function caller(): number { return five(); }`, async (_file, configFile) => {
      const result = await checkCorsaProject({ configFile });
      expect(result.artifacts.map(item => item.status)).toEqual(["verified", "verified"]);
      expect(result.artifacts.every(item => item.native?.coverage === "safe-integer-arithmetic")).toBe(true);
    });
  });

  it.each([
    'function five(): number { return 5; }\n/* uneffect:ensures result === 5 */\nexport function caller(): number { return five(); }',
    'export function five(): number { return 5; }\n/* uneffect:ensures result === 5 */\nexport function caller(): number { return five(); }',
    'export const five = () => 5;\n/* uneffect:ensures result === 5 */\nexport function caller(): number { return five(); }',
    '/* uneffect:ensures result === 5 */\nexport function five(): number { return five(); }',
  ])("keeps uncontracted, ambiguous, non-declaration, and recursive calls unsupported: %s", async source => {
    await project(source, async (_file, configFile) => {
      const result = await checkCorsaProject({ configFile });
      expect(result.artifacts.some(item => item.status === "unsupported")).toBe(true);
    });
  });

  it.each([
    'value + 1 < limit',
    '1 + value < limit',
    'value - (-1) < limit',
    '-(value + 1) > -limit',
    '1 - value > 2 - limit',
    'value + 1 <= limit - 1',
    'value + 1 === 1',
    'value + 1 !== 9007199254740991 && limit === 9007199254740991',
  ])("inverts checked offset comparisons into variable bounds: %s", async condition => {
    await project(`/* uneffect:requires value < limit */\n/* uneffect:ensures result <= limit */
export function checked(value: 0 | 1 | 9007199254740989 | 9007199254740991, limit: 2 | 9007199254740991) {
  if (${condition}) return value + 2; return 0;
}`, async (_file, configFile) => {
      expect((await checkCorsaProject({ configFile })).artifacts.map(item => item.status)).toEqual(["verified", "verified"]);
    });
  });

  it.each([
    ['if (value + 1 >= limit) return 0; return value + 2;', 'result <= limit', ["verified", "verified"]],
    ['return value + 1 >= limit || value + 2 <= limit;', 'result', ["verified"]],
    ['return value;', 'result + 1 >= limit || result + 2 <= limit', ["verified"]],
    ['if (value + 1 < limit) return value + 2; return 0;', 'result === 0', ["counterexample", "verified"]],
  ] as const)("uses offset comparisons in false paths and clauses: %s", async (body, ensures, statuses) => {
    await project(`/* uneffect:requires value < limit */\n/* uneffect:ensures ${ensures} */
export function checked(value: 0 | 1 | 9007199254740989 | 9007199254740991, limit: 2 | 9007199254740991) { ${body} }`, async (_file, configFile) => {
      const result = await checkCorsaProject({ configFile });
      expect(result.artifacts.map(item => item.status)).toEqual(statuses);
      if (statuses[0] === "counterexample") {
        const assignments = result.artifacts[0]!.counterexample!.assignments;
        const value = Number(assignments.value), limit = Number(assignments.limit);
        expect(value + 1 < limit).toBe(true);
        expect(value + 2).not.toBe(0);
      }
    });
  });

  it("propagates checked offset comparisons inside a precondition", async () => {
    await project(`/* uneffect:requires value < limit && value + 1 < limit */\n/* uneffect:ensures result <= limit */
export function checked(value: 0 | 9007199254740991, limit: 2 | 9007199254740991) { return value + 2; }`, async (_file, configFile) => {
      expect((await checkCorsaProject({ configFile })).artifacts.map(item => item.status)).toEqual(["verified"]);
    });
  });

  it("inverts offset lower bounds near the negative safe integer limit", async () => {
    await project(`/* uneffect:requires value > floor */\n/* uneffect:ensures result >= floor */
export function checked(value: -9007199254740991 | -9007199254740989 | 0, floor: -9007199254740991 | -2) {
  if (value - 1 > floor) return value - 2; return 0;
}`, async (_file, configFile) => {
      expect((await checkCorsaProject({ configFile })).artifacts.map(item => item.status)).toEqual(["verified", "verified"]);
    });
  });

  it("reports a counterexample when offset inequality does not imply the postcondition", async () => {
    await project(`/* uneffect:requires value < limit */\n/* uneffect:ensures result <= limit */
export function checked(value: 1 | 9007199254740991, limit: 2 | 9007199254740991) {
  if (value + 1 !== 9007199254740991) return value + 2; return 0;
}`, async (_file, configFile) => {
      const result = await checkCorsaProject({ configFile });
      expect(result.artifacts.map(item => item.status)).toEqual(["counterexample", "verified"]);
      expect(result.artifacts[0]!.counterexample!.assignments).toMatchObject({ value: "1", limit: "2", result: "3" });
    });
  });

  it.each([
    'if ((value + 2) - 1 < limit) return value + 2; return 0;',
    'if (value + 1 <= limit) return value + 2; return 0;',
    'if (value + 1 < limit || enabled) return value + 2; return 0;',
    'if (value + 1 < limit) {} return value + 2;',
  ])("does not justify unsafe arithmetic by normalizing offset expressions: %s", async body => {
    await project(`/* uneffect:requires value < limit */\n/* uneffect:ensures result >= 0 */
export function checked(value: 0 | 9007199254740990 | 9007199254740991, limit: 1 | 9007199254740991, enabled: boolean) { ${body} }`, async (_file, configFile) => {
      expect((await checkCorsaProject({ configFile })).artifacts).toEqual([expect.objectContaining({ status: "unsupported", evidence: "unknown" })]);
    });
  });

  it("terminates relational propagation on a contradictory cycle with huge ranges", () => {
    const limit = BigInt(Number.MAX_SAFE_INTEGER);
    const variables = new Map(["x", "y"].map(name => [name, nativeInteger({ kind: "variable", name }, -limit, limit)]));
    const narrowed = narrowNativeRanges(variables, [parseLogicExpression("x < y && y < x")]);
    for (const range of narrowed.values()) {
      if (range.kind !== "number") throw new Error("numeric range lost");
      expect(range.minimum >= -limit && range.maximum <= limit && range.minimum <= range.maximum).toBe(true);
    }
  });

  it("retains only concrete finite-union values compatible with affine comparisons", () => {
    const value = { ...nativeInteger({ kind: "variable", name: "value" }, 0n, 10n), values: Object.freeze([0n, 2n, 10n]) };
    const limit = { ...nativeInteger({ kind: "variable", name: "limit" }, 1n, 10n), values: Object.freeze([1n, 10n]) };
    const narrowed = narrowNativeRanges(new Map([["value", value], ["limit", limit]]), [parseLogicExpression("value + 1 < limit")]);
    expect(narrowed.get("value")).toMatchObject({ minimum: 0n, maximum: 8n, values: [0n, 2n] });
    expect(narrowed.get("limit")).toMatchObject({ minimum: 2n, maximum: 10n, values: [10n] });
  });

  it.each([
    ['', 'if (value < limit) return value + 1; return 0;', 'result <= limit', ["verified", "verified"]],
    ['', 'if (limit > value) return value + 1; return 0;', 'result <= limit', ["verified", "verified"]],
    ['', 'if (value >= limit) return 0; return value + 1;', 'result <= limit', ["verified", "verified"]],
    ['', 'return value >= limit || value + 1 > value;', 'result', ["verified"]],
    ['/* uneffect:requires value < limit */', 'return value + 1;', 'result <= limit', ["verified"]],
    ['', 'if (value < limit) return value + 1; return 0;', 'result === 0', ["counterexample", "verified"]],
    ['', 'return value;', 'result >= limit || result + 1 > result', ["verified"]],
    ['/* uneffect:requires value === limit && limit === 1 */', 'return value + 1;', 'result === 2', ["verified"]],
    ['/* uneffect:requires value <= limit && limit === 1 */', 'return value + 1;', 'result <= 2', ["verified"]],
    ['/* uneffect:requires value !== limit && limit === 9007199254740991 */', 'return value + 1;', 'result <= 2', ["verified"]],
  ] as const)("uses established variable comparisons for safe arithmetic: %s / %s", async (requires, body, ensures, statuses) => {
    await project(`${requires}\n/* uneffect:ensures ${ensures} */\nexport function checked(value: 0 | 1 | 9007199254740991, limit: 1 | 9007199254740991) { ${body} }`, async (_file, configFile) => {
      const result = await checkCorsaProject({ configFile });
      expect(result.artifacts.map(item => item.status)).toEqual(statuses);
      expect(result.artifacts.every(item => item.native?.coverage === "safe-integer-arithmetic")).toBe(true);
      if (statuses[0] === "counterexample") {
        const assignments = result.artifacts[0]!.counterexample!.assignments;
        const value = Number(assignments.value), limit = Number(assignments.limit);
        expect(value < limit).toBe(true);
        expect(value + 1).not.toBe(0);
      }
    });
  });

  it("propagates lower bounds from variable comparisons", async () => {
    await project(`/* uneffect:ensures result >= floor */\nexport function checked(value: -9007199254740991 | 0, floor: -9007199254740991 | -1) {
      if (value > floor) return value - 1; return 0;
    }`, async (_file, configFile) => {
      expect((await checkCorsaProject({ configFile })).artifacts.map(item => item.status)).toEqual(["verified", "verified"]);
    });
  });

  it.each([
    ['value < middle && middle < limit', 'limit < middle && middle < value'],
    ['middle < limit && value < middle', 'middle < value && limit < middle'],
  ])("propagates chains independently of predicate order: %s", async (upper, lower) => {
    await project(`/* uneffect:requires ${upper} && limit === 9007199254740991 */\n/* uneffect:ensures result <= limit */
export function upper(value: 0 | 9007199254740991, middle: 1 | 9007199254740991, limit: 2 | 9007199254740991) { return value + 2; }
/* uneffect:requires ${lower} && limit === -9007199254740991 */\n/* uneffect:ensures result >= limit */
export function lower(value: -9007199254740991 | 0, middle: -9007199254740991 | -1, limit: -9007199254740991 | -2) { return value - 2; }`, async (_file, configFile) => {
      expect((await checkCorsaProject({ configFile })).artifacts.map(item => item.status)).toEqual(["verified", "verified"]);
    });
  });

  it.each([
    'if (value <= limit) return value + 1; return 0;',
    'if (value === limit) return value + 1; return 0;',
    'if (value !== limit) return value + 1; return 0;',
    'if (value < limit || enabled) return value + 1; return 0;',
    'if (value < limit) {} return value + 1;',
    'if (value + 1 <= limit) return value + 1; return 0;',
  ])("does not overstate bounds from variable comparisons: %s", async body => {
    await project(`/* uneffect:ensures result >= 0 */\nexport function checked(value: 0 | 9007199254740991, limit: 1 | 9007199254740991, enabled: boolean) { ${body} }`, async (_file, configFile) => {
      expect((await checkCorsaProject({ configFile })).artifacts).toEqual([expect.objectContaining({ status: "unsupported", evidence: "unknown" })]);
    });
  });

  it.each([
    ['', 'return value < 9007199254740991 && value + 1 > value;', 'result === (value === 0)', ["verified"]],
    ['', 'return value === 9007199254740991 || value + 1 > value;', 'result', ["verified"]],
    ['', 'return !(value >= 9007199254740991) && value + 1 > value;', 'result === (value === 0)', ["verified"]],
    ['', 'return (enabled && value < 9007199254740991) && value + 1 > value;', 'result === (enabled && value === 0)', ["verified"]],
    ['', 'return (enabled || value >= 9007199254740991) || value + 1 > value;', 'result', ["verified"]],
    ['', 'if (value < 9007199254740991 && value + 1 > value) return value + 1; return 0;', 'result >= 0', ["verified", "verified"]],
    ['/* uneffect:requires value < 9007199254740991 && value + 1 > value */', 'return value + 1;', 'result === 1', ["verified"]],
    ['', 'return value;', 'result === 9007199254740991 || result + 1 > result', ["verified"]],
    ['', 'return value;', 'result < 9007199254740991 && result + 1 > result', ["counterexample"]],
    ['', 'return false && value + 1 > value;', 'result === false', ["verified"]],
    ['', 'return true || value + 1 > value;', 'result', ["verified"]],
  ] as const)("respects short-circuit evaluation in bodies and clauses: %s / %s", async (requires, body, ensures, statuses) => {
    await project(`${requires}\n/* uneffect:ensures ${ensures} */\nexport function checked(value: 0 | 9007199254740991, enabled: boolean) { ${body} }`, async (_file, configFile) => {
      const result = await checkCorsaProject({ configFile });
      expect(result.artifacts.map(item => item.status)).toEqual(statuses);
      if (statuses[0] === "counterexample") expect(result.artifacts[0]!.counterexample?.assignments.value).toBe("9007199254740991");
    });
  });

  it.each([
    'return value + 1 > value && value < 9007199254740991;',
    'return value < 9007199254740991 || value + 1 > value;',
    'return value === 9007199254740991 && value + 1 > value;',
    'return (enabled || value < 9007199254740991) && value + 1 > value;',
    'return (enabled && value >= 9007199254740991) || value + 1 > value;',
    'return (value < 9007199254740991 && enabled) === (value + 1 > value);',
    'return false && console.log(value);',
    'return false && (value / 2 > 0);',
    'return false && value;',
  ])("rejects unsafe evaluation and unsupported short-circuit operands: %s", async body => {
    await project(`/* uneffect:ensures result */\nexport function checked(value: 0 | 9007199254740991, enabled: boolean) { ${body} }`, async (_file, configFile) => {
      const result = await checkCorsaProject({ configFile });
      expect(result.artifacts).toEqual([expect.objectContaining({ status: "unsupported", evidence: "unknown" })]);
    });
  });

  it("keeps every concrete state satisfying the narrowing assumptions", () => {
    const variables = new Map(["x", "y"].map(name => [name, Object.freeze(nativeInteger({ kind: "variable", name }, -3n, 3n))]));
    const atoms = ["===", "!==", "<", "<=", ">", ">="].flatMap(operator => [-4, -1, 0, 2, 4].flatMap(value =>
      [`x ${operator} ${value}`, `${value} ${operator} x`]));
    const predicates = [...atoms.flatMap(atom => [atom, `!(${atom})`]),
      "x > -2 && x < 2", "!(x <= -2 || x >= 2)", "x < 0 || y > 0", "!(x < 0 && y > 0)",
      "x + 1 < 2", "x > 2 && x < -2",
      ...["===", "!==", "<", "<=", ">", ">="].flatMap(operator => [
        `x ${operator} y`, `!(x ${operator} y)`, `x ${operator} y && y === 0`, `y === 0 && x ${operator} y`,
        `x ${operator} x`, `x ${operator} y && y ${operator} x`,
      ]),
      ...["x + 1", "1 + x", "x - 2", "2 - x", "-(x + 1)", "1 - (2 - x)", "x + (1 + 2)", "x + x"].flatMap(term =>
        ["===", "!==", "<", "<=", ">", ">="].flatMap(operator => [
          `${term} ${operator} y - 1`, `!(${term} ${operator} y - 1)`, `${term} ${operator} y - 1 && y === 0`,
        ]))];
    for (const predicate of predicates) {
      const narrowed = narrowNativeRanges(variables, [parseLogicExpression(predicate)]);
      const accepts = new Function("x", "y", `return (${predicate});`) as (x: number, y: number) => boolean;
      for (let x = -3; x <= 3; x++) for (let y = -3; y <= 3; y++) {
        if (!accepts(x, y)) continue;
        for (const [name, value] of [["x", x], ["y", y]] as const) {
          const range = narrowed.get(name)!;
          if (range.kind !== "number") throw new Error("numeric range lost");
          expect(BigInt(value) >= range.minimum && BigInt(value) <= range.maximum, `${predicate}: ${name}=${value}`).toBe(true);
        }
      }
    }
    for (const value of variables.values()) expect(value).toMatchObject({ minimum: -3n, maximum: 3n });
  });

  it.each([
    ['', 'if (value < 9007199254740991) return value + 1; return 0;', 'result >= 0', ["verified", "verified"]],
    ['', 'if (value === 9007199254740991) return 0; return value + 1;', 'result >= 0', ["verified", "verified"]],
    ['', 'if (value !== 9007199254740991) return value + 1; return 0;', 'result >= 0', ["verified", "verified"]],
    ['', 'if (value === 0) return value + 1; return 0;', 'result >= 0', ["verified", "verified"]],
    ['', 'if (value <= 9007199254740990) return value + 1; return 0;', 'result >= 0', ["verified", "verified"]],
    ['', 'if (9007199254740991 > value) return value + 1; return 0;', 'result >= 0', ["verified", "verified"]],
    ['', 'if (!(value >= 9007199254740991)) return value + 1; return 0;', 'result >= 0', ["verified", "verified"]],
    ['', 'if (value < 9007199254740991 && value >= 0) return value + 1; return 0;', 'result >= 0', ["verified", "verified"]],
    ['', 'if (value >= 9007199254740991 || value < 0) return 0; return value + 1;', 'result >= 0', ["verified", "verified"]],
    ['/* uneffect:requires value < 9007199254740991 */', 'return value + 1;', 'result === value + 1', ["verified"]],
    ['', 'if (value < 9007199254740991) { if (value + 1 > 0) return value + 1; return 0; } return 0;', 'result >= 0', ["verified", "verified", "verified"]],
    ['', 'if (value < 9007199254740991) return value + 1; return 0;', 'result === 0', ["counterexample", "verified"]],
    ['', 'if (value === 9007199254740991) return -1; return value;', 'result + 1 > result', ["verified", "verified"]],
  ] as const)("narrows safe arithmetic using established conditions: %s / %s", async (requires, body, ensures, statuses) => {
    await project(`${requires}\n/* uneffect:ensures ${ensures} */\nexport function checked(value: 0 | 9007199254740991) { ${body} }`, async (_file, configFile) => {
      const result = await checkCorsaProject({ configFile });
      expect(result.artifacts.map(item => item.status)).toEqual(statuses);
      expect(result.artifacts.every(item => item.native?.coverage === "safe-integer-arithmetic")).toBe(true);
      if (statuses[0] === "counterexample") expect(result.artifacts[0]!.counterexample?.assignments.value).toBe("0");
    });
  });

  it("narrows negative bounds without rounding the range check", async () => {
    await project(`/* uneffect:ensures result <= 0 */\nexport function checked(value: -9007199254740991 | 0) {
      if (value > -9007199254740991) return value - 1; return 0;
    }`, async (_file, configFile) => {
      const result = await checkCorsaProject({ configFile });
      expect(result.artifacts.map(item => item.status)).toEqual(["verified", "verified"]);
    });
  });

  it.each([
    ['', 'if (value < 9007199254740991) return value + 1; return value + 1;', 'result >= 0'],
    ['', 'if (value < 9007199254740991) {} return value + 1;', 'result >= 0'],
    ['', 'if (value < 9007199254740991 || enabled) return value + 1; return 0;', 'result >= 0'],
    ['', 'if (value < 9007199254740991 && enabled) return 0; return value + 1;', 'result >= 0'],
    ['', 'if (value + 1 > value) return value + 1; return 0;', 'result >= 0'],
    ['/* uneffect:requires value + 1 > value && value < 9007199254740991 */', 'return value + 1;', 'result >= 0'],
    ['/* uneffect:requires value < 9007199254740991 */\n/* uneffect:requires value + 1 > value */', 'return value + 1;', 'result >= 0'],
    ['', 'if (value < 9007199254740991) { return value / 2; } return 0;', 'result >= 0'],
    ['', 'return value;', 'value < 9007199254740991 && result + 1 > result'],
  ])("does not use unsafe, alternative, or future conditions to justify arithmetic: %s / %s", async (requires, body, ensures) => {
    await project(`${requires}\n/* uneffect:ensures ${ensures} */\nexport function checked(value: 0 | 9007199254740991, enabled: boolean) { ${body} }`, async (_file, configFile) => {
      const result = await checkCorsaProject({ configFile });
      expect(result.artifacts).toEqual([expect.objectContaining({ status: "unsupported", evidence: "unknown" })]);
    });
  });

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
