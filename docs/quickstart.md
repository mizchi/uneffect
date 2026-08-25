# Quickstart

This guide adds Uneffect to a small existing TypeScript project without changing
its runtime architecture.

## 1. Install

Uneffect requires Node.js 24 or newer. TypeScript is a peer dependency so the
analyzer can use the compiler selected by the project.

```sh
npm install --save-dev @mizchi/uneffect typescript
npx uneffect doctor
```

`doctor` fails only for missing requirements used by normal checks. Quint and a
JDK are optional unless the project runs generated temporal models.

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

After every function in that boundary has an explicit effect upper bound, use
the stronger effect gate:

```sh
npx uneffect check --assurance declared src/uneffect-example.ts
```

These profiles cover emitted evidence for the explicit file boundary; they are
not whole-program or assumption-free proofs. The CLI prints both the claims
established by a passing profile and exclusions that remain outside it; API
consumers receive the same data in `AssuranceAssessment.claims` and
`.exclusions`. See
[Assurance boundaries](./assurance-boundaries.md).

Treat exit code 1 as a program diagnostic or assurance failure and exit code 2
as a broken invocation. A practical rollout
starts with a small explicit file set and expands it only after existing
diagnostics have owners.

Continue with [Adoption patterns](./adoption-patterns.md), then consult the
[feature matrix](./feature-matrix.md) before relying on a proof boundary.
