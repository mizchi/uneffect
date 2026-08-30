import { describe, expect, it } from "vitest";
import ts from "typescript";
import { parseContractDsl, prepareContractDslLinks } from "../src/contract-dsl.js";
import { instrumentContractPredicates, isContractRuntimeError } from "../src/contract-runtime.js";
import { analyzeTypeScriptControlFlow, analyzeTypeScriptProgramControlFlow } from "../src/typescript-control-flow.js";
import { verifyUneffectProject } from "../src/project-verification.js";

const specification = `
  import { defineContract, int } from "@mizchi/uneffect/spec";
  export const Increment = defineContract({
    parameters: { value: int() },
    returns: int(),
    requires: [({ value }) => value >= 0, ({ value }) => value < 100],
    ensures: [({ value, result }) => result === value + 1, ({ result }) => result > 0],
  });
`;

describe("TypeScript contract DSL", () => {
  it("lowers a typed contract to Hoare-style expressions", () => {
    expect(parseContractDsl("counter.uneffect.ts", specification, "Increment")).toEqual({
      parameters: [{ name: "value", domain: "int" }],
      resultDomain: "int",
      requires: ["value >= 0", "value < 100"],
      ensures: ["result === value + 1", "result > 0"],
    });
  });

  it("connects the contract to the existing Z3 verifier", async () => {
    const result = await verifyUneffectProject({ files: {
      "src/counter.ts": `/* uneffect:contract from "./counter.uneffect.ts#Increment" */\nexport function increment(value: number): number { return value + 1 }`,
      "src/counter.uneffect.ts": specification,
    } });
    expect(result.obligations).toContainEqual(expect.objectContaining({ obligation: expect.objectContaining({ functionName: "increment" }), result: "verified" }));
    expect(result.diagnostics).toEqual([]);
  });

  it("lowers the safe predicate fragment to optional runtime assertions", async () => {
    const result = await verifyUneffectProject({
      files: {
        "src/counter.ts": `/* uneffect:contract from "./counter.uneffect.ts#Increment" */\nexport function increment(value: number): number { return value + 1 }`,
        "src/counter.uneffect.ts": specification,
      },
      runtimeAssertions: "fallback",
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.emittedFiles["src/counter.js"]).toContain("Uneffect precondition failed: value >= 0");
    expect(result.emittedFiles["src/counter.js"]).toContain("Uneffect postcondition failed: result === value + 1");
    expect(result.emittedFiles["src/counter.js"]).toContain("src/counter.uneffect.ts");
    expect(result.emittedFiles["src/counter.js"]).not.toContain("src/counter.ts:1:1 Uneffect postcondition");

    const prepared = prepareContractDslLinks({
      "src/counter.ts": `/* uneffect:contract from "./counter.uneffect.ts#Increment" */\nexport function increment(value: number): number { return value + 1 }`,
      "src/counter.uneffect.ts": specification,
    });
    expect(prepared.provenance["src/counter.ts"]).toHaveLength(4);
    for (const clause of prepared.provenance["src/counter.ts"]!) {
      expect(specification.slice(clause.span.start, clause.span.end)).toBe(clause.expression);
      expect(clause.fileName).toBe("src/counter.uneffect.ts");
      expect(clause.line).toBeGreaterThan(0);
      expect(clause.column).toBeGreaterThan(0);
    }
  });

  it("does not execute unsupported calls embedded in contract comments", () => {
    const result = instrumentContractPredicates("unsafe.ts", `
      /* uneffect:contract
       * requires validate(value)
       */
      function unsafe(value: number): number { return value }
    `);
    expect(result.code).not.toContain("if (!(validate(value)))");
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ kind: "unsupported-function", parameter: "<contract>" }));
  });

  it("instruments every value return in a synchronous branching function", () => {
    const result = instrumentContractPredicates("branch.ts", `
      /* uneffect:contract
       * ensures result >= 0
       */
      function absolute(value: number): number {
        if (value < 0) return -value;
        return value;
      }
    `);
    expect(result.diagnostics).toEqual([]);
    expect(result.code.match(/Uneffect postcondition failed/g)).toHaveLength(2);
    expect(result.code).toContain("const __uneffect_contract_result_0 = (-value)");
    expect(result.code).toContain("const __uneffect_contract_result_1 = (value)");
  });

  it("does not treat returns in nested functions as outer contract exits", () => {
    const result = instrumentContractPredicates("nested.ts", `
      /* uneffect:contract
       * ensures result >= 0
       */
      function outer(value: number): number {
        const inner = () => { return -1 };
        return value;
      }
    `);
    expect(result.diagnostics).toEqual([]);
    expect(result.code.match(/Uneffect postcondition failed/g)).toHaveLength(1);
    expect(result.code).toContain("return -1");
  });

  it("chooses generated result names that do not shadow user bindings", () => {
    const result = instrumentContractPredicates("collision.ts", `
      /* uneffect:contract
       * ensures result >= 0
       */
      function collision(value: number): number {
        const __uneffect_contract_result_0 = value;
        return __uneffect_contract_result_0;
      }
    `);
    expect(result.diagnostics).toEqual([]);
    expect(result.code).toContain("const __uneffect_contract_result_1 = (__uneffect_contract_result_0)");
  });

  it("fails closed when a postcondition function may fall through", () => {
    const result = instrumentContractPredicates("fallthrough.ts", `
      /* uneffect:contract
       * ensures result >= 0
       */
      function incomplete(value: number): number {
        if (value >= 0) return value;
      }
    `);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      kind: "unsupported-function",
      parameter: "result",
      message: expect.stringContaining("fall through"),
    }));
    expect(result.code).not.toContain("Uneffect postcondition failed");
  });

  it("checks the fulfilled value of an async contract", () => {
    const result = instrumentContractPredicates("async.ts", `
      /* uneffect:contract
       * ensures result >= value
       */
      async function load(value: number): Promise<number> {
        return Promise.resolve(value + 1);
      }
    `);
    expect(result.diagnostics).toEqual([]);
    expect(result.code).toContain("return Promise.resolve(Promise.resolve(value + 1)).then((__uneffect_contract_result_0)");
    expect(result.code).toContain("__uneffect_contract_result_0 >= value");
  });

  it("preserves async rejection and rejects a bad fulfilled value", async () => {
    const result = instrumentContractPredicates("async-runtime.ts", `
      /* uneffect:contract
       * ensures result >= 0
       */
      async function checked(value: number): Promise<number> {
        if (value === -2) throw new TypeError("original rejection");
        return value;
      }
    `);
    const javascript = ts.transpileModule(result.code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const checked = new Function(`${javascript}; return checked;`)() as (value: number) => Promise<number>;
    await expect(checked(1)).resolves.toBe(1);
    await expect(checked(-1)).rejects.toThrow("Uneffect postcondition failed");
    await expect(checked(-2)).rejects.toThrow(new TypeError("original rejection"));
  });

  it("does not make an async returned rejection catchable by the surrounding try", async () => {
    const result = instrumentContractPredicates("async-try.ts", `
      /* uneffect:contract
       * ensures result >= 0
       */
      async function checked(): Promise<number> {
        try { return Promise.reject(new TypeError("late rejection")); }
        catch { return 0; }
      }
    `);
    const javascript = ts.transpileModule(result.code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const checked = new Function(`${javascript}; return checked;`)() as () => Promise<number>;
    await expect(checked()).rejects.toThrow(new TypeError("late rejection"));
  });

  it("recognizes exhaustive switch exits", () => {
    const result = instrumentContractPredicates("switch.ts", `
      /* uneffect:contract
       * ensures result >= 0
       */
      function choose(value: number): number {
        switch (value) {
          case 0: return 0;
          case 1: throw new Error("unavailable");
          default: return value;
        }
      }
    `);
    expect(result.diagnostics).toEqual([]);
    expect(result.code.match(/Uneffect postcondition failed/g)).toHaveLength(2);
  });

  it("composes switch fallthrough before deciding exit coverage", () => {
    const result = instrumentContractPredicates("switch-fallthrough.ts", `
      /* uneffect:contract
       * ensures result >= 0
       */
      function choose(value: number): number {
        switch (value) {
          case 0: value = 1;
          case 1: return value;
          default: return 2;
        }
      }
    `);
    expect(result.diagnostics).toEqual([]);
    expect(result.code.match(/Uneffect postcondition failed/g)).toHaveLength(2);
  });

  it("composes try/catch exits and instruments both returns", () => {
    const result = instrumentContractPredicates("try.ts", `
      /* uneffect:contract
       * ensures result >= 0
       */
      function recover(value: number): number {
        try { if (value < 0) throw new Error("negative"); return value; }
        catch { return 0; }
        finally { console.log("finished"); }
      }
    `);
    expect(result.diagnostics).toEqual([]);
    expect(result.code.match(/Uneffect postcondition failed/g)).toHaveLength(2);
  });

  it("accepts an obvious non-breaking infinite loop as non-fallthrough", () => {
    const result = instrumentContractPredicates("loop.ts", `
      /* uneffect:contract
       * ensures result >= 0
       */
      function waitForever(): number {
        while (true) { continue; }
      }
    `);
    expect(result.diagnostics).toEqual([]);
    expect(result.code).not.toContain("Uneffect postcondition failed");
  });

  it("resolves break targets instead of rejecting every nested break", () => {
    const result = instrumentContractPredicates("targeted-loop.ts", `
      /* uneffect:contract
       * ensures result >= 0
       */
      function loop(value: number): number {
        while (true) {
          switch (value) { default: break; }
          inner: { break inner; }
          return value;
        }
      }
    `);
    expect(result.diagnostics).toEqual([]);
    expect(result.code.match(/Uneffect postcondition failed/g)).toHaveLength(1);
  });

  it("reports the source location in generated contract failures", () => {
    const result = instrumentContractPredicates("located.ts", `
      /* uneffect:contract
       * requires value >= 0
       * ensures result >= value
       */
      function located(value: number): number { return value; }
    `);
    expect(result.code).toContain("located.ts:3:");
    expect(result.code).toContain("Uneffect precondition failed");
    expect(result.code).toContain("located.ts:4:");
    expect(result.code).toContain("Uneffect postcondition failed");
    expect(result.code).toContain('kind: "precondition"');
    expect(result.code).toContain('fileName: "located.ts"');
  });

  it("exposes a type guard for structured runtime contract failures", () => {
    const instrumented = instrumentContractPredicates("value.ts", `/* uneffect:contract\n * requires value >= 0\n */\nfunction checked(value: number): number { return value; }`);
    const javascript = ts.transpileModule(instrumented.code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const checked = new Function(`${javascript}; return checked;`)() as (value: number) => number;
    let failure: unknown;
    try { checked(-1); } catch (cause) { failure = cause; }
    expect(isContractRuntimeError(failure)).toBe(true);
    if (isContractRuntimeError(failure)) expect(failure.uneffect).toEqual(expect.objectContaining({ kind: "precondition", fileName: "value.ts", line: 2, expression: "value >= 0", column: expect.any(Number), span: expect.objectContaining({ start: expect.any(Number), end: expect.any(Number) }) }));
    expect(isContractRuntimeError(new RangeError("ordinary"))).toBe(false);
    expect(isContractRuntimeError({ uneffect: isContractRuntimeError(failure) ? failure.uneffect : undefined })).toBe(false);
  });

  it("checks a Generator final return without treating yielded values as results", () => {
    const instrumented = instrumentContractPredicates("generator.ts", `
      /* uneffect:contract
       * ensures result >= 0
       */
      function* values(): Generator<number, number, void> {
        yield -1;
        return -2;
      }
    `);
    expect(instrumented.diagnostics).toEqual([]);
    const javascript = ts.transpileModule(instrumented.code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const values = new Function(`${javascript}; return values;`)() as () => Generator<number, number, void>;
    const iterator = values();
    expect(iterator.next()).toEqual({ done: false, value: -1 });
    expect(() => iterator.next()).toThrow("Uneffect postcondition failed");
  });

  it("checks an AsyncGenerator fulfilled final return", async () => {
    const instrumented = instrumentContractPredicates("async-generator.ts", `
      /* uneffect:contract
       * ensures result >= 0
       */
      async function* values(): AsyncGenerator<number, number, void> {
        yield -1;
        return Promise.resolve(-2);
      }
    `);
    expect(instrumented.diagnostics).toEqual([]);
    const javascript = ts.transpileModule(instrumented.code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const values = new Function(`${javascript}; return values;`)() as () => AsyncGenerator<number, number, void>;
    const iterator = values();
    await expect(iterator.next()).resolves.toEqual({ done: false, value: -1 });
    await expect(iterator.next()).rejects.toThrow("Uneffect postcondition failed");
  });

  it("attributes each runtime failure to its directive line", () => {
    const instrumented = instrumentContractPredicates("clauses.ts", `
      /* uneffect:contract
       * requires value >= 0
       * ensures result >= value
       */
      function checked(value: number): number { return value; }
    `);
    expect(instrumented.code).toContain('fileName: "clauses.ts", line: 3, expression: "value >= 0"');
    expect(instrumented.code).toContain('fileName: "clauses.ts", line: 4, expression: "result >= value"');
    expect(instrumented.code).toContain("column:");
    expect(instrumented.code).toContain("span: { start:");
  });

  it("uses TypeChecker-resolved never calls as non-fallthrough exits", () => {
    const source = `
      declare function stop(message: string): never;
      /* uneffect:contract
       * ensures result >= 0
       */
      function checked(value: number): number {
        if (value >= 0) return value;
        stop("negative");
      }
    `;
    expect(instrumentContractPredicates("never.ts", source).diagnostics).toEqual([]);
    const shadowed = source.replace("declare function stop(message: string): never;", "function stop(message: string): void { console.log(message); }");
    expect(instrumentContractPredicates("void.ts", shadowed).diagnostics).toContainEqual(expect.objectContaining({ message: expect.stringContaining("fall through") }));
  });

  it("uses TypeChecker literal booleans for semantic branch reachability", () => {
    const source = `
      const enabled: true = true;
      /* uneffect:contract
       * ensures result >= 0
       */
      function checked(value: number): number {
        if (enabled) return value;
      }
    `;
    expect(instrumentContractPredicates("literal-true.ts", source).diagnostics).toEqual([]);
    const widened = source.replace("const enabled: true = true", "const enabled: boolean = true");
    expect(instrumentContractPredicates("boolean.ts", widened).diagnostics).toContainEqual(expect.objectContaining({ message: expect.stringContaining("fall through") }));
  });

  it("uses TypeScript CFG diagnostics to accept an exhaustive literal-union switch", () => {
    const source = `
      type Kind = "left" | "right";
      /* uneffect:contract
       * ensures result >= 0
       */
      function checked(kind: Kind): number {
        switch (kind) {
          case "left": return 1;
          case "right": return 2;
        }
      }
    `;
    const analysis = analyzeTypeScriptControlFlow("exhaustive.ts", source);
    expect(analysis.schema).toBe("uneffect-typescript-control-flow/v1");
    expect(analysis.typescriptVersion).toBe(ts.version);
    expect(analysis.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(analysis.functions).toContainEqual(expect.objectContaining({ name: "checked", endpoint: "unreachable", neutralEndpoint: "reachable", parity: "typescript-refines", evidence: "public-diagnostics", internalFlowApi: "observed" }));
    expect(instrumentContractPredicates("exhaustive.ts", source).diagnostics).toEqual([]);

    const widened = source.replace('type Kind = "left" | "right"', "type Kind = string");
    expect(analyzeTypeScriptControlFlow("open.ts", widened).functions).toContainEqual(expect.objectContaining({ name: "checked", endpoint: "reachable", diagnosticCodes: expect.arrayContaining([2366]) }));
    expect(instrumentContractPredicates("open.ts", widened).diagnostics).toContainEqual(expect.objectContaining({ message: expect.stringContaining("fall through") }));

    const erroneous = source.replace("switch (kind)", "const broken: string = 1; switch (kind)");
    expect(analyzeTypeScriptControlFlow("error.ts", erroneous).functions).toContainEqual(expect.objectContaining({ name: "checked", endpoint: "unknown", diagnosticCodes: expect.arrayContaining([2322]) }));
    expect(instrumentContractPredicates("error.ts", erroneous).diagnostics).toContainEqual(expect.objectContaining({ message: expect.stringContaining("fall through") }));
  });

  it("reuses one TypeScript Program and binds methods and immutable function values by node identity", () => {
    const files = {
      "/virtual/shared.ts": `export function identity(value: number): number { return value; }`,
      "/virtual/consumer.ts": `
        type Kind = "left" | "right";
        export class Checks {
          checked(kind: Kind): number {
            switch (kind) { case "left": return 1; case "right": return 2; }
          }
        }
        export const checked = (kind: Kind): number => {
          switch (kind) { case "left": return 1; case "right": return 2; }
        };
        let mutable = (kind: Kind): number => {
          switch (kind) { case "left": return 1; case "right": return 2; }
        };
      `,
    };
    const options: ts.CompilerOptions = { strict: true, noImplicitReturns: true, module: ts.ModuleKind.CommonJS, moduleResolution: ts.ModuleResolutionKind.Node10, noEmit: true };
    const host = ts.createCompilerHost(options);
    const getSourceFile = host.getSourceFile.bind(host);
    host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
      const text = files[fileName as keyof typeof files];
      return text === undefined ? getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile) : ts.createSourceFile(fileName, text, languageVersion, true);
    };
    host.fileExists = (fileName) => fileName in files || ts.sys.fileExists(fileName);
    host.readFile = (fileName) => files[fileName as keyof typeof files] ?? ts.sys.readFile(fileName);
    const program = ts.createProgram({ rootNames: Object.keys(files), options, host });
    const analysis = analyzeTypeScriptProgramControlFlow(program, [program.getSourceFile("/virtual/consumer.ts")!]);
    expect(analysis.programReused).toBe(true);
    expect(analysis.functions).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Checks.checked", kind: "method", endpoint: "unreachable" }),
      expect.objectContaining({ name: "checked", kind: "arrow", endpoint: "unreachable" }),
      expect.objectContaining({ name: "mutable", kind: "arrow", endpoint: "unknown", diagnosticCodes: expect.arrayContaining(["uneffect-mutable-binding"]) }),
    ]));

    const uncheckedProgram = ts.createProgram({ rootNames: Object.keys(files), options: { ...options, noImplicitReturns: false }, host });
    const unchecked = analyzeTypeScriptProgramControlFlow(uncheckedProgram, [uncheckedProgram.getSourceFile("/virtual/consumer.ts")!]);
    expect(unchecked.configurationCompatible).toBe(false);
    expect(unchecked.functions).toContainEqual(expect.objectContaining({ name: "Checks.checked", endpoint: "unknown", diagnosticCodes: expect.arrayContaining(["uneffect-incompatible-compiler-options"]) }));
  });

  it("instruments contracts on methods and immutable variable-bound functions", () => {
    const source = `
      class Counter {
        /* uneffect:contract
         * ensures result >= 0
         */
        next(value: number): number { return value + 1; }
      }
      /* uneffect:contract
       * ensures result >= 0
       */
      const next = (value: number): number => { return value + 1; };
    `;
    const result = instrumentContractPredicates("callables.ts", source);
    expect(result.diagnostics).toEqual([]);
    expect(result.code.match(/Uneffect postcondition failed/g)).toHaveLength(2);

    const mutable = instrumentContractPredicates("mutable.ts", source.replace("const next", "let next"));
    expect(mutable.diagnostics).toContainEqual(expect.objectContaining({ kind: "unsupported-function", message: expect.stringContaining("immutable") }));
    expect(mutable.code.match(/Uneffect postcondition failed/g)).toHaveLength(1);
  });

  it("instruments getter results and setter preconditions while rejecting setter postconditions", () => {
    const source = `
      class Box {
        #value = 1;
        /* uneffect:contract
         * ensures result >= 0
         */
        get value(): number { return this.#value; }
        /* uneffect:contract
         * requires value >= 0
         */
        set value(value: number) { this.#value = value; }
      }
    `;
    const result = instrumentContractPredicates("accessor.ts", source);
    expect(result.diagnostics).toEqual([]);
    expect(result.code).toContain("Uneffect postcondition failed: result >= 0");
    expect(result.code).toContain("Uneffect precondition failed: value >= 0");

    const invalid = instrumentContractPredicates("setter.ts", source.replace("requires value >= 0", "ensures result >= 0"));
    expect(invalid.diagnostics).toContainEqual(expect.objectContaining({ message: expect.stringContaining("setter postconditions") }));
  });

  it("accepts literal computed methods and rejects dynamic computed dispatch", () => {
    const source = `
      class Checks {
        /* uneffect:contract
         * ensures result >= 0
         */
        ["run"](value: number): number { return value; }
      }
    `;
    const result = instrumentContractPredicates("computed.ts", source);
    expect(result.diagnostics).toEqual([]);
    expect(result.code).toContain("Uneffect postcondition failed");
    const analysis = analyzeTypeScriptControlFlow("computed.ts", source);
    expect(analysis.functions).toContainEqual(expect.objectContaining({ name: "Checks.run", endpoint: "unreachable" }));

    const dynamic = source.replace('["run"]', "[methodName]");
    expect(instrumentContractPredicates("dynamic.ts", dynamic).diagnostics).toContainEqual(expect.objectContaining({ message: expect.stringContaining("dynamic computed") }));
    expect(analyzeTypeScriptControlFlow("dynamic.ts", `declare const methodName: unique symbol; ${dynamic}`).functions)
      .toContainEqual(expect.objectContaining({ name: "Checks.<computed>", endpoint: "unknown", diagnosticCodes: expect.arrayContaining(["uneffect-dynamic-computed-name"]) }));
  });

  it("lowers synchronous and async expression-bodied arrows", async () => {
    const source = `
      /* uneffect:contract
       * requires value >= 0
       * ensures result > value
       */
      const next = (value: number): number => value + 1;
      /* uneffect:contract
       * ensures result >= 0
       */
      const asyncNext = async (value: number): Promise<number> => Promise.resolve(value + 1);
    `;
    const result = instrumentContractPredicates("expression-arrow.ts", source);
    expect(result.diagnostics).toEqual([]);
    expect(result.code.match(/Uneffect postcondition failed/g)).toHaveLength(2);
    expect(result.code).toContain("return Promise.resolve(Promise.resolve(value + 1)).then");
    expect(analyzeTypeScriptControlFlow("expression-arrow.ts", source).functions).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "next", endpoint: "unreachable", neutralEndpoint: "unreachable" }),
      expect.objectContaining({ name: "asyncNext", endpoint: "unreachable", neutralEndpoint: "unreachable" }),
    ]));
  });

  it("resolves immutable callable alias chains to one source function identity", () => {
    const source = `
      const base = (value: number): number => value + 1;
      const first = base;
      /* uneffect:contract
       * ensures result > value
       */
      const next = first;
    `;
    const result = instrumentContractPredicates("alias.ts", source);
    expect(result.diagnostics).toEqual([]);
    expect(result.code).toContain("const base = (value: number): number => {");
    expect(result.code.match(/Uneffect postcondition failed/g)).toHaveLength(1);
    expect(analyzeTypeScriptControlFlow("alias.ts", source).functions).toContainEqual(expect.objectContaining({ name: "base", aliases: ["first", "next"] }));

    const mutable = source.replace("const first = base", "let first = base");
    expect(instrumentContractPredicates("mutable-alias.ts", mutable).diagnostics).toContainEqual(expect.objectContaining({ message: expect.stringContaining("immutable callable alias") }));
  });

  it("instruments lexically nested declarations without crossing function boundaries", () => {
    const source = `
      function outer(value: number): number {
        /* uneffect:contract
         * ensures result > value
         */
        function inner(value: number): number { return value + 1; }
        /* uneffect:contract
         * ensures result > value
         */
        const arrow = (value: number): number => value + 2;
        return inner(value) + arrow(value);
      }
    `;
    const result = instrumentContractPredicates("nested-declarations.ts", source);
    expect(result.diagnostics).toEqual([]);
    expect(result.code.match(/Uneffect postcondition failed/g)).toHaveLength(2);
    expect(analyzeTypeScriptControlFlow("nested-declarations.ts", source).functions).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "inner", endpoint: "unreachable" }),
      expect.objectContaining({ name: "arrow", endpoint: "unreachable" }),
    ]));
  });

  it("resolves nested immutable callable aliases", () => {
    const source = `
      function outer(value: number): number {
        const base = (input: number): number => input + 1;
        const first = base;
        /* uneffect:contract
         * ensures result > input
         */
        const next = first;
        return next(value);
      }
    `;
    const result = instrumentContractPredicates("nested-alias.ts", source);
    expect(result.diagnostics).toEqual([]);
    expect(result.code).toContain("Uneffect postcondition failed");
    const mutable = instrumentContractPredicates("nested-mutable-alias.ts", source.replace("const first = base", "let first = base"));
    expect(mutable.diagnostics).toContainEqual(expect.objectContaining({ message: expect.stringContaining("immutable TypeChecker-resolved callable alias") }));
  });

  it("relocates imported/re-exported and frozen-property alias contracts to their source callable", async () => {
    const result = await verifyUneffectProject({
      files: {
        "src/base.ts": `export const base = (value: number): number => value + 1;`,
        "src/barrel.ts": `export { base as nextBase } from "./base.js";`,
        "src/consumer.ts": `
          import { nextBase } from "./barrel.js";
          /* uneffect:contract
           * ensures result > value
           */
          export const next = nextBase;
        `,
        "src/registry.ts": `
          const local = (value: number): number => value + 2;
          const registry = Object.freeze({ run: local });
          /* uneffect:contract
           * ensures result > value
           */
          export const run = registry.run;
        `,
      },
      runtimeAssertions: "fallback",
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.emittedFiles["src/base.js"]).toContain("Uneffect postcondition failed");
    expect(result.emittedFiles["src/registry.js"]).toContain("Uneffect postcondition failed");
    expect(result.emittedFiles["src/consumer.js"]).not.toContain("Uneffect postcondition failed");

    const unfrozen = instrumentContractPredicates("unfrozen.ts", `
      const base = (value: number): number => value + 1;
      const registry = { run: base };
      /* uneffect:contract
       * ensures result > value
       */
      const run = registry.run;
    `);
    expect(unfrozen.diagnostics).toContainEqual(expect.objectContaining({ message: expect.stringContaining("immutable TypeChecker-resolved callable alias") }));
  });

  it("rejects incomplete switch, catch, and breaking-loop exit analysis", () => {
    const sources = [
      `function incomplete(value: number): number { switch (value) { case 0: return 0; } }`,
      `function incomplete(value: number): number { switch (value) { case 0: if (value === 0) break; return 0; default: return value; } }`,
      `function incomplete(value: number): number { try { return value; } catch { console.log(value); } }`,
      `function incomplete(): number { while (true) { break; } }`,
    ];
    for (const source of sources) {
      const result = instrumentContractPredicates("incomplete.ts", `/* uneffect:contract\n * ensures result >= 0\n */\n${source}`);
      expect(result.diagnostics).toContainEqual(expect.objectContaining({ message: expect.stringContaining("fall through") }));
      expect(result.code).not.toContain("Uneffect postcondition failed");
    }
  });

  it("keeps a broken implementation as a counterexample", async () => {
    const result = await verifyUneffectProject({ files: {
      "src/counter.ts": `/* uneffect:contract from "./counter.uneffect.ts#Increment" */\nexport function increment(value: number): number { return value }`,
      "src/counter.uneffect.ts": specification,
    } });
    expect(result.obligations).toContainEqual(expect.objectContaining({ obligation: expect.objectContaining({ functionName: "increment" }), result: "counterexample" }));
  });

  it("fails closed on block bodies and missing exports", () => {
    expect(() => parseContractDsl("bad.uneffect.ts", specification.replace("({ value }) => value >= 0", "({ value }) => { return value >= 0 }"), "Increment"))
      .toThrow(/single-expression predicate/);
    expect(() => parseContractDsl("bad.uneffect.ts", specification, "Missing")).toThrow(/does not export contract Missing/);
  });

  it("rejects an implementation signature that does not match the contract", async () => {
    await expect(verifyUneffectProject({ files: {
      "src/counter.ts": `/* uneffect:contract from "./counter.uneffect.ts#Increment" */\nexport function increment(value: boolean): number { return 1 }`,
      "src/counter.uneffect.ts": specification,
    } })).rejects.toThrow(/parameter value expects int, implementation is bool/);
  });

  it("lowers Nat refinements to both Z3 domains and optional Valibot assertions", async () => {
    const refined = `
      import { defineContract, nat } from "@mizchi/uneffect/spec";
      export const Double = defineContract({
        parameters: { value: nat() }, returns: nat(),
        ensures: ({ value, result }) => result === value,
      });
    `;
    const result = await verifyUneffectProject({
      files: {
        "src/double.ts": `import type { Nat } from "@mizchi/uneffect";\n/* uneffect:contract from "./double.uneffect.ts#Double" */\nexport function double(value: Nat): Nat { return value }`,
        "src/double.uneffect.ts": refined,
      },
      runtimeAssertions: "fallback",
    });
    expect(result.obligations).toContainEqual(expect.objectContaining({ result: "verified" }));
    expect(result.emittedFiles["src/double.js"]).toContain("safeInteger()");
    expect(result.emittedFiles["src/double.js"]).toContain("minValue(0)");
    expect(result.emittedFiles["src/double.js"]).toContain("Uneffect postcondition failed: result === value");
  }, 30_000);
});
