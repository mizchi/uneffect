# Uneffect feature overview

This page is a pattern-oriented map of the public Uneffect 0.3 surface. It is
intended for deciding what to write first in an existing TypeScript project.
Examples are not claims of complete JavaScript verification: every result is
limited to its selected files, supported syntax, exact source and compiler,
assumptions, blockers, and exclusions.

## Start here

```sh
pnpm add --save-dev @mizchi/uneffect typescript@^7
pnpm exec uneffect doctor
pnpm exec uneffect check --project tsconfig.json --infer
```

All source annotations use block comments with an explicit `uneffect:` marker.
Normal comments and JSDoc remain untouched. Use `.uneffect.ts` modules when a
state machine or larger typed specification is clearer than inline comments.

## Effect tracking

For an existing unannotated codebase, start by committing an inferred-effect
baseline. Later checks fail when a function gains a capability or a new unknown
analysis reason, so the first useful CI signal does not depend on predicting a
bug in a comment:

```sh
pnpm exec uneffect check --project tsconfig.json \
  --write-effect-baseline .uneffect/effects.json
pnpm exec uneffect check --project tsconfig.json \
  --effect-baseline .uneffect/effects.json
```

The baseline is a regression allowance, not proof that existing effects are
safe or that behavior within an unchanged effect set is correct.

An effect annotation is an upper bound. A missing transitive effect is an
error; a declared but unused effect is a warning. Unannotated functions are not
implicitly pure.

```ts
/* uneffect:effect Console | Fetch<GET, "https://api.example.com/v1/**"> */
export async function loadUser(id: string) {
  console.log("loading", id)
  return fetch(`https://api.example.com/v1/users/${id}`)
}

/* uneffect:effect none */
export function add(left: number, right: number) { return left + right }
```

Common capability patterns are:

| Pattern | Purpose |
| --- | --- |
| `FsRead<"$WORKSPACE_ROOT/config/**">` | Read within a symbolic path scope. |
| `FsWrite<"$TEMP/**">` | Write below the target OS temporary directory. |
| `Fetch<GET \| POST, "https://api.example.com/**">` | Restrict methods and URL scope. |
| `Net<"api.example.com:443">` | Deno-shaped network authority. |
| `EnvRead<"APP_*">` / `EnvWrite<"APP_MODE">` | Environment authority. |
| `CookieRead` / `CookieWrite` | Browser cookie access. |
| `LocalStorageRead` / `LocalStorageWrite` | Local-storage access. |
| `GlobalVarsRead<"featureFlag">` | Read a selected global property. |
| `GlobalVarsWrite<"counter">` | Write a selected global property. |
| `Dom<AttributeWrite<"aria-*">, typeof root>` | A documented DOM operation and receiver region. |
| `Mutate<typeof state>` | Mutation of a tracked reference region. |
| `Throw<TypeError>` | A synchronous typed throw. |
| `Random` | Nondeterministic randomness as an explicit effect. |

Literal permission scopes are checked as sets. Dynamic scopes remain
conservative or unknown. A typed external capability policy can be linked:

```ts
// policy.uneffect.ts
import { Console, Fetch, defineCapability } from "@mizchi/uneffect/spec"

export const LoadUser = defineCapability({
  effects: [Console(), Fetch({ methods: ["GET"], urls: ["https://api.example.com/v1/**"] })],
})
```

```ts
/* uneffect:capability_from "./policy.uneffect.ts#LoadUser" */
export async function loadUser() { /* implementation */ }
```

See [Effect system](./effect-system.md), [Deno permissions](./deno-permissions.md),
and [Builtin contracts](./builtin-contracts.md).

## Hoare-style contracts

Use preconditions, postconditions, and loop invariants for supported scalar and
bounded collection reasoning:

```ts
import type { Nat } from "@mizchi/uneffect"

/* uneffect:requires n >= 0 */
/* uneffect:ensures result === n */
export function count(n: Nat): Nat {
  let value = 0
  /* uneffect:loop_invariant value >= 0 && value <= n */
  while (value < n) value++
  return value as Nat
}
```

`Throw<T>` remains in the Effect bound until a supported `catch` discharges
it. Promise rejection is distinct from synchronous throw and is discharged
only by ownership operations such as `await` in the matching `try/catch`, a
rejection handler, or returning/transferring the Promise.

Typed contract modules keep predicates visible to TypeScript:

```ts
// counter.uneffect.ts
import { defineContract, int } from "@mizchi/uneffect/spec"

export const Increment = defineContract({
  parameters: { value: int() },
  returns: int(),
  requires: ({ value }) => value >= 0,
  ensures: ({ value, result }) => result === value + 1,
})
```

```ts
/* uneffect:contract_from "./counter.uneffect.ts#Increment" */
export function increment(value: number) { return value + 1 }
```

`runtimeAssertions: "fallback"` can emit checks for the supported predicate
fragment. This is opt-in; ordinary static annotations add no runtime work.

See [Gradual annotations](./gradual-annotations.md), [Contract summaries](./contract-summaries.md),
and [TypeScript CFG bridge](./typescript-control-flow.md).

## Numeric and typed-array patterns

```ts
import { parseNat, parseU8, u32, type BoundedUint8Array, type Nat, type U8 } from "@mizchi/uneffect"

const length: Nat = parseNat(input.length)
const byte: U8 = parseU8(inputByte)
const word = u32(left + right)

