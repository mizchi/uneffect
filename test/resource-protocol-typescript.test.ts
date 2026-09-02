import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { evaluateResourceProtocolCfg, type ResourceProtocolModel } from "../src/resource-protocol.js";
import { analyzeCallableSummaries } from "../src/callable-summary.js";
import { analyzeResourceCallableSummaries, collectResourceCallableTransitionSites } from "../src/resource-callable-typescript.js";
import { collectBuiltinResourceTransitionSites, collectCallableExceptionalTransitionSites, lowerResourceProtocolCfgInFunction, type ResourceTransitionSite } from "../src/resource-protocol-typescript.js";
import type { ExternalFunctionEffectContract } from "../src/effects.js";

function fixture(text: string): { source: ts.SourceFile; fn: ts.FunctionDeclaration; sites: ResourceTransitionSite[] } {
  const source = ts.createSourceFile("/entry.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const fn = source.statements.find(ts.isFunctionDeclaration)!;
  const sites: ResourceTransitionSite[] = [];
  const visit = (node: ts.Node): void => {
    if (node !== fn && ts.isFunctionLike(node)) return;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "consume") {
      sites.push({ node, transitions: [{ kind: "consume", resource: "body", at: node.getStart(source) }] });
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "risky") {
      sites.push({ node, transitions: [], exceptionalCompletion: "throw" });
    }
    ts.forEachChild(node, visit);
  };
  visit(fn);
  return { source, fn, sites };
}

const model: ResourceProtocolModel = {
  schema: "uneffect-resource-protocol/v1",
  resources: [{ id: "body", label: "body", kind: "Body", initialState: "available", requiredTerminalStates: ["consumed"] }],
  transitions: [],
};

