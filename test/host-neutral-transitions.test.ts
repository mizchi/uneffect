import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import type { CallableSummary } from "../src/callable-summary.js";
import type { ResourceDisposal } from "../src/async-safety.js";
import type { PromiseChainModel } from "../src/promise-chains.js";
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
        events: [], possibleSettlements: ["fulfilled", "rejected"], mayRemainPending: false, span: { start: 0, end: 4 } }],
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
      expect.objectContaining({ kind: "settle-promise", lane: "inline", outcomes: ["fulfilled", "rejected"], firstSettlementWins: true }),
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
});
