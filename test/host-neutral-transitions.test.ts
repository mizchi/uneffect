import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import type { CallableSummary } from "../src/callable-summary.js";
import type { ResourceDisposal } from "../src/async-safety.js";
import type { PromiseChainModel } from "../src/promise-chains.js";
import { analyzeAsyncPatternsInProgram, generateWebEventLoopQuint } from "../src/async-patterns.js";
import {
  composeHostNeutralTransitions,
  analyzeHostNeutralTransitions,
  analyzeAbortSignalsInProgram,
  lowerCallableSummaryTransitions,
  lowerPromiseChainTransitions,
  lowerResourceDisposalTransitions,
  lowerHostNeutralTransitions,
  generateHostTransitionModel,
} from "../src/host-neutral-transitions.js";

describe("host-neutral async transitions", () => {
  it("lowers callback timing without choosing a Web or Node queue", () => {
    const summary = {
      schema: "uneffect-callable-summary/v1", id: "entry.ts:0", name: "work", fileName: "entry.ts",
      span: { start: 0, end: 10 }, effects: [], throws: [], rejects: [], reads: [], writes: [],
      callbackParameters: [], evidence: "inferred", unknownReasons: [],
      callbackInvocations: [
        { api: "Array.prototype.map", callback: "inline", cardinality: "0..n", timing: "inline", completion: "propagate-throw", span: { start: 1, end: 2 } },
        { api: "Promise.prototype.then", callback: "reaction", cardinality: "0..1", timing: "promise-reaction", completion: "convert-throw-to-rejection", span: { start: 3, end: 4 } },
        { api: "setTimeout", callback: "later", cardinality: "0..1", timing: "deferred", completion: "host-report-throw", span: { start: 5, end: 6 } },
      ],
    } satisfies CallableSummary;
    expect(lowerCallableSummaryTransitions(summary)).toMatchObject([
      { kind: "invoke-callback", lane: "inline", completion: "propagate-throw", cardinality: "0..n" },
      { kind: "invoke-callback", lane: "microtask", completion: "reject", cardinality: "0..1" },
      { kind: "invoke-callback", lane: "host-task", completion: "host-report-throw", cardinality: "0..1" },
    ]);
  });

  it("uses the same contract for Promise settlement and sync/async disposal", () => {
    const promises: PromiseChainModel = {
      executors: [{ owner: "p", callback: "executor", synchronous: true, throwBecomesRejection: true,
        events: [], possibleSettlements: ["fulfilled", "rejected"], mayRemainPending: false, mayDivergeSynchronously: true, synchronousDivergenceReasons: ["recursion"], span: { start: 0, end: 4 } },
      { owner: "external", binding: "task", callback: "<external-resolvers>", synchronous: false, throwBecomesRejection: false,
        settlementSource: "external-resolvers", events: [], possibleSettlements: ["fulfilled"], mayRemainPending: true, mayDivergeSynchronously: false, synchronousDivergenceReasons: [], span: { start: 10, end: 14 } }],
      thenables: [],
      chains: [{ owner: "p", source: "p", links: [{ kind: "then", handlers: ["ok", "bad"], handlerReturns: ["value", "value"], span: { start: 5, end: 9 } }], span: { start: 0, end: 9 } }],
    };
    const sync: ResourceDisposal = { owner: "work", binding: "file", order: 0, asynchronous: false,
      scopeId: "scope", scopeDepth: 0, disposalPoint: 20, mayFail: true, failureKind: "throw",
      failureType: "Error", catchesFailure: false, escapingFailure: "throw", exits: ["normal", "return"] };
    const asyncDisposal: ResourceDisposal = { ...sync, binding: "socket", order: 1, asynchronous: true,
      failureKind: "reject", escapingFailure: "reject" };
    const transitions = composeHostNeutralTransitions(
      lowerPromiseChainTransitions("entry.ts", promises),
      lowerResourceDisposalTransitions("entry.ts", [sync, asyncDisposal]),
    );
    expect(transitions).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "settle-promise", lane: "inline", outcomes: ["fulfilled", "rejected"], firstSettlementWins: true, mayDivergeSynchronously: true, synchronousDivergenceReasons: ["recursion"] }),
      expect.objectContaining({ kind: "settle-promise", promise: "task", lane: "external", outcomes: ["fulfilled"], firstSettlementWins: true }),
      expect.objectContaining({ kind: "invoke-callback", lane: "microtask", completion: "reject", callback: "ok" }),
      expect.objectContaining({ kind: "dispose-resource", resource: "file", lane: "inline", completion: "throw" }),
      expect.objectContaining({ kind: "dispose-resource", resource: "socket", lane: "microtask", completion: "reject" }),
    ]));
    expect(new Set(transitions.map(({ id }) => id)).size).toBe(transitions.length);
  });

  it("selects Web and Node queues only where the neutral evidence is sufficient", () => {
    const summary = {
      schema: "uneffect-callable-summary/v1", id: "entry.ts:0", name: "work", fileName: "entry.ts",
      span: { start: 0, end: 10 }, effects: [], throws: [], rejects: [], reads: [], writes: [],
      callbackParameters: [], evidence: "inferred", unknownReasons: [], callbackInvocations: [
        { api: "Promise.prototype.then", callback: "reaction", cardinality: "0..1", timing: "promise-reaction", completion: "convert-throw-to-rejection", span: { start: 1, end: 2 } },
        { api: "setTimeout", callback: "timer", cardinality: "0..1", timing: "deferred", completion: "host-report-throw", span: { start: 3, end: 4 } },
        { api: "EventTarget.prototype.addEventListener", callback: "event", cardinality: "0..n", timing: "deferred", completion: "host-report-throw", span: { start: 5, end: 6 } },
      ],
    } satisfies CallableSummary;
    const neutral = lowerCallableSummaryTransitions(summary);
    expect(lowerHostNeutralTransitions(neutral, "web").map(({ queue, evidence }) => [queue, evidence])).toEqual([
      ["microtask", "exact"], ["timer-task", "exact"], ["event-task", "exact"],
    ]);
    expect(lowerHostNeutralTransitions(neutral, "node").map(({ queue, evidence }) => [queue, evidence])).toEqual([
      ["v8-microtask", "exact"], ["timers", "exact"], ["unknown", "unknown"],
    ]);
  });

  it("links cancellation and bounded fairness to the executable Web state model", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-neutral-web-"));
    try {
      const fileName = join(directory, "entry.ts");
      writeFileSync(fileName, `
        export function main() {
          const handle = setTimeout(() => console.log("later"), 10)
          clearTimeout(handle)
          queueMicrotask(() => console.log("microtask"))
        }
      `);
      const program = ts.createProgram([fileName], {
        target: ts.ScriptTarget.ES2024, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], noEmit: true,
      });
      const model = generateHostTransitionModel(program, program.getSourceFile(fileName)!, {
        profile: "web", moduleName: "neutral_web", fairnessBound: 3, fairness: "weak",
      });
      expect(model.cancellations).toContainEqual(expect.objectContaining({ definite: true, compatible: true, evidence: "exact" }));
      expect(model.fairness).toEqual(expect.arrayContaining([
        expect.objectContaining({ maximumSkips: 3, evidence: "assumed", assumption: "bounded-host-progress" }),
      ]));
      expect(model.quint).toContain("module neutral_web");
      expect(model.quint).toContain("callback_0_pending' = false");
      expect(model.quint).toContain("temporal fair_host_1 = drain_microtask_1.weakFair(hostFairnessVars)");
      expect(model.fairnessProperties).toEqual(["fair_host_1"]);
      const quintFile = join(directory, "neutral-web.qnt");
      writeFileSync(quintFile, model.quint);
      expect(spawnSync("quint", ["typecheck", quintFile], { encoding: "utf8" })).toMatchObject({ status: 0 });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("links external poll completion to the executable Node state model", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-neutral-node-"));
    try {
      const fileName = join(directory, "entry.ts");
      writeFileSync(fileName, `
        import { readFile } from "node:fs"
        export function main() {
          readFile("settings.json", () => console.log("loaded"))
        }
      `);
      const program = ts.createProgram([fileName], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, types: ["node"], noEmit: true,
      });
      const model = generateHostTransitionModel(program, program.getSourceFile(fileName)!, {
        profile: "node", moduleName: "neutral_node", fairnessBound: 2, fairness: "strong",
      });
      expect(model.externalCompletions).toContainEqual(expect.objectContaining({ queue: "poll", evidence: "exact" }));
      expect(model.quint).toContain("module neutral_node");
      expect(model.quint).toContain("action complete_poll_0");
      expect(model.quint).toContain("run_poll_0.strongFair(hostFairnessVars)");
      expect(model.quint).toContain("complete_poll_0.strongFair(hostFairnessVars)");
      const quintFile = join(directory, "neutral-node.qnt");
      writeFileSync(quintFile, model.quint);
      expect(spawnSync("quint", ["typecheck", quintFile], { encoding: "utf8" })).toMatchObject({ status: 0 });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("links WebSocket EventTarget registration to executable external Web completion", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-neutral-websocket-"));
    try {
      const fileName = join(directory, "entry.ts");
      writeFileSync(fileName, `
        export function main(socket: WebSocket) {
          socket.addEventListener("message", () => queueMicrotask(() => console.log("message")), { once: true })
        }
      `);
      const program = ts.createProgram([fileName], {
        target: ts.ScriptTarget.ES2024, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], noEmit: true,
      });
      const source = program.getSourceFile(fileName)!;
      const model = generateHostTransitionModel(program, source, {
        profile: "web", moduleName: "neutral_websocket", fairnessBound: 2, fairness: "weak",
      });
      expect(model.scheduled).toContainEqual(expect.objectContaining({ queue: "event-task", evidence: "exact" }));
      expect(model.externalCompletions).toContainEqual(expect.objectContaining({ queue: "external", evidence: "exact" }));
      expect(model.quint).toContain("action complete_external_0");
      expect(model.quint).toContain("callback_0_fires == 0");
      expect(model.quint).toContain("action run_external_event_0");
      expect(model.quint).toContain("action drain_microtask_1");
      expect(model.fairnessProperties).toEqual(expect.arrayContaining(["fair_host_0", "fair_external_0"]));
      const quintFile = join(directory, "neutral-websocket.qnt");
      writeFileSync(quintFile, model.quint);
      expect(spawnSync("quint", ["typecheck", quintFile], { encoding: "utf8" })).toMatchObject({ status: 0 });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("connects EventTarget AbortSignal options to external completion cancellation", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-web-event-abort-"));
    try {
      const fileName = join(directory, "entry.ts");
      writeFileSync(fileName, `
        export function preAborted(socket: WebSocket, callback: (event: MessageEvent) => void) {
          socket.addEventListener("message", callback, { signal: AbortSignal.abort("stop") })
        }
        export function timed(socket: WebSocket, callback: (event: MessageEvent) => void) {
          socket.addEventListener("message", callback, { signal: AbortSignal.timeout(5) })
        }
        export function external(socket: WebSocket, callback: (event: MessageEvent) => void, signal: AbortSignal) {
          socket.addEventListener("message", callback, { signal })
        }
        export function composed(socket: WebSocket, callback: (event: MessageEvent) => void, signal: AbortSignal) {
          const combined = AbortSignal.any([signal, AbortSignal.timeout(8)])
          socket.addEventListener("message", callback, { signal: combined })
        }
      `);
      const program = ts.createProgram([fileName], {
        target: ts.ScriptTarget.ES2024, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], noEmit: true,
      });
      const source = program.getSourceFile(fileName)!;
      const patterns = analyzeAsyncPatternsInProgram(program, source);
      expect(patterns.timers).toContainEqual(expect.objectContaining({ owner: "preAborted", queue: "external", initiallyCancelled: true }));
      const timeoutIndex = patterns.timers.findIndex((timer) => timer.owner === "timed" && timer.kind === "abort-timeout");
      expect(timeoutIndex).toBeGreaterThanOrEqual(0);
      expect(patterns.timers).toContainEqual(expect.objectContaining({ owner: "timed", queue: "external", abortTimer: timeoutIndex }));
      const externalIndex = patterns.timers.findIndex((timer) => timer.owner === "external" && timer.queue === "external");
      expect(patterns.timers[externalIndex]).toEqual(expect.objectContaining({ externalAbortSignal: true }));
      const composedIndex = patterns.timers.findIndex((timer) => timer.owner === "composed" && timer.queue === "external");
      expect(patterns.timers[composedIndex]).toEqual(expect.objectContaining({ abortComposition: expect.any(Number) }));
      const quint = generateWebEventLoopQuint("external_abort", patterns);
      expect(quint).toContain(`action cancel_external_${externalIndex}_from_external_signal`);
      expect(quint).toMatch(new RegExp(`action cancel_external_${externalIndex}_from_external_signal[\\s\\S]*callback_${externalIndex}_external_aborted' = true`));
      expect(quint).toMatch(new RegExp(`action complete_external_${externalIndex}[\\s\\S]*not\\(callback_${externalIndex}_external_aborted\\)`));
      expect(quint).toMatch(new RegExp(`action complete_external_${composedIndex}[\\s\\S]*not\\(abort_\\d+_aborted\\)`));
      const quintFile = join(directory, "external-abort.qnt");
      writeFileSync(quintFile, quint);
      expect(spawnSync("quint", ["typecheck", quintFile], { encoding: "utf8" })).toMatchObject({ status: 0 });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("matches EventTarget removal by target, type, callback, and capture identity", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-web-event-remove-"));
    try {
      const fileName = join(directory, "entry.ts");
      writeFileSync(fileName, `
        export function removed(target: EventTarget, handler: EventListener) {
          target.addEventListener("message", handler)
          target.removeEventListener("message", handler)
        }
        export function maybeRemoved(target: EventTarget, handler: EventListener, remove: boolean) {
          target.addEventListener("message", handler, true)
          if (remove) target.removeEventListener("message", handler, true)
        }
        export function aliased(target: EventTarget, handler: EventListener) {
          const targetAlias = target
          const handlerAlias = handler
          targetAlias.addEventListener("message", handlerAlias)
          target.removeEventListener("message", handler)
        }
        export function mismatch(target: EventTarget, first: EventListener, second: EventListener) {
          target.addEventListener("message", first, true)
          target.removeEventListener("message", second, true)
          target.removeEventListener("other", first, true)
          target.removeEventListener("message", first, false)
        }
      `);
      const program = ts.createProgram([fileName], {
        target: ts.ScriptTarget.ES2024, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], noEmit: true,
      });
      const patterns = analyzeAsyncPatternsInProgram(program, program.getSourceFile(fileName)!);
      const removed = patterns.timers.findIndex((timer) => timer.owner === "removed" && timer.queue === "external");
      const maybe = patterns.timers.findIndex((timer) => timer.owner === "maybeRemoved" && timer.queue === "external");
      const mismatch = patterns.timers.findIndex((timer) => timer.owner === "mismatch" && timer.queue === "external");
      const aliased = patterns.timers.findIndex((timer) => timer.owner === "aliased" && timer.queue === "external");
      expect(patterns.cancellations).toEqual(expect.arrayContaining([
        expect.objectContaining({ owner: "removed", timer: removed, definite: true, compatible: true }),
        expect.objectContaining({ owner: "maybeRemoved", timer: maybe, definite: false, compatible: true }),
        expect.objectContaining({ owner: "aliased", timer: aliased, definite: true, compatible: true }),
      ]));
      expect(patterns.cancellations).not.toContainEqual(expect.objectContaining({ owner: "mismatch", timer: mismatch, compatible: true }));
      const quint = generateWebEventLoopQuint("listener_remove", patterns);
      expect(quint).toMatch(new RegExp(`callback_${removed}_removed' = true`));
      expect(quint).toMatch(new RegExp(`action remove_listener_${maybe}[\\s\\S]*callback_${maybe}_removed' = true`));
      expect(quint).toMatch(new RegExp(`action complete_external_${maybe}[\\s\\S]*not\\(callback_${maybe}_removed\\)`));
      const quintFile = join(directory, "listener-remove.qnt");
      writeFileSync(quintFile, quint);
      expect(spawnSync("quint", ["typecheck", quintFile], { encoding: "utf8" })).toMatchObject({ status: 0 });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(["web", "node"] as const)("keeps conditional cancellation as a %s execution race", (profile) => {
    const directory = mkdtempSync(join(tmpdir(), `uneffect-neutral-cancel-${profile}-`));
    try {
      const fileName = join(directory, "entry.ts");
      writeFileSync(fileName, `
        export function main(cancel: boolean) {
          const handle = setTimeout(() => console.log("later"), 1)
          if (cancel) clearTimeout(handle)
        }
      `);
      const program = ts.createProgram([fileName], {
        target: ts.ScriptTarget.ES2024, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], types: ["node"], noEmit: true,
      });
      const model = generateHostTransitionModel(program, program.getSourceFile(fileName)!, {
        profile, moduleName: `cancel_${profile}`, fairness: "weak",
      });
      expect(model.cancellations).toContainEqual(expect.objectContaining({ definite: false, compatible: true, evidence: "exact" }));
      expect(model.quint).toContain("action cancel_timer_0");
      expect(model.quint).toContain(profile === "web" ? "run_timer_task_0.weakFair" : "run_timer_0.weakFair");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("tracks TypeChecker-identified AbortController aborts and AbortSignal.any sources", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-neutral-abort-"));
    try {
      const fileName = join(directory, "entry.ts");
      writeFileSync(fileName, `
        export function main(cancel: boolean) {
          const controller = new AbortController()
          const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10)])
          if (cancel) controller.abort(new Error("cancelled"))
          return signal
        }
        class FakeAbortController { signal = {}; abort(_reason?: unknown) {} }
        const fake = new FakeAbortController()
        fake.abort("ignored")
      `);
      const program = ts.createProgram([fileName], {
        target: ts.ScriptTarget.ES2024, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], noEmit: true,
      });
      const aborts = analyzeAbortSignalsInProgram(program, program.getSourceFile(fileName)!);
      expect(aborts.controllers).toHaveLength(1);
      expect(aborts.events).toEqual([
        expect.objectContaining({ controller: "controller", reason: 'new Error("cancelled")', conditional: true, evidence: "exact" }),
      ]);
      expect(aborts.compositionLinks).toEqual([
        expect.objectContaining({ controller: "controller", composition: 0, source: 0, evidence: "exact" }),
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps same-spelled block-scoped AbortControllers distinct", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-neutral-abort-shadow-"));
    try {
      const fileName = join(directory, "entry.ts");
      writeFileSync(fileName, `
        export function main() {
          { const controller = new AbortController(); const first = AbortSignal.any([controller.signal]); void first }
          { const controller = new AbortController(); const second = AbortSignal.any([controller.signal]); void second }
        }
      `);
      const program = ts.createProgram([fileName], {
        target: ts.ScriptTarget.ES2024, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], noEmit: true,
      });
      const aborts = analyzeAbortSignalsInProgram(program, program.getSourceFile(fileName)!);
      expect(aborts.controllers.map((controller) => controller.identity.declarationStart)).toEqual([
        expect.any(Number), expect.any(Number),
      ]);
      expect(aborts.controllers[0]!.identity).not.toEqual(aborts.controllers[1]!.identity);
      expect(aborts.compositionLinks).toEqual([
        expect.objectContaining({ controllerIndex: 0, composition: 0, source: 0 }),
        expect.objectContaining({ controllerIndex: 1, composition: 1, source: 0 }),
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("feeds a definite synchronous controller abort into Web scheduler state", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-neutral-abort-host-"));
    try {
      const fileName = join(directory, "entry.ts");
      writeFileSync(fileName, `
        export function main() {
          const controller = new AbortController()
          const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10)])
          scheduler.postTask(() => console.log("never"), { signal, priority: "background" })
          controller.abort("stop")
        }
      `);
      const program = ts.createProgram([fileName], {
        target: ts.ScriptTarget.ES2024, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], noEmit: true,
      });
      const model = generateHostTransitionModel(program, program.getSourceFile(fileName)!, {
        profile: "web", moduleName: "abort_host",
      });
      expect(model.transitionAnalysis.transitions).toContainEqual(expect.objectContaining({
        kind: "abort-signal", controller: "controller", reason: '"stop"', lane: "inline",
      }));
      expect(model.quint).toContain("abort_0_aborted' = true");
      expect(model.quint).toContain("callback_1_pending' = false");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("connects TypeScript callback and Promise analyses before host lowering", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-neutral-transitions-"));
    try {
      const fileName = join(directory, "entry.ts");
      writeFileSync(fileName, `
        function schedule(promise: Promise<number>) {
          promise.then(value => value + 1)
          setTimeout(() => console.log("later"), 0)
        }
      `);
      const program = ts.createProgram([fileName], {
        target: ts.ScriptTarget.ES2024, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], noEmit: true,
      });
      const analysis = analyzeHostNeutralTransitions(program, program.getSourceFile(fileName)!);
      expect(analysis.schema).toBe("uneffect-host-neutral-transitions/v1");
      expect(analysis.transitions).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "invoke-callback", api: "Promise.prototype.then", lane: "microtask" }),
        expect.objectContaining({ kind: "invoke-callback", api: "setTimeout", lane: "host-task" }),
      ]));
      expect(analysis.transitions.filter((transition) => transition.kind === "invoke-callback"
        && transition.api === "Promise.prototype.then")).toHaveLength(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("lowers a verified external Promise-reaction callback to microtask rejection", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-external-reaction-"));
    try {
      const fileName = join(directory, "entry.ts");
      writeFileSync(fileName, `
        declare function later(callback: () => void): Promise<void>
        function fail() { throw new RangeError("failed") }
        export function run() { return later(fail) }
      `);
      const program = ts.createProgram([fileName], {
        target: ts.ScriptTarget.ES2024, lib: ["lib.es2024.d.ts"], noEmit: true,
      });
      const source = program.getSourceFile(fileName)!;
      const declaration = source.statements.find((statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === "later")!;
      const key = `${fileName}:${declaration.getStart(source)}`;
      const externalFunctionEffects = new Map([[key, {
        effects: [], evidence: "verified" as const, functionName: "later",
        callbackParameters: [{
          index: 0, name: "callback", timing: "promise-reaction" as const,
          cardinality: "0..1" as const, completion: "convert-throw-to-rejection" as const,
        }],
      }]]);
      const analysis = analyzeHostNeutralTransitions(program, source, {
        externalFunctionEffects,
      });

      expect(analysis.transitions).toContainEqual(expect.objectContaining({
        kind: "invoke-callback", api: "later", callback: "fail",
        cardinality: "0..1", lane: "microtask", completion: "reject",
      }));
      expect(analysis.transitions).toContainEqual(expect.objectContaining({
        kind: "settle-promise", promise: "later(fail)", lane: "microtask",
        outcomes: ["fulfilled", "rejected"], mayRemainPending: true,
        synchronousDivergenceReasons: ["opaque-call"],
      }));
      expect(analysis.evidence).toBe("inferred");
      const model = generateHostTransitionModel(program, source, {
        profile: "web", moduleName: "ExternalReaction", externalFunctionEffects,
      });
      expect(model.quint).toContain("promise_reaction_0_0_pending");
      expect(model.quint).toContain("return_promise_executor_0_settled");
      expect(model.quint).toContain("return_promise_executor_0_pending");
      expect(model.quint).toContain("diverge_promise_executor_0");
      const quintFile = join(directory, "external-reaction.qnt");
      writeFileSync(quintFile, model.quint);
      expect(spawnSync("quint", ["typecheck", quintFile], { encoding: "utf8" })).toMatchObject({ status: 0 });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails closed when an external callback path is not a finite literal", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-external-reaction-unknown-"));
    try {
      const fileName = join(directory, "entry.ts");
      writeFileSync(fileName, `
        declare function later(options: { onDone: () => void }): Promise<void>
        export function run(options: { onDone: () => void }) { return later(options) }
      `);
      const program = ts.createProgram([fileName], {
        target: ts.ScriptTarget.ES2024, lib: ["lib.es2024.d.ts"], noEmit: true,
      });
      const source = program.getSourceFile(fileName)!;
      const declaration = source.statements.find((statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === "later")!;
      const analysis = analyzeHostNeutralTransitions(program, source, {
        externalFunctionEffects: new Map([[`${fileName}:${declaration.getStart(source)}`, {
          effects: [], evidence: "verified" as const, functionName: "later",
          callbackParameters: [{
            index: 0, path: ["onDone"], name: "onDone", timing: "promise-reaction" as const,
            cardinality: "0..1" as const, completion: "convert-throw-to-rejection" as const,
          }],
        }]]),
      });

      expect(analysis.transitions).toContainEqual(expect.objectContaining({
        kind: "invoke-callback", callback: "<unresolved>", lane: "unknown", completion: "unknown",
      }));
      expect(analysis.evidence).toBe("unknown");
      expect(analysis.diagnostics).toContainEqual(expect.objectContaining({
        message: expect.stringContaining("cannot be resolved at its declared argument path"),
      }));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("joins external Promise settlement to floating ownership by binding identity", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-external-floating-"));
    try {
      const fileName = join(directory, "entry.ts");
      writeFileSync(fileName, `
        declare function later(callback: () => void): Promise<void>
        function done() {}
        export function run() { const task = later(done) }
      `);
      const program = ts.createProgram([fileName], {
        target: ts.ScriptTarget.ES2024, lib: ["lib.es2024.d.ts"], noEmit: true,
      });
      const source = program.getSourceFile(fileName)!;
      const declaration = source.statements.find((statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === "later")!;
      const analysis = analyzeHostNeutralTransitions(program, source, {
        externalFunctionEffects: new Map([[`${fileName}:${declaration.getStart(source)}`, {
          effects: [], evidence: "verified" as const, functionName: "later",
          callbackParameters: [{
            index: 0, name: "callback", timing: "promise-reaction" as const,
            cardinality: "0..1" as const, completion: "convert-throw-to-rejection" as const,
          }],
        }]]),
      });

      expect(analysis.transitions).toContainEqual(expect.objectContaining({
        kind: "settle-promise", promise: "task",
        promiseIdentity: expect.objectContaining({ fileName }),
        ownership: expect.objectContaining({ status: "floating", observations: [] }),
      }));
      expect(analysis.diagnostics).toContainEqual(expect.objectContaining({ kind: "floating-promise" }));
      expect(analysis.evidence).toBe("unknown");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a throw-to-rejection callback contract on a non-Promise return", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-external-invalid-rejection-"));
    try {
      const fileName = join(directory, "entry.ts");
      writeFileSync(fileName, `
        declare function schedule(callback: () => void): void
        function done() {}
        export function run() { schedule(done) }
      `);
      const program = ts.createProgram([fileName], {
        target: ts.ScriptTarget.ES2024, lib: ["lib.es2024.d.ts"], noEmit: true,
      });
      const source = program.getSourceFile(fileName)!;
      const declaration = source.statements.find((statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === "schedule")!;
      const analysis = analyzeHostNeutralTransitions(program, source, {
        externalFunctionEffects: new Map([[`${fileName}:${declaration.getStart(source)}`, {
          effects: [], evidence: "verified" as const, functionName: "schedule",
          callbackParameters: [{
            index: 0, name: "callback", timing: "promise-reaction" as const,
            cardinality: "0..1" as const, completion: "convert-throw-to-rejection" as const,
          }],
        }]]),
      });

      expect(analysis.transitions.some(({ kind }) => kind === "settle-promise")).toBe(false);
      expect(analysis.evidence).toBe("unknown");
      expect(analysis.diagnostics).toContainEqual(expect.objectContaining({
        message: expect.stringContaining("does not return a TypeChecker-visible Promise"),
      }));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
