import { readFileSync } from "node:fs";
import { bench, describe } from "vitest";
import { findTemporalCounterexampleWithZ3 } from "../src/spec-lint.js";
import { parseSpec } from "../src/spec-ir.js";

const fileName = "examples/dogfood/node-lease-dynamic-map-domain.ts";
const source = readFileSync(fileName, "utf8");
const safe = parseSpec(fileName, source).temporal;
const broken = parseSpec(fileName, source.replace(
  "{ epoch: 0, valid: false }",
  "{ epoch: 0, valid: true }",
)).temporal;
const multipleFileName = "examples/dogfood/node-lease-primary-backup-map-domains.ts";
const multipleSource = readFileSync(multipleFileName, "utf8");
const multipleSafe = parseSpec(multipleFileName, multipleSource).temporal;
const multipleBroken = parseSpec(multipleFileName, multipleSource.replaceAll(
  "{ epoch: 0, valid: false }",
  "{ epoch: 0, valid: true }",
)).temporal;
const jointFileName = "examples/dogfood/node-lease-failover-joint-map-domains.ts";
const jointSource = readFileSync(jointFileName, "utf8");
const jointSafe = parseSpec(jointFileName, jointSource).temporal;
const jointBroken = parseSpec(jointFileName, jointSource.replace(
  "{ epoch: 0, valid: false }",
  "{ epoch: 0, valid: true }",
)).temporal;
const stringFileName = "examples/dogfood/node-lease-string-identities.ts";
const stringSource = readFileSync(stringFileName, "utf8");
const stringSafe = parseSpec(stringFileName, stringSource).temporal;
const recordGrantFileName = "examples/dogfood/node-lease-record-grants.ts";
const recordGrantSource = readFileSync(recordGrantFileName, "utf8");
const recordGrantBroken = parseSpec(recordGrantFileName, recordGrantSource.replace("epoch: 2", "epoch: 0")).temporal;

describe("proved dynamic Map key domain", () => {
  bench("extract the record-valued Node Lease grant", async () => {
    const result = await findTemporalCounterexampleWithZ3(
      recordGrantBroken, "validGrantHasEpoch", { maxSteps: 2 },
    );
    if (result.status !== "counterexample" || result.depth !== 1) {
      throw new Error(`expected record-valued Set counterexample, got ${result.status}`);
    }
  }, { time: 500, iterations: 2 });

  bench("prove the string-identity Node Lease lookup", async () => {
    const result = await findTemporalCounterexampleWithZ3(
      stringSafe, "missingLeaseIsFenced", { maxSteps: 3 },
    );
    if (result.status !== "safe-within-bound"
      || result.observationDomains?.[0]?.values.join(",") !== "node-a,node-b") {
      throw new Error(`expected proved string observation domain, got ${result.status}`);
    }
  }, { time: 500, iterations: 2 });

  bench("prove and decode the bounded-safe Node Lease lookup", async () => {
    const result = await findTemporalCounterexampleWithZ3(
      safe, "absentSelectedLeaseIsFenced", { maxSteps: 2 },
    );
    if (result.status !== "safe-within-bound" || !result.observationDomains?.length) {
      throw new Error(`expected proved finite observation domain, got ${result.status}`);
    }
  }, { time: 500, iterations: 2 });

  bench("extract the broken dynamic lease fallback", async () => {
    const result = await findTemporalCounterexampleWithZ3(
      broken, "absentSelectedLeaseIsFenced", { maxSteps: 2 },
    );
    if (result.status !== "counterexample") throw new Error(`expected counterexample, got ${result.status}`);
  }, { time: 500, iterations: 2 });

  bench("prove two selectors and decode the bounded-safe Node Lease lookup", async () => {
    const result = await findTemporalCounterexampleWithZ3(
      multipleSafe, "selectedLeasesAreFenced", { maxSteps: 2 },
    );
    if (result.status !== "safe-within-bound" || result.observationDomains?.length !== 2) {
      throw new Error(`expected two proved finite observation domains, got ${result.status}`);
    }
  }, { time: 500, iterations: 2 });

  bench("extract the broken primary/backup lease fallback", async () => {
    const result = await findTemporalCounterexampleWithZ3(
      multipleBroken, "selectedLeasesAreFenced", { maxSteps: 2 },
    );
    if (result.status !== "counterexample") throw new Error(`expected counterexample, got ${result.status}`);
  }, { time: 500, iterations: 2 });

  bench("prove the jointly inductive failover selectors", async () => {
    const result = await findTemporalCounterexampleWithZ3(
      jointSafe, "selectedLeasesAreFenced", { maxSteps: 2 },
    );
    if (result.status !== "safe-within-bound"
      || result.observationDomains?.some((domain) => domain.rule !== "jointly-inductive-finite-membership")) {
      throw new Error(`expected jointly proved finite observation domains, got ${result.status}`);
    }
  }, { time: 500, iterations: 2 });

  bench("extract the broken jointly inductive failover fallback", async () => {
    const result = await findTemporalCounterexampleWithZ3(
      jointBroken, "selectedLeasesAreFenced", { maxSteps: 2 },
    );
    if (result.status !== "counterexample" || result.depth !== 2) {
      throw new Error(`expected depth-two counterexample, got ${result.status}`);
    }
  }, { time: 500, iterations: 2 });
});
