import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { evaluateResourceProtocolCfg, type ResourceProtocolModel } from "../src/resource-protocol.js";
import { analyzeCallableSummaries } from "../src/callable-summary.js";
import { analyzeResourceCallableSummaries, collectResourceCallableTransitionSites } from "../src/resource-callable-typescript.js";
import { collectBuiltinResourceTransitionSites, collectCallableExceptionalTransitionSites, lowerResourceProtocolCfgInFunction, type ResourceTransitionSite } from "../src/resource-protocol-typescript.js";

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
      expect(collected.resources).toEqual([expect.objectContaining({ id: "reader", kind: "stream-reader", initialState: "absent" })]);
      expect(collected.sites.flatMap((site) => site.transitions)).toMatchObject([
        { kind: "acquire", resource: "reader", evidence: "trusted" },
        { kind: "release", resource: "reader", evidence: "trusted" },
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
      expect(collected.resources).toEqual([expect.objectContaining({ id: "socket", kind: "websocket", initialState: "absent" })]);
      expect(collected.sites.flatMap((site) => site.transitions)).toMatchObject([
        { kind: "acquire", resource: "socket", evidence: "trusted" },
        { kind: "use", resource: "socket", evidence: "trusted" },
        { kind: "release", resource: "socket", evidence: "trusted" },
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
      `);
      writeFileSync(entry, `
        import { sink as external } from "./sdk.js"
        function main(value: object) { external.drain(value) }
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
      expect(analysis.summaries).toMatchObject([{ evidence: "trusted", operations: [{
        kind: "consume", subject: { kind: "parameter", index: 0, name: "value" },
      }] }]);
      const functions = new Map(source.statements.filter(ts.isFunctionDeclaration).map((fn) => [fn.name!.text, fn]));
      expect(collectResourceCallableTransitionSites(program, functions.get("main")!, analysis.summaries).sites)
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
        /* uneffect: transfer value -> return */
        function moves(value: object): object { return value }
        function unbound(value: object) { moves(value) }
      `);
      const program = ts.createProgram([fileName], { target: ts.ScriptTarget.ES2024, noEmit: true });
      const source = program.getSourceFile(fileName)!;
      const analysis = analyzeResourceCallableSummaries(program);
      expect(analysis.diagnostics).toMatchObject([{ code: "invalid-resource-transfer" }]);
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
        function main() {
          riskySync()
        }
        async function awaited() {
          await riskyAsync()
        }
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
});