function read(bytes: BoundedUint8Array<1024>, index: Nat): U8 {
  return bytes[index] as U8
}
```

The checked fragment covers selected Uint8Array, Uint32Array, DataView,
fixed/bounded ArrayBuffer, index, write-domain, copy, shift, and canonical-loop
obligations. It does not prove general IEEE-754 accuracy, numerical stability,
SIMD, Atomics, shared-memory ordering, or opaque Wasm/native kernels.

See [Typed arrays and numeric domains](./typed-arrays.md).

## Generated property tests and shrinking

Supported contracts produce deterministic boundary candidates and Vitest
tests, including JavaScript signed-remainder boundaries:

```ts
/* uneffect:requires value >= 0 && value < 1024 && value % 16 === 0 */
/* uneffect:ensures result >= 0 */
export function shard(value: number) { return value }
```

User predicates require a finite authenticated specialization. Empty filters,
unsupported recursion, higher-order predicates, and dynamic selection do not
become proofs. See [Property testing](./property-testing.md).

## Async, resources, and temporal models

Promise ownership is inferred from ordinary TypeScript:

```ts
await task()
return task()
task().catch(recover)
task().then(onValue, onError)

task() // floating-promise error
```

`using` and `await using`, iterators, streams, fetch bodies, file handles,
servers, WebSockets, cancellation, and supported Promise combinators lower into
a shared acquire/use/borrow/consume/release/transfer model. This tracks
responsibility and selected ordering; it is not a general heap or concurrency
proof.

Explicit temporal properties belong in a typed specification:

```ts
// upload.uneffect.ts
import { bool, defineTemporal, int } from "@mizchi/uneffect/spec"

export default defineTemporal({
  state: { attempts: int(), done: bool() },
  init: { attempts: 0, done: false },
  actions: {
    retry: ({ attempts }) => ({ attempts: attempts + 1 }),
    finish: () => ({ done: true }),
  },
  invariants: { bounded: ({ attempts }) => attempts <= 3 },
  eventually: { completes: ({ done }) => done },
})
```

```ts
/* uneffect:temporal_from "./upload.uneffect.ts#default" */
export async function upload() { /* implementation */ }
```

```sh
pnpm exec uneffect spec temporal src/upload.ts upload --runtime web > upload.qnt
```

The stable facade returns independently checked projections and explicit
exclusions. Generated Quint is evidence, not a stable textual ABI. See
[Async safety](./async-safety.md), [Resource protocols](./resource-protocols.md),
and [Temporal DSL](./temporal-dsl.md).

## Domain-specific validators

```ts
import { defineUneffectValidator } from "@mizchi/uneffect"

const DatadogOnce = defineUneffectValidator({
  name: "DatadogOnce",
  rule: "at-most-once",
  sink: { module: "@datadog/browser-rum", export: "datadogRum.addAction" },
  specialization: { kind: "call-cardinality", maximum: 1 },
})
```

```ts
/* uneffect:validate DatadogOnce */
function report(enabled: boolean) {
  if (enabled) datadogRum.addAction("loaded")
}
```

Dynamic dispatch, unresolved callbacks, and recursion become unknown instead
of satisfying the validator. See [Custom validators](./custom-validators.md).

## Trusted Types checks

The experimental TrustedScript checker follows producer provenance rather than
accepting a structural cast:

```ts
const policy = trustedTypes.createPolicy("app", {
  createScript(input) {
    if (input === "boot()") return input
    throw new TypeError("rejected")
  },
})

eval(policy.createScript("boot()"))
eval(userInput as TrustedScript) // rejected
```

This does not prove CSP delivery, sanitizer correctness, TrustedHTML,
TrustedScriptURL, or every dynamic-code path. See [Trusted Types](./trusted-types.md).

## Programmatic public API

Effect tracking and the high-level facades are public:

```ts
import {
  analyzeEffects,
  analyzeProgramEffects,
  generateTemporalModel,
  parseEffectSet,
  verifyUneffectProject,
} from "@mizchi/uneffect"
```

The root also contains numeric/runtime helpers, property generation, custom
validators, effect schema/module registration, builtin registry integration,
contract-summary bundles, and the bounded Trusted Types analyzer. These are API
placement commitments; supported semantics still come from the feature matrix.

Solver calls, SMT/Quint lowering, CFG lattices, optimizer experiments, and
direct async/resource generators are only in `@mizchi/uneffect/experimental`
and have no compatibility guarantee. See [Public API](./public-api.md).

## Assurance workflow

```sh
pnpm exec uneffect check --project tsconfig.json --infer
pnpm exec uneffect check --project tsconfig.json --infer \
  --assurance no-unknown --json > uneffect-check.json
```

Read `claims`, `coverage`, `assumptions`, `blockers`, and `exclusions` together.
A default exit code 0 says enabled checks passed; it is not a whole-program
proof.

## Unsupported or unknown

Keep relevant `unknown` results blocking. Important non-claims in 0.3 include:

- arbitrary CFG, reflection, Proxy, mutable dynamic dispatch, and whole-heap
  alias reasoning;
- arbitrary third-party, native, Wasm, or dynamically loaded script internals
  without explicit reviewed contracts;
- complete host scheduling, fairness, liveness, race freedom, or termination;
- general IEEE-754 error bounds and numerical stability;
- React concurrent semantics outside the documented fragment;
- authorization for general optimizer transformations.

Use [Stability](./stability.md), [Assurance boundaries](./assurance-boundaries.md),
and the [Feature matrix](./feature-matrix.md) as the normative limits.
