import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { bench, describe } from "vitest";
import { exportCorsaCheckerFacts } from "../src/corsa-checker-exporter.js";
import { compareUneffectFrontends } from "../src/frontend-parity.js";

const fileName = "examples/dogfood/corsa-inferred-effect.ts";
const files = { [fileName]: readFileSync(fileName, "utf8") };
const workhubFileName = "examples/dogfood/corsa-workhub-builtins.ts";
const workhubFiles = { [workhubFileName]: readFileSync(workhubFileName, "utf8") };
const conditionalFileName = "examples/dogfood/corsa-workhub-conditional-await.ts";
const conditionalFiles = { [conditionalFileName]: readFileSync(conditionalFileName, "utf8") };
const returnFileName = "examples/dogfood/corsa-workhub-promise-returns.ts";
const returnFiles = { [returnFileName]: readFileSync(returnFileName, "utf8") };
const directoryFileName = "examples/dogfood/corsa-workhub-fs-directory.ts";
const directoryFiles = { [directoryFileName]: readFileSync(directoryFileName, "utf8") };
const corsaExecutable = resolve("node_modules/.bin/tsgo");

describe("checker-backed Corsa inferred-effect handoff", () => {
  bench("export and normalize one inferred Console fixture", async () => {
    const facts = await exportCorsaCheckerFacts({ files, corsaExecutable });
    const comparison = await compareUneffectFrontends({
      files,
      corsaFacts: facts,
      requireCorsaCheckerFacts: true,
    });
    if (!comparison.equivalent) {
      throw new Error(`Corsa inferred-effect parity failed: ${JSON.stringify(comparison.schemaDrift)}`);
    }
  }, { time: 500, iterations: 1 });

  bench("export and normalize Workhub-shaped fs/fetch facts", async () => {
    const facts = await exportCorsaCheckerFacts({ files: workhubFiles, corsaExecutable });
    const comparison = await compareUneffectFrontends({
      files: workhubFiles,
      corsaFacts: facts,
      requireCorsaCheckerFacts: true,
    });
    if (!comparison.equivalent) {
      throw new Error(`Corsa direct-await parity failed: ${JSON.stringify(comparison.schemaDrift)}`);
    }
  }, { time: 500, iterations: 1 });

  bench("export and normalize Workhub-shaped single-if await facts", async () => {
    const facts = await exportCorsaCheckerFacts({ files: conditionalFiles, corsaExecutable });
    const comparison = await compareUneffectFrontends({
      files: conditionalFiles,
      corsaFacts: facts,
      requireCorsaCheckerFacts: true,
    });
    if (!comparison.equivalent) {
      throw new Error(`Corsa conditional-await parity failed: ${JSON.stringify(comparison.schemaDrift)}`);
    }
  }, { time: 500, iterations: 1 });

  bench("export and normalize Workhub-shaped Promise return facts", async () => {
    const facts = await exportCorsaCheckerFacts({ files: returnFiles, corsaExecutable });
    const comparison = await compareUneffectFrontends({
      files: returnFiles,
      corsaFacts: facts,
      requireCorsaCheckerFacts: true,
    });
    if (!comparison.equivalent) {
      throw new Error(`Corsa Promise-return parity failed: ${JSON.stringify(comparison.schemaDrift)}`);
    }
  }, { time: 500, iterations: 1 });

  bench("export and normalize Workhub-shaped directory fs facts", async () => {
    const facts = await exportCorsaCheckerFacts({ files: directoryFiles, corsaExecutable });
    const comparison = await compareUneffectFrontends({
      files: directoryFiles,
      corsaFacts: facts,
      requireCorsaCheckerFacts: true,
    });
    if (!comparison.equivalent) {
      throw new Error(`Corsa directory-fs parity failed: ${JSON.stringify(comparison.schemaDrift)}`);
    }
  }, { time: 500, iterations: 1 });
});
