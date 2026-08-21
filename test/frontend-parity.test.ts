import { describe, expect, it } from "vitest";
import { compareUneffectFrontends } from "../src/frontend-parity.js";

describe("TypeScript/Corsa neutral projection parity", () => {
  it("normalizes UTF-8 trivia and reports schema drift instead of treating it as parity", async () => {
    const files = { "unicode.ts": `/* uneffect: effect FsRead<"$CWD/データ/**"> */ export function read() {}` };
    const matching = await compareUneffectFrontends({ files });
    expect(matching).toMatchObject({ equivalent: true, schemaDrift: [] });

    const drift = await compareUneffectFrontends({ files, corsaSchemaVersion: 3 });
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
