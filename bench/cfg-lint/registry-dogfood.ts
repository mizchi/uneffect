import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { lowerCorsaRegistryReadCfg } from "../../src/lint/corsa.js";
import { lintPrerequisites, ownPropertyReadRule } from "../../src/lint/index.js";

const corpus = JSON.parse(readFileSync("dogfood/registry-cases.json", "utf8")) as {
  cases: Array<{ fileName: string; functionName: string; registry: string; flow?: "expression" | "statement" }>;
};
const reports = [];
for (const { fileName, functionName, registry, flow = "expression" } of corpus.cases) {
  const source = readFileSync(fileName, "utf8");
  const lowered = await lowerCorsaRegistryReadCfg({ fileName, functionName, registry, flow, configFile: resolve("tsconfig.json") });
  const result = lowered.status === "lowered" ? lintPrerequisites(lowered.cfg, ownPropertyReadRule) : lowered;
  reports.push({ fileName, functionName, registry, flow, sourceSha256: createHash("sha256").update(source).digest("hex"),
    status: result.status,
    ...(result.status === "unknown" ? { reason: result.reason, detail: result.detail } : { reads: result.diagnostics.map(item => ({
      start: item.location.start, end: item.location.end, source: source.slice(item.location.start, item.location.end),
      line: source.slice(0, item.location.start).split("\n").length,
    })) }),
  });
}
process.stdout.write(`${JSON.stringify({ rule: ownPropertyReadRule.id, reports }, null, 2)}\n`);
