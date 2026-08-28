import { readFileSync } from "node:fs";
import ts from "typescript";
import { bench, describe } from "vitest";
import { analyzeRefinementActionBodies, analyzeRefinementActionBodiesInProgram, analyzeRefinementActionBodiesWithZ3 } from "../src/refinement-bindings.js";
import { parseSpec } from "../src/spec-ir.js";

const source = `/* uneffect:
  state pending: int
  state delivered: int
  state failed: int
  state audited: int
  state reject: bool
  init pending = 0
  init delivered = 0
  init failed = 0
  init audited = 0
  init reject = false
  action drain: pending' = pending > 0 ? 0 : pending, delivered' = delivered + (pending > 0 ? (reject ? 0 : pending * (pending + 1) / 2) : 0), failed' = failed + (pending > 0 ? (reject ? pending * (pending + 1) / 2 : 0) : 0), audited' = audited + (pending > 0 ? pending : 0)
*/
  interface Runtime { pending: number; delivered: number; failed: number; audited: number; reject: boolean }
  /* uneffect: refinement fixedPointJoin@1 create */ export function create(initial: Runtime) { return initial }
  /* uneffect: refinement fixedPointJoin@1 observe */ export function observe(runtime: Runtime) { return runtime }
  /* uneffect: refinement fixedPointJoin@1 action drain */
  export function drain(runtime: Runtime) {
    while (runtime.pending > 0) {
      try {
        if (runtime.reject) throw runtime.pending
        runtime.delivered += runtime.pending
      } catch (amount) {
        runtime.failed += amount
      } finally {
        runtime.pending--
        runtime.audited++
      }
    }
  }
`;
const spec = parseSpec("refinement-fixed-point.ts", source).temporal;
const handlerJoinFile = "examples/dogfood/telemetry-routing-accounting.ts";
const handlerJoinSource = readFileSync(handlerJoinFile, "utf8");
const handlerJoinSpec = parseSpec(handlerJoinFile, handlerJoinSource).temporal;
const aliasFile = "examples/dogfood/local-alias-refinement.ts";
const aliasSource = readFileSync(aliasFile, "utf8");
const aliasSpec = parseSpec(aliasFile, aliasSource).temporal;
const aliasProgram = ts.createProgram([aliasFile], {
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  noEmit: true,
});

