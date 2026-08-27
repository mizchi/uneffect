# Evidence and optimization

Uneffect separates gradual diagnostics from authority to rewrite code. Every effect summary carries one evidence status:

- `verified`: inferred behavior is contained by a checked declaration or a discharged solver obligation.
- `trusted`: a reviewed external contract or user-supplied temporal summary is assumed at the boundary.
- `inferred`: behavior was observed by analysis but has no checked upper bound.
- `unknown`: analysis, syntax, or a proof obligation was unsupported or contradicted.

Only `verified` authorizes an optimizer transformation. `trusted`, `inferred`,
and `unknown` remain useful for adoption and audit diagnostics, but a reviewed
assumption is not silently upgraded into a semantics-preserving rewrite proof.

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

The overload that accepts a TypeScript configuration preserves solution
boundaries rather than constructing one merged Program:

```ts
const workspace = await verifyUneffectProject({ projectFile: "tsconfig.json" })

if (!workspace.assurance.passed) {
  for (const blocker of workspace.blockers) console.error(blocker)
}
```

Its `uneffect-project-workspace/v1` envelope contains the reference graph,
child-first build order, every config/root/compiler provenance tuple, every
per-domain `VerifyUneffectProjectResult`, and aggregate assurance. Different
valid compiler options remain independent. Missing/malformed/cyclic graphs,
ambiguous root ownership, unreadable sources, TypeScript version drift, and a
failed child domain block the aggregate result. The published envelope schema
is `schemas/uneffect-project-workspace-v1.schema.json`.

This aggregation links only uniquely resolved `verified` function and module Effect
summaries across project declaration/import boundaries and records every accepted or
blocked link in `effectComposition`. A separate `refinementComposition` ledger
links the documented direct scalar action fragment only after local child
validation, exact declaration matching, and parent-action revalidation. A
guarded action is accepted only through a sole direct wrapper call and records
the inherited guard; extra wrapper work prevents guard inheritance.
It does not link solver obligations, cross-project invariants, ownership, or
temporal evidence. Supported parameter, exported
closure/module, same-realm global, and bounded iterator Effect substitutions are
part of the linked Effect contract. Every declaration consumed by such a link
must exactly match a SHA-256-bound same-compiler in-memory declaration emit.
Pass `buildArtifacts: "require-fresh"` to make TypeScript SolutionBuilder's
dry-run freshness judgment load-bearing. Use `buildArtifacts: "require-exact"`
when deployed code is the exact TypeScript emit: it additionally byte-compares
all emitted declarations and runtime JavaScript. `noEmit`, `emitDeclarationOnly`,
bundlers, and post-emit transforms do not satisfy that stronger claim.
The composition status is deliberately non-vacuous: zero links and zero
blockers is `not-applicable`, not `verified`.

`uneffect evidence file.ts` emits `schemaVersion: 3`. Each summary retains its
stable Program identity, source file, UTF-16 span, formatted concrete effects,
and evidence status; polymorphic Generator consumers
also retain `iteratorEffectParameters` and their formatted
`iteratorEffectBounds`. Consequently a downstream auditor can distinguish an
empty function-body effect set from an unbounded lazy-effect parameter and can
inspect the declaration that justified a bounded `verified` result. Schema v1
predates iterator polymorphism and schema v2 lacks mandatory per-summary source
identity; neither may authorize a current claim. The artifact identifies its `sourceFile`
and binds `sourceHashes` for every non-declaration source in the analyzed
TypeScript Program; `sourceHash` remains the root-file hash for compatibility.
Changing an imported implementation therefore changes the evidence inputs even
when the root source is unchanged.

Consumers should call `validateEvidenceArtifact(program, source, summaries,
artifact, builtinRegistry)` after regenerating the current Program analysis.
Both `createEvidenceArtifact` and `validateEvidenceArtifact` require the exact
registry used for analysis. This explicit argument prevents evidence produced
with caller-owned contracts from being accidentally bound to or checked
against the default registry digest. The validator compares the
schema and Uneffect/TypeScript/builtin revisions, compiler options, root source,
the exact complete Program source-hash set, and every source-attributed summary.
Missing dependency hashes, reordered JSON object keys, changed summaries, old
schemas, and malformed values fail closed with machine-readable reasons. This
validator establishes freshness and integrity relative to the current Uneffect
analyzer trusted computing base. It does not turn an analyzer attestation into
an independently checkable proof certificate; that remains tracked in issue
#7.

