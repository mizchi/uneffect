# Evidence and optimization

Uneffect separates gradual diagnostics from authority to rewrite code. Every effect summary carries one evidence status:

- `verified`: inferred behavior is contained by a checked declaration or a discharged solver obligation.
- `trusted`: a reviewed external contract or user-supplied temporal summary is assumed at the boundary.
- `inferred`: behavior was observed by analysis but has no checked upper bound.
- `unknown`: analysis, syntax, or a proof obligation was unsupported or contradicted.

`inferred` and `unknown` remain useful for adoption diagnostics, but neither authorizes an optimizer transformation.

`verifyUneffectProject` runs the program-wide effect analysis in gradual
adoption mode alongside contracts, typed arrays, ownership, assumptions, and
optional temporal verification. Unannotated functions are inferred without a
mandatory boundary, while any function that has an `effect` annotation is
checked as an upper bound and its missing/unused effects appear in the unified
project diagnostics.
The same call returns these inferred/verified summaries under `result.effects`,
so tooling can inspect the authority actually attributed to every callable
instead of reconstructing it from diagnostics. Program-produced summaries
include a stable `fileName:start` ID and source span, avoiding ambiguity between
same-named functions in different modules.

Project verification is fail-closed on TypeScript syntax, semantic, and
compiler-option errors. These errors appear in `result.diagnostics`; function
and module summaries, contract obligations, and typed-array obligations from
the invalid source are downgraded to `unknown`. Optional temporal models may
still be emitted for inspection, but their properties return `error` without
invoking Quint. Emitted JavaScript remains available for gradual tooling and
must not be interpreted as verified output. Every temporal property carries
its source `fileName`, so a verified sibling cannot be mistaken for evidence
about an invalid file with the same property name.

## Reproducible artifacts

`just evidence file.ts` emits JSON containing the Uneffect version, TypeScript compiler revision, normalized compiler-options hash, source hash, builtin-contract digest, summaries, and diagnostics. Changing any of these proof dependencies invalidates the artifact.

Builtin overlays are `trusted`; Z3 `unsat` obligations are `verified`; Z3 counterexamples, `unknown`, and unsupported lowering produce `unknown` evidence. Temporal summaries are currently `trusted` because composition checks their use but does not prove their bodies.

## Assumption ledger and CI policy

`verifyUneffectProject` returns an `uneffect-assumptions/v1` ledger. It currently
records every trusted builtin call that the frontend resolves, every
function-level `trust typed-array` escape hatch, and every user-supplied
temporal function summary. Each entry has a stable content-derived ID, reason,
domain, file/function scope, UTF-16 source span, and optional owner and
expiration date. Builtin defaults are owned by `@mizchi/uneffect`; their
expiration is deliberately unbounded and must be explicitly allowed by policy.

User assumptions attach review metadata without changing JSDoc semantics:

```ts
function encodePacket(output: BoundedUint8Array<1>, value: number) {
  /* uneffect: trust typed-array:u8-write validated by the packet conformance suite */
  /* uneffect: trust_owner telemetry-platform */
  /* uneffect: trust_expires 2027-06-30 */
  output[0] = value
}
```

A CI caller can require review ownership and expiration, reject assumptions
whose valid calendar date is earlier than `asOf`, and exempt selected domains:

```ts
const result = await verifyUneffectProject({
  files,
  assumptionPolicy: {
    requireOwner: true,
    requireExpiration: true,
    denyExpired: true,
    allowUnboundedDomains: ["builtin"],
    asOf: "2026-08-21",
  },
})
if (result.assumptions.violations.length > 0) process.exitCode = 1
```

Violations also appear in project diagnostics with kind `assumption-policy`.
The ledger is exhaustive for the three trusted domains listed above, not for
arbitrary objects constructed through the low-level `trustedSummary` evidence
helper. New trusted domains must integrate with the collector before claiming
project-wide audit completeness. Metadata is review accountability rather than
a proof: the typed-array escape hatch and temporal body remain assumed.

