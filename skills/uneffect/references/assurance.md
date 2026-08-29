# Uneffect assurance guide

Read this before relying on a green check or describing Uneffect's guarantees.

## Safe reliance line

Uneffect is an additional, fail-closed review and CI layer for explicitly
selected TypeScript boundaries. A diagnostic or counterexample is useful
evidence of a problem. A `verified` artifact applies only to its exact claim,
source snapshot, configuration, supported syntax fragment, compiler, and
backend evidence.

Do not use Uneffect as:

- the sole security or authorization boundary;
- a replacement for TypeScript or runtime input validation;
- a whole-program correctness, termination, or purity proof;
- proof of arbitrary third-party, native, WASM, browser, or framework behavior;
- authorization for general compiler optimization or code reordering.

## Result vocabulary

- `verified`: the emitted claim was established inside the named supported
  fragment with no assumption required by the selected policy.
- `assumed`: the result depends on a visible trusted contract or escape hatch.
- `unknown`: Uneffect could not establish or refute the claim. It proves
  nothing and should block assurance-sensitive boundaries.
- `violated`: a checked obligation was refuted or a required bound was exceeded.

An empty or not-applicable ledger is not proof that the corresponding domain
was checked. Ensure the selected files emit proof-relevant evidence for every
domain being relied upon.

## Common reasons to stay conservative

Expect partial or unknown evidence around dynamic dispatch, unresolved aliases,
reflection, Proxy behavior, mutable callback selection, arbitrary getters and
coercions, native addons, external package bodies, bundler transforms, full
event-loop behavior, SharedArrayBuffer/Atomics, general heap aliasing, and
unsupported control-flow shapes.

Temporal model checking is bounded and trusts the translation from TypeScript
annotations to the generated model. Z3 and Quint outputs are reproducible
evidence, not independently checkable proof certificates. Integer/real solver
models must not be described as full JavaScript `number` or IEEE-754 semantics.

## Third-party boundaries

External contracts can make an application wrapper auditable: allowed hosts,
DOM regions, invocation count, Promise ownership, and initialization effects.
They do not verify the dependency's hidden implementation. Record exact package
identity/version and trust provenance where supported, reject unregistered
external calls in assurance-sensitive code, and re-review contracts on upgrades.

## Escape hatches

Use trust/discharge mechanisms only to name a real external argument the tool
cannot prove. Keep owner, reason, scope, and expiry visible where the schema
supports them. Never relabel trusted evidence as verified or suppress unknown
evidence from CI reports.

## Before enabling a CI gate

1. Pin Uneffect, TypeScript, relevant schemas, and solver/backend policy.
2. Select exact files or a project boundary.
3. Confirm each relied-on domain emitted evidence.
4. Review assumptions, unknown reason codes, exclusions, and uncovered files.
5. Keep runtime checks at untrusted boundaries.
6. Store the JSON report and generated model/counterexample artifacts.
7. Start with `no-unknown`; move to stronger profiles only when their extra
   requirements match the intended claim.

## Authoritative details

- [`docs/assurance-boundaries.md`](../../../docs/assurance-boundaries.md)
- [`docs/stability.md`](../../../docs/stability.md)
- [`docs/feature-matrix.md`](../../../docs/feature-matrix.md)
- [`docs/implementation-status.md`](../../../docs/implementation-status.md)
- [`docs/evidence-and-optimization.md`](../../../docs/evidence-and-optimization.md)
