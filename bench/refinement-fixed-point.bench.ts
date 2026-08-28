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
const scalarHandlerFile = "examples/dogfood/scalar-handler-join.ts";
const scalarHandlerSource = readFileSync(scalarHandlerFile, "utf8");
const scalarHandlerSpec = parseSpec(scalarHandlerFile, scalarHandlerSource).temporal;
const scalarProductFile = "examples/dogfood/scalar-product-handler-join.ts";
const scalarProductSource = readFileSync(scalarProductFile, "utf8");
const scalarProductSpec = parseSpec(scalarProductFile, scalarProductSource).temporal;
const scalarProductThreeRegionFile = "examples/dogfood/scalar-product-three-region.ts";
const scalarProductThreeRegionSource = readFileSync(scalarProductThreeRegionFile, "utf8");
const scalarProductThreeRegionSpec = parseSpec(
  scalarProductThreeRegionFile,
  scalarProductThreeRegionSource,
).temporal;
const conditionalScalarProductFile = "examples/dogfood/conditional-scalar-product.ts";
const conditionalScalarProductSource = readFileSync(conditionalScalarProductFile, "utf8");
const conditionalScalarProductSpec = parseSpec(
  conditionalScalarProductFile,
  conditionalScalarProductSource,
).temporal;
const cfgAffineDrainFile = "examples/dogfood/cfg-affine-drain.ts";
const cfgAffineDrainSource = readFileSync(cfgAffineDrainFile, "utf8");
const cfgAffineDrainSpec = parseSpec(cfgAffineDrainFile, cfgAffineDrainSource).temporal;
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
  bench("infer a two-member affine recurrence at a CFG back edge", () => {
    const result = analyzeRefinementActionBodies(
      cfgAffineDrainFile, cfgAffineDrainSource, "cfgAffineDrain", cfgAffineDrainSpec,
      { proofBudget: { cfgFixedPointIterations: 64 } },
    );
    const obligation = result.obligations.find((item) =>
      item.kind === "scalar-recurrence-fixed-point");
    if (result.diagnostics.length !== 0
      || obligation?.reason !== "independent-proof-required"
      || obligation.fixedPoint.members.length !== 2
      || obligation.backEdge.rule !== "source-bound-affine-transformer") {
      throw new Error("CFG affine recurrence benchmark fixture did not converge provisionally");
    }
  }, { time: 500, iterations: 20 });

  bench("independently prove the CFG affine recurrence with Z3", async () => {
    const result = await analyzeRefinementActionBodiesWithZ3(
      cfgAffineDrainFile, cfgAffineDrainSource, "cfgAffineDrain", cfgAffineDrainSpec,
      { analysis: { proofBudget: { cfgFixedPointIterations: 64 } } },
    );
    const obligation = result.obligations.find((item) =>
      item.kind === "scalar-recurrence-fixed-point");
    if (result.diagnostics.length !== 0
      || obligation?.status !== "verified"
      || obligation.recurrenceProof?.status !== "verified") {
      throw new Error("CFG affine recurrence Z3 benchmark fixture did not verify");
    }
  }, { time: 500, iterations: 2 });

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

  bench("carry one scalar environment through two handler regions", () => {
    const result = analyzeRefinementActionBodies(
      scalarHandlerFile, scalarHandlerSource, "scalarHandlerJoin", scalarHandlerSpec,
      { proofBudget: { cfgFixedPointIterations: 64 } },
    );
    const obligation = result.obligations.find((item) =>
      item.kind === "handler-scalar-environment-join");
    if (obligation?.fixedPoint.converged !== true
      || obligation.fixedPoint.regions.length !== 2
      || obligation.reason !== "independent-proof-required") {
      throw new Error("scalar handler environment benchmark fixture did not converge");
    }
  }, { time: 500, iterations: 20 });

  bench("independently prove the sibling-region scalar environment with Z3", async () => {
    const result = await analyzeRefinementActionBodiesWithZ3(
      scalarHandlerFile, scalarHandlerSource, "scalarHandlerJoin", scalarHandlerSpec,
      { analysis: { proofBudget: { cfgFixedPointIterations: 64 } } },
    );
    const obligation = result.obligations.find((item) =>
      item.kind === "handler-scalar-environment-join");
    if (obligation?.status !== "verified" || obligation.proof?.status !== "verified") {
      throw new Error("scalar handler environment Z3 benchmark fixture did not verify");
    }
  }, { time: 500, iterations: 2 });

  bench("carry a two-member scalar product through two handler regions", () => {
    const result = analyzeRefinementActionBodies(
      scalarProductFile, scalarProductSource, "scalarProductJoin", scalarProductSpec,
      { proofBudget: { cfgFixedPointIterations: 64 } },
    );
    const obligation = result.obligations.find((item) =>
      item.kind === "handler-scalar-environment-join");
    if (obligation?.fixedPoint.converged !== true
      || obligation.fixedPoint.members.length !== 2
      || obligation.reason !== "independent-proof-required") {
      throw new Error("scalar product handler environment benchmark fixture did not converge");
    }
  }, { time: 500, iterations: 20 });

  bench("independently prove both scalar product members with Z3", async () => {
    const result = await analyzeRefinementActionBodiesWithZ3(
      scalarProductFile, scalarProductSource, "scalarProductJoin", scalarProductSpec,
      { analysis: { proofBudget: { cfgFixedPointIterations: 64 } } },
    );
    const obligation = result.obligations.find((item) =>
      item.kind === "handler-scalar-environment-join");
    if (obligation?.status !== "verified"
      || obligation.proof?.checks.length !== 2
      || obligation.proof.checks.some((check) => check.status !== "verified")) {
      throw new Error("scalar product handler environment Z3 benchmark fixture did not verify");
    }
  }, { time: 500, iterations: 2 });

  bench("carry a two-member scalar product through three handler regions", () => {
    const result = analyzeRefinementActionBodies(
      scalarProductThreeRegionFile,
      scalarProductThreeRegionSource,
      "scalarProductThreeRegion",
      scalarProductThreeRegionSpec,
      { proofBudget: { cfgFixedPointIterations: 64 } },
    );
    const obligation = result.obligations.find((item) =>
      item.kind === "handler-scalar-environment-join");
    if (obligation?.fixedPoint.converged !== true
      || obligation.fixedPoint.members.length !== 2
      || obligation.fixedPoint.members.some((member) => member.regions.length !== 3)
      || obligation.reason !== "independent-proof-required") {
      throw new Error("three-region scalar product benchmark fixture did not converge");
    }
  }, { time: 500, iterations: 20 });

  bench("independently prove both three-region product members with Z3", async () => {
    const result = await analyzeRefinementActionBodiesWithZ3(
      scalarProductThreeRegionFile,
      scalarProductThreeRegionSource,
      "scalarProductThreeRegion",
      scalarProductThreeRegionSpec,
      { analysis: { proofBudget: { cfgFixedPointIterations: 64 } } },
    );
    const obligation = result.obligations.find((item) =>
      item.kind === "handler-scalar-environment-join");
    if (obligation?.status !== "verified"
      || obligation.proof?.checks.length !== 2
      || obligation.proof.checks.some((check) => check.status !== "verified")) {
      throw new Error("three-region scalar product Z3 benchmark fixture did not verify");
    }
  }, { time: 500, iterations: 2 });

  bench("join a scalar product after conditional handler selection", () => {
    const result = analyzeRefinementActionBodies(
      conditionalScalarProductFile,
      conditionalScalarProductSource,
      "conditionalScalarProduct",
      conditionalScalarProductSpec,
      { proofBudget: { cfgFixedPointIterations: 64 } },
    );
    const obligation = result.obligations.find((item) =>
      item.kind === "handler-scalar-environment-join");
    if (obligation?.fixedPoint.converged !== true
      || obligation.fixedPoint.members.length !== 2
      || obligation.conditionalJoin?.rule !== "predicate-correlated-phi"
      || obligation.reason !== "independent-proof-required") {
      throw new Error("conditional scalar product benchmark fixture did not converge");
    }
  }, { time: 500, iterations: 20 });

  bench("independently prove both conditional product members with Z3", async () => {
    const result = await analyzeRefinementActionBodiesWithZ3(
      conditionalScalarProductFile,
      conditionalScalarProductSource,
      "conditionalScalarProduct",
      conditionalScalarProductSpec,
      { analysis: { proofBudget: { cfgFixedPointIterations: 64 } } },
    );
    const obligation = result.obligations.find((item) =>
      item.kind === "handler-scalar-environment-join");
    if (obligation?.status !== "verified"
      || obligation.proof?.checks.length !== 2
      || obligation.proof.checks.some((check) => check.status !== "verified")) {
      throw new Error("conditional scalar product Z3 benchmark fixture did not verify");
    }
  }, { time: 500, iterations: 2 });

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