describe("refinement CFG fixed point", () => {
  bench("analyze a ranking loop throw/normal join", () => {
    const result = analyzeRefinementActionBodies(
      "refinement-fixed-point.ts", source, "fixedPointJoin", spec,
      { proofBudget: { cfgFixedPointIterations: 64 } },
    );
    if (result.diagnostics.length !== 0 || result.obligations[0]?.status !== "verified") {
      throw new Error("ranking-loop fixed-point benchmark fixture did not verify");
    }
  }, { time: 500, iterations: 20 });

  bench("independently prove the recurrence summary with Z3", async () => {
    const result = await analyzeRefinementActionBodiesWithZ3(
      "refinement-fixed-point.ts", source, "fixedPointJoin", spec,
      { analysis: { proofBudget: { cfgFixedPointIterations: 64 } } },
    );
    const obligation = result.obligations.find((item) => item.kind === "ranking-loop-fixed-point");
    if (result.diagnostics.length !== 0
      || obligation?.recurrenceProof?.status !== "verified") {
      throw new Error("ranking-loop recurrence proof benchmark fixture did not verify");
    }
  }, { time: 500, iterations: 2 });

  bench("analyze an application switch/catch/finally join", () => {
    const result = analyzeRefinementActionBodies(
      handlerJoinFile, handlerJoinSource, "telemetryRouting", handlerJoinSpec,
      { proofBudget: { cfgFixedPointIterations: 32 } },
    );
    const obligation = result.obligations.find((item) =>
      item.kind === "handler-join-fixed-point" && item.modelName === "routeRecovery");
    if (result.diagnostics.some((item) => item.modelName === "routeRecovery")
      || obligation?.status !== "verified") {
      throw new Error("handler-join fixed-point benchmark fixture did not verify");
    }
  }, { time: 500, iterations: 20 });

  bench("analyze an application nested-if/catch join", () => {
    const result = analyzeRefinementActionBodies(
      handlerJoinFile, handlerJoinSource, "telemetryRouting", handlerJoinSpec,
      { proofBudget: { cfgFixedPointIterations: 32 } },
    );
    const obligation = result.obligations.find((item) =>
      item.kind === "handler-join-fixed-point" && item.modelName === "nestedReject");
    if (result.diagnostics.some((item) => item.modelName === "nestedReject")
      || obligation?.status !== "verified") {
      throw new Error("nested handler CFG benchmark fixture did not verify");
    }
  }, { time: 500, iterations: 20 });

  bench("analyze a handler sequence with abrupt suffix exclusion", () => {
    const result = analyzeRefinementActionBodies(
      handlerJoinFile, handlerJoinSource, "telemetryRouting", handlerJoinSpec,
      { proofBudget: { cfgFixedPointIterations: 32 } },
    );
    const obligation = result.obligations.find((item) =>
      item.kind === "handler-join-fixed-point" && item.modelName === "returnOrReject");
    if (result.diagnostics.some((item) => item.modelName === "returnOrReject")
      || obligation?.status !== "verified") {
      throw new Error("handler sequence CFG benchmark fixture did not verify");
    }
  }, { time: 500, iterations: 20 });

  bench("correlate a caught path predicate with its value join", () => {
    const result = analyzeRefinementActionBodies(
      handlerJoinFile, handlerJoinSource, "telemetryRouting", handlerJoinSpec,
      { proofBudget: { cfgFixedPointIterations: 32 } },
    );
    const obligation = result.obligations.find((item) =>
      item.kind === "handler-join-fixed-point" && item.modelName === "reject");
    if (result.diagnostics.some((item) => item.modelName === "reject")
      || obligation?.status !== "verified"
      || obligation.pathCorrelation?.rule !== "same-predicate-branch-restriction") {
      throw new Error("handler path/value correlation benchmark fixture did not verify");
    }
  }, { time: 500, iterations: 20 });

  bench("analyze application abrupt-finally overrides", () => {
    const result = analyzeRefinementActionBodies(
      handlerJoinFile, handlerJoinSource, "telemetryRouting", handlerJoinSpec,
      { proofBudget: { cfgFixedPointIterations: 32 } },
    );
    const obligation = result.obligations.find((item) =>
      item.kind === "handler-join-fixed-point" && item.modelName === "finalizeRecovery");
    if (result.diagnostics.some((item) => item.modelName === "finalizeRecovery")
      || obligation?.status !== "verified"
      || obligation.completionJoin.finallyOverrides.join("|") !== "return|throw") {
      throw new Error("abrupt finally CFG benchmark fixture did not verify");
    }
  }, { time: 500, iterations: 20 });

  bench("analyze two bounded sibling handler roots", () => {
    const result = analyzeRefinementActionBodies(
      handlerJoinFile, handlerJoinSource, "telemetryRouting", handlerJoinSpec,
      { proofBudget: { cfgFixedPointIterations: 32 } },
    );
    const obligation = result.obligations.find((item) =>
      item.kind === "handler-join-fixed-point" && item.modelName === "stagedReject");
    if (result.diagnostics.some((item) => item.modelName === "stagedReject")
      || obligation?.status !== "verified"
      || obligation.controlRootBudget.observed !== 2) {
      throw new Error("bounded sibling handler CFG benchmark fixture did not verify");
    }
  }, { time: 500, iterations: 20 });

  bench("analyze a finite handler-local for-of", () => {
    const result = analyzeRefinementActionBodies(
      handlerJoinFile, handlerJoinSource, "telemetryRouting", handlerJoinSpec,
      { proofBudget: { cfgFixedPointIterations: 32 } },
    );
    const obligation = result.obligations.find((item) =>
      item.kind === "handler-join-fixed-point" && item.modelName === "scanConfigured");
    if (result.diagnostics.some((item) => item.modelName === "scanConfigured")
      || obligation?.status !== "verified"
      || obligation.finiteLoopBudget?.observed !== 2) {
      throw new Error("finite handler-local loop benchmark fixture did not verify");
    }
  }, { time: 500, iterations: 20 });

  bench("analyze one bounded nested try/catch", () => {
    const result = analyzeRefinementActionBodies(
      handlerJoinFile, handlerJoinSource, "telemetryRouting", handlerJoinSpec,
      { proofBudget: { cfgFixedPointIterations: 64 } },
    );
    const obligation = result.obligations.find((item) =>
      item.kind === "handler-join-fixed-point" && item.modelName === "nestedRecovery");
    if (result.diagnostics.some((item) => item.modelName === "nestedRecovery")
      || obligation?.status !== "verified"
      || obligation.handlerNestingBudget?.observed !== 2) {
      throw new Error("bounded nested handler CFG benchmark fixture did not verify");
    }
  }, { time: 500, iterations: 20 });

  bench("analyze two source-keyed sibling nested handlers", () => {
    const result = analyzeRefinementActionBodies(
      handlerJoinFile, handlerJoinSource, "telemetryRouting", handlerJoinSpec,
      { proofBudget: { cfgFixedPointIterations: 64 } },
    );
    const obligation = result.obligations.find((item) =>
      item.kind === "handler-join-fixed-point" && item.modelName === "stagedNestedRecovery");
    const regionCount = obligation?.kind === "handler-join-fixed-point"
      ? Object.keys(obligation.fixedPoint.blockCompletions)
        .filter((id) => id.startsWith("nested-handler-join:")).length : 0;
    if (result.diagnostics.some((item) => item.modelName === "stagedNestedRecovery")
      || obligation?.status !== "verified" || regionCount !== 2) {
      throw new Error("source-keyed sibling nested handler benchmark fixture did not verify");
    }
  }, { time: 500, iterations: 20 });

  bench("analyze one TypeChecker-backed local alias helper region", () => {
    const result = analyzeRefinementActionBodiesInProgram(
      aliasProgram, aliasFile, "localAlias", aliasSpec,
    );
    const obligation = result.obligations.find((item) => item.kind === "local-alias-helper");
    if (result.diagnostics.length !== 0 || obligation?.status !== "verified") {
      throw new Error("local alias helper region benchmark fixture did not verify");
    }
  }, { time: 500, iterations: 20 });
});
