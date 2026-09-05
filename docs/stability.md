# Stability and safe adoption

Uneffect 0.3.0 is an experimental release. Public JavaScript APIs, CLI options,
comment grammar, and semantic behavior may change before 1.0. Versioned artifact
schemas retain their own compatibility boundary. This page distinguishes a
tested fragment that can be used conservatively today from experimental models
and unsupported work. "Supported" below means covered by executable positive
and negative tests for the exact documented shape; it does not mean complete
JavaScript semantics.

## Maturity labels

| Label | Meaning | Permitted reliance |
| --- | --- | --- |
| Supported fragment | Positive tests, adjacent fail-closed controls, machine-readable evidence, and CI coverage exist for a precisely documented shape. | Use as an additional review or CI gate on a pinned, explicitly selected boundary. Rely only on the emitted claim and exclusions. |
| Experimental | An executable model or prototype exists, but composition, host coverage, proof independence, or application evidence is incomplete. | Explore, generate counterexamples, and collect evidence. Do not make it a sole release, security, or optimization authorization boundary. |
| Unsupported | The shape is rejected, reported `unknown`, or not analyzed. | No positive assurance. Keep it blocking when the property matters, or use an explicit reviewed assumption/escape hatch. |

An `unknown` result never becomes supported because another nearby test passes.
An `assumed` result remains conditional on its recorded trust ledger. A
`verified` result applies only to its exact source snapshot, configuration,
syntax fragment, backend, claim, and exclusions.

## Supported adoption line

The following workflow is the current safe line:

1. Pin Uneffect, Node.js, TypeScript, and solver/tool versions.
2. Select files with the consumer project's `tsconfig.json`; do not infer a
   whole-program boundary from an entry file.
3. Start with diagnostics and inventories, then enable an assurance profile for
   a deliberately selected boundary.
4. Treat every `unknown` relevant to the intended claim as blocking.
5. Store the versioned JSON report with the build and inspect its `claims`,
   `blockers`, `assumptions`, `coverage`, and `exclusions` together.
6. Retain TypeScript checks, tests, and runtime validation at untrusted inputs.

```sh
npx uneffect doctor
npx uneffect check --project tsconfig.json --infer \
  --assurance no-unknown --json > uneffect-check.json
```

Within that workflow, these bounded capabilities have a supported fragment:

- parsing and validating `/* uneffect: ... */` directives;
- explicit function and module Effect upper bounds for documented direct,
  TypeChecker-resolved builtin and local-call shapes;
- versioned JSON decision reports and fail-closed assurance profiles;
- Deno-shaped permission-set parsing and containment for documented literal
  path, host, environment, subprocess, system, FFI, and import scopes;
- deterministic property generation and shrinking for the domains listed in
  the feature matrix, including finite source-local and direct named-imported
  unary predicate specializations;
- native-Z3 preference with classified infrastructure fallback to bundled WASM;
- the exact bounded contract, typed-array, Promise/resource, temporal, and
  cross-project fragments listed as tested in the feature matrix.
- the versioned Corsa semantic-query API descriptor and its explicitly listed
  position, alias, module-export, type, assignability, and bounded builtin
  query capabilities;
- the versioned temporal model coverage contract, which distinguishes modeled,
  not-applicable, and excluded Promise/resource domains and rejects malformed
  stored artifacts.

These are supported but remain pre-1.0 APIs. Pinning is required, and a future
minor release may change syntax or report fields outside an explicitly
versioned schema. The `@mizchi/uneffect/experimental` subpath remains outside
this compatibility boundary.

## Installed-package evidence

`just package-check` runs the package lifecycle and tests the produced tarball,
not the source-tree imports. A fresh Node 24 consumer must type-check and execute
the documented root, Corsa, direct Corsa API, spec, and JSON-schema entrypoints.
The same probe rejects unknown fields and schema versions for the temporal and
Corsa descriptors, verifies the stable/experimental export split, and installs
a second consumer with optional dependencies omitted to require explicit Corsa
compiler and binding diagnostics. CI retains the exact file inventory, npm
integrity values, SHA-256 digest, and per-probe completion state as
`uneffect.package-evidence/v1`. A pending probe state or failed CI job is not
release evidence.

## 0.3.0 application-mutation evidence

Release qualification retains two realistic implementation-only mutations in
`test/dogfood.test.ts`. In both cases, the public specification boundary stays
unchanged between the passing source and mutant:

