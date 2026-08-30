export const ciTestTiers = {
  fast: [
    "test/annotations.test.ts",
    "test/assurance.test.ts",
    "test/builtin-contracts.test.ts",
    "test/call-graph.test.ts",
    "test/capability-dsl.test.ts",
    "test/capabilities.test.ts",
    "test/ci-tiers.test.ts",
    "test/cli.test.ts",
    "test/clock-conformance.test.ts",
    "test/declaration-transforms.test.ts",
    "test/deno-permissions.test.ts",
    "test/diagnostics.test.ts",
    "test/effect-ts.test.ts",
    "test/effects.test.ts",
    "test/frontend-adapter.test.ts",
    "test/frontend-parity.test.ts",
    "test/model-replay.test.ts",
    "test/module-initialization.test.ts",
    "test/modules.test.ts",
    "test/numeric-types.test.ts",
    "test/project-optimizer.test.ts",
    "test/quicksort.test.ts",
    "test/react-semantics.test.ts",
    "test/release-readiness.test.ts",
    "test/refinement-bindings.test.ts",
    "test/refinement-flow.test.ts",
    "test/refinement-handler-flow.test.ts",
    "test/registry-config.test.ts",
    "test/static-evaluation.test.ts",
    "test/temporal-expressions.test.ts",
    "test/test-timeouts.test.ts",
    "test/todo-consistency.test.ts",
    "test/trusted-types.test.ts",
    "test/workspace-module-initialization.test.ts",
  ],
  z3: [
    "test/contract-summary.test.ts",
    "test/contracts.test.ts",
    "test/contract-dsl.test.ts",
    "test/documentation-entrypoints.test.ts",
    "test/instrument.test.ts",
    "test/invariant-ir.test.ts",
    "test/property-tests.test.ts",
    "test/refinement-equivalence.test.ts",
    "test/refinement-scalar-product-conditional-join.test.ts",
    "test/refinement-cfg-affine-recurrence.test.ts",
    "test/refinement-cfg-boolean-involution-recurrence.test.ts",
    "test/refinement-cfg-bounded-self-affine-recurrence.test.ts",
    "test/refinement-cfg-caught-self-affine-recurrence.test.ts",
    "test/refinement-cfg-conditional-value-recurrence.test.ts",
    "test/refinement-cfg-coupled-recurrence.test.ts",
    "test/refinement-cfg-entry-read-recurrence.test.ts",
    "test/refinement-cfg-piecewise-recurrence.test.ts",
    "test/refinement-cfg-switch-recurrence.test.ts",
    "test/refinement-cfg-two-diamond-recurrence.test.ts",
    "test/refinement-cfg-handler-recurrence.test.ts",
    "test/refinement-cfg-mixed-join-recurrence.test.ts",
    "test/refinement-scalar-product-handler-join.test.ts",
    "test/refinement-scalar-product-three-region.test.ts",
    "test/refinement-scalar-handler-join.test.ts",
    "test/typed-array-safety.test.ts",
    "test/temporal-map-dynamic-domain.test.ts",
    "test/temporal-map-joint-dynamic-domains.test.ts",
    "test/temporal-map-multiple-dynamic-domains.test.ts",
    "test/z3-backend.test.ts",
  ],
  quint: [
    "test/async-patterns.test.ts",
    "test/formal-models.test.ts",
    "test/ownership.test.ts",
    "test/promise-chains.test.ts",
    "test/temporal-async-integration.test.ts",
    "test/temporal-compose.test.ts",
  ],
  integration: [
    "test/acceptance-roadmap.test.ts",
    "test/async-safety.test.ts",
    "test/corsa-checker-exporter.test.ts",
    "test/dogfood.test.ts",
    "test/evidence-optimizer.test.ts",
    "test/fixtures.test.ts",
    "test/node-lease.test.ts",
    "test/spec-backends.test.ts",
    "test/temporal-dsl.test.ts",
    "test/temporal-map-default.test.ts",
  ],
} as const;

export type CiTestTier = keyof typeof ciTestTiers;

export const ciIntegrationShards = {
  core: [
    "test/acceptance-roadmap.test.ts",
    "test/corsa-checker-exporter.test.ts",
    "test/evidence-optimizer.test.ts",
    "test/fixtures.test.ts",
    "test/node-lease.test.ts",
  ],
  applications: [
    "test/async-safety.test.ts",
    "test/spec-backends.test.ts",
    "test/temporal-dsl.test.ts",
    "test/temporal-map-default.test.ts",
  ],
  dogfood: [
    "test/dogfood.test.ts",
  ],
} as const satisfies Readonly<Record<string, readonly (typeof ciTestTiers.integration)[number][]>>;

export type CiIntegrationShard = keyof typeof ciIntegrationShards;