describe("TypeScript resource protocol CFG lowering", () => {
  it("lowers generic builtin stream acquire/release semantics without API-specific CFG logic", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-builtin-resource-"));
    try {
      const fileName = join(directory, "entry.ts");
      writeFileSync(fileName, `
        function read(stream: ReadableStream<Uint8Array>) {
          const reader = stream.getReader()
          const alias = reader
          alias.releaseLock()
        }
      `);
      const program = ts.createProgram([fileName], { target: ts.ScriptTarget.ESNext, lib: ["lib.esnext.d.ts", "lib.dom.d.ts"], noEmit: true });
      const source = program.getSourceFile(fileName)!;
      const fn = source.statements.find(ts.isFunctionDeclaration)!;
      const collected = collectBuiltinResourceTransitionSites(program, fn);
      expect(collected.resources).toEqual([expect.objectContaining({ label: "reader", kind: "stream-reader", initialState: "absent" })]);
      expect(collected.sites.flatMap((site) => site.transitions)).toMatchObject([
        { kind: "acquire", evidence: "trusted" },
        { kind: "release", evidence: "trusted" },
      ]);
      const lowered = lowerResourceProtocolCfgInFunction(source, fn, {
        schema: "uneffect-resource-protocol/v1", resources: collected.resources, transitions: [],
      }, collected.sites);
      expect(lowered.status).toBe("exact");
      if (lowered.status === "exact") expect(evaluateResourceProtocolCfg(lowered.cfg).status).toBe("satisfied");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it("lowers catalog-driven constructor/use/release semantics for WebSocket aliases", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-websocket-resource-"));
    try {
      const fileName = join(directory, "entry.ts");
      writeFileSync(fileName, `
        function exchange() {
          const socket = new WebSocket("wss://stream.example.com/events")
          const alias = socket
          alias.send("ping")
          alias.close()
        }
        function invalid() {
          const socket = new WebSocket("wss://stream.example.com/events")
          socket.close()
          socket.send("too-late")
        }
      `);
      const program = ts.createProgram([fileName], { target: ts.ScriptTarget.ESNext, lib: ["lib.esnext.d.ts", "lib.dom.d.ts"], noEmit: true });
      const source = program.getSourceFile(fileName)!;
      const fn = source.statements.find(ts.isFunctionDeclaration)!;
      const collected = collectBuiltinResourceTransitionSites(program, fn);
      expect(collected.unknown).toEqual([]);
      expect(collected.resources).toEqual([expect.objectContaining({ label: "socket", kind: "websocket", initialState: "absent" })]);
      expect(collected.sites.flatMap((site) => site.transitions)).toMatchObject([
        { kind: "acquire", evidence: "trusted" },
        { kind: "use", evidence: "trusted" },
        { kind: "release", evidence: "trusted" },
      ]);
      const lowered = lowerResourceProtocolCfgInFunction(source, fn, {
        schema: "uneffect-resource-protocol/v1", resources: collected.resources, transitions: [],
      }, collected.sites);
      expect(lowered.status).toBe("exact");
      if (lowered.status === "exact") expect(evaluateResourceProtocolCfg(lowered.cfg).status).toBe("satisfied");
      const invalid = source.statements.filter(ts.isFunctionDeclaration).find((candidate) => candidate.name?.text === "invalid")!;
      const invalidCollected = collectBuiltinResourceTransitionSites(program, invalid);
      const invalidLowered = lowerResourceProtocolCfgInFunction(source, invalid, {
        schema: "uneffect-resource-protocol/v1", resources: invalidCollected.resources, transitions: [],
      }, invalidCollected.sites);
      expect(invalidLowered.status).toBe("exact");
      if (invalidLowered.status === "exact") expect(evaluateResourceProtocolCfg(invalidLowered.cfg)).toMatchObject({
        status: "unknown", diagnostics: [expect.objectContaining({ code: "invalid-transition", transition: "use", state: "released" })],
      });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it("extracts and instantiates declared resource boundaries by symbol identity", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-resource-boundary-"));
    try {
      const fileName = join(directory, "entry.ts");
      writeFileSync(fileName, `
        /* uneffect:
          borrow input
          consume body
          transfer port -> return
          escape callback
        */
        function boundary(input: object, body: object, port: object, callback: object): object { return port }
        function main(input: object, body: object, port: object, callback: object) {
          const returned = boundary(input, body, port, callback)
          return returned
        }
        function shadow(input: object) {
          const boundary = (value: object) => value
          return boundary(input)
        }
      `);
      const program = ts.createProgram([fileName], { target: ts.ScriptTarget.ES2024, noEmit: true });
      const source = program.getSourceFile(fileName)!;
      const analysis = analyzeResourceCallableSummaries(program);
      expect(analysis.diagnostics).toEqual([]);
      expect(analysis.summaries).toMatchObject([{
        evidence: "trusted",
        operations: [
          { kind: "borrow", subject: { kind: "parameter", index: 0, name: "input" } },
          { kind: "consume", subject: { kind: "parameter", index: 1, name: "body" } },
          { kind: "transfer", subject: { kind: "parameter", index: 2, name: "port" }, target: { kind: "return" } },
          { kind: "escape", subject: { kind: "parameter", index: 3, name: "callback" } },
        ],
      }]);
      const functions = new Map(source.statements.filter(ts.isFunctionDeclaration).map((fn) => [fn.name!.text, fn]));
      const instantiated = collectResourceCallableTransitionSites(program, functions.get("main")!, analysis.summaries);
      expect(instantiated.diagnostics).toEqual([]);
      expect(instantiated.sites).toHaveLength(1);
      expect(instantiated.sites[0]!.transitions.map(({ kind, evidence }) => [kind, evidence])).toEqual([
        ["use", "trusted"], ["consume", "trusted"], ["transfer", "trusted"], ["escape", "trusted"],
      ]);
      expect(collectResourceCallableTransitionSites(program, functions.get("shadow")!, analysis.summaries).sites).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("models user-defined acquire/use/release APIs and rejects leaks and use-after-release", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-resource-lifecycle-"));
    try {
      const fileName = join(directory, "entry.ts");
      writeFileSync(fileName, `
        interface Handle { readonly fd: number }
        /* uneffect:acquire return */
        declare function open(): Handle
        /* uneffect:use handle */
        declare function inspect(handle: Handle): void
        /* uneffect:release handle */
        declare function close(handle: Handle): void
        function valid() {
          const handle = open()
          const alias = handle
          inspect(alias)
          close(alias)
        }
        function leaked() { const handle = open(); inspect(handle) }
        function invalid() { const handle = open(); close(handle); inspect(handle) }
      `);
      const program = ts.createProgram([fileName], { target: ts.ScriptTarget.ES2024, noEmit: true });
      const source = program.getSourceFile(fileName)!;
      const analysis = analyzeResourceCallableSummaries(program);
      expect(analysis.diagnostics).toEqual([]);
      expect(analysis.summaries.map((summary) => summary.operations[0]?.kind)).toEqual(["acquire", "use", "release"]);
      const functions = new Map(source.statements.filter(ts.isFunctionDeclaration).filter((fn) => fn.body).map((fn) => [fn.name!.text, fn]));
      const evaluate = (name: string) => {
        const fn = functions.get(name)!;
        const collected = collectResourceCallableTransitionSites(program, fn, analysis.summaries);
        expect(collected.diagnostics).toEqual([]);
        expect(new Set(collected.sites.flatMap((site) => site.transitions).map((transition) => "resource" in transition ? transition.resource : "")))
          .toEqual(new Set(collected.resources.map((resource) => resource.id)));
        const lowered = lowerResourceProtocolCfgInFunction(source, fn, {
          schema: "uneffect-resource-protocol/v1", resources: collected.resources, transitions: [],
        }, collected.sites);
        expect(lowered.status).toBe("exact");
        if (lowered.status !== "exact") throw new Error(lowered.reason);
        return evaluateResourceProtocolCfg(lowered.cfg);
      };
      const valid = evaluate("valid");
      expect(valid.diagnostics).toEqual([]);
      expect(valid).toMatchObject({ status: "satisfied" });
      expect(evaluate("leaked")).toMatchObject({ status: "unsatisfied" });
      expect(evaluate("invalid")).toMatchObject({
        status: "unknown", diagnostics: [expect.objectContaining({ transition: "use", state: "released" })],
      });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("binds method lifecycle operations to the stable receiver identity", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-resource-receiver-"));
    try {
      const fileName = join(directory, "entry.ts");
      writeFileSync(fileName, `
        interface Client {
          /* uneffect:use this */ query(): void
          /* uneffect:release this */ close(): void
        }
        /* uneffect:acquire return */ declare function connect(): Client
        function main() { const client = connect(); const alias = client; alias.query(); alias.close() }
        function invalid() { const client = connect(); client.close(); client.query() }
      `);
      const program = ts.createProgram([fileName], { target: ts.ScriptTarget.ES2024, noEmit: true });
      const source = program.getSourceFile(fileName)!;
      const analysis = analyzeResourceCallableSummaries(program);
      expect(analysis.diagnostics).toEqual([]);
      expect(analysis.summaries.flatMap((summary) => summary.operations)).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "use", subject: { kind: "receiver" } }),
        expect.objectContaining({ kind: "release", subject: { kind: "receiver" } }),
      ]));
      const functions = new Map(source.statements.filter(ts.isFunctionDeclaration).filter((fn) => fn.body).map((fn) => [fn.name!.text, fn]));
      const evaluate = (name: string) => {
        const fn = functions.get(name)!;
        const collected = collectResourceCallableTransitionSites(program, fn, analysis.summaries);
        expect(collected.diagnostics).toEqual([]);
        const lowered = lowerResourceProtocolCfgInFunction(source, fn, {
          schema: "uneffect-resource-protocol/v1", resources: collected.resources, transitions: [],
        }, collected.sites);
        if (lowered.status !== "exact") throw new Error(lowered.reason);
        return evaluateResourceProtocolCfg(lowered.cfg);
      };
      expect(evaluate("main")).toMatchObject({ status: "satisfied" });
      expect(evaluate("invalid")).toMatchObject({ status: "unknown" });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("extracts trusted method contracts from declaration files and imported aliases", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-resource-declaration-"));
    try {
      const sdk = join(directory, "sdk.d.ts"), entry = join(directory, "entry.ts");
      writeFileSync(sdk, `
        export interface Sink {
          /* uneffect: consume value */
          drain(value: object): void
        }
        export declare const sink: Sink
        /* uneffect: consume value */
        export declare function drainDirect(value: object): void
      `);
      writeFileSync(entry, `
        import { sink as external } from "./sdk.js"
        import * as sdk from "./sdk.js"
        const { drainDirect } = sdk
        function main(value: object) { external.drain(value) }
        function namespaceCall(value: object) { sdk.drainDirect(value) }
        function destructuredCall(value: object) { drainDirect(value) }
        function shadow(value: object) {
          const external = { drain(input: object) { return input } }
          external.drain(value)
        }
      `);
      const program = ts.createProgram([sdk, entry], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      const source = program.getSourceFile(entry)!;
      const analysis = analyzeResourceCallableSummaries(program);
      expect(analysis.diagnostics).toEqual([]);
      expect(analysis.summaries).toHaveLength(2);
      expect(analysis.summaries).toEqual(expect.arrayContaining([expect.objectContaining({ evidence: "trusted", operations: [{
        kind: "consume", subject: { kind: "parameter", index: 0, name: "value" },
      }] })]));
      const functions = new Map(source.statements.filter(ts.isFunctionDeclaration).map((fn) => [fn.name!.text, fn]));
      expect(collectResourceCallableTransitionSites(program, functions.get("main")!, analysis.summaries).sites)
        .toMatchObject([{ transitions: [{ kind: "consume", evidence: "trusted" }] }]);
      expect(collectResourceCallableTransitionSites(program, functions.get("namespaceCall")!, analysis.summaries).sites)
        .toMatchObject([{ transitions: [{ kind: "consume", evidence: "trusted" }] }]);
      expect(collectResourceCallableTransitionSites(program, functions.get("destructuredCall")!, analysis.summaries).sites)
        .toMatchObject([{ transitions: [{ kind: "consume", evidence: "trusted" }] }]);
      expect(collectResourceCallableTransitionSites(program, functions.get("shadow")!, analysis.summaries).sites).toEqual([]);

      const transitiveProgram = ts.createProgram([entry], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true,
      });
      expect(analyzeResourceCallableSummaries(transitiveProgram).summaries).toEqual([]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("rejects malformed or unbound declared resource boundaries", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-resource-boundary-invalid-"));
    try {
      const fileName = join(directory, "entry.ts");
      writeFileSync(fileName, `
        /* uneffect: transfer value */
        function malformed(value: object): object { return value }
        /* uneffect: acquire value */
        function malformedAcquire(value: object): object { return value }
        /* uneffect: use this */
        function malformedReceiver(): void {}
        /* uneffect: transfer value -> return */
        function moves(value: object): object { return value }
        function unbound(value: object) { moves(value) }
      `);
      const program = ts.createProgram([fileName], { target: ts.ScriptTarget.ES2024, noEmit: true });
      const source = program.getSourceFile(fileName)!;
      const analysis = analyzeResourceCallableSummaries(program);
      expect(analysis.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "invalid-resource-transfer" }),
        expect.objectContaining({ code: "invalid-resource-acquire" }),
        expect.objectContaining({ code: "invalid-resource-receiver" }),
      ]));
      const unbound = source.statements.filter(ts.isFunctionDeclaration).find((fn) => fn.name?.text === "unbound")!;
      expect(collectResourceCallableTransitionSites(program, unbound, analysis.summaries).diagnostics)
        .toMatchObject([{ code: "unresolved-resource-binding", message: expect.stringContaining("return resource") }]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("proves the same terminal transition in both if branches", () => {
    const { source, fn, sites } = fixture(`
      function main(flag: boolean) {
        if (flag) consume(body)
        else consume(body)
      }
    `);
    const lowered = lowerResourceProtocolCfgInFunction(source, fn, model, sites);
    expect(lowered.status).toBe("exact");
    if (lowered.status !== "exact") return;
    expect(evaluateResourceProtocolCfg(lowered.cfg)).toMatchObject({ status: "satisfied", states: new Map([["body", "consumed"]]) });
  });

  it("joins one missing branch transition to unknown", () => {
    const { source, fn, sites } = fixture(`
      function main(flag: boolean) {
        if (flag) consume(body)
      }
    `);
    const lowered = lowerResourceProtocolCfgInFunction(source, fn, model, sites);
    expect(lowered.status).toBe("exact");
    if (lowered.status !== "exact") return;
    expect(evaluateResourceProtocolCfg(lowered.cfg)).toMatchObject({ status: "unknown", states: new Map([["body", "unknown"]]) });
  });

  it("applies fulfillment transitions only on the normal awaited edge", () => {
    const { source, fn } = fixture(`
      async function main() {
        const handle = open()
        await close(handle)
      }
    `);
    const statements = fn.body!.statements;
    const openCall = (statements[0] as ts.VariableStatement).declarationList.declarations[0]!.initializer as ts.CallExpression;
    const closeCall = ((statements[1] as ts.ExpressionStatement).expression as ts.AwaitExpression).expression as ts.CallExpression;
    const resourceModel: ResourceProtocolModel = {
      schema: "uneffect-resource-protocol/v1",
      resources: [{ id: "handle", label: "handle", kind: "Handle", initialState: "absent", requiredTerminalStates: ["released"] }],
      transitions: [],
    };
    const lowered = lowerResourceProtocolCfgInFunction(source, fn, resourceModel, [
      { node: openCall, transitions: [{ kind: "acquire", resource: "handle", at: openCall.getStart() }] },
      { node: closeCall, transitions: [], fulfillmentTransitions: [{ kind: "release", resource: "handle", at: closeCall.getStart() }], exceptionalCompletion: "throw" },
    ]);
    expect(lowered.status).toBe("exact");
    if (lowered.status !== "exact") return;
    expect(evaluateResourceProtocolCfg(lowered.cfg)).toMatchObject({ status: "unknown", states: new Map([["handle", "unknown"]]) });
  });

  it("keeps a conditional loop consumption unknown without claiming an iteration", () => {
    const { source, fn, sites } = fixture(`
      function main(flag: boolean) {
        while (flag) consume(body)
      }
    `);
    const lowered = lowerResourceProtocolCfgInFunction(source, fn, model, sites);
    expect(lowered.status).toBe("exact");
    if (lowered.status !== "exact") return;
    expect(evaluateResourceProtocolCfg(lowered.cfg)).toMatchObject({ status: "unknown" });
  });

  it("lowers loop exits before a trailing terminal transition", () => {
    const { source, fn, sites } = fixture(`
      function main(flag: boolean) {
        while (flag) { if (flag) continue; else break }
        consume(body)
      }
    `);
    const lowered = lowerResourceProtocolCfgInFunction(source, fn, model, sites);
    expect(lowered.status).toBe("exact");
    if (lowered.status !== "exact") return;
    expect(evaluateResourceProtocolCfg(lowered.cfg)).toMatchObject({ status: "satisfied" });
  });

  it("preserves switch breaks and requires every selected clause", () => {
    const { source, fn, sites } = fixture(`
      function main(kind: "a" | "b") {
        switch (kind) {
          case "a": consume(body); break
          case "b": consume(body); break
          default: consume(body)
        }
      }
    `);
    const lowered = lowerResourceProtocolCfgInFunction(source, fn, model, sites);
    expect(lowered.status).toBe("exact");
    if (lowered.status !== "exact") return;
    expect(evaluateResourceProtocolCfg(lowered.cfg)).toMatchObject({ status: "satisfied" });
  });

  it("routes labeled break without executing the skipped suffix", () => {
    const { source, fn, sites } = fixture(`
      function main() {
        selected: {
          consume(body)
          break selected
          consume(body)
        }
      }
    `);
    const lowered = lowerResourceProtocolCfgInFunction(source, fn, model, sites);
    expect(lowered.status).toBe("exact");
    if (lowered.status !== "exact") return;
    expect(evaluateResourceProtocolCfg(lowered.cfg)).toMatchObject({ status: "satisfied" });
  });

  it("keeps nested declarations outside the enclosing resource owner", () => {
    const { source, fn, sites } = fixture(`
      function main() {
        function later() { consume(body) }
        consume(body)
      }
    `);
    const lowered = lowerResourceProtocolCfgInFunction(source, fn, model, sites);
    expect(lowered.status).toBe("exact");
    if (lowered.status !== "exact") return;
    expect(evaluateResourceProtocolCfg(lowered.cfg)).toMatchObject({ status: "satisfied" });
  });

  it("routes normal and explicit throw paths through mandatory finally", () => {
    const { source, fn, sites } = fixture(`
      function main(fail: boolean) {
        try {
          if (fail) throw new Error("stop")
        } catch (error) {
          console.log(error)
        } finally {
          consume(body)
        }
      }
    `);
    const lowered = lowerResourceProtocolCfgInFunction(source, fn, model, sites);
    expect(lowered.status).toBe("exact");
    if (lowered.status !== "exact") return;
    expect(evaluateResourceProtocolCfg(lowered.cfg)).toMatchObject({ status: "satisfied" });
  });

  it("routes return completion through mandatory finally", () => {
    const { source, fn, sites } = fixture(`
      function main(done: boolean) {
        try {
          if (done) return
        } finally {
          consume(body)
        }
      }
    `);
    const lowered = lowerResourceProtocolCfgInFunction(source, fn, model, sites);
    expect(lowered.status).toBe("exact");
    if (lowered.status !== "exact") return;
    expect(evaluateResourceProtocolCfg(lowered.cfg)).toMatchObject({ status: "satisfied" });
  });

  it("routes loop break through mandatory finally", () => {
    const { source, fn, sites } = fixture(`
      function main() {
        while (true) {
          try { break }
          finally { consume(body) }
        }
      }
    `);
    const lowered = lowerResourceProtocolCfgInFunction(source, fn, model, sites);
    expect(lowered.status).toBe("exact");
    if (lowered.status !== "exact") return;
    expect(evaluateResourceProtocolCfg(lowered.cfg)).toMatchObject({ status: "satisfied" });
  });

  it("routes an authenticated call throw into catch", () => {
    const { source, fn, sites } = fixture(`
      function main() {
        try {
          risky()
          consume(body)
        } catch {
          consume(body)
          consume(body)
        }
      }
    `);
    const lowered = lowerResourceProtocolCfgInFunction(source, fn, model, sites);
    expect(lowered.status).toBe("exact");
    if (lowered.status !== "exact") return;
    expect(evaluateResourceProtocolCfg(lowered.cfg)).toMatchObject({
      status: "unknown",
      diagnostics: [expect.objectContaining({ code: "invalid-transition", state: "consumed" })],
    });
  });

  it("resolves trusted Throw and awaited Reject summaries by declaration identity", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-resource-callable-exception-"));
    try {
      const fileName = join(directory, "entry.ts");
      writeFileSync(fileName, `
        function riskySync(): void {}
        async function riskyAsync(): Promise<void> {}
        const syncAlias = riskySync
        const asyncAlias = riskyAsync
        const frozen = Object.freeze({ riskyAsync })
        const { riskyAsync: destructuredAsync } = frozen
        let mutableAlias = riskySync
        function main() {
          riskySync()
        }
        async function awaited() {
          await riskyAsync()
        }
        function aliasedSync() { syncAlias() }
        async function aliasedAsync() { await asyncAlias() }
        async function frozenAsync() { await frozen.riskyAsync() }
        async function destructured() { await destructuredAsync() }
        function mutable() { mutableAlias() }
        function floating() {
          riskyAsync()
        }
        function sameName() {
          const riskySync = () => {}
          riskySync()
        }
        function caught() {
          try {
            riskySync()
            consume(body)
          } catch {
            consume(body)
            consume(body)
          }
        }
      `);
      const program = ts.createProgram([fileName], { target: ts.ScriptTarget.ES2024, noEmit: true });
      const source = program.getSourceFile(fileName)!;
      const functions = new Map(source.statements.filter(ts.isFunctionDeclaration).map((fn) => [fn.name!.text, fn]));
      const summaryIds = new Map(["riskySync", "riskyAsync"].map((name) => {
        const declaration = functions.get(name)!;
        return [name, `${fileName}:${declaration.getStart(source)}`] as const;
      }));
      const analyzed = analyzeCallableSummaries(program).summaries;
      const summaries = analyzed.map((summary) => summary.id === summaryIds.get("riskySync")
        ? { ...summary, evidence: "trusted" as const, throws: ["Error"] }
        : summary.id === summaryIds.get("riskyAsync") ? { ...summary, evidence: "trusted" as const, rejects: ["Error"] } : summary);
      const syncSites = collectCallableExceptionalTransitionSites(program, functions.get("main")!, summaries);
      expect(syncSites).toHaveLength(1);
      expect(syncSites[0]).toMatchObject({
        exceptionalCompletion: "throw",
        exceptionEvidence: { completion: "synchronous-throw", evidence: "trusted", errorTypes: ["Error"] },
      });
      expect(collectCallableExceptionalTransitionSites(program, functions.get("awaited")!, summaries)[0]).toMatchObject({
        exceptionEvidence: { completion: "awaited-reject", errorTypes: ["Error"] },
      });
      expect(collectCallableExceptionalTransitionSites(program, functions.get("aliasedSync")!, summaries)[0]).toMatchObject({
        exceptionEvidence: { completion: "synchronous-throw", errorTypes: ["Error"] },
      });
      expect(collectCallableExceptionalTransitionSites(program, functions.get("aliasedAsync")!, summaries)[0]).toMatchObject({
        exceptionEvidence: { completion: "awaited-reject", errorTypes: ["Error"] },
      });
      expect(collectCallableExceptionalTransitionSites(program, functions.get("frozenAsync")!, summaries)[0]).toMatchObject({
        exceptionEvidence: { completion: "awaited-reject", errorTypes: ["Error"] },
      });
      expect(collectCallableExceptionalTransitionSites(program, functions.get("destructured")!, summaries)[0]).toMatchObject({
        exceptionEvidence: { completion: "awaited-reject", errorTypes: ["Error"] },
      });
      expect(collectCallableExceptionalTransitionSites(program, functions.get("mutable")!, summaries)).toEqual([]);
      expect(collectCallableExceptionalTransitionSites(program, functions.get("floating")!, summaries)).toEqual([]);
      expect(collectCallableExceptionalTransitionSites(program, functions.get("sameName")!, summaries)).toEqual([]);
      expect(syncSites[0]!.exceptionEvidence?.summaryId).toContain(`${fileName}:`);
      expect(syncSites[0]!.exceptionEvidence?.call.fileName).toBe(fileName);

      const caught = functions.get("caught")!;
      const consumeSites: ResourceTransitionSite[] = [];
      const collectConsumes = (node: ts.Node): void => {
        if (node !== caught && ts.isFunctionLike(node)) return;
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "consume") {
          consumeSites.push({ node, transitions: [{ kind: "consume", resource: "body", at: node.getStart(source) }] });
        }
        ts.forEachChild(node, collectConsumes);
      };
      collectConsumes(caught.body!);
      const lowered = lowerResourceProtocolCfgInFunction(source, caught, model, [
        ...consumeSites,
        ...collectCallableExceptionalTransitionSites(program, caught, summaries),
      ]);
      expect(lowered.status).toBe("exact");
      if (lowered.status === "exact") expect(evaluateResourceProtocolCfg(lowered.cfg)).toMatchObject({
        status: "unknown",
        diagnostics: [expect.objectContaining({ code: "invalid-transition", state: "consumed" })],
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("composes authenticated package Throw and awaited rejection edges", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-resource-package-exception-"));
    try {
      const fileName = join(directory, "entry.ts");
      writeFileSync(fileName, `
        declare function riskySync(): void
        declare function riskyAsync(): Promise<void>
        declare function riskyBoth(): Promise<void>
        declare function unauthenticated(): void
        declare function makeRisky(): () => Promise<void>
        declare function makeClient(): { risky(): Promise<void> }
        const madeRisky = makeRisky()
        function syncMain() { riskySync() }
        async function awaitedMain() { await riskyAsync() }
        async function bothMain() { await riskyBoth() }
        function floatingMain() { riskyAsync() }
        function shadowMain() { const riskySync = () => {}; riskySync() }
        function unauthenticatedMain() { unauthenticated() }
        async function madeMain() { await madeRisky() }
        async function madeMemberMain() {
          const client = makeClient()
          const alias = client
          await alias.risky()
        }
      `);
      const program = ts.createProgram([fileName], { target: ts.ScriptTarget.ES2024, noEmit: true });
      const source = program.getSourceFile(fileName)!;
      const functions = new Map(source.statements.filter(ts.isFunctionDeclaration).map((fn) => [fn.name!.text, fn]));
      const contracts = new Map<string, ExternalFunctionEffectContract>();
      const sync = functions.get("riskySync")!, async = functions.get("riskyAsync")!;
      contracts.set(`${fileName}:${sync.getStart(source)}`, {
        effects: [{ kind: "throw", errorType: "Error" }], evidence: "verified",
        contractEvidence: "trusted", functionName: "riskySync",
      });
      contracts.set(`${fileName}:${async.getStart(source)}`, {
        effects: [], rejects: ["TypeError"], evidence: "verified",
        contractEvidence: "trusted", functionName: "riskyAsync",
      });
      const both = functions.get("riskyBoth")!;
      contracts.set(`${fileName}:${both.getStart(source)}`, {
        effects: [{ kind: "throw", errorType: "RangeError" }], rejects: ["TypeError"],
        evidence: "verified", contractEvidence: "trusted", functionName: "riskyBoth",
      });
      const untrusted = functions.get("unauthenticated")!;
      contracts.set(`${fileName}:${untrusted.getStart(source)}`, {
        effects: [{ kind: "throw", errorType: "Error" }], evidence: "unknown",
        contractEvidence: "trusted", functionName: "unauthenticated",
      });
      const factory = functions.get("makeRisky")!;
      contracts.set(`${fileName}:${factory.getStart(source)}`, {
        effects: [], evidence: "verified", contractEvidence: "trusted", functionName: "makeRisky",
        returnCallable: {
          effects: [{ kind: "throw", errorType: "RangeError" }], rejects: ["TypeError"],
          contractEvidence: "trusted",
        },
      });
      const clientFactory = functions.get("makeClient")!;
      contracts.set(`${fileName}:${clientFactory.getStart(source)}`, {
        effects: [], evidence: "verified", contractEvidence: "trusted", functionName: "makeClient",
        returnMembers: [{
          key: "risky", effects: [{ kind: "throw", errorType: "RangeError" }], rejects: ["TypeError"],
          contractEvidence: "trusted",
        }],
      });

      expect(collectCallableExceptionalTransitionSites(program, functions.get("syncMain")!, [], contracts)[0]).toMatchObject({
        exceptionEvidence: { completion: "synchronous-throw", evidence: "trusted", errorTypes: ["Error"] },
      });
      expect(collectCallableExceptionalTransitionSites(program, functions.get("awaitedMain")!, [], contracts)[0]).toMatchObject({
        exceptionEvidence: { completion: "awaited-reject", evidence: "trusted", errorTypes: ["TypeError"] },
      });
      expect(collectCallableExceptionalTransitionSites(program, functions.get("bothMain")!, [], contracts).map((site) =>
        site.exceptionEvidence?.completion)).toEqual(["synchronous-throw", "awaited-reject"]);
      expect(collectCallableExceptionalTransitionSites(program, functions.get("floatingMain")!, [], contracts)).toEqual([]);
      expect(collectCallableExceptionalTransitionSites(program, functions.get("shadowMain")!, [], contracts)).toEqual([]);
      expect(collectCallableExceptionalTransitionSites(program, functions.get("unauthenticatedMain")!, [], contracts)).toEqual([]);
      expect(collectCallableExceptionalTransitionSites(program, functions.get("madeMain")!, [], contracts).map((site) =>
        site.exceptionEvidence?.completion)).toEqual(["synchronous-throw", "awaited-reject"]);
      expect(collectCallableExceptionalTransitionSites(program, functions.get("madeMemberMain")!, [], contracts).map((site) =>
        site.exceptionEvidence?.completion)).toEqual(["synchronous-throw", "awaited-reject"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
