# Uneffect usage patterns

Choose a pattern from the incident or invariant you need to make reviewable.

## Audit existing side effects

Use when adopting Uneffect in an existing service or script.

```sh
pnpm exec uneffect check --project tsconfig.json --infer src/integration.ts
```

Review inferred effects and unknown reasons first. Then declare broad upper
bounds at leaf I/O boundaries and narrow them over time. Declared but unused
effects warn, which helps remove stale permissions.

## Restrict filesystem, network, and environment authority

Use for build tools, CLIs, server handlers, integrations, and plugins.

```ts
/* uneffect:capability effect FsRead<"$WORKSPACE_ROOT/config/**"> | FsWrite<"$TEMP/**"> */
function generate() { /* ... */ }

/* uneffect:capability effect Fetch<GET | POST, "https://api.example.com/v1/**"> */
async function request() { /* ... */ }

/* uneffect:capability effect Net<"api.example.com:443"> | Env<"APP_*"> */
function connect() { /* ... */ }
```

Uneffect aligns filesystem/network/environment/process vocabulary with Deno's
permission model where practical. Path roots such as `$WORKSPACE_ROOT`, `$CWD`,
`$PACKAGE_ROOT`, `$SOURCE_DIR`, and `$TEMP` are semantic roots, not shell
expansion. Use the exact forms supported by the current permission docs.

## Bound DOM and browser authority

Use for UI infrastructure, third-party SDK adapters, and code that should only
touch a known DOM region. Prefer operation-specific DOM effects over a broad
`Dom` bound when supported. Browser storage and globals should be declared as
separate permissions, for example `CookieRead`, `CookieWrite`,
`LocalStorageRead`, and `LocalStorageWrite` according to the current schemas.
`GlobalVarsRead<K>` and `GlobalVarsWrite<K>` are planned vocabulary, not an
implemented permission to rely on yet.

Do not claim that detecting DOM insertion proves the behavior of inserted
third-party code. External script execution and transitive runtime behavior
remain separate trust boundaries.

## Prevent injection into script sinks

Use when values flow into `eval`, string timers, `Function`, or supported
script-element text sinks. Uneffect's Trusted Types analysis follows producer
provenance; a structural cast to `TrustedScript` is not accepted.

```ts
const policy = trustedTypes.createPolicy("app", {
  createScript(input) {
    if (input === "boot()") return input
    throw new TypeError("rejected")
  },
})

eval(policy.createScript("boot()"))
```

The policy implementation is a reviewed security boundary. This does not prove
CSP deployment or sanitizer correctness.

## Express local functional contracts

Use for parsers, numeric kernels, allocation limits, indexes, and domain
validation.

```ts
/* uneffect:contract requires denominator > 0 */
/* uneffect:contract ensures result <= numerator */
function divide(numerator: number, denominator: number) {
  return Math.floor(numerator / denominator)
}
```

Add loop invariants only when they constrain reachable states. Contradictory,
malformed, unsupported, or vacuous specifications must remain diagnostics or
unknown evidence rather than being treated as proof.

## Check binary and integer code

Use for codecs, packet parsers, hashes, and local Uint8/Uint32/DataView kernels.
Use branded domains, bounded buffers, explicit `toU32`/machine coercions, and
contracted indexes. This fragment can check selected bounds and word domains;
it does not prove a complete cryptographic algorithm, IEEE-754 numerical
stability, WASM internals, SIMD, or shared-memory correctness.

## Track Promise and resource ownership

Use at application entrypoints, schedulers, adapters, and shutdown paths.
Uneffect detects selected floating Promise rejections and models supported
`using`/`await using` disposal. APIs that take ownership can declare it:

```ts
/* uneffect:async consumes_rejection 0 */
declare function enqueue(job: Promise<void>): void

/* uneffect:async consumes_callback_rejection 0 */
declare function schedule(job: () => Promise<void>): void
```

Do not add a consuming contract to silence a diagnostic unless the callee
actually observes or owns that rejection on every required path.

## Model ordering, retries, leases, and cardinality

Use temporal annotations when the bug is about transitions rather than only
which effects may occur: at-most-once telemetry, retry budgets, lease epochs,
timer ordering, cancellation, and resource states.

```ts
/* uneffect:temporal state pending: int */
/* uneffect:temporal init pending = 0 */
/* uneffect:temporal action enqueue: pending' = pending + 1 */
/* uneffect:temporal action complete: pending' = pending > 0 ? pending - 1 : pending */
/* uneffect:temporal invariant nonnegative: pending >= 0 */
```

Uneffect parses a TypeScript-oriented annotation language into a neutral IR;
it does not pass arbitrary annotation text directly to Quint. Generated bounded
Z3/Quint evidence finds counterexamples within the selected model and bounds.
Supported Promise, timer, microtask, and host event-loop observations compose
with this user model through `generateTemporalModel` or `spec temporal
--runtime web|node`. A selected root's `using`/`await using` lifecycle is
co-verified through the same facade. Promise ownership and synchronization of
conditional resource suspension with host queues are reported exclusions. A
straight-line `await using` root additionally checks that disposal resumes in a
microtask checkpoint; arbitrary callback interleavings remain excluded rather
than silently claimed.

## Opt into React semantics

Use on selected functional components when render purity, Hook ordering,
effect cleanup, stale closures, Suspense, or Action transitions are relevant.

```tsx
/* uneffect:react-component */
export function Profile() {
  // component body
}
```

This is an experimental partial model, not a formalization of all React or host
scheduling. Read the current supported fragment before gating CI.

## Extend Uneffect with reviewed semantics

Use builtin contracts, effect schemas, validators, or semantic modules when a
project-specific API needs formal meaning. Bind contracts to resolved symbols
and exact package/build provenance where supported. Treat user-defined and
third-party contracts as explicit trusted assumptions unless independently
verified.

## Authoritative details

- [`docs/adoption-patterns.md`](../../../docs/adoption-patterns.md)
- [`docs/deno-permissions.md`](../../../docs/deno-permissions.md)
- [`docs/async-safety.md`](../../../docs/async-safety.md)
- [`docs/formal-models.md`](../../../docs/formal-models.md)
- [`docs/react-semantics.md`](../../../docs/react-semantics.md)
- [`docs/trusted-types.md`](../../../docs/trusted-types.md)
- [`docs/typed-arrays.md`](../../../docs/typed-arrays.md)
- [`docs/semantics-modules.md`](../../../docs/semantics-modules.md)
