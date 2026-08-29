# Quickstart

This guide adds Uneffect to a small existing TypeScript project without changing
its runtime architecture.

Uneffect 0.1 is experimental. Before making a check release-blocking, read the
[stability and safe-adoption guide](./stability.md): pin tool versions, select a
consumer-project boundary, reject relevant `unknown` results, retain the JSON
evidence, and keep runtime validation at untrusted inputs.

## 1. Install

Uneffect requires Node.js 24 or newer. TypeScript is a peer dependency. For an
explicit `--project` boundary, Uneffect resolves the consumer's TypeScript
package and compares its exact version with the analyzer module executing the
check.

```sh
npm install --save-dev @mizchi/uneffect typescript
npx uneffect doctor
```

`doctor` fails only for missing requirements used by normal checks. Quint and a
JDK are optional unless the project runs generated temporal models. Contract
checks prefer an installed native `z3` and otherwise use bundled WASM; pin the
choice with `UNEFFECT_Z3_BACKEND=native` or `wasm` when reproducible execution
policy matters.

## 2. Add one annotated file

Create `src/uneffect-example.ts`:

```ts
/* uneffect: effect Console */
export function report(value: number): void {
  console.log(value)
}

/* uneffect: requires n >= 0 */
/* uneffect: ensures result === n */
export function count(n: number): number {
  let value = 0
  /* uneffect: invariant value >= 0 && value <= n */
  while (value < n) value = value + 1
  return value
}
```

The repository keeps the same program as
[`examples/quickstart.ts`](../examples/quickstart.ts), and CI checks that
example through the public CLI.

The comments remain valid TypeScript trivia. Removing Uneffect from the build
does not change the emitted JavaScript.

## 3. Check it

```sh
npx uneffect check src/uneffect-example.ts
```

No output and exit code 0 mean no enabled checker produced a diagnostic. They
do not mean arbitrary TypeScript or every host behavior was proved. Add
`--evidence` to see successful obligations and inferred effects:

```sh
npx uneffect check --evidence src/uneffect-example.ts
```

For an existing project, pass its TypeScript configuration. Explicit files use
that project's compiler options; omitting files uses its `include`/`files`
selection:

```sh
npx uneffect check --project tsconfig.json --infer src/entry.ts
npx uneffect check --project tsconfig.json --infer
```

For CI integrations that must not parse human-readable prose, request the
versioned decision report. It is emitted even when the command exits 1:

```sh
npx uneffect check --project tsconfig.json --infer \
  --assurance no-unknown --json > uneffect-check.json
```

Treat `outcome`, `assurance.status`, `blockers`, `claims`, and `exclusions` as a
single decision. In particular, `assurance: null` means no assurance profile was
requested; it is not equivalent to `verified`. A failed assurance report has an
empty `claims` array. Read its `blockers`; Uneffect does not publish the target
claim as an established fact alongside a failed decision.

The JSON report records both compiler package locations and versions.
Assurance fails with a TypeScript `unknown` blocker when the consumer package
cannot be resolved or its exact version differs. A gradual check can still
produce diagnostics and inventories, but is not presented as project-compatible
TypeChecker evidence.

For a solution-style root, the no-positional-file form follows project
references and checks each config independently:

```sh
npx uneffect check --project tsconfig.json --infer \
  --assurance no-unknown --json > uneffect-workspace-check.json
```

The output uses `uneffect-workspace-check/v1`, not `uneffect-check/v1`. Inspect
the aggregate `outcome` and `assurance`, every child in `projects`, and graph
`blockers`. Missing/malformed references, cycles, duplicate root ownership, and
empty leaf configs fail closed. Explicit positional files continue to select a
single compiler domain; they do not request solution expansion.

The workspace report contains separate `effectComposition` and
`refinementComposition` ledgers. The latter currently verifies only a direct
call from one annotated action to a scalar action in a referenced project. A
guarded action requires the parent wrapper body to contain only that call; its
verified guard is checked and emitted on the link. Both projects must use the
same adapter version, the child
create/observe/action bindings must verify locally, and the consumed `.d.ts`
must match the selected TypeScript compiler's exact in-memory declaration emit.
Do not treat an empty (`not-applicable`) ledger as proof that refinements were
composed.

Refinement markers currently attach only to exported top-level function
declarations. Placing one on a class method, arrow-function variable, or another
unsupported declaration shape is an explicit violation. In particular, moving
the same text to a different declaration is not a harmless no-op.

An action may also use up to two source-local function helpers. Each helper must
resolve by TypeChecker symbol identity, have no writes to its binding, and have
a body consisting only of the next call. The report emits the complete
`callPath` and `helperDepthBudget: 2`; a guarded child also retains its `guard`.
Helper-local guards, extra/conditional work, reassignment, recursion, and a
third helper level remain `unknown`.

For an adapter whose runtime is the ECMAScript global object in the current
Realm, both projects may opt in explicitly:

