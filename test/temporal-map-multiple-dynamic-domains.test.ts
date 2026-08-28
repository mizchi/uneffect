import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findTemporalCounterexampleWithZ3 } from "../src/spec-lint.js";
import { parseSpec } from "../src/spec-ir.js";

const fixture = `/* uneffect:
  state nodes: Set<int>
  state primary: int
  state backup: int
  state leases: Map<int, int>
  init nodes = Set(1, 2)
  init primary = 1
  init backup = 1
  init leases = Map([[1, 7]])
  action selectBackup: backup' = 2
  action retain: primary' = primary, backup' = backup
  temporal primaryIsNode: nodes.contains(primary)
  temporal backupIsNode: nodes.contains(backup)
  temporal selectedLeasesExist: leases.getOrElse(primary, 0) > 0 && leases.getOrElse(backup, 0) > 0
*/`;

describe("proved finite domains for multiple temporal Map keys", () => {
  it("proves every key independently before decoding one counterexample", async () => {
    const temporal = parseSpec("multiple-map-domains.ts", fixture).temporal;
    const result = await findTemporalCounterexampleWithZ3(temporal, "selectedLeasesExist", { maxSteps: 2 });
    expect(result).toMatchObject({
        status: "counterexample",
        depth: 1,
        observationDomains: [
          {
            rule: "inductively-proved-finite-membership",
            domainState: "nodes",
            keyState: "backup",
            property: "backupIsNode",
            values: [1, 2],
            proof: {
              initSatisfiable: "verified",
              membershipInitiation: "verified",
              domainStability: "verified-by-syntax",
              membershipPreservation: "verified",
            },
          },
          {
            rule: "inductively-proved-finite-membership",
            domainState: "nodes",
            keyState: "primary",
            property: "primaryIsNode",
            values: [1, 2],
            proof: {
              initSatisfiable: "verified",
              membershipInitiation: "verified",
              domainStability: "verified-by-syntax",
              membershipPreservation: "verified",
            },
          },
        ],
        trace: {
          initialState: { nodes: [1, 2], primary: 1, backup: 1, leases: [[1, 7]] },
          steps: [{ action: "selectBackup", after: { nodes: [1, 2], primary: 1, backup: 2, leases: [[1, 7]] } }],
        },
      });
    if (result.status !== "counterexample") throw new Error(`expected counterexample, got ${result.status}`);
    expect(result.observationDomains).toHaveLength(2);
    for (const evidence of result.observationDomains ?? []) {
      expect(evidence.proof.solverChecks).toEqual([
        { obligation: "init-satisfiable", result: "sat", backend: expect.stringMatching(/^(native|wasm)$/), version: expect.any(String) },
        { obligation: "membership-initiation", result: "unsat", backend: expect.stringMatching(/^(native|wasm)$/), version: expect.any(String) },
        { obligation: "membership-preservation", result: "unsat", backend: expect.stringMatching(/^(native|wasm)$/), version: expect.any(String) },
      ]);
    }
  });

  it("fails the whole universe closed when any key proof premise is absent", async () => {
    for (const [name, source] of [
      ["missing-membership", fixture.replace("  temporal backupIsNode: nodes.contains(backup)\n", "")],
      ["non-inductive-key", fixture.replace("action selectBackup: backup' = 2", "action selectBackup: backup' = 3")],
      ["compound-key", fixture.replace("leases.getOrElse(backup, 0)", "leases.getOrElse(backup + 0, 0)")],
      ["mutable-domain", fixture.replace("action selectBackup: backup' = 2", "action selectBackup: backup' = 2, nodes' = nodes.union(Set(3))")],
      ["ambiguous-backup-domain", fixture
        .replace("state primary: int", "state primary: int\n  state backupNodes: Set<int>")
        .replace("init primary = 1", "init primary = 1\n  init backupNodes = Set(1, 2)")
        .replace("temporal backupIsNode: nodes.contains(backup)", "temporal backupIsNode: nodes.contains(backup)\n  temporal backupIsOtherNode: backupNodes.contains(backup)")],
    ] as const) {
      const temporal = parseSpec(`${name}.ts`, source).temporal;
      await expect(findTemporalCounterexampleWithZ3(temporal, "selectedLeasesExist", { maxSteps: 2 }), name)
        .resolves.toEqual({ status: "unknown", depth: 0 });
    }

    const temporal = parseSpec("multiple-map-domains-solver-unavailable.ts", fixture).temporal;
    await expect(findTemporalCounterexampleWithZ3(temporal, "selectedLeasesExist", {
      maxSteps: 2,
      z3: { preference: "native", nativeExecutable: "/definitely/missing/uneffect-z3" },
    })).resolves.toEqual({ status: "unknown", depth: 0 });
  });

  it("dogfoods primary and standby Node Lease selectors without scalarizing either key", async () => {
    const fileName = "examples/dogfood/node-lease-primary-backup-map-domains.ts";
    const source = readFileSync(fileName, "utf8");
    const safe = parseSpec(fileName, source).temporal;
    await expect(findTemporalCounterexampleWithZ3(safe, "selectedLeasesAreFenced", { maxSteps: 2 }))
      .resolves.toMatchObject({
        status: "safe-within-bound",
        depth: 2,
        observationDomains: [
          { domainState: "nodes", keyState: "backupNode", property: "backupNodeIsKnown", values: [1, 2] },
          { domainState: "nodes", keyState: "primaryNode", property: "primaryNodeIsKnown", values: [1, 2] },
        ],
      });

    const broken = parseSpec("node-lease-primary-backup-broken.ts", source.replaceAll(
      "{ epoch: 0, valid: false }",
      "{ epoch: 0, valid: true }",
    )).temporal;
    await expect(findTemporalCounterexampleWithZ3(broken, "selectedLeasesAreFenced", { maxSteps: 2 }))
      .resolves.toMatchObject({
        status: "counterexample",
        depth: 1,
        trace: { steps: [{ action: "selectStandby", after: { primaryNode: 1, backupNode: 2 } }] },
      });
  });
});
