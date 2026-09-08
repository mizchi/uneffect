import { bench, describe, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeModuleInitializationOrderV2 } from "../src/modules/module-order-api.js";

const directory = mkdtempSync(join(tmpdir(), "uneffect-native-order-bench-"));
const options = { entryFile: join(directory, "entry.mts") };
writeFileSync(options.entryFile, "const ready = Math.random() > .5; if (ready) await Promise.resolve(); export {};");
afterAll(() => rmSync(directory, { recursive: true, force: true }));
// Includes native compiler startup and source acquisition; no reused TS6 Program.
describe("native module initialization v2", () => {
  bench("conditional await including native frontend startup", async () => {
    const result = await analyzeModuleInitializationOrderV2(options);
    const proof = result.modules[0]?.controlFlow?.proof;
    if (result.evidence !== "verified" || proof?.status !== "converged" || proof.iterations > proof.budget.limit) {
      throw new Error("conditional module domain benchmark did not verify within its budget");
    }
  }, { time: 500, iterations: 5 });
});