| Application boundary | Implementation-only defect | Public decision | Explicit non-claim |
| --- | --- | --- | --- |
| Browser dashboard fetch with timeout and composed shutdown signals | Replace the returned `fetch` with a floating call while retaining the Effect directive | `verifyUneffectProject` reports `floating-promise` and a violated ownership assurance blocker | Synchronization through the externally supplied/composed abort signals remains `abortable-fetch-synchronization` excluded |
| Node upload loop with `await using` session disposal | Remove the mandatory alias clear so the disposed session is used after its lexical scope | `verifyUneffectProject` reports `disposed-resource-use` and a violated resource assurance blocker | Resource/callback interleavings remain excluded; the declared external session factory also keeps its separate Effect evidence unknown |

The resource projections may still verify their disposal-order invariants in
the broken alias case. That does not erase the independent use-after-disposal
diagnostic: project assurance aggregates both results and fails. Conversely,
an explicit exclusion is not presented as a counterexample. The focused test
records diagnostic code, source owner, coverage classification, and normalized
message stability across repeated analysis.

Run the retained evidence with:

```sh
pnpm exec vitest run test/dogfood.test.ts \
  -t 'blocks a stale disposed upload-session alias|blocks a floating fetch mutation'
```

On the 2026-09-05 development host, that focused command completed in 11.26
seconds wall time (9.79 seconds in the two test bodies, including the repeated
diagnostic check). After two later remote partitioning controls exposed repeated
whole-source analysis as the remaining bottleneck, the five-partition local
candidate executed all 130 cases once in 131.851 seconds of child time; its
slowest partition took 57.414 seconds. Current-HEAD run 33968358071 then passed
all seven jobs. Its five dogfood partitions completed on attempt 1 in 63.339,
13.534, 39.114, 89.250, and 140.988 seconds: 346.225 seconds total, or 72.1% of
the 480-second acceptance budget. The slowest partition used 47.0% of its
300-second hard deadline. These observations are not portable promises; the
versioned timing artifact and #67's finite policy own the release-time decision.

## Public API boundary

The supported import paths and compatibility policy are defined in [Public API
and compatibility](./public-api.md). In particular, use
`generateTemporalModel` or `spec temporal` for temporal work. The
`@mizchi/uneffect/experimental` subpath intentionally has no compatibility
guarantee. A symbol being available from the package root stabilizes its API
placement; it does not promote every input shape accepted by that symbol to a
supported proof fragment. Assurance maturity remains defined by this document
and the feature matrix.

## Experimental surfaces

The following areas have meaningful executable coverage but remain research
prototypes rather than generally safe language semantics:

- general temporal-property and invariant synthesis ([#2](https://github.com/mizchi/uneffect/issues/2), [#5](https://github.com/mizchi/uneffect/issues/5));
- complete Node/browser event-loop and Promise timing ([#10](https://github.com/mizchi/uneffect/issues/10), [#18](https://github.com/mizchi/uneffect/issues/18));
- React function-component lifecycle and concurrent scheduling ([#16](https://github.com/mizchi/uneffect/issues/16));
- Corsa/native frontend parity beyond the supported semantic-query API descriptor
  and documented symbol families ([#8](https://github.com/mizchi/uneffect/issues/8));
- arbitrary CFG fixed points, aliases, dynamic dispatch, and heap reasoning ([#25](https://github.com/mizchi/uneffect/issues/25), [#24](https://github.com/mizchi/uneffect/issues/24));
- recursive, higher-order, inferred, or multi-argument property predicates ([#4](https://github.com/mizchi/uneffect/issues/4));
- complete SHA-256, resizable/shared buffers, Atomics, and shared-memory proofs ([#6](https://github.com/mizchi/uneffect/issues/6));
- proof-guided compression, mangling, reordering, or dead-code elimination ([#13](https://github.com/mizchi/uneffect/issues/13));
- independently checkable proof certificates for every solver result ([#7](https://github.com/mizchi/uneffect/issues/7));
- compatibility guarantees for the pre-1.0 public surface ([#62](https://github.com/mizchi/uneffect/issues/62)).

Z3, Quint, and TLC artifacts are useful reproducible evidence. They are not by
themselves certificates checked independently of Uneffect's translation.

## Unsafe interpretations

Do not use Uneffect as:

- the sole security, authorization, sandbox, or runtime input-validation layer;
- evidence that unannotated code is pure or that an unmodeled domain is absent;
- a whole-program correctness, termination, liveness, or race-freedom proof;
- permission to ignore `unknown`, unsupported syntax, compiler drift, or an
  assumption ledger;
- authorization for a general optimizer transformation.

The [feature matrix](./feature-matrix.md) is the compact per-domain boundary.
[Assurance boundaries](./assurance-boundaries.md) define result-state meaning.
[Implementation status](./implementation-status.md) records the exact tested
fragments, and the [roadmap](./roadmap.md) owns known gaps.
