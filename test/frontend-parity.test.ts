import { describe, expect, it } from "vitest";
import { compareUneffectFrontends } from "../src/frontend-parity.js";

describe("TypeScript/Corsa neutral projection parity", () => {
  it("keeps Corsa execution bounded and reports an explicit timeout", async () => {
    const result = await compareUneffectFrontends({
      files: { "timeout.ts": `export function run() {}` },
      corsaTimeoutMs: 1,
    });
    expect(result.equivalent).toBe(false);
    expect(result.schemaDrift).toContainEqual(expect.objectContaining({
      frontend: "corsa", message: expect.stringContaining("ETIMEDOUT"),
    }));
  });

  it("normalizes UTF-8 trivia and reports schema drift instead of treating it as parity", async () => {
    const files = { "unicode.ts": `/* uneffect: effect FsRead<"$CWD/データ/**"> */ export function read() {}` };
    const matching = await compareUneffectFrontends({ files });
    expect(matching).toMatchObject({ equivalent: true, schemaDrift: [] });

    const drift = await compareUneffectFrontends({ files, corsaSchemaVersion: 7 });
    expect(drift.equivalent).toBe(false);
    expect(drift.schemaDrift[0]?.message).toContain("unsupported Corsa frontend schema");

  });

  it("compares Promise observation and rejection-ownership records", async () => {
    const result = await compareUneffectFrontends({ files: { "async.ts": `
      declare function task(): Promise<number>
      export async function run() {
        const pending = task()
        return await pending
      }
    ` } });
    expect(result.equivalent, result.schemaDrift.map((item) => item.message).join("\n")).toBe(true);
    expect(result.typescriptIr.promiseObservations).toEqual(expect.arrayContaining([
      expect.objectContaining({ owner: "run", observation: "await", catchesRejection: false }),
    ]));
    expect(result.typescriptIr.rejectionOwnership).toContainEqual(expect.objectContaining({
      owner: "run", binding: "pending", status: "observed", observations: ["await"],
    }));
  });

  it("compares resource scopes and async disposal failure routing", async () => {
    const result = await compareUneffectFrontends({ files: { "resource.ts": `
      interface Resource { [Symbol.asyncDispose](): Promise<void> }
      declare function open(): Promise<Resource>
      export async function run() {
        await using resource = await open()
        return 1
      }
    ` } });
    expect(result.equivalent, result.schemaDrift.map((item) => item.message).join("\n")).toBe(true);
    expect(result.typescriptIr.resourceScopes).toContainEqual(expect.objectContaining({
      owner: "run", binding: "resource", asynchronous: true, acquisitionIndex: 0,
    }));
    expect(result.typescriptIr.disposals).toContainEqual(expect.objectContaining({
      owner: "run", binding: "resource", asynchronous: true, failureKind: "reject", exits: expect.arrayContaining(["return"]),
    }));
  });

  it("preserves disjunctive control paths in schema v6", async () => {
    const result = await compareUneffectFrontends({ files: { "conditional.ts": `
      interface Resource { [Symbol.asyncDispose](): Promise<void> }
      declare function open(): Resource
      export async function run(enabled: boolean) {
        if (enabled) {
          await using resource = open()
          await Promise.resolve(1)
        }
      }
    ` } });
    expect(result.equivalent, result.schemaDrift.map((item) => item.message).join("\n")).toBe(true);
    expect(result.typescriptIr.schemaVersion).toBe(6);
    expect(result.typescriptIr.promiseObservations).toContainEqual(expect.objectContaining({ owner: "run", conditional: true, controlConditions: [expect.objectContaining({ expected: true })], controlPaths: [[expect.objectContaining({ expected: true })]] }));
    expect(result.typescriptIr.resourceScopes).toContainEqual(expect.objectContaining({ owner: "run", binding: "resource", conditional: true, controlConditions: [expect.objectContaining({ expected: true })], controlPaths: [[expect.objectContaining({ expected: true })]] }));
  });

  it("preserves switch fallthrough control-path disjunctions across frontends", async () => {
    const result = await compareUneffectFrontends({ files: { "switch.ts": `
      declare function note(value: string): void
      export async function run(mode: "prepare" | "run" | "ignore") {
        switch (mode) {
          case "prepare": note("prepared")
          case "run": await Promise.resolve("shared")
          default: return
        }
      }
    ` } });
    expect(result.equivalent, result.schemaDrift.map((item) => item.message).join("\n")).toBe(true);
    const shared = result.typescriptIr.promiseObservations.find((item) => item.source.includes('"shared"'))!;
    expect(shared.controlPaths).toHaveLength(2);
  });

  it("preserves nested SuppressedError payload order across frontends", async () => {
    const result = await compareUneffectFrontends({ files: { "suppressed.ts": `
      class FirstError extends Error {}
      class SecondError extends Error {}
      class First { /* uneffect: effect Throw<FirstError> */ [Symbol.dispose](): void {} }
      class Second { /* uneffect: effect Throw<SecondError> */ [Symbol.dispose](): void {} }
      export function run() { using first = new First(); using second = new Second() }
    ` } });
    expect(result.equivalent, result.schemaDrift.map((item) => item.message).join("\n")).toBe(true);
    expect(result.typescriptIr.suppressedErrors).toContainEqual({ owner: "run", payload: {
      kind: "suppressed",
      error: { kind: "error", errorType: "FirstError", source: "dispose:first" },
      suppressed: { kind: "error", errorType: "SecondError", source: "dispose:second" },
    } });
  });

  it("carries disposal protocols by symbol identity instead of escaped spelling", async () => {
    const result = await compareUneffectFrontends({ files: { "protocol.ts": `
      interface Resource { [Symbol.dispose](): void }
      declare function open(): Resource
      const disposeAlias: typeof Symbol.dispose = Symbol.dispose
      interface Aliased { [disposeAlias](): void }
      declare function openAliased(): Aliased
      const FakeSymbol = { dispose: "dispose" as const }
      interface Fake { [FakeSymbol.dispose](): void }
      declare function openFake(): Fake
      export function run() { using first = open(); using second = openAliased() }
      export function invalid() { using fake = openFake() }
    ` } });
    expect(result.equivalent).toBe(true);
    expect(result.typescriptIr.protocolSymbols).toHaveLength(2);
    const run = result.typescriptIr.resourceScopes.filter((item) => item.owner === "run");
    expect(run.map((item) => item.protocolKind)).toEqual(["sync", "sync"]);
    expect(run.every((item) => item.protocolSymbol !== null)).toBe(true);
    expect(result.typescriptIr.resourceScopes.find((item) => item.owner === "invalid")?.protocolSymbol).toBeNull();
  });

  it("compares inferred effects, call edges, and ordered call events", async () => {
    const result = await compareUneffectFrontends({ files: { "calls.ts": `
      /* uneffect: effect Console */
      export function emit() { console.log("x") }
      export function main() { emit() }
    ` } });
    expect(result.equivalent, result.schemaDrift.map((item) => item.message).join("\n")).toBe(true);
    expect(result.typescriptIr.functions).toContainEqual({ name: "main", effects: ["Console"] });
    expect(result.typescriptIr.calls).toEqual([{ caller: "main", callee: "emit", callbackTiming: "none" }]);
    expect(result.typescriptIr.orderedEvents).toEqual([expect.objectContaining({ kind: "call", caller: "main", callee: "emit" })]);
  });
});
