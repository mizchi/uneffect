import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findTemporalCounterexampleWithZ3 } from "../src/spec-lint.js";
import { parseSpec } from "../src/spec-ir.js";

const fixture = `/* uneffect: state nodes: Set<int> */ /* uneffect: state selected: int */ /* uneffect: state leases: Map<int, int> */ /* uneffect: init nodes = Set(1, 2) */ /* uneffect: init selected = 1 */ /* uneffect: init leases = Map([[1, 7]]) */ /* uneffect: action selectMissing: selected' = 2 */ /* uneffect: action observe: selected' = selected */ /* uneffect:always selectedIsNode: nodes.contains(selected) */ /* uneffect:always selectedHasLease: leases.getOrElse(selected, 0) > 0 */`;

describe("proved finite domains for dynamic temporal Map keys", () => {
  it("extracts a JSON-safe counterexample after independently proving membership", async () => {
    const temporal = parseSpec("dynamic-map-domain.ts", fixture).temporal;
    await expect(findTemporalCounterexampleWithZ3(temporal, "selectedHasLease", { maxSteps: 2 }))
      .resolves.toMatchObject({
        status: "counterexample",
        depth: 1,
        observationDomains: [{
          rule: "inductively-proved-finite-membership",
          domainState: "nodes",
          keyState: "selected",
          property: "selectedIsNode",
          values: [1, 2],
          proof: {
            initSatisfiable: "verified",
            membershipInitiation: "verified",
            domainStability: "verified-by-syntax",
            membershipPreservation: "verified",
            solverChecks: [
              { obligation: "init-satisfiable", result: "sat", backend: expect.stringMatching(/^(native|wasm)$/), version: expect.any(String) },
              { obligation: "membership-initiation", result: "unsat", backend: expect.stringMatching(/^(native|wasm)$/), version: expect.any(String) },
              { obligation: "membership-preservation", result: "unsat", backend: expect.stringMatching(/^(native|wasm)$/), version: expect.any(String) },
            ],
          },
        }],
        trace: {
          initialState: { nodes: [1, 2], selected: 1, leases: [[1, 7]] },
          steps: [{ action: "selectMissing", after: { nodes: [1, 2], selected: 2, leases: [[1, 7]] } }],
        },
      });

    const explicitStutter = parseSpec("dynamic-map-domain-stutter.ts", fixture.replace(
      "action selectMissing: selected' = 2",
      "action selectMissing: selected' = 2, nodes' = nodes",
    )).temporal;
    await expect(findTemporalCounterexampleWithZ3(explicitStutter, "selectedHasLease", { maxSteps: 2 }))
      .resolves.toMatchObject({ status: "counterexample", depth: 1 });
  });

  it("fails closed when any finite-domain proof premise is absent", async () => {
    for (const [name, source] of [
      ["missing-property", fixture.replace("/* uneffect:always selectedIsNode: nodes.contains(selected) */", "")],
      ["mutated-domain", fixture.replace("action selectMissing: selected' = 2", "action selectMissing: selected' = 2, nodes' = nodes.union(Set(3))")],
      ["non-inductive", fixture.replace("action selectMissing: selected' = 2", "action selectMissing: selected' = 3")],
      ["compound-key", fixture.replace("leases.getOrElse(selected, 0)", "leases.getOrElse(selected + 0, 0)")],
      ["dynamic-domain", fixture.replace("init nodes = Set(1, 2)", "init nodes = Set(selected)")],
      ["dynamic-map-put", fixture.replace(
        "action observe: selected' = selected",
        "action observe: selected' = selected, leases' = leases.put(selected, 9)",
      )],
      ["empty-domain", fixture.replace("init nodes = Set(1, 2)", "init nodes = Set()")],
      ["ambiguous-domain", fixture.replace(
        "state selected: int",
        "state selected: int\n  state otherNodes: Set<int>",
      ).replace(
        "init selected = 1",
        "init selected = 1\n  init otherNodes = Set(1, 2)",
      ).replace(
        "always selectedIsNode: nodes.contains(selected)",
        "always selectedIsNode: nodes.contains(selected) */ /* uneffect:always selectedIsOtherNode: otherNodes.contains(selected)",
      )],
    ] as const) {
      const temporal = parseSpec(`${name}.ts`, source).temporal;
      await expect(findTemporalCounterexampleWithZ3(temporal, "selectedHasLease", { maxSteps: 2 }), name)
        .resolves.toEqual({ status: "unknown", depth: 0 });
    }

    const temporal = parseSpec("solver-unavailable.ts", fixture).temporal;
    await expect(findTemporalCounterexampleWithZ3(temporal, "selectedHasLease", {
      maxSteps: 2,
      z3: { preference: "native", nativeExecutable: "/definitely/missing/uneffect-z3" },
    })).resolves.toEqual({ status: "unknown", depth: 0 });
  });

  it("supports the same proved fragment for boolean Map keys", async () => {
    const temporal = parseSpec("dynamic-bool-map-domain.ts", `/* uneffect: state flags: Set<bool> */ /* uneffect: state selected: bool */ /* uneffect: state values: Map<bool, int> */ /* uneffect: init flags = Set(false, true) */ /* uneffect: init selected = false */ /* uneffect: init values = Map([[false, 1]]) */ /* uneffect: action selectMissing: selected' = true */ /* uneffect:always selectedIsFlag: flags.contains(selected) */ /* uneffect:always selectedHasValue: values.getOrElse(selected, 0) > 0 */`).temporal;
    await expect(findTemporalCounterexampleWithZ3(temporal, "selectedHasValue", { maxSteps: 1 }))
      .resolves.toMatchObject({
        status: "counterexample",
        depth: 1,
        observationDomains: [{ values: [false, true] }],
        trace: { steps: [{ after: { selected: true, values: [[false, 1]] } }] },
      });
  });

  it("dogfoods a record-valued Node Lease table without scalarizing nodes", async () => {
    const fileName = "examples/dogfood/node-lease-dynamic-map-domain.ts";
    const source = readFileSync(fileName, "utf8");
    const safe = parseSpec(fileName, source).temporal;
    await expect(findTemporalCounterexampleWithZ3(safe, "absentSelectedLeaseIsFenced", { maxSteps: 2 }))
      .resolves.toMatchObject({
        status: "safe-within-bound",
        depth: 2,
        observationDomains: [{ domainState: "nodes", keyState: "selectedNode", values: [1, 2] }],
      });

    const broken = parseSpec("node-lease-dynamic-map-domain-broken.ts", source.replace(
      "{ epoch: 0, valid: false }",
      "{ epoch: 0, valid: true }",
    )).temporal;
    await expect(findTemporalCounterexampleWithZ3(broken, "absentSelectedLeaseIsFenced", { maxSteps: 2 }))
      .resolves.toMatchObject({
        status: "counterexample",
        depth: 1,
        trace: { steps: [{ action: "selectStandby", after: { selectedNode: 2 } }] },
      });
  });
});
