import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyCorsaContracts } from "../src/contracts/corsa-contracts.js";
import { nativeBodyExpression } from "../src/contracts/native-scalars.js";
import { parseOxcExpression } from "../src/frontends/oxc/expression.js";
import { logicToSmt } from "../src/contracts/obligations.js";
import { evaluateLogic, formatLogic, formatValue, parseModel } from "../src/contracts/contract-explanations.js";

async function verify(files: Record<string, string>) {
  const directory = mkdtempSync(join(tmpdir(), "uneffect-call-composition-"));
  const sources = new Map(Object.entries(files).map(([name, source]) => [join(directory, name), source]));
  const configFile = join(directory, "tsconfig.json");
  for (const [file, source] of sources) writeFileSync(file, source);
  writeFileSync(configFile, JSON.stringify({ compilerOptions: {
    strict: true, target: "ES2024", module: "NodeNext", types: [],
  }, files: [...sources.keys()] }));
  try {
    const result = await verifyCorsaContracts({ configFile, files: sources });
    return result.artifacts.filter(artifact => artifact.source?.fileName === join(directory, "entry.mts"));
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

const five = `/* uneffect:ensures result === 5 */
export function value(): number { return 5; }`;

describe("native branching callees", () => {
  it("composes Boolean early returns", async () => {
    const artifacts = await verify({ "helper.mts": `/* uneffect:ensures result === !flag */
export function invert(flag: boolean): boolean { if (flag) return false; return true; }`,
      "entry.mts": `import { invert } from "./helper.mjs";
/* uneffect:ensures result === !enabled */
export function caller(enabled: boolean): boolean { return invert(enabled); }` });
    expect(artifacts.map(item => item.status)).toEqual(["verified"]);
  });

  it("reconstructs three sequential early-return paths", async () => {
    const artifacts = await verify({ "helper.mts": `/* uneffect:ensures result === item */
export function choose(item: 0 | 1 | 2): number { if (item === 0) return 0; if (item === 1) return 1; return 2; }`,
      "entry.mts": `import { choose } from "./helper.mjs";
/* uneffect:ensures result === value */
export function caller(value: 0 | 1 | 2): number { return choose(value); }` });
    expect(artifacts.map(item => item.status)).toEqual(["verified"]);
  });

  it.each([
    "if (item === 0) return 2; else return 3;",
    "if (item === 0) return 2; return 3;",
    "{ if (item === 0) { return 2; } } { return 3; }",
  ])("composes authenticated branching returns: %s", async body => {
    const artifacts = await verify({ "helper.mts": `/* uneffect:ensures result === item + 2 */
export function choose(item: 0 | 1): number { ${body} }`,
      "entry.mts": `import { choose as pick } from "./helper.mjs";
/* uneffect:ensures result === value + 2 */
export function caller(value: 0 | 1): number { return pick(value); }` });
    expect(artifacts.map(item => item.status)).toEqual(["verified"]);
  });

  const positive = `/* uneffect:requires value > 0 */
/* uneffect:ensures result === value */
export function positive(value: 0 | 1): number { return value; }`;
  it("retains both predecessor paths at a shared callee call", async () => {
    const artifacts = await verify({ "leaf.mts": positive,
      "wrapper.mts": `import { positive } from "./leaf.mjs";
/* uneffect:ensures result >= 0 */
export function wrapper(item: 0 | 1): number { if (item > 0) {} return positive(item); }`,
      "entry.mts": `import { wrapper } from "./wrapper.mjs";
/* uneffect:ensures result >= 0 */
export function caller(value: 0 | 1): number { return wrapper(value); }` });
    expect(artifacts.filter(item => item.obligation?.clause === "requires").map(item => item.status).sort()).toEqual(["counterexample", "verified"]);
    expect(artifacts.at(-1)?.status).toBe("verified");
  });
  it.each([
    ["if (item === 0) return 0; return positive(item);", "verified"],
    ["if (item === 0) return positive(item); return 0;", "counterexample"],
    ["if (positive(item) > 0) {} return 0;", "counterexample"],
  ])("retains evaluation conditions even when a predicate does not affect the return: %s", async (body, status) => {
    const artifacts = await verify({ "leaf.mts": positive,
      "wrapper.mts": `import { positive } from "./leaf.mjs";
/* uneffect:ensures result >= 0 */
export function wrapper(item: 0 | 1): number { ${body} }`,
      "entry.mts": `import { wrapper } from "./wrapper.mjs";
/* uneffect:ensures result >= 0 */
export function caller(value: 0 | 1): number { return wrapper(value); }` });
    expect(artifacts.map(item => item.status)).toEqual([status, "verified"]);
  });

  it("keeps wrapper requires independent of its early return", async () => {
    const artifacts = await verify({ "helper.mts": `/* uneffect:requires item > 0 */
/* uneffect:ensures result >= 0 */
export function choose(item: 0 | 1): number { if (item === 0) return 0; return item; }`,
      "entry.mts": `import { choose } from "./helper.mjs";
/* uneffect:ensures result >= 0 */
export function caller(value: 0 | 1): number { return choose(value); }` });
    expect(artifacts.map(item => item.status)).toEqual(["counterexample", "verified"]);
  });

  it("checks numeric predicate evaluation before discarding an empty branch", async () => {
    const artifacts = await verify({ "helper.mts": `/* uneffect:ensures result === 0 */
export function choose(item: number): number { if (item + 1 > 0) {} return 0; }`,
      "entry.mts": `import { choose } from "./helper.mjs";
/* uneffect:ensures result === 0 */
export function caller(): number { return choose(9007199254740991); }` });
    expect(artifacts).toEqual([expect.objectContaining({ status: "unsupported", message: expect.stringMatching(/safe integer range/) })]);
  });

  it("rejects a non-Boolean predicate even if both paths return the same value", async () => {
    const artifacts = await verify({ "helper.mts": `/* uneffect:ensures result === 0 */
export function choose(item: 0 | 1): number { if (item) {} return 0; }`,
      "entry.mts": `import { choose } from "./helper.mjs";
/* uneffect:ensures result === 0 */
export function caller(value: 0 | 1): number { return choose(value); }` });
    expect(artifacts).toEqual([expect.objectContaining({ status: "unsupported", message: expect.stringMatching(/Boolean/) })]);
  });

  it("does not require an unreachable callee call after an early return", async () => {
    const artifacts = await verify({ "leaf.mts": positive,
      "wrapper.mts": `import { positive } from "./leaf.mjs";
/* uneffect:ensures result === 0 */
export function wrapper(item: 0 | 1): number { if (true) return 0; return positive(item); }`,
      "entry.mts": `import { wrapper } from "./wrapper.mjs";
/* uneffect:ensures result === 0 */
export function caller(value: 0 | 1): number { return wrapper(value); }` });
    expect(artifacts.map(item => item.status)).toEqual(["verified"]);
  });

  it("retains safe arithmetic under an early-return guard", async () => {
    const artifacts = await verify({ "helper.mts": `/* uneffect:ensures result >= item */
export function increment(item: 0 | 9007199254740991): number { if (item === 9007199254740991) return item; return item + 1; }`,
      "entry.mts": `import { increment } from "./helper.mjs";
/* uneffect:ensures result >= value */
export function caller(value: 0 | 9007199254740991): number { return increment(value); }` });
    expect(artifacts.map(item => item.status)).toEqual(["verified"]);
  });

  it("rejects a callee with a path falling through", async () => {
    const artifacts = await verify({ "helper.mts": `/* uneffect:ensures result === 0 */
export function choose(flag: boolean): number | undefined { if (flag) return 0; }`,
      "entry.mts": `import { choose } from "./helper.mjs";
/* uneffect:ensures result === 0 */
export function caller(flag: boolean): number | undefined { return choose(flag); }` });
    expect(artifacts).toEqual([expect.objectContaining({ status: "unsupported", message: expect.stringMatching(/fall through/) })]);
  });

  it("keeps free variables in a discarded predicate out of the caller namespace", async () => {
    const artifacts = await verify({ "helper.mts": `const captured = true;
/* uneffect:ensures result === 0 */
export function choose(): number { if (captured) {} return 0; }`,
      "entry.mts": `import { choose } from "./helper.mjs";
/* uneffect:ensures result === 0 */
export function caller(captured: boolean): number { return choose(); }` });
    expect(artifacts.map(item => item.status)).toEqual(["unsupported"]);
  });

  it("rejects excessive callee paths with an explicit CFG budget", async () => {
    const artifacts = await verify({ "helper.mts": `/* uneffect:ensures result === 0 */
export function choose(flag: boolean): number { ${"if (flag) {} ".repeat(10)} return 0; }`,
      "entry.mts": `import { choose } from "./helper.mjs";
/* uneffect:ensures result === 0 */
export function caller(flag: boolean): number { return choose(flag); }` });
    expect(artifacts).toEqual([expect.objectContaining({ status: "unsupported", message: expect.stringMatching(/budget/) })]);
  });

  it("checks the sort of an unreachable predicate", async () => {
    const artifacts = await verify({ "helper.mts": `/* uneffect:ensures result === 0 */
export function choose(item: 0 | 1): number { if (true) return 0; if (item) {} return 0; }`,
      "entry.mts": `import { choose } from "./helper.mjs";
/* uneffect:ensures result === 0 */
export function caller(value: 0 | 1): number { return choose(value); }` });
    expect(artifacts).toEqual([expect.objectContaining({ status: "unsupported", message: expect.stringMatching(/Boolean/) })]);
  });

  it("does not check runtime arithmetic for an unreachable unused argument", async () => {
    const artifacts = await verify({ "leaf.mts": `/* uneffect:ensures result === 0 */
export function discard(unused: number): number { return 0; }`,
      "wrapper.mts": `import { discard } from "./leaf.mjs";
/* uneffect:ensures result === 0 */
export function wrapper(): number { if (true) return 0; return discard(9007199254740991 + 1); }`,
      "entry.mts": `import { wrapper } from "./wrapper.mjs";
/* uneffect:ensures result === 0 */
export function caller(): number { return wrapper(); }` });
    expect(artifacts.map(item => item.status)).toEqual(["verified"]);
  });
});

describe("native conditional call results", () => {
  const choice = `/* uneffect:ensures result === value + 2 */
export function choose(value: 0 | 1): number { return value === 0 ? 2 : 3; }`;

  it.each([["result === value + 2", "verified"], ["result === 2", "counterexample"]])("checks a numeric conditional result: %s", async (ensures, status) => {
    const artifacts = await verify({ "helper.mts": choice,
      "entry.mts": `import { choose as pick } from "./helper.mjs";
/* uneffect:ensures ${ensures} */
export function caller(value: 0 | 1): number { return pick(value); }` });
    expect(artifacts.map(item => item.status)).toEqual([status]);
    if (status === "counterexample") expect(artifacts[0]!.counterexample?.assignments).toMatchObject({ value: "1", result: "3" });
  });

  it("composes Boolean conditional results", async () => {
    const artifacts = await verify({ "helper.mts": `/* uneffect:ensures result === !enabled */
export function invert(enabled: boolean): boolean { return enabled ? false : true; }`,
      "entry.mts": `import { invert } from "./helper.mjs";
/* uneffect:ensures result === !flag */
export function caller(flag: boolean): boolean { return invert(flag); }` });
    expect(artifacts.map(item => item.status)).toEqual(["verified"]);
  });

  it.each([false, true])("retains independent guards for both leaf calls (reversed: %s)", async reversed => {
    const artifacts = await verify({ "helper.mts": `/* uneffect:requires value > 0 */
/* uneffect:ensures result === value */
export function positive(value: 0 | 1): number { return value; }
/* uneffect:requires value === 0 */
/* uneffect:ensures result === value */
export function zero(value: 0 | 1): number { return value; }`,
      "wrapper.mts": `import { positive, zero } from "./helper.mjs";
/* uneffect:ensures result === item */
export function wrapper(item: 0 | 1): number { return item === 0 ? ${reversed ? "positive" : "zero"}(item) : ${reversed ? "zero" : "positive"}(item); }`,
      "entry.mts": `import { wrapper } from "./wrapper.mjs";
/* uneffect:ensures result === value */
export function caller(value: 0 | 1): number { return wrapper(value); }` });
    expect(artifacts.map(item => item.status)).toEqual([reversed ? "counterexample" : "verified", reversed ? "counterexample" : "verified", "verified"]);
  });

  it("does not assume a conditional predicate before evaluating its call", async () => {
    const artifacts = await verify({ "helper.mts": `/* uneffect:requires value > 0 */
/* uneffect:ensures result === value */
export function positive(value: 0 | 1): number { return value; }`,
      "wrapper.mts": `import { positive } from "./helper.mjs";
/* uneffect:ensures result >= 0 */
export function wrapper(item: 0 | 1): number { return positive(item) > 0 ? 1 : 0; }`,
      "entry.mts": `import { wrapper } from "./wrapper.mjs";
/* uneffect:ensures result >= 0 */
export function caller(value: 0 | 1): number { return wrapper(value); }` });
    expect(artifacts.map(item => item.status)).toEqual(["counterexample", "verified"]);
  });

  it("preserves finite conditional values through an initializer and division", async () => {
    const artifacts = await verify({ "helper.mts": `/* uneffect:ensures result === 2 || result === 4 */
export function choose(flag: boolean): number { return flag ? 2 : 4; }`,
      "entry.mts": `import { choose } from "./helper.mjs";
/* uneffect:ensures result === 1 || result === 2 */
export function caller(flag: boolean): number { const selected = choose(flag); return selected / 2; }` });
    expect(artifacts.map(item => item.status)).toEqual(["verified"]);
  });

  it("retains the wrapper's own requires independently of its conditional guard", async () => {
    const artifacts = await verify({ "helper.mts": `/* uneffect:requires value > 0 */
/* uneffect:ensures result === value */
export function positive(value: 0 | 1): number { return value; }`,
      "wrapper.mts": `import { positive } from "./helper.mjs";
/* uneffect:requires item > 0 */
/* uneffect:ensures result >= 0 */
export function wrapper(item: 0 | 1): number { return item === 0 ? 0 : positive(item); }`,
      "entry.mts": `import { wrapper } from "./wrapper.mjs";
/* uneffect:ensures result >= 0 */
export function caller(value: 0 | 1): number { return wrapper(value); }` });
    expect(artifacts.map(item => item.status)).toEqual(["counterexample", "verified", "verified"]);
  });

  it("substitutes parameters through nested conditional arms", async () => {
    const artifacts = await verify({ "helper.mts": `/* uneffect:ensures result === item */
export function choose(item: 0 | 1 | 2): number { return item === 0 ? 0 : item === 1 ? 1 : 2; }`,
      "entry.mts": `import { choose } from "./helper.mjs";
/* uneffect:ensures result === value */
export function caller(value: 0 | 1 | 2): number { return choose(value); }` });
    expect(artifacts.map(item => item.status)).toEqual(["verified"]);
  });

  it("uses an imported conditional's guard for safe integer bounds", async () => {
    const artifacts = await verify({ "helper.mts": `/* uneffect:ensures result >= item */
export function increment(item: 0 | 9007199254740991): number { return item < 9007199254740991 ? item + 1 : item; }`,
      "entry.mts": `import { increment } from "./helper.mjs";
/* uneffect:ensures result >= value */
export function caller(value: 0 | 9007199254740991): number { return increment(value); }` });
    expect(artifacts.map(item => item.status)).toEqual(["verified"]);
  });

  it("combines conditionals in an initializer, argument and arithmetic", async () => {
    const artifacts = await verify({ "helper.mts": `/* uneffect:ensures result === value */
export function identity(value: number): number { return value; }`,
      "entry.mts": `import { identity } from "./helper.mjs";
/* uneffect:ensures result === 1 || result === 2 */
export function caller(flag: boolean): number {
  const selected = flag ? 0 : 1;
  return identity(flag ? selected : 0) + (flag ? 1 : 2);
}` });
    expect(artifacts.map(item => item.status)).toEqual(["verified"]);
  });

  it.each([
    ["value ? 2 : 3", "number", /conditions must be Boolean/],
    ["value === 0 ? 2 : true", "number | boolean", /matching scalar sorts/],
  ])("rejects invalid conditional result semantics: %s", async (expression, type, message) => {
    const artifacts = await verify({ "helper.mts": `/* uneffect:ensures result === result */
export function choose(value: 0 | 1): ${type} { return ${expression}; }`,
      "entry.mts": `import { choose } from "./helper.mjs";
/* uneffect:ensures result === result */
export function caller(value: 0 | 1): ${type} { return choose(value); }` });
    expect(artifacts).toEqual([expect.objectContaining({ status: "unsupported", message: expect.stringMatching(message) })]);
  });

  it.each(["true", "false"])("retains branch-local arithmetic checks under literal %s", async flag => {
    const artifacts = await verify({ "helper.mts": `/* uneffect:ensures result === 0 */
export function choose(): number { return ${flag} ? 0 : 9007199254740991 + 1; }`,
      "entry.mts": `import { choose } from "./helper.mjs";
/* uneffect:ensures result === 0 */
export function caller(): number { return choose(); }` });
    expect(artifacts.map(item => item.status)).toEqual([flag === "true" ? "verified" : "unsupported"]);
  });

  it.each(["captured ? value : 0", "true ? value : captured"])("rejects free variables anywhere in a conditional: %s", async expression => {
    const artifacts = await verify({ "helper.mts": `const captured = 1;
/* uneffect:ensures result === value */
export function choose(value: 0 | 1): number { return ${expression}; }`,
      "entry.mts": `import { choose } from "./helper.mjs";
/* uneffect:ensures result === value */
export function caller(value: 0 | 1, captured: 0): number { return choose(value); }` });
    expect(artifacts.map(item => item.status)).toEqual(["unsupported"]);
  });

  it("counts substituted conditional arms against the expression budget", async () => {
    const sum = (term: string) => Array(64).fill(term).join(" + ");
    const artifacts = await verify({ "helper.mts": `/* uneffect:ensures result >= 0 */
export function choose(value: number, flag: boolean): number { return flag ? ${sum("value")} : 0; }`,
      "entry.mts": `import { choose } from "./helper.mjs";
/* uneffect:ensures result >= 0 */
export function caller(value: 0 | 1, flag: boolean): number { return choose(${sum("value")}, flag); }` });
    expect(artifacts).toEqual([expect.objectContaining({ status: "unsupported", message: expect.stringMatching(/node budget/) })]);
  });

  it("keeps recursion inside an unselected arm unsupported", async () => {
    const artifacts = await verify({ "entry.mts": `/* uneffect:ensures result === 0 */
export function caller(): number { return recursive(); }
/* uneffect:ensures result === 0 */
function recursive(): number { return true ? 0 : recursive(); }` });
    expect(artifacts.some(item => item.status === "unsupported" && /recursive/.test(item.message ?? ""))).toBe(true);
  });

  it("serializes and explains a conditional with the same selected value", () => {
    const expression = nativeBodyExpression(parseOxcExpression("(flag ? 2 : 4) + 1", "test").expression);
    expect(logicToSmt(expression)).toBe("(+ (ite flag 2 4) 1)");
    const rendered = formatLogic(expression);
    const roundTrip = nativeBodyExpression(parseOxcExpression(rendered, "test").expression);
    for (const [flag, expected] of [["true", "3"], ["false", "5"]]) {
      const model = parseModel({ flag: flag! });
      expect(formatValue(evaluateLogic(expression, model)!)).toBe(expected);
      expect(evaluateLogic(roundTrip, model)).toEqual(evaluateLogic(expression, model));
    }
  });

  it("does not evaluate the unselected arm when explaining a model", () => {
    const expression = nativeBodyExpression(parseOxcExpression("flag ? 2 : 1 / 0", "test").expression);
    expect(formatValue(evaluateLogic(expression, parseModel({ flag: "true" }))!)).toBe("2");
    expect(evaluateLogic(expression, parseModel({ flag: "false" }))).toBeUndefined();
  });
});

describe("native calls in arguments", () => {
  const helpers = `/* uneffect:ensures result === value */
export function identity(value: 0 | 1): 0 | 1 { return value; }
/* uneffect:requires value > 0 */
/* uneffect:ensures result */
export function positive(value: 0 | 1): boolean { return true; }
/* uneffect:ensures result */
export function ignore(unused: boolean): boolean { return true; }`;

  it("composes renamed imports inside an argument without treating repeated calls as recursion", async () => {
    const artifacts = await verify({ "helper.mts": helpers,
      "entry.mts": `import { identity as normalize } from "./helper.mjs";
/* uneffect:ensures result === value */
export function caller(value: 0 | 1): number { return normalize(normalize(value)); }` });
    expect(artifacts.map(item => item.status)).toEqual(["verified"]);
  });

  it.each([
    ["ignore(positive(value))", "counterexample"],
    ["value === 0 || ignore(positive(value))", "verified"],
    ["ignore(value === 0 || positive(value))", "verified"],
    ["ignore(positive(value) || value === 0)", "counterexample"],
  ])("checks unused arguments with only their established guards: %s", async (expression, status) => {
    const artifacts = await verify({ "helper.mts": helpers,
      "entry.mts": `import { positive, ignore } from "./helper.mjs";
/* uneffect:ensures result */
export function caller(value: 0 | 1): boolean { return ${expression}; }` });
    expect(artifacts.filter(item => item.obligation?.clause === "requires").map(item => item.status)).toEqual([status]);
    expect(artifacts.at(-1)?.status).toBe("verified");
  });

  it("does not lend the callee body guard to an eagerly evaluated argument", async () => {
    const artifacts = await verify({ "helper.mts": `${helpers}
/* uneffect:ensures result === true || result === false */
export function guarded(value: 0 | 1, ready: boolean): boolean { return value === 0 || ready; }`,
      "entry.mts": `import { guarded, positive } from "./helper.mjs";
/* uneffect:ensures result */
export function caller(value: 0 | 1): boolean { return guarded(value, positive(value)); }` });
    expect(artifacts.map(item => item.status)).toEqual(["counterexample", "verified"]);
  });

  it("does not assume the outer call's requires for its argument's preconditions", async () => {
    const artifacts = await verify({ "helper.mts": `${helpers}
/* uneffect:requires value !== 0 */
/* uneffect:ensures result */
export function consume(value: 0 | 1, unused: boolean): boolean { return true; }`,
      "entry.mts": `import { consume, positive } from "./helper.mjs";
/* uneffect:ensures result */
export function caller(value: 0 | 1): boolean { return consume(value, positive(value)); }` });
    expect(artifacts.map(item => item.status)).toEqual(["counterexample", "counterexample", "verified"]);
  });

  it("retains both leaf evaluations in a guarded wrapper", async () => {
    const artifacts = await verify({ "helper.mts": helpers,
      "wrapper.mts": `import { positive, identity } from "./helper.mjs";
/* uneffect:ensures result */
export function wrapper(item: 0 | 1): boolean { return item === 0 || positive(identity(item)); }`,
      "entry.mts": `import { wrapper } from "./wrapper.mjs";
/* uneffect:ensures result */
export function caller(value: 0 | 1): boolean { return wrapper(value); }` });
    expect(artifacts.map(item => item.status)).toEqual(["verified", "verified"]);
  });

  it("keeps the caller namespace when a nested argument changes a same-named parameter", async () => {
    const artifacts = await verify({ "helper.mts": `/* uneffect:ensures result === value */
export function identity(value: number): number { return value; }
/* uneffect:requires value > 0 */
/* uneffect:ensures result */
export function positive(value: number): boolean { return true; }`,
      "entry.mts": `import { positive, identity } from "./helper.mjs";
/* uneffect:ensures result */
export function caller(value: 0): boolean { return positive(identity(value + 1)); }` });
    expect(artifacts.map(item => item.status)).toEqual(["verified", "verified"]);
  });

  it.each(["false", "true"])("checks unused nested argument arithmetic under a %s guard", async flag => {
    const artifacts = await verify({ "helper.mts": `${helpers}
/* uneffect:ensures result */
export function truth(unused: number): boolean { return true; }`,
      "entry.mts": `import { ignore, truth } from "./helper.mjs";
/* uneffect:ensures result */
export function caller(): boolean { return ignore(${flag} && truth(9007199254740991 + 1)); }` });
    expect(artifacts.map(item => item.status)).toEqual([flag === "false" ? "verified" : "unsupported"]);
  });

  it("checks the result arithmetic of a call passed to an unused parameter", async () => {
    const artifacts = await verify({ "helper.mts": `/* uneffect:ensures result === value + 1 */
export function increment(value: number): number { return value + 1; }
/* uneffect:ensures result === 0 */
export function ignore(unused: number): number { return 0; }`,
      "entry.mts": `import { ignore, increment } from "./helper.mjs";
/* uneffect:ensures result === 0 */
export function caller(): number { return ignore(increment(9007199254740991)); }` });
    expect(artifacts).toEqual([expect.objectContaining({ status: "unsupported", message: expect.stringMatching(/safe integer range/) })]);
  });

  it("does not use a later argument as a guard for an earlier argument", async () => {
    const artifacts = await verify({ "helper.mts": `${helpers}
/* uneffect:ensures result */
export function pair(first: boolean, second: boolean): boolean { return true; }`,
      "entry.mts": `import { pair, positive } from "./helper.mjs";
/* uneffect:ensures result */
export function caller(value: 0 | 1): boolean { return pair(positive(value), value > 0); }` });
    expect(artifacts.map(item => item.status)).toEqual(["counterexample", "verified"]);
  });

  it("detects recursion reached through an argument expression", async () => {
    const artifacts = await verify({ "helper.mts": helpers,
      "entry.mts": `import { identity } from "./helper.mjs";
/* uneffect:ensures result === value */
export function caller(value: 0 | 1): 0 | 1 { return identity(caller(value)); }` });
    expect(artifacts).toEqual([expect.objectContaining({ status: "unsupported", message: expect.stringMatching(/recursive/) })]);
  });

  it.each([31, 32])("shares the expansion call budget with argument calls: %i leaves", async count => {
    const artifacts = await verify({ "helper.mts": `${helpers}
/* uneffect:ensures result */
export function truth(): boolean { return true; }`,
      "entry.mts": `import { ignore, truth } from "./helper.mjs";
/* uneffect:ensures result */
export function caller(): boolean { return ignore(${Array(count).fill("truth()").join(" && ")}); }` });
    if (count === 31) expect(artifacts.map(item => item.status)).toEqual(["verified"]);
    else expect(artifacts).toEqual([expect.objectContaining({ status: "unsupported", message: expect.stringMatching(/call budget.*32/) })]);
  });
});

describe("guarded native wrapper expressions", () => {
  const leaf = `/* uneffect:requires input > 0 */
/* uneffect:ensures result */
export function positive(input: 0 | 1): boolean { return true; }`;

  it.each([
    ["item === 0 || positive(item)", "verified"],
    ["item > 0 && positive(item)", "verified"],
    ["positive(item) && item > 0", "counterexample"],
    ["item > 0 || positive(item)", "counterexample"],
  ])("retains the inner call's evaluation condition: %s", async (expression, status) => {
    const artifacts = await verify({ "leaf.mts": leaf, "wrapper.mts": `import { positive } from "./leaf.mjs";
/* uneffect:ensures result === true || result === false */
export function wrapper(item: 0 | 1): boolean { return ${expression}; }`,
      "entry.mts": `import { wrapper as wrapped } from "./wrapper.mjs";
/* uneffect:ensures result === true || result === false */
export function caller(value: 0 | 1): boolean { return wrapped(value); }` });
    expect(artifacts.filter(item => item.obligation?.clause === "requires").map(item => item.status)).toEqual([status]);
    expect(artifacts.every(item => item.status !== "unsupported")).toBe(true);
  });

  it("composes arithmetic around two sibling calls", async () => {
    const artifacts = await verify({ "leaf.mts": `/* uneffect:ensures result === value */
export function identity(value: 0 | 1): number { return value; }`,
      "wrapper.mts": `import { identity } from "./leaf.mjs";
/* uneffect:ensures result === 2 * value + 1 */
export function wrapper(value: 0 | 1): number { return identity(value) + identity(value) + 1; }`,
      "entry.mts": `import { wrapper } from "./wrapper.mjs";
/* uneffect:ensures result === 3 */
export function caller(): number { return wrapper(1); }` });
    expect(artifacts.map(item => item.status)).toEqual(["verified"]);
  });

  it("does not use an inner guard to discharge the wrapper's own requires", async () => {
    const artifacts = await verify({ "leaf.mts": leaf,
      "wrapper.mts": `import { positive } from "./leaf.mjs";
/* uneffect:requires item > 0 */
/* uneffect:ensures result */
export function wrapper(item: 0 | 1): boolean { return item === 0 || positive(item); }`,
      "entry.mts": `import { wrapper } from "./wrapper.mjs";
/* uneffect:ensures result */
export function caller(value: 0 | 1): boolean { return wrapper(value); }` });
    expect(artifacts.filter(item => item.obligation?.clause === "requires").map(item => item.status)).toEqual(["counterexample", "verified"]);
  });

  it.each(["false", "true"])("preserves evaluation of unused inner arguments under a literal %s guard", async flag => {
    const artifacts = await verify({ "leaf.mts": `/* uneffect:ensures result */
export function truth(unused: number): boolean { return true; }`,
      "wrapper.mts": `import { truth } from "./leaf.mjs";
/* uneffect:ensures result === ${flag} */
export function wrapper(): boolean { return ${flag} && truth(9007199254740991 + 1); }`,
      "entry.mts": `import { wrapper } from "./wrapper.mjs";
/* uneffect:ensures result === ${flag} */
export function caller(): boolean { return wrapper(); }` });
    expect(artifacts.map(item => item.status)).toEqual([flag === "false" ? "verified" : "unsupported"]);
  });

  it("does not use a sibling call's precondition as a path assumption", async () => {
    const artifacts = await verify({ "leaf.mts": `${leaf}
/* uneffect:requires input < 1 */
/* uneffect:ensures result */
export function zero(input: 0 | 1): boolean { return true; }`,
      "wrapper.mts": `import { positive, zero } from "./leaf.mjs";
/* uneffect:ensures result === true || result === false */
export function wrapper(item: 0 | 1): boolean { return item > 0 && positive(item) && zero(item); }`,
      "entry.mts": `import { wrapper } from "./wrapper.mjs";
/* uneffect:ensures result === true || result === false */
export function caller(value: 0 | 1): boolean { return wrapper(value); }` });
    expect(artifacts.filter(item => item.obligation?.clause === "requires").map(item => item.status)).toEqual(["verified", "counterexample"]);
  });

  it.each([31, 32])("bounds sibling call expansion separately from depth: %i leaves", async count => {
    const artifacts = await verify({ "leaf.mts": `/* uneffect:ensures result */
export function truth(): boolean { return true; }`,
      "wrapper.mts": `import { truth } from "./leaf.mjs";
/* uneffect:ensures result */
export function wrapper(): boolean { return ${Array(count).fill("truth()").join(" && ")}; }`,
      "entry.mts": `import { wrapper } from "./wrapper.mjs";
/* uneffect:ensures result */
export function caller(): boolean { return wrapper(); }` });
    if (count === 31) expect(artifacts.map(item => item.status)).toEqual(["verified"]);
    else expect(artifacts).toEqual([expect.objectContaining({ status: "unsupported", message: expect.stringMatching(/call budget.*32/) })]);
  });

  it("does not substitute callee names into the caller's actual argument evaluations", async () => {
    const artifacts = await verify({ "leaf.mts": `/* uneffect:ensures result */
export function truth(value: number): boolean { return true; }`,
      "wrapper.mts": `import { truth } from "./leaf.mjs";
/* uneffect:ensures result */
export function wrapper(value: 9007199254740990): boolean { return truth(value + 1) && true; }`,
      "entry.mts": `import { wrapper } from "./wrapper.mjs";
/* uneffect:ensures result */
export function caller(): boolean { return wrapper(9007199254740990); }` });
    expect(artifacts.map(item => item.status)).toEqual(["verified"]);
  });
});

describe("bounded native wrapper composition", () => {
  const leaf = `/* uneffect:requires value > 0 */
/* uneffect:ensures result === value */
export function leaf(value: 0 | 1): number { return value; }`;
  const wrapper = `import { leaf as inner } from "./leaf.mjs";
/* uneffect:ensures result === item */
export function wrapper(item: 0 | 1): number { return inner(item); }`;

  it.each([
    ["if (value === 0) return 0; return outer(value);", "verified"],
    ["return outer(value);", "counterexample"],
  ])("propagates leaf requirements through a renamed wrapper: %s", async (body, status) => {
    const artifacts = await verify({ "leaf.mts": leaf, "wrapper.mts": wrapper,
      "entry.mts": `import { wrapper as outer } from "./wrapper.mjs";
/* uneffect:ensures result >= 0 */
export function caller(value: 0 | 1): number { ${body} }` });
    expect(artifacts.filter(item => item.obligation?.clause === "requires").map(item => item.status)).toEqual([status]);
    expect(artifacts.every(item => item.status !== "unsupported")).toBe(true);
  });

  it("checks both wrapper and leaf requirements without assuming either", async () => {
    const artifacts = await verify({ "leaf.mts": leaf,
      "wrapper.mts": wrapper.replace("/* uneffect:ensures", "/* uneffect:requires item >= 0 */\n/* uneffect:ensures"),
      "entry.mts": `import { wrapper } from "./wrapper.mjs";
/* uneffect:ensures result >= 0 */
export function caller(value: 0 | 1): number { return wrapper(value); }` });
    expect(artifacts.filter(item => item.obligation?.clause === "requires").map(item => item.status)).toEqual(["verified", "counterexample"]);
  });

  it("substitutes renamed parameters simultaneously when a wrapper swaps arguments", async () => {
    const artifacts = await verify({ "leaf.mts": `/* uneffect:ensures result === left - right */
export function difference(left: 0 | 1, right: 0 | 1): number { return left - right; }`,
      "wrapper.mts": `import { difference } from "./leaf.mjs";
/* uneffect:ensures result === right - left */
export function reversed(left: 0 | 1, right: 0 | 1): number { return (difference(right, left)); }`,
      "entry.mts": `import { reversed } from "./wrapper.mjs";
/* uneffect:ensures result === 1 */
export function caller(): number { return reversed(0, 1); }` });
    expect(artifacts.map(item => item.status)).toEqual(["verified"]);
  });

  it("preserves short-circuit conditions outside the wrapper", async () => {
    const artifacts = await verify({ "leaf.mts": leaf.replace("result === value", "result").replace(": number { return value; }", ": boolean { return true; }"),
      "wrapper.mts": wrapper.replace("result === item", "result").replace(": number", ": boolean"),
      "entry.mts": `import { wrapper } from "./wrapper.mjs";
/* uneffect:ensures result */
export function caller(value: 0 | 1): boolean { return value === 0 || wrapper(value); }` });
    expect(artifacts.map(item => item.status)).toEqual(["verified", "verified"]);
  });

  it("does not drop unsafe arguments unused by the leaf", async () => {
    const artifacts = await verify({ "leaf.mts": `/* uneffect:ensures result === 5 */
export function leaf(unused: number): number { return 5; }`,
      "wrapper.mts": `import { leaf } from "./leaf.mjs";
/* uneffect:ensures result === 5 */
export function wrapper(): number { return leaf(9007199254740991 + 1); }`,
      "entry.mts": `import { wrapper } from "./wrapper.mjs";
/* uneffect:ensures result === 5 */
export function caller(): number { return wrapper(); }` });
    expect(artifacts).toEqual([expect.objectContaining({ status: "unsupported", message: expect.stringMatching(/safe integer/) })]);
  });

  it("rejects a third expansion with an explicit depth limit", async () => {
    const artifacts = await verify({ "leaf.mts": leaf, "wrapper.mts": wrapper,
      "another.mts": `import { wrapper } from "./wrapper.mjs";
/* uneffect:ensures result === value */
export function another(value: 0 | 1): number { return wrapper(value); }`,
      "entry.mts": `import { another } from "./another.mjs";
/* uneffect:ensures result === 1 */
export function caller(): number { return another(1); }` });
    expect(artifacts).toEqual([expect.objectContaining({ status: "unsupported", message: expect.stringMatching(/depth.*2/) })]);
  });

  it.each([
    "export function first(): number { return first(); }",
    "export function first(): number { return second(); }\n/* uneffect:ensures result === 0 */\nexport function second(): number { return first(); }",
  ])("rejects recursive declarations without truncating them into proofs", async body => {
    const artifacts = await verify({ "helper.mts": `/* uneffect:ensures result === 0 */\n${body}`,
      "entry.mts": `import { first } from "./helper.mjs";
/* uneffect:ensures result === 0 */
export function caller(): number { return first(); }` });
    expect(artifacts).toEqual([expect.objectContaining({ status: "unsupported", message: expect.stringMatching(/recursive/) })]);
  });

  it.each([16, 64])("bounds the expanded expression, including repeated argument subtrees: %i", async count => {
    const repeated = (size: number): string => size === 1 ? "value" : `(${repeated(size / 2)} && ${repeated(size / 2)})`;
    const artifacts = await verify({ "leaf.mts": `/* uneffect:ensures result === value */
export function leaf(value: boolean): boolean { return ${repeated(64)}; }`,
      "wrapper.mts": `import { leaf } from "./leaf.mjs";
/* uneffect:ensures result === value */
export function wrapper(value: boolean): boolean { return leaf(${repeated(count)}); }`,
      "entry.mts": `import { wrapper } from "./wrapper.mjs";
/* uneffect:ensures result === value */
export function caller(value: boolean): boolean { return wrapper(value); }` });
    if (count === 16) expect(artifacts.map(item => item.status)).toEqual(["verified"]);
    else expect(artifacts).toEqual([expect.objectContaining({ status: "unsupported", message: expect.stringMatching(/node budget.*4096/) })]);
  });

  it("checks writes to the nested leaf, even with compiler diagnostics suppressed", async () => {
    const artifacts = await verify({ "leaf.mts": `${leaf}\n// @ts-expect-error deliberate runtime reassignment\nleaf = () => 9;`,
      "wrapper.mts": wrapper, "entry.mts": `import { wrapper } from "./wrapper.mjs";
/* uneffect:ensures result === 1 */
export function caller(): number { return wrapper(1); }` });
    expect(artifacts.map(item => item.status)).toEqual(["unsupported"]);
  });

  it("applies the expression budget after substituting caller const bindings", async () => {
    const repeated = (size: number): string => size === 1 ? "value" : `(${repeated(size / 2)} && ${repeated(size / 2)})`;
    const artifacts = await verify({ "leaf.mts": `/* uneffect:ensures result === value */
export function leaf(value: boolean): boolean { return ${repeated(16)}; }`,
      "wrapper.mts": `import { leaf } from "./leaf.mjs";
/* uneffect:ensures result === value */
export function wrapper(value: boolean): boolean { return leaf(${repeated(16)}); }`,
      "entry.mts": `import { wrapper } from "./wrapper.mjs";
/* uneffect:ensures result === value */
export function caller(value: boolean): boolean { const combined = ${repeated(16)}; return wrapper(combined); }` });
    expect(artifacts).toEqual([expect.objectContaining({ status: "unsupported", message: expect.stringMatching(/node budget.*4096/) })]);
  });

  it("does not capture a caller parameter through an unused nested argument", async () => {
    const artifacts = await verify({ "leaf.mts": `/* uneffect:ensures result === 5 */
export function leaf(unused: number): number { return 5; }`,
      "wrapper.mts": `import { leaf } from "./leaf.mjs";
const captured = 9;
/* uneffect:ensures result === 5 */
export function wrapper(): number { return leaf(captured); }`,
      "entry.mts": `import { wrapper } from "./wrapper.mjs";
/* uneffect:ensures result === 5 */
export function caller(captured: 5): number { return wrapper(); }` });
    expect(artifacts.map(item => item.status)).toEqual(["unsupported"]);
  });

  it("lifts a conditional leaf call inside a wrapper", async () => {
    const artifacts = await verify({ "leaf.mts": leaf.replace("result === value", "result").replace(": number { return value; }", ": boolean { return true; }"),
      "wrapper.mts": `import { leaf } from "./leaf.mjs";
/* uneffect:ensures result */
export function wrapper(value: 0 | 1): boolean { return value === 0 || leaf(value); }`,
      "entry.mts": `import { wrapper } from "./wrapper.mjs";
/* uneffect:ensures result */
export function caller(value: 0 | 1): boolean { return wrapper(value); }` });
    expect(artifacts.map(item => item.status)).toEqual(["verified", "verified"]);
  });
});

describe("native call-site preconditions", () => {
  const helper = `/* uneffect:requires value > 0 */
/* uneffect:ensures result === value */
export function positive(value: 0 | 1): number { return value; }`;

  it.each([
    ["if (value > 0) return positive(value); return 0;", "", "verified"],
    ["if (value === 0) return 0; return positive(value);", "", "verified"],
    ["return positive(value);", "/* uneffect:requires value > 0 */", "verified"],
    ["return positive(value);", "", "counterexample"],
    ["if (value > 0) return 1; return positive(value);", "", "counterexample"],
    ["const captured = positive(value); if (value > 0) return captured; return 0;", "", "counterexample"],
    ["let next = value; next = 0; return positive(next);", "", "counterexample"],
  ])("checks only established caller conditions: %s", async (body, requires, status) => {
    const entry = `import { positive } from "./helper.mjs";
${requires}
/* uneffect:ensures result >= 0 */
export function caller(value: 0 | 1): number { ${body} }`;
    const artifacts = await verify({ "helper.mts": helper, "entry.mts": entry });
    const preconditions = artifacts.filter(artifact => artifact.obligation?.clause === "requires");
    expect(preconditions.map(artifact => artifact.status)).toEqual([status]);
    expect(artifacts.every(artifact => artifact.status !== "unsupported")).toBe(true);
    expect(entry.slice(preconditions[0]!.source.span.start, preconditions[0]!.source.span.end)).toMatch(/^positive\(/);
    if (status === "counterexample") expect(preconditions[0]!.counterexample?.assignments).toBeDefined();
  });

  it.each([
    ["value > 0 && positive(value)", "verified"],
    ["value === 0 || positive(value)", "verified"],
    ["positive(value) && value > 0", "counterexample"],
    ["value > 0 || positive(value)", "counterexample"],
  ])("respects expression evaluation order: %s", async (expression, status) => {
    const artifacts = await verify({ "helper.mts": helper.replace("result === value", "result").replace(": number { return value; }", ": boolean { return true; }"),
      "entry.mts": `import { positive } from "./helper.mjs";
/* uneffect:ensures result === true || result === false */
export function caller(value: 0 | 1): boolean { return ${expression}; }` });
    expect(artifacts.filter(artifact => artifact.obligation?.clause === "requires").map(artifact => artifact.status)).toEqual([status]);
  });

  it("does not assume another callee requirement or the caller ensures", async () => {
    const artifacts = await verify({ "helper.mts": helper.replace("/* uneffect:requires value > 0 */", "/* uneffect:requires value >= 0 */\n/* uneffect:requires value > 0 */"),
      "entry.mts": `import { positive } from "./helper.mjs";
/* uneffect:ensures result > 0 */
export function caller(value: 0 | 1): number { return positive(value); }` });
    expect(artifacts.filter(artifact => artifact.obligation?.clause === "requires").map(artifact => artifact.status)).toEqual(["verified", "counterexample"]);
    expect(artifacts.at(-1)?.status).toBe("counterexample");
  });

  it("proves a relational requirement from a comparison between caller parameters", async () => {
    const artifacts = await verify({ "helper.mts": `/* uneffect:requires left < right */
/* uneffect:ensures result === right - left */
export function distance(left: 0 | 1 | 2, right: 0 | 1 | 2): number { return right - left; }`,
      "entry.mts": `import { distance as gap } from "./helper.mjs";
/* uneffect:ensures result >= 0 */
export function caller(start: 0 | 1 | 2, end: 0 | 1 | 2): number {
  if (start < end) return gap(start, end);
  return 0;
}` });
    expect(artifacts.filter(artifact => artifact.obligation?.clause === "requires").map(artifact => artifact.status)).toEqual(["verified"]);
    expect(artifacts.every(artifact => artifact.status === "verified")).toBe(true);
  });

  it("checks a call in an if predicate before assuming the predicate result", async () => {
    const artifacts = await verify({ "helper.mts": helper,
      "entry.mts": `import { positive } from "./helper.mjs";
/* uneffect:ensures result >= 0 */
export function caller(value: 0 | 1): number { if (positive(value) > 0) return 1; return 0; }` });
    const preconditions = artifacts.filter(artifact => artifact.obligation?.clause === "requires");
    expect(preconditions.map(artifact => artifact.status)).toEqual(["counterexample"]);
    expect(preconditions[0]!.counterexample?.assignments.value).toBe("0");
  });

  it("retains both predecessor conditions at a shared call", async () => {
    const artifacts = await verify({ "helper.mts": helper,
      "entry.mts": `import { positive } from "./helper.mjs";
/* uneffect:ensures result >= 0 */
export function caller(value: 0 | 1): number { if (value > 0) {} return positive(value); }` });
    expect(artifacts.filter(artifact => artifact.obligation?.clause === "requires").map(artifact => artifact.status).sort()).toEqual(["counterexample", "verified"]);
  });

  it("does not delay an unused initializer's call until the function returns", async () => {
    const artifacts = await verify({ "helper.mts": helper,
      "entry.mts": `import { positive } from "./helper.mjs";
/* uneffect:ensures result === 1 */
export function caller(value: 0 | 1): number { const unused = positive(value); return 1; }` });
    expect(artifacts.map(artifact => artifact.status)).toEqual(["counterexample", "verified"]);
  });
});

describe("native contract call declaration identity", () => {
  it("composes a renamed named import from its actual implementation", async () => {
    const artifacts = await verify({ "helper.mts": five, "entry.mts": `import { value as read } from "./helper.mjs";
/* uneffect:ensures result === 5 */
export function caller(): number { return read(); }` });
    expect(artifacts.map(artifact => artifact.status)).toEqual(["verified"]);
  });

  it("distinguishes same-named functions in separate modules", async () => {
    const artifacts = await verify({ "helper.mts": five, "unrelated.mts": five.replaceAll("5", "9"),
      "entry.mts": `import { value } from "./helper.mjs";
/* uneffect:ensures result === 5 */
export function caller(): number { return value(); }` });
    expect(artifacts.map(artifact => artifact.status)).toEqual(["verified"]);
  });

  it("reports an actual imported result that violates the caller contract", async () => {
    const artifacts = await verify({ "helper.mts": five.replaceAll("5", "9"), "unrelated.mts": five,
      "entry.mts": `import { value } from "./helper.mjs";
/* uneffect:ensures result === 5 */
export function caller(): number { return value(); }` });
    expect(artifacts.map(artifact => artifact.status)).toEqual(["counterexample"]);
  });

  it("does not borrow a same-named function's contract for an uncontracted import", async () => {
    const artifacts = await verify({ "helper.mts": "export function value(): number { return 9; }", "unrelated.mts": five,
      "entry.mts": `import { value } from "./helper.mjs";
/* uneffect:ensures result === 5 */
export function caller(): number { return value(); }` });
    expect(artifacts.map(artifact => artifact.status)).toEqual(["unsupported"]);
  });

  it.each([
    "value = () => 9;",
    "function replace() { value = () => 9; } replace();",
    "({ value } = { value: () => 9 });",
    "eval('value = () => 9');",
  ])("rejects a writable or dynamically scoped imported target: %s", async mutation => {
    // Suppress TS2630 deliberately to exercise the analyzer's write screen.
    const assignment = mutation.startsWith("eval") ? mutation : `// @ts-expect-error intentional runtime reassignment\n${mutation}`;
    const artifacts = await verify({ "helper.mts": `${five}\n${assignment}`, "entry.mts": `import { value } from "./helper.mjs";
/* uneffect:ensures result === 5 */
export function caller(): number { return value(); }` });
    expect(artifacts.map(artifact => artifact.status)).toEqual(["unsupported"]);
  });

  it("does not capture a caller parameter as a callee's free variable", async () => {
    const artifacts = await verify({ "helper.mts": `const captured = 9;
/* uneffect:ensures result === 9 */
export function value(): number { return captured; }`, "entry.mts": `import { value } from "./helper.mjs";
/* uneffect:ensures result === captured */
export function caller(captured: 5): number { return value(); }` });
    expect(artifacts.map(artifact => artifact.status)).toEqual(["unsupported"]);
  });

  it("checks every callee requires clause", async () => {
    const artifacts = await verify({ "helper.mts": `/* uneffect:requires value >= 0 */
/* uneffect:requires value > 0 */
/* uneffect:ensures result === value */
export function identity(value: 0 | 1): number { return value; }`, "entry.mts": `import { identity } from "./helper.mjs";
/* uneffect:ensures result === 0 */
export function caller(): number { return identity(0); }` });
    expect(artifacts.map(artifact => artifact.status)).toEqual(["counterexample", "verified"]);
    expect(artifacts[0]?.obligation?.clause).toBe("requires");
  });

  it("retains zero-argument callee preconditions", async () => {
    const artifacts = await verify({ "helper.mts": `/* uneffect:requires false */\n${five}`, "entry.mts": `import { value } from "./helper.mjs";
/* uneffect:ensures result === 5 */
export function caller(): number { return value(); }` });
    expect(artifacts.map(artifact => artifact.status)).toEqual(["counterexample", "verified"]);
    expect(artifacts[0]?.obligation?.clause).toBe("requires");
  });

  it("composes a renamed import with multiple satisfied preconditions", async () => {
    const artifacts = await verify({ "helper.mts": `/* uneffect:requires value > 0 */
/* uneffect:requires value < 2 */
/* uneffect:ensures result === value + 1 */
export function inc(value: 0 | 1): number { return value + 1; }`, "entry.mts": `import { inc as increment } from "./helper.mjs";
/* uneffect:ensures result === 2 */
export function caller(): number { return increment(1); }` });
    expect(artifacts.map(artifact => artifact.status)).toEqual(["verified"]);
  });

  it("retains finite caller parameters through a renamed import", async () => {
    const artifacts = await verify({ "helper.mts": `/* uneffect:ensures result === value + 1 */
export function inc(value: 0 | 1): number { return value + 1; }`, "entry.mts": `import { inc as increment } from "./helper.mjs";
/* uneffect:ensures result === value + 1 */
export function caller(value: 0 | 1): number { return increment(value); }` });
    expect(artifacts.map(artifact => artifact.status)).toEqual(["verified"]);
  });

  it("does not treat a matching callable type as runtime target identity", async () => {
    const artifacts = await verify({ "helper.mts": five, "entry.mts": `import { value } from "./helper.mjs";
const selected: typeof value = () => 9;
/* uneffect:ensures result === 5 */
export function caller(): number { return selected(); }` });
    expect(artifacts.map(artifact => artifact.status)).toEqual(["unsupported"]);
  });

  it("checks unused argument arithmetic before body substitution", async () => {
    const artifacts = await verify({ "helper.mts": `/* uneffect:ensures result === 5 */
export function value(unused: number): number { return 5; }`, "entry.mts": `import { value } from "./helper.mjs";
/* uneffect:ensures result === 5 */
export function caller(): number { return value(9007199254740991 + 1); }` });
    expect(artifacts.map(artifact => artifact.status)).toEqual(["unsupported"]);
  });
});
