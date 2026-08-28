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

describe("proved dynamic Map key domain", () => {
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
});
