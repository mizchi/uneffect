import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { exportCorsaCheckerFacts } from "../src/corsa-checker-exporter.js";
import { compareUneffectFrontends } from "../src/frontend-parity.js";

describe("corsa-bind checker fact exporter", () => {
  it("exports Workhub-shaped FsRead, Fetch/Net, and FsWrite facts in source order", async () => {
    const fileName = "examples/dogfood/corsa-workhub-builtins.ts";
    const files = { [fileName]: readFileSync(fileName, "utf8") };
    const facts = await exportCorsaCheckerFacts({ files, corsaExecutable: resolve("node_modules/.bin/tsgo") });
    const synchronize = facts.symbols.find((symbol) => symbol.name === "synchronizeState")!;

    expect(synchronize.inferredEffects.map(({ effect, builtin }) => ({ effect, builtin }))).toEqual([
      { effect: "FsRead", builtin: { module: "node:fs/promises", export: "readFile" } },
      { effect: "Fetch", builtin: { module: "global", export: "fetch" } },
      { effect: "Net", builtin: { module: "global", export: "fetch" } },
      { effect: "Fetch", builtin: { module: "global", export: "fetch" } },
      { effect: "Net", builtin: { module: "global", export: "fetch" } },
      { effect: "FsWrite", builtin: { module: "node:fs/promises", export: "writeFile" } },
    ]);
    expect(synchronize.inferredEffects.map((effect) => effect.span.start)).toEqual(
      [...synchronize.inferredEffects.map((effect) => effect.span.start)].sort((left, right) => left - right),
    );
    expect(synchronize.inferredEffects[0]?.declaration).toEqual(expect.objectContaining({ fileName }));
    expect(synchronize.inferredEffects[1]?.declaration.fileName).toMatch(/lib\.(dom|webworker)\.d\.ts$/);
    expect(synchronize.inferredEffects[5]?.declaration).toEqual(expect.objectContaining({ fileName }));

    const compared = await compareUneffectFrontends({ files, corsaFacts: facts, requireCorsaCheckerFacts: true });
    expect(compared, JSON.stringify({
      schemaDrift: compared.schemaDrift,
      typescriptIr: compared.typescriptIr,
      corsaIr: compared.corsaIr,
    }, null, 2)).toMatchObject({
      equivalent: true,
      semanticEquivalent: true,
      checkerMetadataEquivalent: true,
      schemaDrift: [],
    });
    expect(compared.corsaIr?.functions).toEqual([
      { name: "synchronizeState", effects: ["Fetch", "FsRead", "FsWrite", "Net"] },
    ]);
    expect(compared.corsaIr?.promiseObservations).toEqual([
      expect.objectContaining({ owner: "synchronizeState", source: 'readFile(path, "utf8")', observation: "await", conditional: false }),
      expect.objectContaining({ owner: "synchronizeState", source: "fetch(endpoint)", observation: "await", conditional: false }),
      expect.objectContaining({ owner: "synchronizeState", source: 'fetch(endpoint, { method: "PUT", body: current })', observation: "await", conditional: false }),
      expect.objectContaining({ owner: "synchronizeState", source: "writeFile(path, await response.text())", observation: "await", conditional: false }),
      expect.objectContaining({ owner: "synchronizeState", source: "response.text()", observation: "await", conditional: false }),
    ]);
  });

  it("does not infer Workhub builtin effects from same-spelled local declarations", async () => {
    const files = {
      "fixture.ts": `
        function readFile(_path: string): string { return "" }
        function writeFile(_path: string, _body: string): void {}
        function fetch(_url: string): void {}
        export function synchronizeState(path: string, endpoint: string): void {
          const current = readFile(path)
          fetch(endpoint)
          writeFile(path, current)
        }
      `,
    };
    const facts = await exportCorsaCheckerFacts({ files, corsaExecutable: resolve("node_modules/.bin/tsgo") });
    const synchronize = facts.symbols.find((symbol) => symbol.name === "synchronizeState")!;

    expect(synchronize.inferredEffects).toEqual([]);
    const compared = await compareUneffectFrontends({ files, corsaFacts: facts, requireCorsaCheckerFacts: true });
    expect(compared.checkerMetadataEquivalent, JSON.stringify(compared.schemaDrift, null, 2)).toBe(true);
  });

  it("exports Workhub-shaped directory and append filesystem effects in source order", async () => {
    const fileName = "examples/dogfood/corsa-workhub-fs-directory.ts";
    const files = { [fileName]: readFileSync(fileName, "utf8") };
    const facts = await exportCorsaCheckerFacts({ files, corsaExecutable: resolve("node_modules/.bin/tsgo") });
    const update = facts.symbols.find((symbol) => symbol.name === "updateArchive")!;
    expect(update.inferredEffects.map(({ effect, builtin }) => ({ effect, builtin }))).toEqual([
      { effect: "FsRead", builtin: { module: "node:fs/promises", export: "access" } },
      { effect: "FsRead", builtin: { module: "node:fs/promises", export: "readdir" } },
      { effect: "FsWrite", builtin: { module: "node:fs/promises", export: "mkdir" } },
      { effect: "FsWrite", builtin: { module: "node:fs/promises", export: "appendFile" } },
    ]);
    const compared = await compareUneffectFrontends({ files, corsaFacts: facts, requireCorsaCheckerFacts: true });
    expect(compared, JSON.stringify(compared.schemaDrift, null, 2)).toMatchObject({
      equivalent: true,
      semanticEquivalent: true,
      checkerMetadataEquivalent: true,
      schemaDrift: [],
    });
    expect(compared.corsaIr?.functions).toEqual([
      { name: "updateArchive", effects: ["FsRead", "FsWrite"] },
    ]);
  });

  it("does not infer directory or append effects from same-spelled local bindings", async () => {
    const files = { "fixture.ts": `
      function access(_path: string): void {}
      function readdir(_path: string): string[] { return [] }
      function mkdir(_path: string): void {}
      function appendFile(_path: string, _value: string): void {}
      export function update(path: string): void {
        access(path); readdir(path); mkdir(path); appendFile(path, "x")
      }
    ` };
    const facts = await exportCorsaCheckerFacts({ files, corsaExecutable: resolve("node_modules/.bin/tsgo") });
    expect(facts.symbols.find((symbol) => symbol.name === "update")?.inferredEffects).toEqual([]);
    const compared = await compareUneffectFrontends({ files, corsaFacts: facts, requireCorsaCheckerFacts: true });
    expect(compared.checkerMetadataEquivalent, JSON.stringify(compared.schemaDrift, null, 2)).toBe(true);
  });

  it("does not infer node builtin effects from a same-spelled local-module import", async () => {
    const files = {
      "local.ts": `
        export function access(_path: string): void {}
        export function appendFile(_path: string, _body: string): void {}
        export function mkdir(_path: string): void {}
        export function readdir(_path: string): string[] { return [] }
        export function readFile(_path: string): string { return "" }
        export function writeFile(_path: string, _body: string): void {}
      `,
      "fixture.ts": `
        import { access, appendFile, mkdir, readdir, readFile, writeFile } from "./local.js"
        export function synchronizeState(path: string): void {
          access(path)
          appendFile(path, "x")
          mkdir(path)
          readdir(path)
          writeFile(path, readFile(path))
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

  it("rejects tampered directory and append builtin metadata", async () => {
    const fileName = "examples/dogfood/corsa-workhub-fs-directory.ts";
    const files = { [fileName]: readFileSync(fileName, "utf8") };
    const facts = await exportCorsaCheckerFacts({ files, corsaExecutable: resolve("node_modules/.bin/tsgo") });
    const tampered = structuredClone(facts);
    const update = tampered.symbols.find((symbol) => symbol.name === "updateArchive")!;
    update.inferredEffects.find((effect) => effect.builtin.export === "mkdir")!.builtin.export = "rm";
    const compared = await compareUneffectFrontends({ files, corsaFacts: tampered, requireCorsaCheckerFacts: true });
    expect(compared).toMatchObject({ equivalent: false, semanticEquivalent: true, checkerMetadataEquivalent: false });
    expect(compared.schemaDrift).toContainEqual(expect.objectContaining({
      message: expect.stringContaining("checker-backed inferred-effect evidence differs"),
    }));
  });

  it("exports a Workhub-shaped direct await under one if branch", async () => {
    const fileName = "examples/dogfood/corsa-workhub-conditional-await.ts";
    const files = { [fileName]: readFileSync(fileName, "utf8") };
    const facts = await exportCorsaCheckerFacts({ files, corsaExecutable: resolve("node_modules/.bin/tsgo") });
    expect(facts.promiseObservations).toEqual([
      expect.objectContaining({
        source: "response.text()",
        observation: "await",
        conditional: true,
        controlConditions: [expect.objectContaining({ expected: true })],
        controlPaths: [[expect.objectContaining({ expected: true })]],
      }),
    ]);

    const compared = await compareUneffectFrontends({ files, corsaFacts: facts, requireCorsaCheckerFacts: true });
    expect(compared, JSON.stringify(compared.schemaDrift, null, 2)).toMatchObject({
      equivalent: true,
      semanticEquivalent: true,
      checkerMetadataEquivalent: true,
      schemaDrift: [],
    });
  });

  it("exports Workhub-shaped direct try/catch await ownership", async () => {
    const fileName = "examples/dogfood/corsa-workhub-caught-await.ts";
    const files = { [fileName]: readFileSync(fileName, "utf8") };
    const facts = await exportCorsaCheckerFacts({ files, corsaExecutable: resolve("node_modules/.bin/tsgo") });
    expect(facts.promiseObservations).toEqual([
      expect.objectContaining({
        source: 'readFile(path, "utf8")',
        observation: "await",
        catchesRejection: true,
        conditional: false,
        controlConditions: [],
        controlPaths: [[]],
      }),
    ]);

    const compared = await compareUneffectFrontends({ files, corsaFacts: facts, requireCorsaCheckerFacts: true });
    expect(compared, JSON.stringify(compared.schemaDrift, null, 2)).toMatchObject({
      equivalent: true,
      semanticEquivalent: true,
      checkerMetadataEquivalent: true,
      schemaDrift: [],
    });
  });

  it("does not claim caught rejection ownership outside the supported protected block", async () => {
    const files = { "fixture.ts": `
      declare function operation(): Promise<void>
      export async function escapes(): Promise<void> { await operation() }
      export async function inCatch(): Promise<void> {
        try { throw new Error("failure") }
        catch { await operation() }
      }
      export async function nested(): Promise<void> {
        try { try { await operation() } catch {} } catch {}
      }
    ` };
    const facts = await exportCorsaCheckerFacts({ files, corsaExecutable: resolve("node_modules/.bin/tsgo") });
    expect(facts.promiseObservations).toEqual([
      expect.objectContaining({ source: "operation()", catchesRejection: false }),
    ]);
  });

  it("preserves one if control path inside the supported caught region", async () => {
    const files = { "fixture.ts": `
      declare function operation(): Promise<void>
      export async function maybe(flag: boolean): Promise<void> {
        try { if (flag) await operation() } catch {}
      }
    ` };
    const facts = await exportCorsaCheckerFacts({ files, corsaExecutable: resolve("node_modules/.bin/tsgo") });
    expect(facts.promiseObservations).toEqual([
      expect.objectContaining({
        source: "operation()",
        catchesRejection: true,
        conditional: true,
        controlConditions: [expect.objectContaining({ expected: true })],
      }),
    ]);
    const compared = await compareUneffectFrontends({ files, corsaFacts: facts, requireCorsaCheckerFacts: true });
    expect(compared.equivalent, JSON.stringify(compared.schemaDrift, null, 2)).toBe(true);
  });

  it("rejects tampered direct try/catch await ownership", async () => {
    const fileName = "examples/dogfood/corsa-workhub-caught-await.ts";
    const files = { [fileName]: readFileSync(fileName, "utf8") };
    const facts = await exportCorsaCheckerFacts({ files, corsaExecutable: resolve("node_modules/.bin/tsgo") });
    facts.promiseObservations[0]!.catchesRejection = false;
    const compared = await compareUneffectFrontends({ files, corsaFacts: facts, requireCorsaCheckerFacts: true });
    expect(compared).toMatchObject({ equivalent: false, semanticEquivalent: false });
    expect(compared.schemaDrift).toContainEqual(expect.objectContaining({
      message: expect.stringContaining("checker-backed Promise observation evidence differs"),
    }));
  });

  it("exports Workhub-shaped dynamic fs import and read facts", async () => {
    const fileName = "examples/dogfood/corsa-workhub-dynamic-fs-import.ts";
    const files = { [fileName]: readFileSync(fileName, "utf8") };
    const facts = await exportCorsaCheckerFacts({ files, corsaExecutable: resolve("node_modules/.bin/tsgo") });
    expect(facts.symbols.find((symbol) => symbol.name === "loadConfigText")?.inferredEffects).toEqual([
      expect.objectContaining({
        effect: "FsRead",
        builtin: { module: "node:fs/promises", export: "readFile" },
      }),
    ]);
    expect(facts.promiseObservations.map((item) => ({
      source: item.source,
      observation: item.observation,
      catchesRejection: item.catchesRejection,
    }))).toEqual([
      { source: 'import("node:fs/promises")', observation: "await", catchesRejection: false },
      { source: 'readFile(path, "utf8")', observation: "await", catchesRejection: false },
    ]);

    const compared = await compareUneffectFrontends({ files, corsaFacts: facts, requireCorsaCheckerFacts: true });
    expect(compared, JSON.stringify(compared.schemaDrift, null, 2)).toMatchObject({
      equivalent: true,
      semanticEquivalent: true,
      checkerMetadataEquivalent: true,
      schemaDrift: [],
    });
  });

  it("does not infer dynamic fs effects for unsupported binding shapes", async () => {
    const files = { "fixture.ts": `
      export async function namespaceLater(path: string): Promise<string> {
        const fs = await import("node:fs/promises")
        return fs.readFile(path, "utf8")
      }
      export async function nonLiteral(path: string, moduleName: string): Promise<string> {
        const { readFile } = await import(moduleName)
        return readFile(path, "utf8")
      }
      export async function renamed(path: string): Promise<string> {
        const { readFile: load } = await import("node:fs/promises")
        return load(path, "utf8")
      }
    ` };
    const facts = await exportCorsaCheckerFacts({ files, corsaExecutable: resolve("node_modules/.bin/tsgo") });
    expect(facts.symbols.flatMap((symbol) => symbol.inferredEffects)).toEqual([]);
  });

  it("rejects tampered dynamic fs import effect and observation evidence", async () => {
    const fileName = "examples/dogfood/corsa-workhub-dynamic-fs-import.ts";
    const files = { [fileName]: readFileSync(fileName, "utf8") };
    const original = await exportCorsaCheckerFacts({ files, corsaExecutable: resolve("node_modules/.bin/tsgo") });
    const mutations = [
      (facts: typeof original) => { facts.symbols[0]!.inferredEffects[0]!.builtin.module = "node:fs"; },
      (facts: typeof original) => { facts.symbols[0]!.inferredEffects[0]!.builtin.export = "writeFile"; },
      (facts: typeof original) => { facts.promiseObservations[0]!.source = 'import("./local.js")'; },
      (facts: typeof original) => { facts.promiseObservations[0]!.span.start += 1; },
    ];
    for (const mutate of mutations) {
      const facts = structuredClone(original);
      mutate(facts);
      const compared = await compareUneffectFrontends({ files, corsaFacts: facts, requireCorsaCheckerFacts: true });
      expect(compared.equivalent).toBe(false);
      expect(compared.schemaDrift.some((item) => item.message.includes("checker-backed"))).toBe(true);
    }
  });

  it("retains parity for the remaining Workhub awaited catch-chain shape", async () => {
    const files = { "fixture.ts": `
      export async function responseBody(response: Response): Promise<string> {
        return await response.text().catch(() => "")
      }
    ` };
    const facts = await exportCorsaCheckerFacts({ files, corsaExecutable: resolve("node_modules/.bin/tsgo") });
    expect(facts.promiseObservations).toEqual([
      expect.objectContaining({
        source: 'response.text().catch(() => "")',
        observation: "await",
        catchesRejection: false,
      }),
    ]);
    const compared = await compareUneffectFrontends({ files, corsaFacts: facts, requireCorsaCheckerFacts: true });
    expect(compared, JSON.stringify(compared.schemaDrift, null, 2)).toMatchObject({
      equivalent: true,
      semanticEquivalent: true,
      checkerMetadataEquivalent: true,
      schemaDrift: [],
    });
  });

  it("preserves opposite polarity for one direct if/else await", async () => {
    const files = { "fixture.ts": `
      export async function choose(enabled: boolean, left: Response, right: Response): Promise<string> {
        if (enabled) return await left.text()
        else return await right.text()
      }
    ` };
    const facts = await exportCorsaCheckerFacts({ files, corsaExecutable: resolve("node_modules/.bin/tsgo") });
    expect(facts.promiseObservations.map((item) => ({ source: item.source, conditions: item.controlConditions }))).toEqual([
      { source: "left.text()", conditions: [expect.objectContaining({ expected: true })] },
      { source: "right.text()", conditions: [expect.objectContaining({ expected: false })] },
    ]);
    expect(facts.promiseObservations[0]?.controlConditions[0]?.id)
      .toBe(facts.promiseObservations[1]?.controlConditions[0]?.id);
    const compared = await compareUneffectFrontends({ files, corsaFacts: facts, requireCorsaCheckerFacts: true });
    expect(compared.equivalent, JSON.stringify(compared.schemaDrift, null, 2)).toBe(true);
  });

  it("keeps nested and loop conditional awaits outside the single-if fragment", async () => {
    for (const source of [
      `export async function nested(a: boolean, b: boolean, response: Response) { if (a) { if (b) await response.text() } }`,
      `export async function loop(enabled: boolean, response: Response) { while (enabled) await response.text() }`,
    ]) {
      const facts = await exportCorsaCheckerFacts({ files: { "fixture.ts": source }, corsaExecutable: resolve("node_modules/.bin/tsgo") });
      expect(facts.promiseObservations).toEqual([]);
      const compared = await compareUneffectFrontends({
        files: { "fixture.ts": source }, corsaFacts: facts, requireCorsaCheckerFacts: true,
      });
      expect(compared).toMatchObject({ equivalent: false, checkerMetadataEquivalent: false });
      expect(compared.schemaDrift).toContainEqual(expect.objectContaining({
        message: expect.stringContaining("checker-backed Promise observation evidence differs"),
      }));
    }
  });

  it("rejects tampered single-if condition identity, polarity, and path evidence", async () => {
    const fileName = "examples/dogfood/corsa-workhub-conditional-await.ts";
    const files = { [fileName]: readFileSync(fileName, "utf8") };
    const facts = await exportCorsaCheckerFacts({ files, corsaExecutable: resolve("node_modules/.bin/tsgo") });
    const mutations = [
      (tampered: typeof facts) => { tampered.promiseObservations[0]!.controlConditions[0]!.id += ":forged"; },
      (tampered: typeof facts) => { tampered.promiseObservations[0]!.controlConditions[0]!.expected = false; },
      (tampered: typeof facts) => { tampered.promiseObservations[0]!.controlPaths = [[]]; },
    ];
    for (const mutate of mutations) {
      const tampered = structuredClone(facts);
      mutate(tampered);
      const compared = await compareUneffectFrontends({ files, corsaFacts: tampered, requireCorsaCheckerFacts: true });
      expect(compared).toMatchObject({ equivalent: false, checkerMetadataEquivalent: false });
      expect(compared.schemaDrift).toContainEqual(expect.objectContaining({
        message: expect.stringContaining("checker-backed Promise observation evidence differs"),
      }));
    }
  });

  it("keeps same-named cross-file conditions owner-scoped while spans remain project-wide", async () => {
    const files = {
      "a.ts": `export async function load(enabled: boolean, response: Response) { if (enabled) await response.text() }`,
      "b.ts": `export async function load(enabled: boolean, response: Response) { if (enabled) await response.text() }`,
    };
    const facts = await exportCorsaCheckerFacts({ files, corsaExecutable: resolve("node_modules/.bin/tsgo") });
    const compared = await compareUneffectFrontends({ files, corsaFacts: facts, requireCorsaCheckerFacts: true });
    expect(compared.equivalent, JSON.stringify(compared.schemaDrift, null, 2)).toBe(true);
    expect(facts.promiseObservations.map((item) => item.controlConditions[0]?.id)).toEqual([
      "load@if:67",
      "load@if:67",
    ]);
    expect(facts.promiseObservations[1]!.span.start).toBeGreaterThan(Buffer.byteLength(files["a.ts"]));
  });

  it("exports Workhub-shaped direct Promise return observations", async () => {
    const fileName = "examples/dogfood/corsa-workhub-promise-returns.ts";
    const files = { [fileName]: readFileSync(fileName, "utf8") };
    const facts = await exportCorsaCheckerFacts({ files, corsaExecutable: resolve("node_modules/.bin/tsgo") });
    expect(facts.promiseObservations.map((item) => ({
      source: item.source,
      observation: item.observation,
      conditional: item.conditional,
      paths: item.controlPaths,
    }))).toEqual([
      { source: "response.arrayBuffer()", observation: "return", conditional: false, paths: [[]] },
      { source: "response.json() as Promise<T>", observation: "return", conditional: false, paths: [[]] },
    ]);
    const compared = await compareUneffectFrontends({ files, corsaFacts: facts, requireCorsaCheckerFacts: true });
    expect(compared, JSON.stringify(compared.schemaDrift, null, 2)).toMatchObject({
      equivalent: true,
      semanticEquivalent: true,
      checkerMetadataEquivalent: true,
      schemaDrift: [],
    });
  });

  it("keeps conditional and non-call Promise returns outside the direct-return fragment", async () => {
    for (const source of [
      `export function choose(enabled: boolean, response: Response): Promise<unknown> { if (enabled) return response.json(); throw new Error("disabled") }`,
      `export function identity(value: Promise<unknown>): Promise<unknown> { return value }`,
      `export function nested(response: Response): Promise<unknown> { return response.json() as unknown as Promise<unknown> }`,
    ]) {
      const files = { "fixture.ts": source };
      const facts = await exportCorsaCheckerFacts({ files, corsaExecutable: resolve("node_modules/.bin/tsgo") });
      expect(facts.promiseObservations).toEqual([]);
      const compared = await compareUneffectFrontends({ files, corsaFacts: facts, requireCorsaCheckerFacts: true });
      expect(compared).toMatchObject({ equivalent: false, checkerMetadataEquivalent: false });
    }
  });

  it("rejects tampered direct-return source, span, owner, and observation evidence", async () => {
    const fileName = "examples/dogfood/corsa-workhub-promise-returns.ts";
    const files = { [fileName]: readFileSync(fileName, "utf8") };
    const facts = await exportCorsaCheckerFacts({ files, corsaExecutable: resolve("node_modules/.bin/tsgo") });
    const mutations = [
      (tampered: typeof facts) => { tampered.promiseObservations[0]!.source = "response.text()"; },
      (tampered: typeof facts) => { tampered.promiseObservations[0]!.span.end -= 1; },
      (tampered: typeof facts) => { tampered.promiseObservations[0]!.owner = 999; },
      (tampered: typeof facts) => { tampered.promiseObservations[0]!.observation = "await"; },
    ];
    for (const mutate of mutations) {
      const tampered = structuredClone(facts);
      mutate(tampered);
      const compared = await compareUneffectFrontends({ files, corsaFacts: tampered, requireCorsaCheckerFacts: true });
      expect(compared).toMatchObject({ equivalent: false, checkerMetadataEquivalent: false });
      expect(compared.schemaDrift).toContainEqual(expect.objectContaining({
        message: expect.stringContaining("checker-backed Promise observation evidence differs"),
      }));
    }
  });

  it("does not attribute a nested callback await to its outer function", async () => {
    const files = {
      "fixture.ts": `
        export async function loadAll(urls: string[]): Promise<void> {
          urls.map(async (url) => { await fetch(url) })
          await fetch("https://example.com/done")
        }
      `,
    };
    const facts = await exportCorsaCheckerFacts({ files, corsaExecutable: resolve("node_modules/.bin/tsgo") });
    expect(facts.promiseObservations).toEqual([
      expect.objectContaining({ source: 'fetch("https://example.com/done")' }),
    ]);

    const compared = await compareUneffectFrontends({ files, corsaFacts: facts, requireCorsaCheckerFacts: true });
    expect(compared.checkerMetadataEquivalent, JSON.stringify(compared.schemaDrift, null, 2)).toBe(true);
  });

  it("rejects tampered direct-await source, span, and owner metadata", async () => {
    const fileName = "examples/dogfood/corsa-workhub-builtins.ts";
    const files = { [fileName]: readFileSync(fileName, "utf8") };
    const facts = await exportCorsaCheckerFacts({ files, corsaExecutable: resolve("node_modules/.bin/tsgo") });
    const mutations = [
      (tampered: typeof facts) => { tampered.promiseObservations[0]!.source = "readFile(otherPath)"; },
      (tampered: typeof facts) => { tampered.promiseObservations[0]!.span.start += 1; },
      (tampered: typeof facts) => { tampered.promiseObservations[0]!.owner = 999; },
    ];
    for (const mutate of mutations) {
      const tampered = structuredClone(facts);
      mutate(tampered);
      const compared = await compareUneffectFrontends({ files, corsaFacts: tampered, requireCorsaCheckerFacts: true });
      expect(compared).toMatchObject({ equivalent: false, checkerMetadataEquivalent: false });
      expect(compared.schemaDrift).toContainEqual(expect.objectContaining({
        message: expect.stringContaining("checker-backed Promise observation evidence differs"),
      }));
    }
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
      /* uneffect:effect Console */
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
      trivia: [expect.objectContaining({ text: expect.stringContaining("uneffect:effect Console") })],
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
      "a.ts": `/* uneffect:effect Console */ export function emit(message: string): void { console.log(message) }`,
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
      "a.ts": `/* uneffect:effect Console */ export function run() { console.log("a") }`,
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
      "a.ts": `/* uneffect:effect Console */ export const emit = (message: string): void => { console.log(message) }`,
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
        /* uneffect:effect Console */
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
          /* uneffect:effect Console */
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
          /* uneffect:effect Console */
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
        /* uneffect:effect Console */
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