Freshness is deliberately separate from proof eligibility. After validation,
consumers must also call `assessEvidenceArtifactEligibility(artifact)` before
using an effect artifact as proof-grade input. Eligibility requires a non-empty
set of uniquely identified `verified` summaries and closed bounds for every
iterator-effect parameter, with no `Unknown<reason>` capability argument. It
fails with explicit blockers for `trusted`, `inferred`, or `unknown` summaries,
unknown capability scopes, open iterator effects, duplicate summary IDs, and
vacuous artifacts. A result can therefore be fresh (`valid: true`) but
ineligible. Conversely, eligibility alone says nothing about staleness. Even
when both checks pass, the claim remains relative to Uneffect's analyzer and
builtin-contract trusted computing base; it is not an independently checkable
proof or a replacement for the project-wide assurance and assumption ledger.

Project verification is fail-closed on TypeScript syntax, semantic, and
compiler-option errors. These errors appear in `result.diagnostics`; function
and module summaries, contract obligations, and typed-array obligations from
the invalid source are downgraded to `unknown`. Optional temporal models may
still be emitted for inspection, but their properties return `error` without
invoking Quint. Emitted JavaScript remains available for gradual tooling and
must not be interpreted as verified output. Every temporal property carries
its source `fileName`, so a verified sibling cannot be mistaken for evidence
about an invalid file with the same property name.

The returned `result.assurance` is the conservative project-level acceptance
decision. It aggregates source-attributed blockers from TypeScript, effects,
contracts, typed arrays, ownership, runtime instrumentation, assumption policy,
temporal verification, and evidence coverage. Consumers should gate on
`result.assurance.passed`, not `diagnostics.length`, one verified obligation,
or a same-named temporal property. Its `claims`, `exclusions`, and per-domain
`blockers` remain machine-readable. Inferred effects are accepted; explicit
typed-array trust is counted separately and remains an assumption. An unknown
helper anywhere in the supplied project makes the project assessment fail even
when a selected entry function and its temporal property are individually
verified.

`result.assurance.status` preserves four distinct outcomes: `verified` has an
empty assumption ledger, `assumed` passes relative to one or more recorded
trusted boundaries, `unknown` lacks sufficient evidence, and `violated`
contains a concrete violation or counterexample. `passed` remains true for
both `verified` and policy-compliant `assumed` results. Assumption-free CI must
therefore gate on `status === "verified"`; gradual CI may gate on `passed` and
ratchet `assurance.assumptions`. Each blocker separately records
`classification: "unknown" | "violation"`.

## Reproducible artifacts

`just evidence file.ts` emits JSON containing the Uneffect version, TypeScript compiler revision, normalized compiler-options hash, source hash, builtin-contract digest, summaries, and diagnostics. Changing any of these proof dependencies invalidates the artifact.

Builtin overlays are `trusted`; Z3 `unsat` obligations are `verified`; Z3 counterexamples, `unknown`, and unsupported lowering produce `unknown` evidence. Temporal summaries are currently `trusted` because composition checks their use but does not prove their bodies.

## Assumption ledger and CI policy

`verifyUneffectProject` returns an `uneffect-assumptions/v1` ledger. It currently
records every trusted builtin call that the frontend resolves, every
function-level `trust typed-array` escape hatch, and every user-supplied
temporal function summary, dispatch-sealing assumption, and reviewed external
module-initialization contract use, including its resolved package version or
Node runtime major. Each entry has a stable content-derived ID, reason,
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
    allowUnboundedDomains: ["builtin", "module-initialization"],
    asOf: "2026-08-21",
  },
})
if (result.assumptions.violations.length > 0) process.exitCode = 1
```

Violations also appear in project diagnostics with kind `assumption-policy`.
The ledger is exhaustive for the trusted domains listed above, not for
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
The attached `ownership-evidence/v2` artifact must be proof-grade and must still
match both the ownership obligation and regenerated verifier program. Unknown,
counterexample, tool failure, stale hashes, or a user-authored span returns the
original source unchanged. Ownership evidence does not justify deleting or
reordering user-authored Promise calls, guards, handlers, or cleanup.
For Z3 evidence the artifact also records whether native or WASM produced the
verdict and retains failed infrastructure attempts made by `auto` selection.

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
The initial analysis only writes a dependency snapshot; a later build may
report a transformation as `applied: true` only after regenerating the local
proof and matching source hashes, TypeScript revision, builtin-contract digest,
and closed-world mode. The currently proved receiver subset is deliberately
narrow: one uniquely named, function-local `const` initialized by a plain
object literal, with a normal data property, no alias/escape/other receiver
use, and no call, construction, tagged template, suspension, or overlapping
update between reads. Parameters, getters, Proxy-capable/open receivers,
aliases, intervening calls, duplicate binding names, malformed sources, and
stale artifacts remain `unknown` and never authorize a transformation. The
current result is an authorization plan for a downstream compressor, not
rewritten JavaScript.

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
