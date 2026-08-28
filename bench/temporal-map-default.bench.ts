import { readFileSync } from "node:fs";
import { bench, describe } from "vitest";
import { generateQuint } from "../src/spec-backends.js";
import { parseSpec } from "../src/spec-ir.js";
import { findTemporalCounterexampleWithZ3 } from "../src/spec-lint.js";

const fileName = "examples/dogfood/node-lease-total-map-lookup.ts";
const source = readFileSync(fileName, "utf8");
const safe = parseSpec(fileName, source).temporal;
const broken = parseSpec(fileName, source.replace(
  "{ epoch: 0, valid: false }).valid",
  "{ epoch: 0, valid: true }).valid",
)).temporal;

describe("total finite Map lookup", () => {
  bench("generate the Node Lease getOrElse Quint model", () => {
    const model = generateQuint("node_lease_total_lookup", safe);
    if (!model.includes("keys().contains(3)")) throw new Error("benchmark fixture lost total lookup lowering");
  }, { time: 500, iterations: 20 });

  bench("extract the missing-lease fallback counterexample with Z3", async () => {
    const result = await findTemporalCounterexampleWithZ3(
      broken,
      "unknownNodeCannotWrite",
      { maxSteps: 1 },
    );
    if (result.status !== "counterexample") throw new Error(`expected counterexample, got ${result.status}`);
  }, { time: 500, iterations: 2 });
});
