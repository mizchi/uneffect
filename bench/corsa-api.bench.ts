import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, bench, describe } from "vitest";
import { openCorsaApiFrontend, type CorsaBuiltinCallQuery } from "../src/corsa-api-frontend.js";

const fixture = resolve("test/fixtures/corsa-api-project/index.ts");
const source = readFileSync(fixture, "utf8");
const fetchPosition = source.indexOf("fetch(\"https://example.com/status\")");
const consoleReceiverPosition = source.indexOf("console.log(path)");
const consoleCalleePosition = consoleReceiverPosition + "console.".length;

function repeatedQueries(count: number): CorsaBuiltinCallQuery[] {
  return Array.from({ length: count }, (_, index) => index % 2 === 0
    ? { calleePosition: fetchPosition }
    : { calleePosition: consoleCalleePosition, receiverPosition: consoleReceiverPosition });
}

const queries100 = repeatedQueries(100);
const queries1000 = repeatedQueries(1_000);
const frontend = await openCorsaApiFrontend({
  configFile: resolve("test/fixtures/corsa-api-project/tsconfig.json"),
  corsaExecutable: resolve("node_modules/.bin/tsgo"),
});

for (const queries of [queries100, queries1000]) {
  const operations = frontend.classifyBuiltinCalls(fixture, queries).map((entry) => entry?.operation);
  if (operations.length !== queries.length || operations.some((operation, index) => operation !== (index % 2 === 0 ? "Fetch" : "Console"))) {
    throw new Error("warm Corsa batch returned non-parity builtin facts");
  }
}

afterAll(() => frontend.close());

describe("warm Corsa semantic query batching", () => {
  bench("classify 100 call sites in one symbol batch", () => {
    if (frontend.classifyBuiltinCalls(fixture, queries100).length !== 100) throw new Error("incomplete Corsa batch");
  }, { time: 250, iterations: 1 });

  bench("classify 100 call sites sequentially", () => {
    if (queries100.map((query) => frontend.classifyBuiltinCall(fixture, query)).length !== 100) throw new Error("incomplete Corsa queries");
  }, { time: 250, iterations: 1 });

  bench("classify 1,000 call sites in one symbol batch", () => {
    if (frontend.classifyBuiltinCalls(fixture, queries1000).length !== 1_000) throw new Error("incomplete Corsa batch");
  }, { time: 250, iterations: 1 });

  bench("classify 1,000 call sites sequentially", () => {
    if (queries1000.map((query) => frontend.classifyBuiltinCall(fixture, query)).length !== 1_000) throw new Error("incomplete Corsa queries");
  }, { time: 250, iterations: 1 });
});
