import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findTemporalCounterexampleWithZ3 } from "../src/spec-lint.js";
import { parseSpec } from "../src/spec-ir.js";

const fixture = `/* uneffect: state nodes: Set<int> */ /* uneffect: state primaryNode: int */ /* uneffect: state backupNode: int */ /* uneffect: state leases: Map<int, { epoch: int, valid: bool }> */ /* uneffect: init nodes = Set(1, 2) */ /* uneffect: init primaryNode = 1 */ /* uneffect: init backupNode = 1 */ /* uneffect: init leases = Map([[1, { epoch: 1, valid: true }]]) */ /* uneffect: action selectStandby: backupNode' = 2 */ /* uneffect: action promoteStandby: primaryNode' = backupNode, backupNode' = 2 */ /* uneffect:always primaryNodeIsKnown: nodes.contains(primaryNode) */ /* uneffect:always backupNodeIsKnown: nodes.contains(backupNode) */ /* uneffect:always selectedLeasesAreFenced: (!leases.getOrElse(primaryNode, { epoch: 0, valid: false }).valid || leases.keys().contains(primaryNode)) && (!leases.getOrElse(backupNode, { epoch: -1, valid: false }).valid || leases.keys().contains(backupNode)) */`;

describe("jointly inductive finite domains for temporal Map keys", () => {
  it("uses the complete membership conjunction for a primary/backup failover", async () => {
    const temporal = parseSpec("joint-map-domains.ts", fixture).temporal;
    const result = await findTemporalCounterexampleWithZ3(temporal, "selectedLeasesAreFenced", { maxSteps: 2 });
    expect(result).toMatchObject({
      status: "safe-within-bound",
      depth: 2,
      observationDomains: [
        {
          rule: "jointly-inductive-finite-membership",
          keyState: "backupNode",
          property: "backupNodeIsKnown",
          proof: {
            membershipPreservation: "verified-jointly",
            preservationAssumptions: ["backupNodeIsKnown", "primaryNodeIsKnown"],
            solverChecks: expect.arrayContaining([
              expect.objectContaining({ obligation: "joint-membership-preservation", result: "unsat" }),
            ]),
          },
        },
        {
          rule: "jointly-inductive-finite-membership",
          keyState: "primaryNode",
          property: "primaryNodeIsKnown",
          proof: {
            membershipPreservation: "verified-jointly",
            preservationAssumptions: ["backupNodeIsKnown", "primaryNodeIsKnown"],
            solverChecks: expect.arrayContaining([
              expect.objectContaining({ obligation: "joint-membership-preservation", result: "unsat" }),
            ]),
          },
        },
      ],
    });
    if (result.status !== "safe-within-bound") throw new Error(`expected bounded safety, got ${result.status}`);
    for (const evidence of result.observationDomains ?? []) {
      expect(evidence.proof.solverChecks).toEqual([
        { obligation: "init-satisfiable", result: "sat", backend: expect.stringMatching(/^(native|wasm)$/), version: expect.any(String) },
        { obligation: "membership-initiation", result: "unsat", backend: expect.stringMatching(/^(native|wasm)$/), version: expect.any(String) },
        { obligation: "joint-membership-preservation", result: "unsat", backend: expect.stringMatching(/^(native|wasm)$/), version: expect.any(String) },
      ]);
    }

    const broken = parseSpec("joint-map-domains-broken.ts", fixture.replace(
      "{ epoch: 0, valid: false }",
      "{ epoch: 0, valid: true }",
    )).temporal;
    await expect(findTemporalCounterexampleWithZ3(broken, "selectedLeasesAreFenced", { maxSteps: 2 }))
      .resolves.toMatchObject({
        status: "counterexample",
        depth: 2,
        trace: { steps: [
          { action: "selectStandby", after: { primaryNode: 1, backupNode: 2 } },
          { action: "promoteStandby", after: { primaryNode: 2, backupNode: 2 } },
        ] },
      });
  });

  it("fails closed when the complete conjunction cannot be initiated or preserved", async () => {
    for (const [name, source] of [
      ["missing-member", fixture.replace("/* uneffect:always backupNodeIsKnown: nodes.contains(backupNode) */ ", "")],
      ["out-of-domain", fixture.replace("action selectStandby: backupNode' = 2", "action selectStandby: backupNode' = 3")],
      ["compound-primary", fixture.replace("leases.getOrElse(primaryNode,", "leases.getOrElse(primaryNode + 0,")],
      ["mutable-domain", fixture.replace("action selectStandby: backupNode' = 2", "action selectStandby: backupNode' = 2, nodes' = nodes.union(Set(3))")],
    ] as const) {
      const temporal = parseSpec(`${name}.ts`, source).temporal;
      await expect(findTemporalCounterexampleWithZ3(temporal, "selectedLeasesAreFenced", { maxSteps: 2 }), name)
        .resolves.toEqual({ status: "unknown", depth: 0 });
    }

    const temporal = parseSpec("joint-map-domains-solver-unavailable.ts", fixture).temporal;
    await expect(findTemporalCounterexampleWithZ3(temporal, "selectedLeasesAreFenced", {
      maxSteps: 2,
      z3: { preference: "native", nativeExecutable: "/definitely/missing/uneffect-z3" },
    })).resolves.toEqual({ status: "unknown", depth: 0 });
  });

  it("dogfoods a depth-two primary/standby Node Lease failover", async () => {
    const fileName = "examples/dogfood/node-lease-failover-joint-map-domains.ts";
    const source = readFileSync(fileName, "utf8");
    const safe = parseSpec(fileName, source).temporal;
    await expect(findTemporalCounterexampleWithZ3(safe, "selectedLeasesAreFenced", { maxSteps: 2 }))
      .resolves.toMatchObject({
        status: "safe-within-bound",
        depth: 2,
        observationDomains: [
          { rule: "jointly-inductive-finite-membership", keyState: "backupNode" },
          { rule: "jointly-inductive-finite-membership", keyState: "primaryNode" },
        ],
      });

    const broken = parseSpec("node-lease-failover-joint-broken.ts", source.replace(
      "{ epoch: 0, valid: false }",
      "{ epoch: 0, valid: true }",
    )).temporal;
    await expect(findTemporalCounterexampleWithZ3(broken, "selectedLeasesAreFenced", { maxSteps: 2 }))
      .resolves.toMatchObject({ status: "counterexample", depth: 2 });
  });
});