```ts
/* uneffect: runtime counter@1 = globalThis */
```

Only the TypeChecker-resolved builtin `globalThis` symbol is accepted at the
composed call. The evidence link records
`identity: "ecmascript:realm.globalThis"`. Uneffect does not equate this with a
shadowed binding, `window`, Node `global`, Worker globals, iframe values, or a
property below the global object.

For Node's ambient `global`, include the Node typings major and a user-chosen
realm label on both sides:

```ts
/* uneffect: runtime counter@1 = node:global@24#main */
```

The composed call must use the TypeChecker-resolved `@types/node` major 24
ambient symbol. A different label such as `#worker`, a different major, or a
locally shadowed `global` is rejected. Realm labels are explicit contracts, not
runtime discovery or proof of deployment topology.

If a non-TypeScript file contains an exact TypeScript region that is emitted as
a `.ts` file without changing its text, bind that relation explicitly:

```json
{
  "$schema": "./node_modules/@mizchi/uneffect/schemas/uneffect-declaration-transforms-v1.schema.json",
  "schema": "uneffect-declaration-transforms/v1",
  "transforms": [{
    "profile": "embedded-typescript/v1",
    "transform": { "name": "component-script", "version": "1.0.0" },
    "sourceFile": "src/counter.component",
    "generatedFile": "generated/counter.ts",
    "sourceSpan": { "start": 19, "end": 417 },
    "sourceDigest": "<lowercase SHA-256 of the complete source file>",
    "generatedDigest": "<lowercase SHA-256 of the generated TypeScript>",
    "compilerVersion": "<exact TypeScript version>"
  }]
}
```

```sh
npx uneffect check --project tsconfig.json --infer \
  --declaration-transforms uneffect.transforms.json \
  --assurance no-unknown --json
```

Offsets are JavaScript UTF-16 string offsets. The selected source substring
must equal the complete generated TypeScript string exactly. Uneffect rejects
source/output digest drift, compiler drift, missing spans, unknown profiles,
and mappings where multiple transformed inputs contribute to one declaration.
This profile proves only exact embedded-TypeScript span identity. It does not
validate the surrounding host language, template semantics, runtime lowering,
or a transform that edits the embedded TypeScript.

If downstream projects rely on checked-in or cached composite outputs, add
`--require-build-artifacts`. This rejects missing/stale `.d.ts` and buildinfo
according to TypeScript SolutionBuilder. If the deployment executes the exact
TypeScript emit, use `--require-exact-build-artifacts` instead. It additionally
byte-compares emitted declarations and runtime JavaScript against an in-memory
emit and rejects post-build changes. It intentionally cannot certify bundler or
post-transform output.

To see a load-bearing failure, change the return to `return value - 1`. The
postcondition must then fail with a source-mapped counterexample. Also replace
`Console` on `report` with `Fetch`: the `console.log` call must produce a
missing-effect error (and `Fetch` is reported as unused).

## 4. Add a repeatable project command

Start with an explicit file list so the checked boundary is reviewable:

```json
{
  "scripts": {
    "check:uneffect": "uneffect check src/uneffect-example.ts"
  }
}
```

Then run:

```sh
npm run check:uneffect
```

Uneffect accepts multiple files as positional arguments. Let the package
manager or repository task runner expand file lists; the CLI does not need to
own a project-specific glob policy.

## 5. Add a scoped capability

Filesystem and network scopes use the same finite-set authority model as Deno.
Symbolic path anchors keep machine-specific paths out of annotations:

```ts
/* uneffect: effect FsRead<"$WORKSPACE_ROOT/config/**"> */
export function loadConfiguration(): unknown {
  // Existing node:fs code remains unchanged.
}
```

Available anchors include `$WORKSPACE_ROOT`, `$CWD`, and `$TEMP`. `$TEMP`
represents the platform result of `node:os.tmpdir()`. See
[Deno-compatible permissions](./deno-permissions.md) for exact containment
rules and unsupported glob forms.

Generator consumers have a separate lazy-effect bound. This prevents an empty
function-body inventory from being mistaken for purity:

```ts
/* uneffect: effect_parameter iterator extends Console | Throw<Error> */
export function consume(iterator: IteratorObject<unknown>): unknown[] {
  return Array.from(iterator)
}
```

Resolved call sites are checked against the bound. An opaque iterator remains
unknown, and a normal `effect` directive does not stand in for
`effect_parameter`. See [Effect system](./effect-system.md).

## 6. Use precise helper types and optional assertions

Uneffect exports TypeScript-friendly helper types such as `Int`, `Nat`,
`Float`, and machine-number refinements. They remain zero-runtime type imports:

```ts
import type { Nat } from "@mizchi/uneffect"

/* uneffect: requires value >= 0 */
/* uneffect: ensures result === value */
export function identity(value: Nat): Nat {
  return value
}
```