export function resolveCiTierFiles(tier: CiTestTier, requestedFile?: string, requestedShard?: string): readonly (string | undefined)[] {
  if (requestedFile && requestedShard) throw new Error("a requested test file cannot be combined with an integration shard");
  if (requestedShard) {
    if (tier !== "integration") throw new Error("a CI shard is only valid for integration");
    if (!(requestedShard in ciIntegrationShards)) throw new Error(`unknown integration shard: ${requestedShard}`);
    return ciIntegrationShards[requestedShard as CiIntegrationShard];
  }
  if (!requestedFile) return tier === "fast" ? [undefined] : ciTestTiers[tier];
  if (!(ciTestTiers[tier] as readonly string[]).includes(requestedFile)) {
    throw new Error(`${requestedFile} is not assigned to ${tier} CI tier`);
  }
  return [requestedFile];
}

export const ciIsolatedTestNames: Readonly<Record<string, readonly string[]>> = {
  "test/node-lease.test.ts": [
    "extracts record-valued lease grants across Quint, Z3, TLC, and replay",
    "preserves production string node identities across Quint, Z3, TLC trace import, and replay",
    "defaults a missing node lease to a fenced record across Quint and Z3",
    "dogfoods synthesized subset authority and catches an unchecked request",
    "uses a proven lease-domain invariant to exclude invalid epoch actions",
    "synthesizes a lease-domain invariant to exclude invalid epoch actions",
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

export const ciIsolatedTestFiles: readonly string[] = ["test/dogfood.test.ts"];

/** Files whose child Quint process failures must be captured at file granularity. */
export const ciExternalVerifierTestFiles: readonly string[] = [
  ...ciTestTiers.quint,
  "test/async-safety.test.ts",
  "test/spec-backends.test.ts",
  "test/temporal-dsl.test.ts",
  "test/temporal-map-default.test.ts",
];
export const ciIsolatedTestTimeoutMs = 60_000;
/** 1.5x the observed 30-second remote project-analysis overruns. */
export const ciMeasuredNativeProjectTimeoutMs = 45_000;
/** Parent-process deadline for synchronous WASM calls that can block Vitest's own timer. */
export const ciIsolatedProcessTimeoutMs = ciIsolatedTestTimeoutMs + 15_000;

export function isIsolatedSolverHardTimeout(error: { code?: unknown } | undefined): boolean {
  return error?.code === "ETIMEDOUT";
}

export function parseVitestListNames(file: string, output: string): readonly string[] {
  const prefix = `${file} > `;
  const names = output.split(/\r?\n/)
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(line.lastIndexOf(" > ") + 3));
  const duplicate = names.find((name, index) => names.indexOf(name) !== index);
  if (duplicate) throw new Error(`duplicate isolated test title in ${file}: ${duplicate}`);
  return names;
}

export function didVitestRunExactlyOneTest(output: string): boolean {
  const plain = output.replaceAll(/\u001b\[[0-9;]*m/g, "");
  return /Tests\s+1 passed(?:\s+\|\s+\d+ skipped)?/.test(plain);
}

export function resolveCiTestIncludes(tier: CiTestTier | undefined, argv: readonly string[]): readonly string[] | undefined {
  if (!tier) return undefined;
  const hasExplicitTestFile = argv.some((argument) => argument.endsWith(".test.ts"));
  return hasExplicitTestFile ? undefined : ciTestTiers[tier];
}

export function shouldRetryIsolatedSolverFailure(output: string): boolean {
  return classifyIsolatedSolverFailure(output) !== undefined;
}

/**
 * Classifies only a child Quint process timeout reported by an otherwise live
 * Vitest process. Model verdicts, parser errors, and Vitest timeouts are not
 * infrastructure failures and deliberately do not match.
 */
export function classifyIsolatedVerifierFailure(tier: CiTestTier, output: string): "external-process-timeout" | undefined {
  if (tier !== "quint" && tier !== "integration") return undefined;
  if (!output.includes("ETIMEDOUT") || !/spawnSync\s+pnpm/.test(output)) return undefined;
  if (tier === "integration" && !/\bquint\b/.test(output)) return undefined;
  return "external-process-timeout";
}

export function classifyIsolatedSolverFailure(output: string): import("./solver-retry-evidence.js").SolverFailureKind | undefined {
  const wasmOom = output.includes("z3-built.wasm") && output.includes("Cannot enlarge memory arrays");
  if (wasmOom) return "wasm-oom";
  const wasmCrash = output.includes("z3-built.wasm") && (
    output.includes("memory access out of bounds") || output.includes("table index is out of bounds")
  );
  if (wasmCrash) return "wasm-memory-fault";
  const wasmHeapCorruption = output.includes("z3-solver/build/z3-built.js")
    && output.includes("corrupted its heap memory area (address zero)");
  if (wasmHeapCorruption) return "wasm-heap-corruption";
  const z3InternalAssertion = output.includes("ASSERTION VIOLATION")
    && output.includes("File: ../src/ast/")
    && output.includes("UNEXPECTED CODE WAS REACHED")
    && /Z3 \d+\.\d+\.\d+/.test(output);
  if (z3InternalAssertion) return "z3-internal-assertion";
  const knownLeaseTimeout = output.includes("test/node-lease.test.ts")
    && [
      "uses a proven lease-domain invariant to exclude invalid epoch actions",
      "synthesizes a lease-domain invariant to exclude invalid epoch actions",
    ].some((name) => output.includes(name))
    && output.includes("Test timed out in 60000ms");
  if (knownLeaseTimeout) return "known-timeout";
  return undefined;
}