## Transformation obligations

Each transformation has a distinct versioned schema.

`stable-read-reuse/v1` requires proof-grade evidence and an event interval with no overlapping mutation, invalidation, transfer, escape, or suspension. `applyStableReadReuse` performs the replacement only after this obligation succeeds; otherwise it returns the original source unchanged.

`property-mangle/v1` is deliberately separate. It additionally requires a closed property universe, no reflective access, and no escape of objects carrying the property. A successful stable-read proof says nothing about safe property renaming.

`ownership-guard-elision/v1` permits removal only of an
`uneffectAssertOwnership(...)` assertion generated by Uneffect instrumentation.
The attached `ownership-evidence/v1` artifact must be proof-grade and must still
match both the ownership obligation and regenerated verifier program. Unknown,
counterexample, tool failure, stale hashes, or a user-authored span returns the
original source unchanged. Ownership evidence does not justify deleting or
reordering user-authored Promise calls, guards, handlers, or cleanup.

`instrumentOwnershipAssertions` emits checks for unresolved guarded ownership
calls that are direct expression statements. `optimizeOwnershipAssertions`
then validates supplied artifacts and removes only matching generated checks.
When every generated check is discharged, it removes the generated helper as
well. The original callee invocation remains in the output. Nested expression
calls are currently rejected by this instrumentation slice because moving a
guard evaluation across sibling expressions could change evaluation order.

The one-shot verified build is available through the API and CLI:

```ts
const result = buildVerifiedOwnership(fileName, source)
```

```sh
just instrument-ownership input.ts  # retain runtime checks
just verified-ownership input.ts    # run Z3, elide matching proofs
```

The CLI flag is `--verify-ownership`. Backend failure and unresolved goals keep
the runtime checks and report their count on stderr. The API also returns every
artifact and unresolved obligation. `just verified-ownership` persists proof
records in `.uneffect/ownership-evidence.json`; the equivalent explicit CLI is
`--verify-ownership --ownership-evidence <cache.json>`. Matching proof-grade
records are reused without invoking Z3. A previously verified record whose
obligation or generated verifier program changed is reported as stale and is
rechecked. Previous unknown/error results are retried but are not mislabeled as
stale proof. Cache writes use an atomic replacement, and malformed caches are
treated as empty, so cache damage can never authorize assertion elision.

These prototypes establish the proof boundary, not a production compressor. A future Corsa/Oxc implementation may regenerate the rewrite layer while preserving the obligation contracts and artifact inputs.

`optimizeUneffectProject` is the first project-level authorization API. It
discovers repeated stable reads and persists `uneffect-project-optimization/v1`.
The initial analysis only writes evidence; a later build may report a
transformation as `applied: true` when source hashes, TypeScript revision,
builtin-contract digest, and closed-world mode still match. Malformed or stale
artifacts never authorize a transformation. The current result is an
authorization plan for a downstream compressor, not rewritten JavaScript.

## Dogfood gate

`just dogfood` analyzes every TypeScript implementation file as one Program in inference-only adoption mode, then runs a regression test requiring zero diagnostics and zero `unknown` summaries. This exercise found and fixed two frontend issues: mutations of freshly allocated locals were incorrectly escaping into caller summaries, and known synchronous TypeScript/Array callback APIs were being classified with unknown invocation timing. Annotated boundaries remain enforced in inference-only mode.

The Node service dogfood additionally reads a scoped settings file, composes
the callback's Console and Timer capabilities into the registering function,
and verifies fs poll → next-tick → V8 microtask → later Immediate behavior.
Removing `Console` from the annotated boundary is a required negative control.

The telemetry packet dogfood fixture additionally applies the assumption policy
to a statement-scoped typed-array wire-format escape hatch, a Console builtin,
and a temporal summary. Removing either user assumption owner produces a CI
diagnostic. Unrelated statements remain checked. This shows useful review
enforcement at a realistic serialization boundary, while the underlying
byte-domain safety is intentionally not claimed as verified.