An `assert` directive can be emitted as an optional runtime assertion by the
instrumenter:

```sh
npx uneffect instrument src/uneffect-example.ts > generated.ts
```

Instrumentation is opt-in. Plain `check` does not add runtime code.

## 7. Generate a temporal model

Temporal expressions use a restricted TypeScript-style syntax and are parsed
into Uneffect's neutral IR before backend generation:

```ts
/* uneffect:
  state pending: int
  init pending = 0
  action enqueue: pending' = pending + 1
  action complete: pending' = pending > 0 ? pending - 1 : pending
  temporal nonnegative: pending >= 0
*/
export type QueueModel = never
```

The checked repository copy is
[`examples/quickstart-model.ts`](../examples/quickstart-model.ts).

Generate Quint source without installing Quint:

```sh
npx uneffect spec quint src/queue-model.ts > queue-model.qnt
```

To execute the generated model:

```sh
npm install --save-dev @informalsystems/quint
npx quint run queue-model.qnt
```

Use `spec lint` and the Z3-backed checks for state predicates; use Quint for
ordering and temporal interleavings. See
[Specification backends](./specification-backends.md).

## 8. Put the check in CI

Run the same package script in CI and pin the lockfile. Once the selected files
have no unresolved effect summaries, add an explicit assurance gate:

```sh
npx uneffect check --assurance no-unknown src/uneffect-example.ts
```

Executable top-level code may declare its own authority upper bound in the file
header. It is checked independently from function declarations:

```ts
/* uneffect: module_effect Console | FsRead */
await main()
```

The module summary is a may-effect set. It does not prove exact ESM or
top-level-await ordering. Known callback owners include effects from inline
callbacks and immutable local/imported function identifiers. Mutable,
reassigned, dynamically selected, or unresolved callbacks make the module
summary `unknown`; adding a wider `module_effect` declaration does not discharge
that uncertainty. Runtime namespace bodies and class heritage, computed member
names, stable decorator functions, static initializers, and static blocks are
also included. A decorator factory whose returned function cannot be resolved
remains `unknown`. String-literal relative dynamic imports resolved to source files in
the current Program contribute conditional may-effects. Computed or external
dynamic imports remain `unknown`; this does not prove their asynchronous
evaluation order.
Static runtime imports from external packages likewise remain `unknown` unless
their initialization has a reviewed, versioned registry contract. A matched
contract is reported as `trusted` and is recorded as a project assumption;
`--assurance no-unknown` may pass it as `assumed`, never as `verified`.
Package contracts match the exact resolved package version and Node contracts
match the reviewed runtime major. Upgrades fail closed until the registry entry
is reviewed and updated.

Library consumers can pass a caller-owned `builtinRegistry` to
`verifyUneffectProject`, `analyzeProgramEffects`, or `checkFiles`. Build it
with `extendBuiltinContractRegistry` so the platform defaults remain present.
Such entries remain reviewable assumptions: they can make a result `assumed`,
not `verified`. The same extension is available to `check` and `evidence` with
`--config uneffect.registry.json`; see [Command line](./cli.md). Invalid schema
versions, unknown keys, duplicate identities, malformed effects, and runtime
version drift fail closed.

After every function in that boundary has an explicit effect upper bound, use
the stronger effect gate:

```ts
/* uneffect: module_effect none */
/* uneffect: effect none */
export function normalize(value: string): string {
  return value.trim().toLowerCase()
}
```

`none` is the explicit empty Effect set. An unannotated function that happens
to infer no Effect is still only `inferred`, so it does not satisfy the
`declared` or `verified` profile as a function boundary.

```sh
npx uneffect check --assurance declared src/uneffect-example.ts
```

For a deliberately narrow boundary that must use no recorded trusted semantic
inputs, require both declaration checking and an empty collected ledger:

```sh
npx uneffect check --assurance verified src/uneffect-example.ts
```

A correctly declared call to a reviewed builtin still blocks this profile. Use
`declared` when that reviewed contract is an accepted, owned assumption.

These profiles cover emitted evidence for the explicit file boundary; they are
not whole-program or assumption-free proofs. The CLI prints both the claims
established by a passing profile and exclusions that remain outside it; API
consumers receive the same data in `AssuranceAssessment.claims` and
`.exclusions`. `AssuranceAssessment.coverage` reports selected files, effect
summaries, contract artifacts, assumptions, and uncovered files. The profile fails if it
would be vacuous or if evidence from one input would hide another selected file
that emitted no proof-relevant artifact. See
[Assurance boundaries](./assurance-boundaries.md).

Treat exit code 1 as a program diagnostic or assurance failure and exit code 2
as a broken invocation. A practical rollout
starts with a small explicit file set and expands it only after existing
diagnostics have owners.

Continue with [Adoption patterns](./adoption-patterns.md), then consult the
[feature matrix](./feature-matrix.md) before relying on a proof boundary.
