import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { exportCorsaCheckerFacts } from "../src/corsa-checker-exporter.js";
import { compareUneffectFrontends } from "../src/frontend-parity.js";

describe("corsa-bind checker fact exporter", () => {
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
      schemaVersion: 7,
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
      equivalent: false,
      semanticEquivalent: false,
      provenance: { satisfiesRequirement: true },
    });
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
});
