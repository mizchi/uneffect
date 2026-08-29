# Stability and safe adoption

Uneffect is published as `0.0.0-alpha.0`. No JavaScript API, CLI option, comment
grammar, or semantic result is SemVer-stable yet. This page distinguishes a
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

These are still alpha APIs. Pinning is required, and a future release may
change syntax or report fields outside an explicitly versioned schema.

## Experimental surfaces

The following areas have meaningful executable coverage but remain research
prototypes rather than generally safe language semantics:

- general temporal-property and invariant synthesis;
- complete Node/browser event-loop and Promise timing;
- React function-component lifecycle and concurrent scheduling;
- Corsa/native frontend parity beyond the documented symbol families;
- arbitrary CFG fixed points, aliases, dynamic dispatch, and heap reasoning;
- recursive, higher-order, inferred, or multi-argument property predicates;
- complete SHA-256, resizable/shared buffers, Atomics, and shared-memory proofs;
- proof-guided compression, mangling, reordering, or dead-code elimination;
- independently checkable proof certificates for every solver result.

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
