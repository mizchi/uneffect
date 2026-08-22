export const ciTestTiers = {
  fast: [
    "test/annotations.test.ts",
    "test/builtin-contracts.test.ts",
    "test/call-graph.test.ts",
    "test/capabilities.test.ts",
    "test/ci-tiers.test.ts",
    "test/clock-conformance.test.ts",
    "test/deno-permissions.test.ts",
    "test/effect-ts.test.ts",
    "test/effects.test.ts",
    "test/frontend-adapter.test.ts",
    "test/frontend-parity.test.ts",
    "test/model-replay.test.ts",
    "test/numeric-types.test.ts",
    "test/project-optimizer.test.ts",
    "test/quicksort.test.ts",
    "test/refinement-bindings.test.ts",
    "test/temporal-expressions.test.ts",
  ],
  z3: [
    "test/contracts.test.ts",
    "test/instrument.test.ts",
    "test/invariant-ir.test.ts",
    "test/property-tests.test.ts",
    "test/typed-array-safety.test.ts",
  ],
  quint: [
    "test/async-patterns.test.ts",
    "test/formal-models.test.ts",
    "test/ownership.test.ts",
    "test/promise-chains.test.ts",
    "test/temporal-compose.test.ts",
  ],
  integration: [
    "test/acceptance-roadmap.test.ts",
    "test/async-safety.test.ts",
    "test/dogfood.test.ts",
    "test/evidence-optimizer.test.ts",
    "test/node-lease.test.ts",
    "test/spec-backends.test.ts",
  ],
} as const;

export type CiTestTier = keyof typeof ciTestTiers;

export const ciIsolatedTestNames: Readonly<Record<string, readonly string[]>> = {
  "test/node-lease.test.ts": [
    "dogfoods synthesized subset authority and catches an unchecked request",
    "uses a proven lease-domain invariant to exclude invalid epoch actions",
    "rules out worker-resource starvation only under the declared weak fairness",
    "extracts the collection-valued Node Lease violation with Z3 finite observation",
    "fences delayed writes across renewal, CAS failure, crash, GC, and takeover lifecycle",
    "uses finite Set and Map state without per-node writer or epoch fields",
    "extracts and replays the same lease violation with bounded Z3",
    "reproduces the early-takeover double-writer counterexample",
    "keeps the bounded two-node model safe when takeover waits for the skew bound",
    "normalizes the Quint counterexample and replays it against a TypeScript lease runtime",
  ],
};

export function resolveCiTestIncludes(tier: CiTestTier | undefined, argv: readonly string[]): readonly string[] | undefined {
  if (!tier) return undefined;
  const hasExplicitTestFile = argv.some((argument) => argument.endsWith(".test.ts"));
  return hasExplicitTestFile ? undefined : ciTestTiers[tier];
}
