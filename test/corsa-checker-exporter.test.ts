import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { exportCorsaCheckerFacts } from "../src/corsa-checker-exporter.js";
import { compareUneffectFrontends } from "../src/frontend-parity.js";

describe("corsa-bind checker fact exporter", () => {
  it("exports Workhub-shaped FsRead, Fetch, and FsWrite facts in source order", async () => {
    const fileName = "examples/dogfood/corsa-workhub-builtins.ts";
    const files = { [fileName]: readFileSync(fileName, "utf8") };
    const facts = await exportCorsaCheckerFacts({ files, corsaExecutable: resolve("node_modules/.bin/tsgo") });
    const synchronize = facts.symbols.find((symbol) => symbol.name === "synchronizeState")!;

    expect(synchronize.inferredEffects.map(({ effect, builtin }) => ({ effect, builtin }))).toEqual([
      { effect: "FsRead", builtin: { module: "node:fs/promises", export: "readFile" } },
      { effect: "Fetch", builtin: { module: "global", export: "fetch" } },
      { effect: "Fetch", builtin: { module: "global", export: "fetch" } },
      { effect: "FsWrite", builtin: { module: "node:fs/promises", export: "writeFile" } },
    ]);
    expect(synchronize.inferredEffects.map((effect) => effect.span.start)).toEqual(
      [...synchronize.inferredEffects.map((effect) => effect.span.start)].sort((left, right) => left - right),
    );
    expect(synchronize.inferredEffects[0]?.declaration).toEqual(expect.objectContaining({ fileName }));
    expect(synchronize.inferredEffects[1]?.declaration.fileName).toMatch(/lib\.(dom|webworker)\.d\.ts$/);
    expect(synchronize.inferredEffects[3]?.declaration).toEqual(expect.objectContaining({ fileName }));

    const compared = await compareUneffectFrontends({ files, corsaFacts: facts, requireCorsaCheckerFacts: true });
    expect(compared, JSON.stringify({
      schemaDrift: compared.schemaDrift,
      typescriptIr: compared.typescriptIr,
      corsaIr: compared.corsaIr,
    }, null, 2)).toMatchObject({
      equivalent: false,
      semanticEquivalent: false,
      checkerMetadataEquivalent: true,
      schemaDrift: [],
    });
    expect(compared.corsaIr?.functions).toEqual([
      { name: "synchronizeState", effects: ["Fetch", "FsRead", "FsWrite"] },
    ]);
  });

  it("does not infer Workhub builtin effects from same-spelled local declarations", async () => {
    const files = {
      "fixture.ts": `
        function readFile(_path: string): Promise<string> { return Promise.resolve("") }
        function writeFile(_path: string, _body: string): Promise<void> { return Promise.resolve() }
        function fetch(_url: string): Promise<string> { return Promise.resolve("") }
        export async function synchronizeState(path: string, endpoint: string): Promise<void> {
          const current = await readFile(path)
          await fetch(endpoint)
          await writeFile(path, current)
        }
      `,
    };
    const facts = await exportCorsaCheckerFacts({ files, corsaExecutable: resolve("node_modules/.bin/tsgo") });
    const synchronize = facts.symbols.find((symbol) => symbol.name === "synchronizeState")!;

    expect(synchronize.inferredEffects).toEqual([]);
    const compared = await compareUneffectFrontends({ files, corsaFacts: facts, requireCorsaCheckerFacts: true });
    expect(compared.checkerMetadataEquivalent, JSON.stringify(compared.schemaDrift, null, 2)).toBe(true);
  });

  it("does not infer node builtin effects from a same-spelled local-module import", async () => {
    const files = {
      "local.ts": `
        export function readFile(_path: string): Promise<string> { return Promise.resolve("") }
        export function writeFile(_path: string, _body: string): Promise<void> { return Promise.resolve() }
      `,
      "fixture.ts": `
        import { readFile, writeFile } from "./local.js"
        export async function synchronizeState(path: string): Promise<void> {
          await writeFile(path, await readFile(path))
        }
      `,
    };
    const facts = await exportCorsaCheckerFacts({ files, corsaExecutable: resolve("node_modules/.bin/tsgo") });
    const synchronize = facts.symbols.find((symbol) => symbol.name === "synchronizeState")!;

    expect(synchronize.inferredEffects).toEqual([]);
    const compared = await compareUneffectFrontends({ files, corsaFacts: facts, requireCorsaCheckerFacts: true });
    expect(compared.checkerMetadataEquivalent, JSON.stringify(compared.schemaDrift, null, 2)).toBe(true);
  });

  it("rejects tampered Workhub builtin metadata while retaining semantic effects", async () => {
    const fileName = "examples/dogfood/corsa-workhub-builtins.ts";
    const files = { [fileName]: readFileSync(fileName, "utf8") };
    const facts = await exportCorsaCheckerFacts({ files, corsaExecutable: resolve("node_modules/.bin/tsgo") });
    const tampered = structuredClone(facts);
    const synchronize = tampered.symbols.find((symbol) => symbol.name === "synchronizeState")!;
    synchronize.inferredEffects.find((effect) => effect.effect === "FsRead")!.builtin.export = "readFileSync";

    const compared = await compareUneffectFrontends({ files, corsaFacts: tampered, requireCorsaCheckerFacts: true });
    expect(compared).toMatchObject({
      equivalent: false,
      checkerMetadataEquivalent: false,
    });
    expect(compared.schemaDrift).toContainEqual(expect.objectContaining({
      message: expect.stringContaining("checker-backed inferred-effect evidence differs"),
    }));
  });

  it("exports one checker-inferred builtin effect and preserves its ordered local call", async () => {
    const files = {
      "fixture.ts": `
        export function emit(message: string): void { console.log(message) }
        export function main(): void { emit("first"); emit("second") }
      `,
    };
    const facts = await exportCorsaCheckerFacts({ files, corsaExecutable: resolve("node_modules/.bin/tsgo") });
    const emit = facts.symbols.find((symbol) => symbol.name === "emit") as any;

    expect(emit.inferredEffects).toEqual([
      expect.objectContaining({
        effect: "Console",
        builtin: { module: "global", export: "console.log" },
        symbolIdentity: expect.any(String),
        declaration: expect.objectContaining({ fileName: expect.stringMatching(/lib\.(dom|webworker)\.d\.ts$/) }),
        span: expect.objectContaining({ start: expect.any(Number), end: expect.any(Number) }),
      }),
    ]);

    const compared = await compareUneffectFrontends({ files, corsaFacts: facts, requireCorsaCheckerFacts: true });
    expect(compared.equivalent, JSON.stringify({ schemaDrift: compared.schemaDrift, facts }, null, 2)).toBe(true);
    expect(compared.corsaIr?.functions).toEqual([
      { name: "emit", effects: ["Console"] },
      { name: "main", effects: ["Console"] },
    ]);
    expect(compared.corsaIr?.orderedEvents).toEqual([
      expect.objectContaining({ kind: "call", caller: "main", callee: "emit" }),
      expect.objectContaining({ kind: "call", caller: "main", callee: "emit" }),
    ]);
    expect(compared.corsaIr!.orderedEvents[0]!.start).toBeLessThan(compared.corsaIr!.orderedEvents[1]!.start);

    emit.inferredEffects[0]!.builtin.export = "console.info";
    const drifted = await compareUneffectFrontends({ files, corsaFacts: facts, requireCorsaCheckerFacts: true });
    expect(drifted).toMatchObject({ equivalent: false, semanticEquivalent: true });
    expect(drifted.schemaDrift).toContainEqual(expect.objectContaining({
      message: expect.stringContaining("inferred-effect evidence differs"),
    }));
  });

  it("does not infer Console from a same-spelled symbol-distinct lookalike", async () => {
    const files = {
      "fixture.ts": `
        const console = { log(_message: string): void {} };
        export function emit(message: string): void { console.log(message) }
        export function main(): void { emit("x") }
      `,
    };
    const facts = await exportCorsaCheckerFacts({ files, corsaExecutable: resolve("node_modules/.bin/tsgo") });
    const emit = facts.symbols.find((symbol) => symbol.name === "emit") as any;

    expect(emit.inferredEffects).toEqual([]);
    const compared = await compareUneffectFrontends({ files, corsaFacts: facts, requireCorsaCheckerFacts: true });
    expect(compared.equivalent, JSON.stringify({ schemaDrift: compared.schemaDrift, facts }, null, 2)).toBe(true);
    expect(compared.corsaIr?.functions).toEqual([
      { name: "emit", effects: [] },
      { name: "main", effects: [] },
    ]);
  });

  it("exports checker-backed functions, trivia, and resolved call edges", async () => {
    const files = { "fixture.ts": `
      /* uneffect: effect Console */
      export function emit(message: string): void { console.log(message) }
      export function main() { emit("x") }
    ` };
    const facts = await exportCorsaCheckerFacts({
      files,
      corsaExecutable: resolve("node_modules/.bin/tsgo"),
    });

    expect(facts).toMatchObject({
      schemaVersion: 8,
      provenance: { producer: "corsa-checker", checkerBacked: true },
      symbols: expect.arrayContaining([
        expect.objectContaining({ name: "emit", typeRepr: "(message: string) => void" }),
        expect.objectContaining({ name: "main", typeRepr: expect.any(String) }),
      ]),
      calls: [expect.objectContaining({ callbackTiming: "none" })],
      trivia: [expect.objectContaining({ text: expect.stringContaining("uneffect: effect Console") })],
    });

    const compared = await compareUneffectFrontends({
      files,
      corsaFacts: facts,
      requireCorsaCheckerFacts: true,
    });
    expect(compared.equivalent, JSON.stringify({
      schemaDrift: compared.schemaDrift,
      typescriptIr: compared.typescriptIr,
      corsaIr: compared.corsaIr,
    }, null, 2)).toBe(true);
    expect(compared.provenance).toMatchObject({
      producer: "corsa-checker",
      checkerBacked: true,
      satisfiesRequirement: true,
    });

    const forged = structuredClone(facts);
    const forgedComparison = await compareUneffectFrontends({
      files,
      corsaFacts: forged,
      requireCorsaCheckerFacts: true,
    });
    expect(forgedComparison).toMatchObject({
      equivalent: false,
      semanticEquivalent: true,
      provenance: { producer: "corsa-checker", checkerBacked: true, satisfiesRequirement: false },
    });
    expect(forgedComparison.schemaDrift).toContainEqual(expect.objectContaining({
      message: expect.stringContaining("not authenticated"),
    }));
  });

  it("fails closed instead of labeling unsupported or unavailable input as checker-backed", async () => {
    await expect(exportCorsaCheckerFacts({
      files: { "a.ts": "export function a() {}" },
      corsaExecutable: resolve("node_modules/.bin/does-not-exist"),
    })).rejects.toThrow("corsa-oxlint fact export failed");
  });

  it("preserves cross-file Corsa symbol identity in deterministic project byte coordinates", async () => {
    const files = {
      "b.ts": `import { emit } from "./a.js"; export function main() { emit("x") }`,
      "a.ts": `/* uneffect: effect Console */ export function emit(message: string): void { console.log(message) }`,
    };
    const facts = await exportCorsaCheckerFacts({
      files,
      corsaExecutable: resolve("node_modules/.bin/tsgo"),
    });
    expect(facts.symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "emit" }),
      expect.objectContaining({ name: "main" }),
    ]));
    expect(facts.calls).toHaveLength(1);
    const call = facts.calls[0] as { span: { start: number; end: number } };
    expect(call.span.start).toBeGreaterThan(Buffer.byteLength(files["a.ts"]));

    const compared = await compareUneffectFrontends({
      files,
      corsaFacts: facts,
      requireCorsaCheckerFacts: true,
    });
    expect(compared.equivalent, JSON.stringify({
      schemaDrift: compared.schemaDrift,
      typescriptIr: compared.typescriptIr,
      corsaIr: compared.corsaIr,
    }, null, 2)).toBe(true);
    expect(compared.typescriptIr.functions).toContainEqual({ name: "main", effects: ["Console"] });
    expect(compared.typescriptIr.calls).toEqual([{ caller: "main", callee: "emit", callbackTiming: "none" }]);
  });

  it("qualifies duplicate function names so cross-file edges cannot alias by spelling", async () => {
    const files = {
      "a.ts": `/* uneffect: effect Console */ export function run() { console.log("a") }`,
      "b.ts": `import { run as dependencyRun } from "./a.js"; export function run() { dependencyRun() }`,
    };
    const facts = await exportCorsaCheckerFacts({ files, corsaExecutable: resolve("node_modules/.bin/tsgo") });
    const compared = await compareUneffectFrontends({
      files,
      corsaFacts: facts,
      requireCorsaCheckerFacts: true,
    });
    expect(compared.equivalent, JSON.stringify({
      typescriptIr: compared.typescriptIr,
      corsaIr: compared.corsaIr,
    }, null, 2)).toBe(true);
    expect(compared.typescriptIr.functions).toEqual([
      { name: "a.ts::run", effects: ["Console"] },
      { name: "b.ts::run", effects: ["Console"] },
    ]);
    expect(compared.typescriptIr.calls).toEqual([
      { caller: "b.ts::run", callee: "a.ts::run", callbackTiming: "none" },
    ]);
  });

  it("exports checker-backed top-level const arrows and function expressions across imports", async () => {
    const files = {
      "a.ts": `/* uneffect: effect Console */ export const emit = (message: string): void => { console.log(message) }`,
      "b.ts": `import { emit } from "./a.js"; export const main = function () { emit("x") }`,
    };
    const facts = await exportCorsaCheckerFacts({ files, corsaExecutable: resolve("node_modules/.bin/tsgo") });
    const compared = await compareUneffectFrontends({
      files,
      corsaFacts: facts,
      requireCorsaCheckerFacts: true,
    });

    expect(compared.equivalent, JSON.stringify({
      schemaDrift: compared.schemaDrift,
      typescriptIr: compared.typescriptIr,
      corsaIr: compared.corsaIr,
    }, null, 2)).toBe(true);
    expect(compared.typescriptIr.functions).toEqual([
      { name: "emit", effects: ["Console"] },
      { name: "main", effects: ["Console"] },
    ]);
    expect(compared.typescriptIr.calls).toEqual([
      { caller: "main", callee: "emit", callbackTiming: "none" },
    ]);
  });

  it("does not mislabel calls inside unsupported callbacks as immediate outer calls", async () => {
    const files = {
      "fixture.ts": `
        /* uneffect: effect Console */
        function emit() { console.log("x") }
        export function main() { [1].forEach(() => emit()) }
      `,
    };
    const facts = await exportCorsaCheckerFacts({ files, corsaExecutable: resolve("node_modules/.bin/tsgo") });

    expect(facts.symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "emit" }),
      expect.objectContaining({ name: "main" }),
    ]));
    expect(facts.symbols).toHaveLength(2);
    expect(facts.calls).toHaveLength(0);

    const compared = await compareUneffectFrontends({ files, corsaFacts: facts, requireCorsaCheckerFacts: true });
    expect(compared).toMatchObject({
      equivalent: true,
      semanticEquivalent: true,
      provenance: { satisfiesRequirement: true },
    });
    expect(compared.corsaIr?.calls).toHaveLength(0);
  });

  it("exports checker-backed class methods and cross-file direct method calls", async () => {
    const files = {
      "a.ts": `
        export class Logger {
          /* uneffect: effect Console */
          emit(message: string): void { console.log(message) }
        }
      `,
      "b.ts": `
        import { Logger } from "./a.js";
        export function main(logger: Logger) { logger.emit("x") }
      `,
    };
    const facts = await exportCorsaCheckerFacts({ files, corsaExecutable: resolve("node_modules/.bin/tsgo") });
    const compared = await compareUneffectFrontends({ files, corsaFacts: facts, requireCorsaCheckerFacts: true });

    expect(compared.equivalent, JSON.stringify({
      schemaDrift: compared.schemaDrift,
      typescriptIr: compared.typescriptIr,
      corsaIr: compared.corsaIr,
    }, null, 2)).toBe(true);
    expect(compared.typescriptIr.functions).toEqual([
      { name: "Logger.emit", effects: ["Console"] },
      { name: "main", effects: ["Console"] },
    ]);
    expect(compared.typescriptIr.calls).toEqual([
      { caller: "main", callee: "Logger.emit", callbackTiming: "none" },
    ]);
  });

  it("fails closed when an explicitly annotated computed method is outside checker coverage", async () => {
    const files = {
      "fixture.ts": `
        const key = "emit" as const;
        class Logger {
          /* uneffect: effect Console */
          [key]() { console.log("x") }
        }
        export function main(logger: Logger) { logger[key]() }
      `,
    };
    const facts = await exportCorsaCheckerFacts({ files, corsaExecutable: resolve("node_modules/.bin/tsgo") });
    const compared = await compareUneffectFrontends({ files, corsaFacts: facts, requireCorsaCheckerFacts: true });

    expect(compared).toMatchObject({
      equivalent: false,
      semanticEquivalent: true,
      provenance: { satisfiesRequirement: true },
    });
    expect(compared.schemaDrift).toContainEqual(expect.objectContaining({
      message: expect.stringContaining("annotated computed method"),
    }));
  });

  it("exports checker-backed overload candidates and the selected call signature", async () => {
    const files = {
      "fixture.ts": `
        /* uneffect: effect Console */
        export function parse(value: string): string;
        export function parse(value: number): number;
        export function parse(value: string | number): string | number {
          console.log(value);
          return value;
        }
        export function main() { return parse("x") }
      `,
    };
    const facts = await exportCorsaCheckerFacts({ files, corsaExecutable: resolve("node_modules/.bin/tsgo") });
    const parse = facts.symbols.find((symbol) => symbol.name === "parse")!;
    const call = facts.calls[0]!;

    expect(parse.overloads).toHaveLength(2);
    expect(call.overloadIndex, JSON.stringify(parse.overloads)).toBe(0);
    const compared = await compareUneffectFrontends({ files, corsaFacts: facts, requireCorsaCheckerFacts: true });
    expect(compared.equivalent, JSON.stringify({ schemaDrift: compared.schemaDrift, facts }, null, 2)).toBe(true);

    call.overloadIndex = 1;
    const mismatched = await compareUneffectFrontends({ files, corsaFacts: facts, requireCorsaCheckerFacts: true });
    expect(mismatched).toMatchObject({ equivalent: false, semanticEquivalent: true });
    expect(mismatched.schemaDrift).toContainEqual(expect.objectContaining({
      message: expect.stringContaining("selected overload differs"),
    }));
  });
});
