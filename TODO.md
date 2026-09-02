# Uneffect implementation ledger

Last reconciled with GitHub Issues: 2026-09-01.

This file is the historical implementation ledger. Completed work is summarized
in `docs/implementation-status.md` and classified by confidence in
`docs/feature-matrix.md`. Unfinished work is tracked in GitHub Issues and
prioritized in `docs/roadmap.md`; unchecked entries below are retained for
traceability and map to those issues rather than forming a second active queue.
Remaining volume and estimate assumptions are maintained in
`docs/remaining-work-estimate.md`.

## Status convention

- GitHub Issues, milestones, priority labels, status labels, and effort labels
  describe the state of `main` and are the source of truth for unfinished work.
- This file records completed implementation history and links every unchecked
  item to exactly one owning Issue. An unchecked item without an Issue link is
  a bookkeeping error.
- Historical ledger section numbers preserve the original implementation
  sequence; they are not GitHub priority levels.
- Local work is not reported as implemented until its acceptance test, adjacent
  negative controls, benchmark where required, English documentation, and full
  validation have landed on `main`.
- `priority:P0` means a proof-boundary or reliability dependency, not that all
  P0 Issues should be developed concurrently.

## Current implementation snapshot

## Unified user-surface tasklist

The target public annotation surface is one marker, `uneffect:`, plus typed
`.uneffect.ts` model modules. Capability, contract, temporal, ownership, and
plugin IRs remain separate internally; users should not have to select those
internal domains before writing a directive. Migration is intentionally
breaking before 1.0: removed dialect spellings are rejected rather than kept as
silent aliases.

1. [x] [#62](https://github.com/mizchi/uneffect/issues/62) Accept canonical
   one-line `/* uneffect:<directive> ... */` and multiline `/* uneffect: ... */`
   blocks, preserving exact source spans and wrong-directive diagnostics.
   - [x] Accept the canonical one-line and multiline forms while preserving the
     existing located-directive extraction contract.
   - [x] Split ambiguous `invariant` into Hoare `loop_invariant` and temporal
     `always`, lowering both to their existing internal IR nodes.
   - [x] [#62](https://github.com/mizchi/uneffect/issues/62) Keep custom
     temporal plugin directives discoverable without letting a plugin shadow a
     core directive.
2. [x] [#62](https://github.com/mizchi/uneffect/issues/62) Migrate capability,
   contract, temporal, Promise-ownership, and resource examples, fixtures,
   skills, and documentation to the unified marker; reject their old dialect
   headers once the repository migration is complete.
3. [x] [#62](https://github.com/mizchi/uneffect/issues/62) Replace
   `temporal-summary` with explicit `temporal_contract requires|ensures|modifies|throws|
   rejects|suspends|cancellable|eventually|repeatedly|stabilizes|response|fair`
   directives whose attachment target is recorded in evidence.
4. [x] [#62](https://github.com/mizchi/uneffect/issues/62) Move refinement,
   abstraction, and runtime bindings to typed `.uneffect.ts` APIs; comments
   retain only a stable model/binding reference where source attachment is
   required.
   - [x] Add the typed `defineRefinement` contract plus explicit identity,
     Set-from-array, Map-from-entries, global, and Node-global descriptors.
   - [x] Parse the supported `.uneffect.ts` fragment without executing it,
     rejecting dynamic expressions, spreads, computed fields, and helpers not
     imported from `@mizchi/uneffect/spec`.
   - [x] Validate helper provenance plus create/observe/action/invariant callable
     identity, shared Runtime compatibility, and Boolean invariant results with
     the TypeChecker.
   - [x] Add `refinement_from "./model.uneffect.ts#default"` attachment and
     lower the typed definition to `uneffect-refinement-bindings/v1`.
     - [x] Add the fail-closed resolver/lowering API, including relative-path,
       default-export, runtime-identity, and attached callable-origin checks.
     - [x] Invoke the resolver from project verification and retain attachment
       span, implementation/specification digests, and TypeScript version as
       `uneffect-refinement-link/v1` evidence.
   - [x] [#62](https://github.com/mizchi/uneffect/issues/62) Migrate repository fixtures and reject comment-authored `refinement`,
     `abstraction`, and `runtime` declarations.
     - [x] Allow action validation and Z3 analysis to consume a lowered typed
       manifest without re-extracting legacy refinement comments; migrate the
       three-region scalar-product dogfood fixture as the first end-to-end case.
     - [x] Move invariant validation/Z3 discharge, state projection, and replay
       adapter construction to manifest-first inputs.
     - [x] Move workspace composition to manifest-first inputs and keep typed
       specification modules outside runtime Effect assurance while retaining
       their TypeScript and refinement identity checks.
     - [x] [#62](https://github.com/mizchi/uneffect/issues/62) Migrate all
       remaining repository fixtures and delete the migration-only extractor.
       The public parser already rejects comment-authored `refinement`,
       `abstraction`, and `runtime` dialects.
       - [x] Migrate an explicit Set-from-array abstraction fixture and its
         action, invariant, projection, coverage, and negative Z3 checks.
       - [x] Migrate a nested Map-from-entries fixture, including mutable entry
         updates and negative action checks.
       - [x] Migrate globalThis and versioned Node-global runtime identity
         coverage to typed runtime descriptors.
       - [x] [#62](https://github.com/mizchi/uneffect/issues/62) Migrate the
         remaining CFG, benchmark, and generated-source
         fixtures before deleting the migration-only extraction path.
         - [x] Add a reusable filesystem attachment loader and migrate affine
           loop and finite switch recurrence dogfood cases.
         - [x] [#62](https://github.com/mizchi/uneffect/issues/62) Migrate the
           remaining conditional, coupled, handler, retry, and labeled CFG
           fixtures with the same loader.
         - [x] Move the standalone conditional, coupled, handler, retry, and
           scalar-product CFG regression suites to explicit test manifests.
         - [x] Migrate every checked-in dogfood refinement fixture to a sibling
           typed `.uneffect.ts` manifest; keep benchmark and generated in-memory
           fixtures as the remaining rejection blockers.
         - [x] Replace benchmark-local legacy annotations with explicit typed
           manifests passed to the verification APIs, including in-memory
           workspace and runtime-identity cases.
         - [x] [#62](https://github.com/mizchi/uneffect/issues/62) Replace the
           remaining generated in-memory test fixtures with explicit manifests.
5. [x] [#62](https://github.com/mizchi/uneffect/issues/62) Move trust metadata
   to authenticated config/evidence records. Source comments may reference an
   assumption ID but cannot self-author owner, expiry, or digest evidence.
   - [x] Add the strict `uneffect-assumption-registry/v1` contract, public
     parser, JSON Schema, exact domain binding, review digest, and typed-array,
     dispatch-sealing, and temporal-contract project-ledger handoffs.
   - [x] [#62](https://github.com/mizchi/uneffect/issues/62) Migrate checked-in trust fixtures to registry IDs, then reject `trust_owner` and
     `trust_expires` source directives.
6. [ ] [#62](https://github.com/mizchi/uneffect/issues/62) Express React roles
   through namespaced plugin directives (`react.component`, `react.hook`, and
   resource lifecycle directives), with the same collision and provenance
   rules available to third-party plugins.
7. [x] [#62](https://github.com/mizchi/uneffect/issues/62) Remove every legacy
   dialect from `UneffectDialect`, README tables, CLI help, schemas, and skills;
   retain only `uneffect:` and `.uneffect.ts` as public authoring entrypoints.
8. [x] [#62](https://github.com/mizchi/uneffect/issues/62) Gate completion on
   parser negative controls, full CI and dogfood, a migration note, and an API
   inventory test that prevents new public dialects or compatibility aliases.

The `uneffect-builtin-semantics/v1` catalog now owns reviewed JavaScript, Node.js,
DOM, and selected package definitions. It rejects duplicate symbol identities
and compiles generic semantic primitives into trusted TypeChecker-backed
contracts. Mutation, capability scopes, callbacks, conditional throw,
alias/result, ownership/resource, and directional property projections share
one interpreter rather than API-family operation branches.
The Node filesystem contract generator has also moved into the catalog,
preserving read/write path positions, callback scheduling, watcher repetition,
and read-buffer mutation across callback, synchronous, and Promise variants.
Node OS, crypto randomness, child-process execution, network, DNS, HTTP(S),
server lifecycle, watcher close, next-tick, and check-phase timer definitions
are also migrated with their queue and scope data.
The Web host boundary slice now covers fetch, console, timers, animation frames,
AbortSignal, Scheduler, Web Crypto, and Worker/MessagePort transfer definitions.
DOM method definitions are also migrated with operation granularity, selector
scope, mutation regions, and possible user-code invocation preserved. Directional
DOM property semantics, including Cookie and Storage permission properties, are
now migrated with access-direction and mutation-region metadata preserved.
The catalog migration is specified in `docs/generic-builtin-semantics.md`.
Its schema, validation, stable serialization, shared interpreter, and public
registry/semantics-module path are implemented. Effect inference, frontend
parity, callback/async extraction, mutation, result, ownership/resource, and
property consumers use the shared events.
Node filesystem is also fully catalog-migrated, including `node:fs/promises`,
path scopes, compound permissions, buffer mutation, callback completion, and
watcher resources; its legacy fs operation has been removed. Direct path and
program parameters now produce parameterized summaries, with literal and
forwarded call-site substitution. Other resolved runtime expressions widen to
the broad capability, which a narrow declaration cannot cover; invalid
projectors retain explicit unknown evidence.
Crypto and child-process effects plus Node DNS/socket/HTTP/server callbacks are
catalog-migrated. Fetch, Promise combinators, timers, cancellation, Abort,
Scheduler, streams, and disposal publish generic protocol transitions consumed
by bounded specialized machines. Superseded builtin operation fields and
branches have been removed. Repository-wide CI, parity, benchmarks, and
no-unknown dogfood are the final acceptance boundary. The generic catalog
migration passed `just dogfood-leaf`, `just dogfood`, `just ci-fast`, the full
`pnpm test` suite, Corsa parity, `just bench`, and `git diff --check` before
commit `7f137b2`.

[#20](https://github.com/mizchi/uneffect/issues/20) completed the supported
cross-project scalar-refinement fragment on `main`, including direct
calls, guarded wrappers, at most two write-screened sole-call helpers, exact
compiler/config/declaration provenance, and one version-matched builtin
`globalThis` runtime identity and one exact embedded-TypeScript declaration
transform profile. It also admits Node ambient `global` only with an exact
`@types/node` major and explicit matching realm label; mismatched labels,
typings majors, and local shadows fail closed. Workhub-derived `StateStore.set` dogfood
retains its unsupported async class-method edge as a violation instead of
silently reporting `not-applicable`. [#18](https://github.com/mizchi/uneffect/issues/18)
now has exact synchronous simple-ring and direct cross-project straight-line
TLA seeds. A scan of the available Workhub and Luna solution sources found no
real top-level-await candidate, so broader module semantics stay queued rather
than being widened without application evidence. The bounded reusable CFG
handoff is complete in [#23](https://github.com/mizchi/uneffect/issues/23);
the bounded local-alias handoff is complete in
[#26](https://github.com/mizchi/uneffect/issues/26), and the first checker-backed
Corsa inferred-effect handoff is complete in
[#27](https://github.com/mizchi/uneffect/issues/27). The bounded scalar-value
children [#28](https://github.com/mizchi/uneffect/issues/28) and
[#29](https://github.com/mizchi/uneffect/issues/29) and
[#30](https://github.com/mizchi/uneffect/issues/30) and
[#31](https://github.com/mizchi/uneffect/issues/31) and
[#32](https://github.com/mizchi/uneffect/issues/32) and
[#33](https://github.com/mizchi/uneffect/issues/33) and
[#34](https://github.com/mizchi/uneffect/issues/34) and
[#35](https://github.com/mizchi/uneffect/issues/35) and
[#36](https://github.com/mizchi/uneffect/issues/36) and
[#37](https://github.com/mizchi/uneffect/issues/37) are complete. #37
normalizes Boolean-diamond and finite-switch recurrence evidence into one
ordered join IR and composes one bounded mixed sequence. The next
application-backed child [#38](https://github.com/mizchi/uneffect/issues/38) is
also complete, proving one source-ordered upper-triangular affine recurrence.
The next application-backed child
[#39](https://github.com/mizchi/uneffect/issues/39) is also complete and lowers
one loop-local conditional value into source-bound recurrence predecessor
evidence. The next application-backed child
[#40](https://github.com/mizchi/uneffect/issues/40) is also complete and proves
one source-bound Boolean involution recurrence by parity. The next bounded
child [#41](https://github.com/mizchi/uneffect/issues/41) is also complete and
proves the complementary entry-read ordering for one triangular affine recurrence.
Bounded child [#47](https://github.com/mizchi/uneffect/issues/47) is complete and
proves one finite self-affine retry-backoff summary only under an exact recorded
precondition of at most eight iterations.
Bounded child [#48](https://github.com/mizchi/uneffect/issues/48) is complete and
composes that finite rule with one source-bound catch/finally handler topology
and immutable Boolean failure selector.

Completed proof-boundary issue [#63](https://github.com/mizchi/uneffect/issues/63)
reconnects explicit temporal specifications with extracted JavaScript async
semantics. The first slice adds one stable `generateTemporalModel` entry,
composes user properties in both Web and Node profiles, and moves standalone
backend-specific generators to `@mizchi/uneffect/experimental`. The second
slice co-verifies the root
function's `using`/`await using` lifecycle through the same facade and project
pipeline. Binding-level Promise rejection ownership for the selected root now
lowers through the common resource protocol and is checked as
`promiseOwnershipSafe`; a floating binding is a load-bearing counterexample.
For a directly bound builtin `new Promise`, the ownership resource is linked to
the host settlement transition by TypeChecker declaration identity. Supported
immutable aliases normalize to the same resource. External producers and
unsupported dynamic/escaping aliases remain explicitly excluded as
`promise-host-synchronization`.
The resource/host product synchronizes straight-line `await using` disposal
with a microtask checkpoint. Bounded non-loop conditional acquisition now uses
explicit acquire-or-skip and release-or-skip paths; repeated loop acquisition
still reports `resource-host-scheduling`. The supported product reports
`resource-host-callback-interleavings` because arbitrary callbacks are not yet
interleaved into that product. Disposal throw/reject paths and a finite
multiple-failure suppression invariant are included; exact nested
`SuppressedError` payload identity remains outside the common product.
Supported immutable AbortController/fetch bindings now include the existing
cancellation/settlement/Promise/body product in the facade. External or
unresolved signals retain `abortable-fetch-synchronization`.
The result records `scheduling.fairness = "none"` and marks arbitrary
resource/callback interleavings as excluded instead of choosing a guessed order.

The first shared-completion slice for the general CFG track is now complete.
It defines typed normal/return/throw/break/continue outcomes, separates an
unlabeled breakable target from the nearest-loop continue target, and shares
sequence, catch, finally, and loop-consumption rules with the structural
contract CFG. Rich Promise/resource/refinement payload joins and arbitrary CFG
fixed points remain owned by [#25](https://github.com/mizchi/uneffect/issues/25)
and [#24](https://github.com/mizchi/uneffect/issues/24).

## Ordered task list: common safe JavaScript subset

This order prioritizes syntax and runtime behavior that occurs frequently in
ordinary TypeScript applications, requires little or no runtime support, and
unblocks more than one Uneffect domain. Each item must fail closed outside its
documented fragment. Later items must reuse the earlier neutral IR rather than
introducing another domain-local control-flow or alias model.

1. [x] Establish typed completion algebra for normal, return, throw, break, and
   continue; share sequencing, catch, finally, and lexical transfer ownership
   with the structural contract CFG.
2. [ ] [#24](https://github.com/mizchi/uneffect/issues/24) Establish a common region/alias IR for non-escaping immutable aliases,
   static property paths, direct monomorphic helper calls, and explicit
   mutation invalidation. Reject reassignment, computed keys, getters, proxies,
   escaping values, and unresolved calls. Connect Effect analysis first, then
   typed-array, contract/refinement, and React consumers. ([#24](https://github.com/mizchi/uneffect/issues/24))
   - [x] Add the shared immutable-alias resolver and migrate direct Effect-call
     mutation argument substitution, including explicit unchecked runtime
     descriptor evidence for property paths.
   - [x] Include canonical static property segments in machine region ids, so
     sibling properties cannot alias accidentally and equivalent dot/literal
     access retains one identity.
   - [ ] [#6](https://github.com/mizchi/uneffect/issues/6) Migrate typed-array buffer/view aliases.
     - [x] Migrate Program-backed bounded DataView receiver alias chains; allow
       repeated reviewed builtin accessor calls and report an escaped alias as
       an `unknown` bounds obligation.
     - [x] Share source-stable ArrayBuffer region identity across immutable
       aliases, ownership transfer/read events, and DataView backing evidence;
       detach/transfer invalidates a differently spelled backing alias.
     - [x] Model local DataView literal byte offsets/lengths and propagate their
       bounded accessor range through immutable aliases.
     - [x] Infer bounded lengths for literal, in-range Uint8/Uint32
       `subarray`/`slice` windows and aliases; dynamic windows produce an
       explicit `unknown` index obligation when used.
     - [x] Distinguish shared `subarray` backing from copied `slice` in emitted
       window provenance, retaining exact literal ranges and unknown dynamic ranges;
       authenticate builtin identity and emit declaration-derived backing region IDs.
     - [x] Reuse the authenticated window semantic in ownership analysis so
       transfer invalidation crosses nested shared windows and immutable aliases,
       while copied windows remain independent.
     - [x] Join ownership transitions across lexical `if`/`else`, zero-or-many
       loops, one-or-many `do...while`, and finite `switch` selection with
       fallthrough and targeted-break awareness; retain may paths as `unknown`.
     - [x] Migrate Transferable ownership sites to the common TypeScript
       resource CFG so explicit throw, catch, mandatory finally, labels, and
       fixed-point joins no longer use a domain-specific control-flow model.
     - [x] Feed authenticated same-Program callable `Throw` and directly awaited
       `Reject` summaries into ownership catch/finally edges as may-completions.
     - [x] Run Program-backed typed-array and Transferable ownership analysis
       from the default `check` pipeline; publish obligations, window
       provenance, ownership diagnostics, assumption entries, and assurance
       blockers in `uneffect-check/v1` JSON and text evidence.
      - [x] Authenticate builtin `ArrayBuffer.resize`, carry literal/dynamic
        post-resize byte lengths through immutable aliases, and update later
        DataView backing obligations; catalog mutation plus TypeError/RangeError.
      - [x] Revalidate accesses through locally constructed fixed-length and
        length-tracking DataViews after literal/dynamic backing-buffer resizes.
      - [x] Revalidate accesses through authenticated local Uint8Array/Uint32Array
        fixed-length and length-tracking views after resize, including immutable
        aliases and byte-width-aware bounds; publish failures through `check`.
      - [x] Authenticate local standard ArrayBuffer construction and connect
        literal initial/max byte lengths to resize success and later view bounds;
        reject shadowed same-spelled constructors as evidence.
      - [x] Prevent source-order overclaims across conditional/loop/switch/try
        resize sites; join pre-existing view states as unknown and allow a later
        unconditional literal resize to re-establish exact state.
      - [ ] [#6](https://github.com/mizchi/uneffect/issues/6) Consume window provenance to prove overlap-sensitive writes, and model
        dynamic/non-literal `maxByteLength`, remaining typed-array domains, exact bounded-loop
        detach counts, and returned/escaping views.
   - [ ] [#24](https://github.com/mizchi/uneffect/issues/24) Migrate contract/refinement mutation snapshots.
     - [x] Migrate the TypeChecker-backed local action-helper alias obligation;
       admit immutable alias chains while retaining helper, escape, computed
       access, generic dispatch, and Mutate-correlation negative controls.
     - [ ] [#24](https://github.com/mizchi/uneffect/issues/24) Migrate general branch/loop snapshots, property regions,
       interprocedural summaries, and invalidation joins.
   - [ ] [#16](https://github.com/mizchi/uneffect/issues/16) Migrate React props/state/ref regions.
   - [x] Introduce `uneffect-resource-protocol/v1` with stable resource
     identities, required terminal states, and ordered acquire/use/consume/
     release/transfer/split/join/escape/invalidate transitions. Conditional
     transitions join to unknown and invalid transitions emit diagnostics.
   - [x] Lower reviewed Response body consumption, reader ownership, pipelines,
     clone, and tee into the shared protocol evaluator while preserving the
     existing detailed compatibility status.
   - [ ] [#24](https://github.com/mizchi/uneffect/issues/24) Lower Transferable ownership, `using`, Promise ownership, typed-array
     invalidation, and user-defined protocols through the same IR instead of
     adding domain-local terminal-state logic.
     - [x] Route non-shared Transferable clone/read/mutate/transfer analysis
       through the shared resource protocol, with parity tests against the
       legacy checker. Detached values lower to invalidation; MessagePort-like
       ownership lowers to transfer.
     - [ ] [#24](https://github.com/mizchi/uneffect/issues/24) Model SharedArrayBuffer/Atomics separately; a shared-memory transfer is
       explicitly outside the exact migration fragment and retains the legacy
       fallback.
     - [x] Project unconditional `using`/`await using` disposal lifecycles into
       the shared resource IR under an explicit all-resources-acquired
       precondition. Preserve reverse disposal order and sync throw/async
       reject/catch/escape metadata. Bounded non-loop conditional acquisition
       uses explicit acquire-or-skip and release-or-skip paths.
     - [x] Extend the resource-state lattice to retain `absent | available`
       and `absent | released` disjunctions and use them for bounded per-scope
       conditional acquisition without the all-acquired precondition.
     - [x] Connect initializer failure as prefix acquisition: a failed binding
       skips later acquisitions and releases only the already acquired prefix,
       without the former all-resources-acquired precondition.
     - [x] Split a direct awaited initializer into inline evaluation failure and
       microtask fulfillment/rejection, with a load-bearing wrong-lane Quint
       counterexample.
     - [x] Replace Boolean-only disposal suppression with a finite origin/parent
       chain for body, initializer, and disposer failures; reject dropped or
       corrupted parent identity in Quint.
     - [x] Connect one contiguous source-loop acquisition group with explicit
       zero-iteration, initializer-failure, repeat-generation, and exit paths.
     - [ ] [#24](https://github.com/mizchi/uneffect/issues/24) Generalize repeated
       acquisition to multiple, nested, non-contiguous, and non-stack resource
       regions without widening iterations to a guessed resource state.
     - [x] Project binding-level Promise rejection ownership into the shared
       resource IR: floating remains available, observed consumes, and explicit
       ownership transfer transitions to transferred.
     - [x] Replace supported binding-level Promise resources with
       TypeChecker-backed underlying Promise identity so immutable local aliases
       compose as one resource rather than parallel compatibility records.
     - [ ] [#24](https://github.com/mizchi/uneffect/issues/24) Extend Promise
       identity through mutable, escaping, and dynamically dispatched aliases.
     - [x] Project explicit `for await...of` exhaustion and abrupt
       break/return/uncaught-throw scenarios into consumed/released resource
       models. Preserve optional `return` lookup, user-code property access,
       awaited-result rejection, nested/labeled loop ownership, and reject
       finally-crossing completion as unknown.
     - [x] Project synchronous `for...of` exhaustion and abrupt
       break/return/uncaught-throw through the same iterator resource schema,
       preserving inline optional-return lookup/call, synchronous throw,
       nested/labeled ownership, and finally uncertainty.
     - [x] Generalize manual iterator analysis across `sync | async`: standard
       TypeChecker identity, immutable aliases, `.next()`/`.return()`, direct
       and closure/aggregate escape, callable contracts, immediate
       `try/finally`, and direct `yield*`, while preserving inline/throw versus
       microtask/reject completion semantics.
     - [x] Preserve iterator identity through shallow builtin-`Object.freeze`
       object properties, immutable object aliases, static string access, and
       destructuring; distinguish returned frozen aggregates from mutable,
       shadowed-freeze, and dynamic-key unknown escape.
     - [x] Recognize canonical sync/async manual `.next().done` while loops as
       natural exhaustion (`consume`) when their body has no additional
       break/return/escaping-throw path; retain partial-correctness scope and
       reject abrupt exits as unclosed.
     - [x] Track sync/async Generator `.throw(value)` as a non-terminal protocol
       use, retaining inline throw versus awaited rejection ownership rather
       than assuming the injected exception closes the generator.
     - [x] Recognize canonical infinite-loop `const step = next(); if
       (step.done) break` and destructured `done` forms by symbol identity,
       rejecting reassignment, intervening guards, and alternate abrupt exits.
     - [x] Admit the canonical mutable-result `for (let step = next();
       !step.done; step = next())` generation only when initializer/update share
       one iterator symbol and the body has no alternate abrupt exit; reject
       cross-iterator and general reassignment.
     - [x] Project TypeChecker-resolved direct manual async-iterator `.next()`
       and `.return()` calls through immutable aliases into the shared resource
       model, retaining missing close, unawaited completion, and post-close use.
     - [x] Project direct async-generator `yield*` over a TypeChecker-resolved
       standard `AsyncIterable` as separate exhaustion and consumer-return
       propagation scenarios.
     - [x] Project direct iterator return and returned immutable closure/simple
       aggregate capture as ownership escape; keep uncontracted call arguments
       as unknown escape instead of assuming transfer.
     - [x] Instantiate symbol-resolved local resource callable contracts at
       manual iterator call boundaries, preserving trusted versus verified
       transition evidence.
     - [x] Generalize callable resource contracts with unified
       `acquire return`, `use parameter`, and `release parameter` operations;
       create call-result resources and check leaks and post-release use in the
       shared CFG evaluator through immutable aliases.
     - [x] Persist direct exported lifecycle operations in the authenticated
       package contract summary, retain them as trusted evidence, and bind them
       to exact installed declaration identities in CLI/project consumers.
     - [x] Compose annotated acquisition with `using` and `await using` lexical
       disposal across normal, return, throw, catch, and nested-block exits;
       keep repeated loop acquisition unknown and disposal failure in the async
       temporal model.
     - [x] Add method-receiver resource references with `use this` and
       `release this`, binding immutable client aliases to the acquired return
       region by TypeChecker method and receiver identity.
     - [x] Persist static factory returned-member resource operations in package
       summaries and consume them through immutable receiver aliases.
     - [x] Audit every acquired-resource reference: accept known transitions,
       aliases, `using`, and direct return escape; fail closed on opaque calls,
       storage, capture, and unannotated use.
     - [x] Route builtin semantic-catalog acquire/use/release events (including
       WebSocket and stream readers) through the normal CLI/project resource
       protocol output, using declaration-region ids instead of variable names.
     - [x] Catalog stream-reader `read()` as a resource use so ordinary
       acquire/read/release code remains analyzable instead of opaque.
     - [x] Add rejection edges for directly awaited Promise-returning resource
       operations and require `finally` for cleanup across rejection, while
       keeping awaited acquisitions fulfillment-only.
     - [x] Connect Node `createServer`/`listen`/`close` through generic receiver
       resource operations and normalize ephemeral port zero to host authority.
     - [x] Treat Node `FSWatcher.ref()`/`unref()` as resource uses and `close()`
       as release, keeping event-loop liveness separate from ownership.
     - [x] Add call-versus-fulfillment timing to generic resource primitives
       and lower fulfilled transitions on only the normal awaited CFG edge.
     - [x] Model `node:fs/promises.open()` as fulfilled `file-handle`
       acquisition, FileHandle I/O as use, and `close()` as responsibility
       release, with rejection-safe cleanup requiring `finally`.
     - [x] Resolve a non-escaping immutable Promise acquisition through exactly
       one later `await` binding by TypeChecker identity; reject extra uses,
       mutation, multiple awaits, and escape as unknown.
     - [x] Share that Promise-to-resource binding across builtin, local
       annotated, and authenticated package resource contracts.
     - [x] Add generic literal-argument conditions to effect primitives and use
       them for Node `open`/`openSync` flag-sensitive `FsRead`/`FsWrite`, while
       retaining both permissions for dynamic and numeric flags.
     - [x] Resolve conditional-effect literals through immutable TypeChecker
       aliases and transparent `as const`/parenthesized expressions; keep
       mutable and unresolved values conservative.
     - [x] Centralize static-string resolution in the TypeScript frontend
       adapter and feed the same resolver to every semantic-event consumer.
     - [x] Distinguish borrowed builtin resource parameters from locally
       acquired ownership: permit use without local close, but retain
       release/use-after-release transition checking.
     - [x] Resolve resource callable contracts through immutable direct aliases
       and builtin-`Object.freeze` callable properties across local/package
       boundaries; reject mutable callable containers as unknown.
     - [x] Forward acquired ownership through immutable local `const` alias
       chains returned by synchronous and directly awaited functions; keep
       mutable aliases fail-closed.
     - [x] Accept conditional resource returns only when both branches resolve
       to the same acquired region identity.
     - [x] Forward ownership through one shallow static property or tuple slot
       of an otherwise unused local `const` aggregate, including object
       shorthand value-symbol resolution; reject mutation, reassignment,
       container escape, and dynamic keys.
     - [x] Resolve flat `const` object/tuple destructuring from direct literals,
       including renamed and shorthand object bindings, into the originating
       resource identity; keep mutable/default/rest/computed forms fail-closed.
     - [x] Generalize direct-literal aggregate lookup to canonical nested
       property/literal-index paths, including mixed nested destructuring and
       parent-slot mutation screening.
     - [x] Resolve nested destructuring through a stable local `const` aggregate
       source when its only observation is that destructuring; reject reused,
       aliased, mutated, or escaped source containers.
     - [x] Lower conditional variable initializers through the expression CFG
       and preserve distinct branch-local acquisition identities through return
       as `absent-or-escaped`; keep pre-acquired alternative selection leaking.
     - [x] Preserve optional acquisition returned from Boolean-only `&&`/`||`
       initializers as `absent-or-escaped`; reject truthiness coercion, `??`,
       assignment forms, and pre-existing resource operands.
     - [x] Preserve `absent-or-available` and `absent-or-released` at CFG joins,
       allowing a branch-local `using` acquisition to discharge conditionally.
     - [x] Accept trusted resource contracts on ambient functions/methods only
       from explicit root `.d.ts` overlays; reject automatic trust from
       transitively imported declaration files.
     - [x] Expose async-iterator resource scenarios through `checkFiles`, CLI
       diagnostics, JSON schema, text evidence, assurance coverage/blockers,
       and the assumption ledger for used trusted callable boundaries.
     - [x] Reuse the iterator decision layer in `verifyUneffectProject`, including
       project coverage/blockers, trusted-boundary policy enforcement,
       TypeScript-error downgrading, and `.uneffect.ts` exclusion.
     - [x] Prove the immediately acquisition-dominating manual
       `try/finally { await iterator.return() }` pattern across normal,
       return/throw, and awaited-next rejection; reject pre-try gaps and
       conditional/catch-only close as unknown.
     - [ ] [#24](https://github.com/mizchi/uneffect/issues/24) Compose implicit
       throw edges, full finally completion overriding, conditional/manual
       protocol order, mutable or escaping iterator aliases, nested delegation
       failure, and generator consumer escape into the shared model.
       - [x] Add reviewed implicit body call/getter throw edges and preserve or
         replace abrupt completion through normal/direct-abrupt `finally`.
       - [x] Collapse a direct exhaustive manual `if/else` close into one exact
         join release for both synchronous and asynchronous iterators.
       - [x] Normalize guarded `if`, `switch`, and `catch` return/throw exits
         against a fallthrough close; reject unclosed nested/loop bypasses and
         possible double close instead of treating lexical order as dominance.
       - [x] Track local mutable iterator aliases by TypeChecker symbol and
         straight-line assignment generation, preserve immutable snapshots,
         and join conditional reassignment candidates as explicit unknowns.
       - [x] Add a fail-closed `yield*` delegation-step failure scenario for
         delegate `next`/`throw` lookup, call, await, and result failures that
         do not generally guarantee IteratorClose.
       - [x] Prove write-screened local object/array iterator slots and closure
         capture, while turning slot mutation, dynamic lookup, external calls,
         and property-storage escape into explicit unknown ownership evidence.
       - [x] Preserve exact static `const` object/array destructuring and retain
         mutable, unstable-source, rest, and computed-pattern candidates as
         `unstable-iterator-alias` unknown evidence.
       - [ ] [#24](https://github.com/mizchi/uneffect/issues/24) Generalize these rules to arbitrary CFG joins, heap/escaping
         aliases, and nested delegation/consumer failures.
     - [x] Define `uneffect-resource-temporal-product/v1` and connect acquired
       `using`/`await using` release transitions to host-neutral disposal IDs,
       requiring matching resource identity and inline/microtask completion
       lanes. Dangling, duplicate, mismatched, or unlinked releases are unknown.
     - [x] Generate the executable acquire/release Quint product from the
       backend-neutral resource temporal product. The previous using/host API
       has been removed. Positive and deliberately broken microtask-order
       models exercise the common backend.
     - [x] Extend that product with bounded non-loop conditional acquisition,
       disposal throw/reject transitions, and a finite multiple-failure
       suppression invariant.
     - [ ] [#24](https://github.com/mizchi/uneffect/issues/24) Extend that product
       through broader repeated acquisition, concrete runtime `SuppressedError`
       payload value/object identity, other resource transitions, arbitrary callback
       interleavings, cancellation, and explicitly selected fairness assumptions.
   - [x] Add the backend-neutral resource-state lattice over the shared CFG
     fixed-point engine. Equal branch states remain exact, unequal states join
     to unknown, normal/exceptional predecessors can share mandatory finally,
     and every evaluation has an explicit proof budget.
   - [x] Add the first public-AST resource CFG lowering for blocks, sequential
     statements, `if`/`else`, and direct `return`/`throw`, using source-bound
     transition sites. Connect direct Response body calls so complete branches
     join to consumed while a missing branch becomes unknown.
   - [x] Extend TypeScript resource CFG lowering through loop back-edges,
     switch fallthrough/break, labeled break/continue, opaque nested
     declarations, and try/catch/finally. Mandatory finally preserves normal,
     explicit throw, return, break, and continue continuations.
   - [x] Lower expression-statement short circuit, conditional expressions, and
     optional calls as resource CFG choices; preserve wrappers and fail closed
     when a conditional transition is nested in an unsupported expression.
   - [x] Add implicit synchronous-throw and directly awaited Promise-rejection edges from trusted or
     verified callable summaries; arbitrary calls must not enter catch merely
     because they may throw at runtime.
     - [x] Add the domain-independent source-bound exceptional-completion site
       and route authenticated throw successors through active catch/finally
       continuations independently of resource transitions.
     - [x] Resolve supplied same-Program trusted/verified callable `Throw` and directly awaited `Reject` summaries
       into those sites with declaration and call-site provenance.
       - [x] Preserve those exceptional summaries through immutable `const`
         callable aliases and authenticated `Object.freeze({...})` properties;
         reject reassigned and mutable-property aliases.
       - [x] Share one TypeChecker-backed stable-callable resolver across
         contract CFG, exception, and resource lifecycle consumers, including
         a same-spelled `Object.freeze` negative control.
     - [x] Authenticate and compose persisted/external callable summaries before
       admitting synchronous `Throw` and directly awaited rejection edges;
       preserve producer authority as trusted, route both alternatives when a
       call may synchronously throw and later reject, and keep floating
       rejections in Promise ownership rather than synchronous CFG edges.
   - [ ] [#24](https://github.com/mizchi/uneffect/issues/24) Define authenticated declarative protocol summaries for builtin,
     package, and plugin operations; executable plugin booleans must not create
     verified evidence.
     - [x] Define and publicly export the backend-neutral parameter/return
       `borrow | consume | transfer | escape` summary contract, and instantiate
       authenticated summaries into shared resource transitions with explicit
       missing-binding results.
     - [x] Add TypeChecker-bound same-Program frontend extraction and call-site
       resource identity substitution for direct calls and direct `const`
       return bindings. `uneffect:temporal` comments remain trusted declarations,
       malformed/unbound references are diagnostics, and same-named shadows do
       not inherit a contract.
     - [x] Authenticate explicitly supplied package summaries against exact
       module/export, runtime version, declaration bytes, artifact digest, and
       trust owner/reason/expiry, then rebind accepted summaries to the actual
       TypeChecker declaration identity without upgrading them to verified.
     - [x] Add `checkFiles`/`verifyUneffectProject` discovery and authentication
       for explicitly supplied package resource artifacts, including installed
       runtime version, declaration bytes, trust expiry, declaration rebinding,
       call-scoped assumptions, and invalid-contract diagnostics.
     - [x] Add repeatable CLI `--resource-contract` JSON loading for package
       resource artifacts; Program binding performs the semantic authentication.
     - [x] Extend synchronous return/argument identity to acquired temporaries,
       including fluent receiver release, nested call arguments, bare leaks,
       source evaluation order, and optional receiver-before-call branching.
     - [x] Treat direct synchronous and directly awaited acquired returns as
       caller escape, retaining acquisition/escape on fulfillment and adding
       `absent-or-consumed|released|transferred|escaped` terminal joins.
     - [x] Extend stable return identity through immutable aliases, nested
       aggregate slots/destructuring, and branch-local conditional or Boolean
       short-circuit acquisition without conflating resource identities.
     - [x] Extend authenticated resource argument identity through stable nested
       aggregate slots and destructured aliases, sharing the return-side
       mutation/escape screen and accounting for the originating stored value.
     - [x] Apply the same aggregate identity and audit accounting to
       authenticated method receivers such as `holder.handle.close()`.
     - [x] Route semantics-module `acquire | use | release` primitives through
       the same `checkFiles` and project resource CFG as the built-in catalog,
       including Promise-fulfillment acquisition/release, and keep their
       authority classified as trusted catalog evidence.
     - [x] Route semantics-module callback primitives on imported direct
       functions through callable summaries into the host-neutral temporal IR,
       preserving an explicitly external completion lane.
     - [x] Bind reviewed registry contracts at explicit re-export boundaries so
       renamed local/package barrels preserve the original declaration identity;
       keep mutable aliases and same-spelled local functions untrusted.
     - [x] Resolve reviewed calls through acyclic immutable `const` callable
       aliases and stable namespace properties; do not propagate contracts
       through `let`, dynamic initializers, or symbol cycles.
     - [x] Lower trusted catalog `throw` primitives into the shared exceptional
       resource CFG, including catch/finally cleanup and invalid-transition
       detection; treat unresolved declared conditions as may-throw.
     - [x] Add a data-only catalog `reject` primitive and propagate its reviewed
       error type through direct Promise return and uncaught direct await into
       callable summaries; exclude floating calls and swallowing catches while
       retaining explicit rethrow.
     - [x] Apply semantics-module resource and callback primitives to reviewed
       interface/class member symbols, retaining concrete receiver identity and
       callback queues through aliases; reject extracted unbound resource
       methods without inventing receiver authority.
     - [x] Pass the caller-owned registry through `checkFiles` and project
       callable/ownership analysis, and consume module `clone | transfer`
       primitives with concrete buffer invalidation in both entry points.
     - [x] [#24](https://github.com/mizchi/uneffect/issues/24) Bind semantics-module ledger identities and digests into producer
       contract-summary bundles before allowing their persisted summaries to
       depend on a caller-owned registry.
       - [x] Reuse the registry-aware Effect analysis when deriving callable
         metadata, and persist module-derived callback and Promise rejection
         summaries with source revalidation under the same ledger.
       - [x] Bind those summaries to the consumer's installed declarations only
         under the identical module ledger, and reconnect persisted callback,
         rejection, and resource operations to temporal and lifecycle analysis.
     - [ ] [#24](https://github.com/mizchi/uneffect/issues/24) Extend argument and escaping identity through mutable/heap aliases,
       dynamic dispatch, and open-ended computed resource selection.
3. [ ] [#24](https://github.com/mizchi/uneffect/issues/24) Establish callable summaries for direct functions and immutable callable
   aliases. Represent may-effects, synchronous throws, Promise rejections,
   region reads/writes, and callback invocation cardinality/timing. Start with
   the common `0..1`, exactly-once, and sequential `0..n` callback families.
   ([#24](https://github.com/mizchi/uneffect/issues/24))
   - [x] Persist direct callback timing/cardinality/completion and Effect bounds
     in package summaries; bind direct inline/immutable callback arguments and
     fail closed when their inferred effects exceed the producer bound.
   - [x] Compose finite object/tuple callback paths through inline literal
     arguments; reject spread, dynamic, unresolved, and aliased containers as
     unknown instead of flattening them into a direct callback.
   - [x] Admit an exclusive single-use `const` object/tuple callback container
     by TypeChecker symbol identity while rejecting mutation, repeated use,
     capture, and escape through the same reference screen.
   - [x] Recognize existing repeated shallow literal callback-container use
     through the TypeChecker-identical standard `Object.freeze`; reject
     same-named user functions, avoid claiming deep immutability, and do not
     recommend introducing a runtime freeze for verification.
   - [x] Generalize repeated zero-runtime callback containers through a
     persisted producer `borrow-readonly` certificate and a TypeChecker-resolved
     same-callee/same-argument reference screen without requiring
     `Object.freeze`; reject mutation, capture, escape, unrelated use, getters,
     and proxies.
   - [x] Publish and consume single immutable exported arrow/function-expression
     callables by root-package export symbol plus resolved signature; exclude
     mutable and compound variable exports.
   - [x] Publish and consume named default functions and directly authored
     default arrow/function expressions through the root-package `default`
     symbol. Share annotation ownership across Effect, callable, and resource
     summaries; reject indirect or dynamic default values.
   - [x] Resolve same-file static export-list aliases to local functions and
     immutable callable `const` declarations by TypeChecker ExportSpecifier
     identity, including rename and `as default`.
   - [x] Resolve static relative re-exports into another source in the producer
     Program, recording export-level implementation file/source digests and
     collecting Hoare artifacts across all CLI-selected project sources.
     External-package re-export producers remain unsupported.
   - [x] Enumerate callable members of static relative `export *` barrels from
     the entry module's final TypeChecker export set, including transitive
     barrels and explicit overrides; exclude default/non-callable members and
     reject ambiguous stars through TypeScript diagnostics.
   - [x] Persist ordered public overload signatures independently of the
     implementation signature. Require both every consumer-resolved call and
     the installed declaration's complete overload set to match, so unused
     overload drift cannot silently retain authority.
   - [x] Preserve reviewed callback forwarding through Promise reactions and
     lower authenticated package callbacks to the shared host-neutral
     microtask/reject transition without leaking callback `Throw` into the
     synchronous caller Effect.
   - [x] Join a directly bound external returned Promise to callback rejection,
     conservative settlement, and async ownership status with one
     source-stable `BindingIdentity`.
   - [x] Require the concrete consumer call to have a TypeChecker-visible
     Promise-like return before emitting external settlement identity; reject
     contradictory throw-to-rejection contracts instead of inventing a Promise.
   - [x] [#63](https://github.com/mizchi/uneffect/issues/63) Project external
     settlement transitions into executable generated Quint rather than only
     the shared host-neutral artifact; retain opaque pending/divergence choices.
   - [x] Lower authenticated callbacks on factory-returned client members
     through the same host-neutral transition collector, including immutable
     receiver aliases and fluent identity. Preserve an unqualified deferred
     callback as an unknown host queue rather than inventing Web/Node timing.
   - [x] Add a versioned backend-neutral callable-summary API for direct
     functions and immutable local callable aliases, including may-effects,
     synchronous throws, direct Promise rejections, and mutated regions.
   - [x] Record `0`, `0..1`, exactly-once, and sequential `0..n` callback
     cardinality for direct calls and reviewed Array callback APIs; mutable
     aliases, callback escape, multiple unrelated calls, and dynamic dispatch
     remain explicit `unknown` evidence.
   - [x] Scan callback parameters and every immutable alias by TypeChecker
     identity. Only direct calls, immutable alias edges, and reviewed builtin
     forwarding consume a reference; unknown calls, storage, return, capture,
     comparison, and other uses become `callback-escape` with unknown
     cardinality and cannot be published as verified package evidence.
   - [x] Compose one direct same-Program callback-parameter forwarding edge
     through a declaration-order-independent fixed point. Preserve enclosing
     conditionality, timing, completion, scheduling provenance, and literal
     delay across acyclic wrapper chains; cycles, multiple/mixed forwarding,
     and unresolved callees remain explicit unknown. Ignore type-only callback
     references without treating runtime identity as escaped.
   - [x] Preserve declared `effect_parameter` bounds in the summary so callers
     and future package summaries can instantiate effect-polymorphic callbacks.
   - [x] Distinguish inline throw propagation, Promise-reaction conversion to
     rejection, and deferred host-reported throws for reviewed Promise, timer,
     microtask, event-listener, and Array callback boundaries.
   - [x] Join direct callback calls across one mutually exclusive `if/else` or
     closed explicit-default `switch`: preserve exactly-once versus enclosing
     conditional/repeated multiplicity, and reject fallthrough, nested
     conditional calls, or independent branches as unknown.
   - [x] Apply the same exclusive-site join to reviewed builtin callback
     forwarding. Compose outer control multiplicity with inner callback
     cardinality, preserve a common timing/completion lane, and reject mixed
     inline/Promise/host-task alternatives as unknown.
   - [x] Persist one directly returned immutable callable's Effect and rejection
     contract, then resolve a consumer's direct `const result = factory()`
     invocation, immutable local alias chain, and imported/re-exported alias by
     TypeChecker declaration identity. Feed its `Throw`/awaited rejection into
     the shared CFG; mutable, conditional, multiple-return, cyclic, and
     unresolved factory results remain unknown.
   - [x] Resolve returned callables stored in a source-local `const` object
     literal when a whole-file symbol screen proves every container use is a
     direct static dot/string-literal property call. Support multiple explicit
     properties; reject mutation, escape, computed keys, spreads, accessors,
     methods, and duplicate keys.
   - [x] Persist callable members of one directly returned static object literal
     and compose `const client = factory(); client.method()` by TypeChecker
     identity plus a whole-file receiver-use screen. Preserve each member's
     Effect, synchronous `Throw`, and awaited rejection; reject receiver
     mutation/escape, dynamic selection, spread, accessor, computed/duplicate
     producer members, and unresolved authority.
     - [x] Instantiate a returned member's `Mutate<typeof this.path>` against
       the concrete static receiver region while retaining unsupported receiver
       identity as unknown.
     - [x] Preserve the factory-result receiver through acyclic `const` alias
       chains. Screen the complete alias family by TypeChecker identity,
       normalize `this` mutation to the factory-bound root, and reject mutable
       aliases, escape, mutation, or dynamic member selection.
     - [x] Persist each returned member's direct callback parameters, Effect
       bounds, invocation cardinality/timing, and completion lane. Project the
       authenticated member contract onto the consumer's TypeChecker-resolved
       method symbol so the existing callback call graph composes it through
       immutable receiver aliases and package boundaries.
     - [x] Authenticate one receiver-preserving fluent shape: an object-literal
       method with exactly one direct final `return this`. Compose nested member
       Effect/Throw/rejection and `this` mutation against the original factory
       receiver; reject conditional/multiple returns, replacement objects,
       arrow lexical `this`, and unsupported dynamic chains.
   - [ ] [#24](https://github.com/mizchi/uneffect/issues/24) Compose callback summaries across open/imported package boundaries,
     reentrant or concurrent callbacks, returned callables, and mixed control
     paths without degrading all such cases to `unknown`.
4. [ ] [#63](https://github.com/mizchi/uneffect/issues/63) Lower Promise settlement, resource disposal, timers, microtasks, and
   callback invocation through one host-neutral temporal transition interface.
   Preserve separate Web and Node scheduling profiles and explicit unsupported
   interleavings. ([#63](https://github.com/mizchi/uneffect/issues/63), [#10](https://github.com/mizchi/uneffect/issues/10))
   - [x] Introduce the versioned `uneffect-host-neutral-transitions/v1`
     contract with source-stable callback invocation, Promise settlement, and
     resource-disposal transitions.
   - [x] Connect callable summaries, Promise-chain analysis, and sync/async
     `using` disposal analysis through one Program-backed entry point while
     deduplicating the shared Promise-reaction observation.
   - [x] Project exact neutral inline/microtask lanes and reviewed timer/event
     APIs to distinct Web and Node queue names; ambiguous Node EventTarget and
     other unreviewed host tasks retain an explicit unknown reason.
   - [x] Link neutral transitions to the executable Web/Node Quint queue-state
     generators, TypeChecker-derived compatible timer cancellation, and Node
     poll/close external completion. Definite cancellation suppresses its
     bounded-progress obligation.
   - [x] Emit explicit bounded-host-progress fairness assumptions for exact,
     non-synchronous, non-cancelled transitions instead of silently treating
     scheduler progress as proved.
   - [x] Encode opt-in weak/strong fairness as executable Quint temporal
     constraints over the generated Web/Node state tuple, including external
     poll/close completion and finite callback alternatives; Quint typechecks
     both host projections.
   - [x] Persist reviewed builtin scheduling provenance for package callbacks.
     Direct `setTimeout`/`setInterval` literal delays, animation frames, and
     EventTarget forwarding can enter their profile-specific queue; generic
     `deferred` timing alone remains insufficient authority. Poll/close package
     provenance remains tracked by [#10](https://github.com/mizchi/uneffect/issues/10).
   - [x] Preserve compatible conditional `clearTimeout` as a nondeterministic
     cancellation-versus-execution race in both Web and Node queue-state
     models; do not impose fairness on the optional cancellation branch.
   - [x] Extract TypeChecker-identified local `AbortController` construction and
     `abort(reason)` calls into neutral inline abort transitions, reject
     same-spelled user classes, and link `controller.signal` sources in static
     `AbortSignal.any` compositions.
   - [x] Feed definite unconditional aborts in synchronous owners into Web
     scheduler initial state, preserving the abort reason and preventing an
     already-cancelled `scheduler.postTask` callback from becoming pending.
   - [x] Add the first executable abortable-operation product for builtin
     `fetch(url, { signal: controller.signal })` with an immutable local Promise
     binding. External fulfillment, normal rejection, conditional abort, abort
     reason, and first-settlement-wins share one Quint state; lookalike fetch and
     dynamic options remain outside the exact fragment.
   - [x] Resolve non-reassigned local signal aliases and static local
     `AbortSignal.any` compositions at builtin fetch sites. Preserve a static
     pre-aborted source in initial state and keep dynamic/mutable aliases
     fail-closed.
   - [x] Accept a single-use local `const` object-literal RequestInit alias;
     reject reused, mutated, dynamic, and escaping options as unknown rather
     than treating `const` as deep immutability.
   - [x] Join each abortable fetch binding with Promise ownership
     (`await`/`return`/`catch`/floating) and emit an executable
     `abortableFetchObserved` Quint property. Response-body resources and retry
     attempt composition remain separate.
   - [x] Track the direct `const response = await request` body-consumption
     fragment for builtin `json/text/arrayBuffer/blob/formData/bytes`; emit
     `abortableFetchBodiesConsumed`, treating conditional consumption as
     unknown. General stream pipelines and interprocedural ownership remain
     open.
   - [x] Resolve immutable Response aliases and model direct
     `body.getReader()` as stream ownership. Treat builtin reader `cancel()` as
     discharge and `releaseLock()` as ownership release without consumption;
     do not equate reader acquisition with consuming the body.
   - [x] Recognize one canonical `reader.read()` EOF drain loop and discharge
     only when every loop break is the direct `if (done) break` from the same
     builtin read result. Treat early break/continue/return/throw as unknown.
   - [x] Recognize direct unconditional `await response.body!.pipeTo(sink)` by
     builtin symbol identity as a `pipe-to` discharge. Keep floating or
     conditional pipes unknown; options remain unsupported.
   - [x] Recognize the direct unconditional builtin chain
     `await response.body!.pipeThrough(transform).pipeTo(sink)` as a
     `pipe-through-to` discharge. Reject floating chains and either method's
     options; longer chains remain unsupported.
   - [x] Resolve one non-reassigned, single-use local `const` alias for the
     result of builtin `response.body!.pipeThrough(transform)`, by declaration
     identity rather than binding spelling. Require a direct awaited builtin
     `alias.pipeTo(sink)`; extra references and conditional use stay unknown.
   - [x] Split one unconditional builtin `const copy = response.clone()` into
     original/copy body obligations and require both branches to be consumed.
     Preserve per-branch status in analysis output; unbound, conditional,
     multiple, or multiply-consumed clones stay unknown.
   - [x] Split one unconditional builtin
     `const [left, right] = response.body!.tee()` into two stream obligations.
     Require each single-use branch to complete one direct awaited builtin
     `pipeTo`; missing branches remain unconsumed, while conditional/repeated
     branch use or reuse of the original source becomes unknown.
   - [ ] [#63](https://github.com/mizchi/uneffect/issues/63) Compose cancellation races and external completion with
     resources/Promise settlement; connect conditional/async/controller aliases,
     direct controller signals, fetch and general abortable APIs; and retain
     unsupported host-specific ordering as explicit unknown transitions.
5. [ ] [#7](https://github.com/mizchi/uneffect/issues/7) Consume persisted package contract/effect summaries at call sites with
   exact package, export, declaration, compiler, and source provenance. Unknown
   or stale summaries must block assurance; publisher/build authenticity stays
   a separate trust claim. ([#7](https://github.com/mizchi/uneffect/issues/7), [#20](https://github.com/mizchi/uneffect/issues/20))
   - [x] Bind verified scalar contract summaries to TypeChecker-resolved calls
     through named aliases, namespace imports, and source re-exports. Require matching summary
     content, TypeScript version, installed package version, and callable
     signature; retain resolved declaration bytes and fail closed on drift.
     Expose the path programmatically and through repeatable CLI
     `--contract-summary` inputs.
   - [x] Publish verified Effect-only exports in the same envelope and lower
     accepted bindings into the existing external Effect contract IR. Preserve
     declaration-order parameter substitution for `Mutate`, synchronous
     `Throw`, scoped capabilities, and the package-contract assumption ledger.
   - [ ] [#7](https://github.com/mizchi/uneffect/issues/7) Bind producer evidence to emitted declaration/build artifacts, consume
     callback/callable/resource summaries, and add publisher/tarball authenticity.
     - [x] Add an opt-in package-relative runtime artifact digest ledger and
       block consumer binding when any explicitly listed installed file is
       missing or byte-different. This does not claim source-to-emit provenance.
     - [x] Bind exact untransformed TypeScript declaration/runtime outputs to a
       same-compiler in-memory re-emit of the producer Program and require every
       output to match the installed package before exposing contracts.
     - [x] Expose package summary publication as a strict CLI command with
       project/entry/package identity, exact TypeScript emit, optional reviewed
       runtime files, registry/module inputs, and deterministic JSON output.
     - [x] Separate root package/version identity from static package subpath
       import identity. Bind consumers by `(module specifier, export)` so equal
       export names at the root and a subpath cannot collide.
     - [x] Preserve same-file export aliases, relative re-exports, transitive
       `export *` barrels, default callables, and ordered public overload sets;
       reject ambiguous barrels and any installed declaration-set drift.
     - [x] Preserve generic arity and the exact public generic signature, then
       accept TypeChecker-resolved concrete instantiations only after the full
       installed declaration has matched. Constraint and type-parameter drift
       remain blocking unknowns.
     - [ ] [#7](https://github.com/mizchi/uneffect/issues/7) Add authenticated
       bundler/post-transform provenance plus publisher and complete tarball
       authenticity. Plain TypeScript emit evidence does not satisfy this boundary.
6. [x] [#25](https://github.com/mizchi/uneffect/issues/25) Expand common expression semantics in measured frequency order:
   optional chaining and nullish coalescing, destructuring/default initializers,
   stable method receivers and `this`, iterator-based `for...of`, then reviewed
   coercions. Property access that may invoke a getter remains effectful or
   unknown until descriptor evidence exists.
   - [x] Resolve a local custom iterable's standard `[Symbol.iterator]`
     method by TypeChecker identity at `for...of`. Generator methods compose
     acquisition/step Effect and synchronous Throw into the consumer; ordinary
     methods compose acquisition but keep opaque `next`/`return` execution
     explicitly unknown.
     - [x] Reuse that implicit iterator edge for spread, array destructuring,
       `yield*`, reviewed iterable constructors, `Array.from`/
       `Object.fromEntries`, and Promise combinators. Preserve synchronous
       Throw for ordinary consumers and convert iteration Throw to Promise
       rejection at combinator boundaries.
   - [x] Extend reviewed coercion boundaries to loose equality, numeric and
     bitwise binary/compound operators, unary numeric conversion, and template
     interpolation. Object/unknown operands emit `InvokeUserCode`; unions made
     entirely from primitive TypeChecker constituents remain effect-free.
   - [x] Lower Program-visible getter/setter access and local coercion hooks to
     ordinary inline call-graph edges. Compose `Symbol.toPrimitive`, followed
     conservatively by local `valueOf`/`toString` fallbacks, including Effect,
     synchronous Throw discharge, and receiver-rooted Mutation substitution.
   - [x] Treat `new` of a same-Program class as an inline constructor call.
     Compose constructor defaults/body and non-static instance field
     initializers; classes with an implicit constructor project their fields at
     the allocation site, including inherited constructor effects.
   - [x] Lower a same-Program standard `Symbol.hasInstance` override to an
     inline `instanceof` call edge, including its argument, receiver Mutation,
     and catch discharge. Track direct builtin `Proxy` plus immutable aliases
     for property access, `in`, and `delete`; reject same-spelled constructors.
   - [x] Model reviewed `JSON.stringify` hidden execution: compose a local
     `toJSON` method or, when absent, same-Program object-literal enumerable
     getters; classify unknown/Proxy and recursively typed container values
     whose elements may expose hooks as `InvokeUserCode`. Preserve the existing
     synchronous replacer callback contract.
   - [x] Model standard `structuredClone` clone failure as
     `Throw<DOMException>`, compose same-Program own enumerable getters through
     finite object/array literals, retain opaque generic graphs as
     `InvokeUserCode`, and discharge catalog throws through synchronous catch.
   - [x] Extend generic collection contracts to synchronous `Map`/`Set` and
     readonly `forEach` callbacks plus receiver mutation for `WeakMap` and
     `WeakSet`; retain TypeChecker identity and same-spelled lookalike controls.
     - [x] Add generic callback invocation-argument and explicit-`thisArg`
       projectors. Instantiate collection receiver Mutation, keep
       engine-produced element/key/index aliases explicitly unknown, and
       exclude TypeScript's erased pseudo-`this` parameter from runtime indexes.
     - [x] Apply invocation shapes to Promise reactions, `Array.from`, JSON
       replacers, EventTarget, disposal callbacks, and host schedulers. Add a
       variadic suffix projector for timer/immediate/next-tick arguments and
       treat omitted callback shapes as unresolved runtime parameters rather
       than zero arguments.
     - [x] Add synchronous callable replacement contracts for String
       `replace`/`replaceAll`, and connect ES2024 `Object.groupBy`/`Map.groupBy`
       to classifier callbacks, iterable consumption, runtime element aliases,
       and fresh-result refinement. RegExp protocol semantics remain deferred.
     - [x] Generate callback, receiver-Mutation, and fresh-result contracts for
       all standard numeric and BigInt TypedArray owners. Reuse the common
       invocation-shape IR and retain numeric bounds/backing/overlap as separate
       typed-array obligations.
   - [x] Model standard-identity `Object.assign` as enumerable reads followed
     by target writes. Compose same-Program object-literal source getters and
     matching target setters, exclude class prototype accessors, and classify
     unknown/type-parameter or authenticated Proxy operands as
     `InvokeUserCode`. Emit target Mutation and result-alias semantics from the
     builtin catalog. Reject same-spelled lookalikes.
   - [x] Reuse enumerable source-read semantics for standard-identity
     `Object.values` and `Object.entries`, while keeping `Object.keys`
     getter-free. Authenticate Proxy enumeration traps for all three; keep
     unknown/type-parameter operands fail-closed and class prototype getters
     excluded.
   - [x] Lower standard-identity `Reflect.get`/`Reflect.set` with finite literal
     keys to the same accessor call edges as direct property access. Preserve
     the optional receiver as accessor `this`, catalog target/receiver Mutation
     for `Reflect.set`, synchronous catch discharge, and fail closed for
     dynamic keys, unknown/type-parameter values, and Proxy traps. Keep
     `Reflect.has`/`Reflect.deleteProperty` free of ordinary accessor calls
     while retaining Proxy traps; catalog delete Mutation explicitly.
   - [x] Lower standard `Function.prototype.call`/`apply` and `Reflect.apply`
     wrappers to the underlying same-Program callable edge. Preserve explicit
     `this`, argument Mutation substitution, synchronous Throw discharge, and
     immutable single-use array-literal argument aliases. Dynamic callable or
     argument-list values, mutated/escaping list aliases, and callable Proxies
     remain `InvokeUserCode` and unresolved Mutation rather than receiving
     guessed identities.
   - [x] Model standard `Function.prototype.bind` as deferred callable
     composition: creation is effect-free, while a later direct/call/apply
     invocation instantiates the target with bound `this`, prefix arguments,
     and call-site arguments. Preserve immutable aliases and repeated calls;
     reject callable Proxy/dynamic targets and any bound callable that escapes
     before invocation as `InvokeUserCode`. Returned bound callables remain an
     open cross-boundary callable-summary problem.
   - [x] Lower standard `Reflect.construct` to the same-Program constructor/new
     semantics for static argument lists. Compose explicit constructors and
     implicit instance field initializers, synchronous catch discharge, and
     argument-rooted Mutation; treat the constructed result as fresh local
     state. Dynamic constructors/lists and Proxy target/newTarget values retain
     `InvokeUserCode`, with unresolved argument Mutation instead of name-based
     guessing.
   - [x] Catalog standard object-internal mutations for
     `Object.defineProperty`/`defineProperties`, `freeze`, `seal`,
     `preventExtensions`, `setPrototypeOf`, and the corresponding reviewed
     Reflect operations. Preserve target result aliases where applicable.
     Compose same-Program descriptor getters (including inherited descriptor
     fields), enumerable descriptor-map getters, synchronous Throw/catch, and
     Proxy/dynamic descriptor boundaries as `InvokeUserCode`.
   - [x] Reuse descriptor-map conversion for `Object.create`: compose map and
     descriptor getters while recording a fresh result and no target Mutation.
     Distinguish `Object.getOwnPropertyDescriptor(s)` and `Object.hasOwn`, which
     do not execute ordinary getters, from authenticated Proxy/unknown targets
     whose descriptor/has traps remain `InvokeUserCode`.
   - [x] Introduce name-independent Program binding identities and migrate
     AbortController composition, timer handles, TaskController handles, and
     locally bound abort signals. Add a block-shadowing negative control.
   - [x] Eliminate unsafe binding-name identity from typed-array, ownership,
     runtime-contract, and React analysis: use symbol/declaration identities in
     Program-backed paths, constrain genuinely single-scope maps, and fail
     closed in source-only paths. Add shared rename and shadowing coverage;
     import-alias and lookalike controls remain in their domain suites.
     - [x] Use declaration identity as the ownership fallback and keep
       same-spelled transferred/read buffers separate.
     - [x] Fail closed in the legacy source-only numeric lowering when one
       function contains same-spelled bindings; do not emit `verified` from a
       potentially colliding textual environment.
     - [x] Audit runtime-contract/control-flow alias maps: they are restricted
       to a single module declaration scope, while nontrivial aliases are
       resolved by the existing TypeChecker bridge.
     - [x] Fail closed for React direct-body event/effect-event callback names
       shadowed by another lexical declaration, rather than merging callbacks
       by spelling.
     - [x] Carry per-expression symbol/declaration keys through the Program-backed
       numeric frontend for parameters, locals, typed arrays, buffers, views,
       and module constants. Keep source-only analysis conservatively unknown
       on shadowing.
     - [x] Resolve direct local JSX event handlers by declaration symbol in the
       Program-backed frontend, while retaining source-only fail-closed behavior.
     - [x] Extend React symbol keys from JSX handlers to Effect Events, ref
       callbacks, and annotated custom-Hook callback environments; retain
       source-only fail-closed behavior.
     - [x] Add one cross-domain rename-invariance suite covering abortable
       fetch, typed-array, ownership, and React Program-backed analyses.
   - [x] Add one shared conservative lexical-execution classifier for optional
     callback calls, the right side of `&&`/`||`/`??`, branch bodies, switch
     clauses, and loop multiplicity. Reuse it for callable cardinality,
     async/EventTarget cancellation, host-neutral conditional transitions, and
     top-level-await ordering. Conditions and `for` initializers remain
     exactly-once; optional calls and short-circuit right operands are `0..1`.
   - [x] Treat parameter entry evaluation as part of the callable: scan ordinary
     defaults, nested object/array binding defaults, and computed destructuring
     keys for direct/callee effects and synchronous throws in both source and
     Program call-graph frontends. Optional callback calls from a default
     initializer have `0..1` cardinality rather than being omitted or reported
     as exactly-once.
     - [x] Lower static top-level object binding reads to local getter edges for
       variable and parameter destructuring, including rename/default forms.
       Parameter binding Throw occurs before the body catch; a getter that
       mutates its nameless destructured source remains an explicit unresolved
       receiver rather than receiving an invented region identity.
     - [x] Compose enumerable same-Program object-literal getters through object
       spread and variable object-rest, excluding explicitly selected rest
       keys. Preserve direct Proxy/alias copies as `InvokeUserCode`; class
       prototype getters are not incorrectly treated as enumerable own fields.
     - [x] Recurse through finite static nested object binding paths for getter
       Effect/Throw. Keep nested receiver Mutation unresolved without stable
       heap identity, and compose a computed binding key's local
       `Symbol.toPrimitive`/fallback coercion before property selection.
   - [x] Extract callback parameters from finite object and tuple destructuring,
     preserving renamed bindings, nested static paths, defaults, immutable local
     aliases, and independent cardinality for multiple callback fields. Add a
     path-keyed instantiation API; rest and computed callback bindings make the
     summary explicitly unknown instead of silently dropping the callback.
   - [x] Resolve same-Program class methods through the TypeChecker resolved
     signature when instantiated receiver symbols differ from declaration
     symbols. Carry a stable receiver on call edges and substitute
     `Mutate<typeof this.path>` into the caller, including immutable aliases and
     nested `this` data-property receivers. Getter receivers, mutable aliases,
     extracted/unbound methods, and non-addressable receivers remain explicit
     `unresolved-mutation-alias` evidence. Same-Program user method callback
     timing is derived from its body without granting same-spelled builtin
     identity.
7. [ ] [#6](https://github.com/mizchi/uneffect/issues/6) Add explicit JavaScript numeric domains instead of widening Z3 Real:
   safe integers and U32 first, then finite IEEE-754 facts (`NaN`, infinity,
   negative zero, and `Math.fround`). Keep unsupported coercion and rounding
   behavior unknown. ([#6](https://github.com/mizchi/uneffect/issues/6))
   - [x] Model TypeChecker-identified `Math.imul` as signed Int32 output and
     `Math.clz32` as an integer in `0..32` for typed-array/DataView range
     obligations; same-spelled shadow objects remain unknown.
   - [x] Treat common Web Crypto and Node crypto randomness APIs as the existing
     `Random` capability: `getRandomValues`, both `randomUUID` forms,
     `randomFill`/`randomFillSync`, `randomInt`, and `randomBytes`, including
     reviewed callback effects and unused-effect diagnostics.
   - [x] Add a TypeChecker-backed exact-value fragment that distinguishes NaN,
     positive/negative infinity, negative zero, finite constants, and exact
     `Math.fround` results. Literal arithmetic is evaluated only when both
     operands are exact; shadowed builtins and general arithmetic remain unknown.
   - [x] Propagate builtin `Math.fround` through typed-array range obligations
     when its input has a proven finite range within Float32 capacity; preserve
     integer evidence only inside the exactly representable integer range.
   - [ ] [#6](https://github.com/mizchi/uneffect/issues/6) Add finite IEEE-754 facts for `NaN`, infinities, negative zero,
     and `Math.fround` to refinement/Hoare obligations, followed by the remaining
     typed-array element domains and overlap/resize semantics. Exact expression
     classification is implemented; general propagation is not. RegExp and Date
     modeling are intentionally deferred.
8. [ ] [#18](https://github.com/mizchi/uneffect/issues/18) Extend module and Realm composition for common static ESM, bounded
   top-level await, Worker entrypoints, and reviewed external-code boundaries.
   Dynamic import targets, `eval`, proxies, prototype mutation, native addons,
   and opaque WebAssembly remain explicit high-authority boundaries rather than
   prerequisites for the safe subset. ([#18](https://github.com/mizchi/uneffect/issues/18), [#10](https://github.com/mizchi/uneffect/issues/10))

### Deferred design track: a mature Uneffect specification DSL

- [ ] Evaluate extracting the current temporal/contract expression language ([#64](https://github.com/mizchi/uneffect/issues/64))
  into a mature, versioned Uneffect DSL rather than growing backend-shaped
  syntax inside annotations.
  - [ ] Read Quint's npm-distributed TypeScript implementation as a design ([#64](https://github.com/mizchi/uneffect/issues/64))
    reference for lexer/parser structure, typed IR, module resolution,
    diagnostics, evaluator boundaries, and source mapping. Record exact
    upstream version, file provenance, and license before adapting any code.
  - [ ] Define the Uneffect DSL independently of Quint syntax. Preserve the ([#64](https://github.com/mizchi/uneffect/issues/64))
    TypeScript-oriented surface, zero-runtime comment embedding, gradual
    adoption, and optional runtime-assertion lowering.
    - [x] Add the first typed `*.uneffect.ts` temporal authoring fragment and
      lower it to the backend-neutral `TemporalSpec` without executing it.
    - [x] Connect an implementation with
      `/* uneffect:temporal_from "./model.uneffect.ts#default" */`, resolve it
      in project verification, and verify linked safety invariants.
    - [x] Resolve DSL helpers through TypeChecker symbol identity during project
      verification; retain the text-only parser as a lower-assurance standalone frontend.
    - [ ] Add typed Set/Map/record descriptors and package-level spec imports. ([#64](https://github.com/mizchi/uneffect/issues/64))
    - [x] Add the first `defineCapability` fragment with Console, scoped Fetch,
      FsRead/FsWrite, and Throw descriptors; connect named exports through
      `uneffect:capability_from` to the existing effect analyzer.
    - [x] Cover all registered builtin Effect schemas through the schema-driven
      `Builtin` descriptor and validate capability helpers through TypeChecker
      symbol identity during project verification.
    - [x] Add declarative project-local user-defined Effect schemas without
      process-global registry mutation and pass their atom domains explicitly
      into the existing effect analyzer.
    - [ ] Compose user-defined Effect schema evidence across packages, including ([#64](https://github.com/mizchi/uneffect/issues/64))
      provenance, version compatibility, and conflicting-schema diagnostics.
    - [x] Add the first typed `defineContract` fragment and connect named exports
      through `uneffect:contract_from` to the existing Z3 Hoare-contract verifier.
    - [x] Match linked scalar contract parameter names/domains and result domains
      against the exact implementation signature and resolve helpers by
      TypeChecker identity.
    - [x] Add multiple clauses, Nat/Float parameter refinements, and linked
      Valibot assertion dogfood through `runtimeAssertions: "fallback"`.
    - [x] Lower the pure scalar `requires`/`ensures` fragment and `Nat`/`Float`
      results to optional runtime checks without evaluating arbitrary
      specification code.
    - [x] Instrument multiple value returns across branches while
      excluding nested function exits and avoiding generated-name collisions.
    - [x] Fail closed when the supported return/throw/block/if-else, exhaustive
      switch, try/catch/finally, or obvious non-breaking infinite-loop fragment
      may fall through without checking a postcondition.
    - [x] Check async fulfillment values with a Promise reaction, preserve
      rejection behavior across surrounding synchronous try/catch, and test
      postcondition failures as distinct rejections.
    - [x] Separate a structured CFG exit summary and compose switch fallthrough,
      targeted labeled/unlabeled break/continue, loops, and try/finally override.
    - [x] Attach stable file, exact local directive line/column/span, contract
      kind, and expression fields to generated runtime failures.
    - [x] Use TypeChecker-resolved direct `never` calls and Boolean literal types
      for the first semantic reachability refinement; same-named `void` calls
      remain fallthrough.
    - [x] Bridge TypeScript's public `noImplicitReturns` semantic diagnostics to
      the neutral CFG, bind evidence to source digest/compiler version/options,
      and refine exhaustive literal-union switches. Function-local semantic
      errors downgrade the endpoint to `unknown`.
    - [x] Observe internal TypeScript `flowNode` availability/count for pinned
      parity reporting only; do not use undocumented graph APIs as proof evidence.
    - [x] Instrument Generator and AsyncGenerator final return values without
      treating yielded values as contract results.
    - [ ] Extend semantic reachability beyond direct expression-statement calls ([#64](https://github.com/mizchi/uneffect/issues/64))
      and literal Boolean conditions.
    - [x] Preserve the originating `.uneffect.ts` file, line, column, expression,
      and AST span across linked-contract materialization and runtime lowering.
    - [x] Reuse one compatible project TypeScript `Program` for runtime CFG
      evidence and extend the analysis bridge from top-level declarations to
      identifier-named methods and directly immutable variable-bound block
      functions by declaration-node identity. Incompatible compiler options
      and mutable bindings fail closed.
    - [x] Extend runtime contract rewriting itself to identifier-named methods
      and directly immutable variable-bound block functions; reject mutable
      bindings.
    - [x] Cover getter results, setter preconditions, literal computed names,
      expression-bodied arrows, top-level immutable callable alias chains, and
      lexically nested direct declarations. Reject setter postconditions,
      dynamic computed names, and mutable alias chains.
    - [x] Extend callable aliases through nested lexical scopes,
      TypeChecker-resolved imports/re-exports, and direct properties of builtin
      `Object.freeze` static object literals, including `const` object
      destructuring through immutable container aliases. Relocate project
      contracts to the source callable instead of generating identity- or
      `this`-changing wrappers.
    - [x] Resolve callable properties of TypeChecker-authenticated module
      namespace imports and their `const` destructuring aliases without
      generalizing ordinary mutable object properties.
    - [ ] Extend stable callable containers beyond direct builtin-frozen object ([#64](https://github.com/mizchi/uneffect/issues/64))
      literals while retaining mutation, getter, proxy, and dispatch-sealing
      negative controls.
  - [ ] Version a backend-neutral AST and module interface shared by capability ([#64](https://github.com/mizchi/uneffect/issues/64))
    effects, Hoare contracts/invariants, and temporal specifications without
    collapsing their distinct semantics.
  - [ ] Specify name resolution, user-defined modules, types, finite ([#64](https://github.com/mizchi/uneffect/issues/64))
    collections, functions, source spans, error recovery, and unsupported
    constructs before exposing a general plugin API.
  - [ ] Keep Quint as one generated verification backend. Do not pass arbitrary ([#64](https://github.com/mizchi/uneffect/issues/64))
    Uneffect annotation text directly to Quint or make generated Quint text the
    public API.
  - [ ] Add parser/typechecker conformance fixtures, formatter round trips, ([#64](https://github.com/mizchi/uneffect/issues/64))
    positive executions, deliberately broken counterexample models, and
    differential tests against the current annotation parser before migration.
  - [ ] Define an incremental migration path in which ([#64](https://github.com/mizchi/uneffect/issues/64))
    `generateTemporalModel` and versioned evidence remain stable while the DSL
    frontend and Quint lowering can be replaced independently.
  - [ ] Establish promotion criteria: deterministic diagnostics, explicit ([#64](https://github.com/mizchi/uneffect/issues/64))
    coverage/exclusions, bounded resource limits, package-level composition,
    editor tooling hooks, and dogfood on at least two realistic applications.

There are 14 open implementation Issues after completing #63 and bounded children #60 and #61 and
bounded children #58
and #59 and children #56 and #57,
after closing #23, #26, #27, #28, and
#29/#30/#31/#32/#33/#34/#35/#36/#37/#38/#39/#40/#41/#42/#43/#44/#45/#46/#47:
14 parent/epic Issues remain queued: one proof-boundary parent in Phase 1,
six specification-expressiveness parents in
Phase 2, six production-integration Issues in Phase 3, and one proof-consumer
Issue in Phase 4. Completed child
[#45](https://github.com/mizchi/uneffect/issues/45) belongs to #5 and follows
completed bounded children
[#42](https://github.com/mizchi/uneffect/issues/42),
[#43](https://github.com/mizchi/uneffect/issues/43), and
[#44](https://github.com/mizchi/uneffect/issues/44). Completed operational
follow-up [#46](https://github.com/mizchi/uneffect/issues/46) owns the landed
solver-heavy CI timing and sharding handoff. Completed child #47 remains inside
parent #25's estimate. The 13 non-overlapping epic estimates, including #64 DSL
work, total 51–110 engineer-weeks, while the remaining Phase 1 breadth is 1–3
engineer-weeks. Use `docs/remaining-work-estimate.md` for scope cuts and
uncertainty; use `docs/feature-matrix.md` for the exact supported/unsupported
user-visible boundary. Completed detail, including the closed Promise/resource
work in #9, remains in the historical ledger and `docs/implementation-status.md`.
Completed operational follow-up
[#49](https://github.com/mizchi/uneffect/issues/49) replaces the checker-backed
dogfood's fixed 20-second CI limit with one tested finite local/CI policy after
an observed false-negative timeout and a successful unchanged rerun.
General CFG values and escaping-alias fixed points remain outside #9 and are
owned by #25 and #24. The completed #26 seed proves only one direct local alias.
Completed checker-builtin child
[#50](https://github.com/mizchi/uneffect/issues/50) extends #8 with the exact
Workhub-shaped named fs read/write and global fetch atom corpus while retaining
Completed child [#51](https://github.com/mizchi/uneffect/issues/51) adds only the
surfaced direct, unconditional `await` observation family; conditional awaits,
callback ownership, rejection handling, and combinators remain outside it.
Completed child [#52](https://github.com/mizchi/uneffect/issues/52) admits only one
direct await beneath one enclosing `if` branch, using Workhub XClient evidence.
Completed child [#53](https://github.com/mizchi/uneffect/issues/53) addresses only
unconditional direct-call Promise returns, including one `as Promise<T>` wrapper.
Completed child [#54](https://github.com/mizchi/uneffect/issues/54) adds the
Workhub-observed `access`/`readdir` read and `appendFile`/`mkdir` write atoms.
Completed child [#55](https://github.com/mizchi/uneffect/issues/55) adds only direct
await rejection ownership in one catch-protected try block.
Completed child [#56](https://github.com/mizchi/uneffect/issues/56) adds the exact
Workhub function-local awaited dynamic fs-import binding and its read evidence.

P2.1 is complete for its direct affine ranking-loop seed. P2.2 now consumes
resource-free dynamic outer-loop `continue` completions by lexical owner and
models their cardinality as a nondeterministic repeat-or-exit choice. Dynamic
resource-bearing loops remain unsupported. P2.3 emits a budgeted completion
fixed-point for the application-backed direct `switch`/`catch`/`finally` join.
P2.4 replaces its completion classifier with reusable statement/basic-block
lowering and covers the application-backed nested `if`/throw/catch family.
Attempted-family loops, incomplete switches, and abrupt finally bodies produce
an explicit `unsupported-control-flow` non-proof. P2.5 extends the graph across
prefix and suffix statements surrounding one control root and proves that an
abrupt branch cannot enter the suffix. P2.6 correlates an exact caught-path
predicate with its value join and discharges `rejectTelemetry`'s redundant
nested ternary while retaining predicate loss as an explicit non-proof. The
P2.7 then lowers application-backed abrupt `finally` return/throw overrides.
P2.8 replaces the ranking-loop seed's separate handler graph with this shared
statement/basic-block builder while retaining its back edge and recurrence
proof. P2.9 admits exactly two application-backed sibling `if` roots under a
named root budget; excess and mixed roots remain explicit non-proofs. P2.10
unrolls one literal finite handler-local `for...of` family under a
named iteration budget without admitting break/continue, resources, dynamic
iteration, or recurrence widening. P2.11 composes one application-backed
depth-two nested try/catch family under a named nesting budget. P2.12 replaces
its singleton block names with source-keyed region identities and composes two
sibling nested handlers without admitting a third, deeper, or irreducible
region. Remaining general value lattices and recurrence widening move to #25.
P3.1 then adds one TypeChecker-backed, source-keyed, non-escaping local object
alias through one direct helper; escape, reassignment, computed access,
polymorphism, and dynamic/unresolved helper selection remain explicit
non-proofs. P3.2 exports one checker-backed `Console` inference and its ordered
local calls with operation/compiler/declaration/symbol provenance; a
same-spelled local object remains effect-free. General builtin and neutral-IR
coverage remains in #8. P2.13 then carries one integer environment through two
source-keyed sibling handler regions and requires an independent Z3 equivalence
proof before verification. P2.14 lifts that environment to two independently
checked integer members. P2.15 carries that product through three regions.
P2.16 adds the first divergent product join, P2.17 adds a direct affine CFG
recurrence, P2.18 adds a predicate-correlated piecewise recurrence, and P2.19
unifies handler/scalar recurrence evidence, and P2.20 composes two sequential
invariant diamonds, and P2.21 adds one bounded finite `switch` fan-out. The next
P2.22 completes #37's common ordered join IR and mixed sequence. P2.23 completes
#38's one-driver/one-dependent upper-triangular affine recurrence.
P2.24 completes #39's source-bound conditional-expression value join.
P2.25 completes #40's source-bound Boolean involution recurrence.
P2.26 completes #41's source-ordered entry-read triangular recurrence.
P2.27 completed #42's total finite-Map lookup slice for Node Lease models.
P2.28 completed #43's inductively proved finite-domain slice for dynamic Map
lookup keys.
P2.29 completed #44's per-key proof composition slice for primary/backup Map
selectors.
P2.30 completed #45's joint-induction slice for failover selectors whose
membership preservation depends on another selector's membership property.
P2.31 completed #58's production-shaped string identity slice through finite
Set/Map, Quint, native/WASM Z3, TLC trace import, and replay.
P2.32 completed #59's exact literal record-valued lease grant Set observation
through native/WASM Z3, Quint, TLC trace import, and replay.
P2.33 completed #60's explicit finite user-predicate property specialization,
real-predicate recheck, vacuity failure, and precondition-preserving shrink.
P2.34 completed #61's TypeChecker-bound direct cross-file predicate
specialization and its fail-closed indirect-import controls.
The 48–102 week figure is the additive whole-backlog inventory, not the estimate
for a first useful release.

## Immediate execution queue

Completed bounded child [#61](https://github.com/mizchi/uneffect/issues/61)
resolves one direct named-imported unary property predicate to its canonical
declaration. Generated Vitest executes that real predicate; barrels,
namespace/default/type-only imports, dynamic selection, and same-spelled
wrappers fail closed. The two-file Datadog dogfood, benchmark, full local gates,
and remote CI run 33248955681 are green.
Completed bounded child [#60](https://github.com/mizchi/uneffect/issues/60)
adds one versioned finite specialization for an exported source-local unary
property predicate. Its Red, Green, vacuity control, unsupported controls,
Datadog-shaped dogfood, benchmark, full local gates, and remote CI run
33247276099 are green. Completed bounded child
[#59](https://github.com/mizchi/uneffect/issues/59) retains an
application-shaped record-valued Node Lease grant Set across native/WASM Z3,
Quint, TLC import, and replay while dynamic composite elements remain
fail-closed; remote CI run 33245382408 is green. Completed bounded child
[#58](https://github.com/mizchi/uneffect/issues/58) preserves
production-shaped string Node Lease IDs through Quint, native/WASM Z3, TLC
trace import, and replay; remote CI run 33243601308 is green. Completed bounded child
[#57](https://github.com/mizchi/uneffect/issues/57) proves the exact Workhub
top-level `main().catch(handler)` launch/attachment family and fixes nested
function `await` being misclassified as TLA. The current Workhub function-level
#8 corpus is exhausted; another #8 child requires new application evidence.
After #61 closes, this implementation cycle is intentionally paused. The next
recommended product decision returns to the
temporal/Node Lease line (#2/#5), but neither parent should be activated as an
epic. First capture one realistic unsupported model as a skipped acceptance
test, then create an independently estimated child Issue.

The remaining work is therefore organized as three candidate Red tests, not as
three simultaneously active implementation branches:

| Candidate | Parent | First bounded Red | Slice estimate | Why it is bounded |
| --- | --- | --- | ---: | --- |
| Temporal/Node Lease | #5 | Import and replay one value or trace shape emitted by a realistic lease model but currently reported `unknown` | 1–2 weeks | The fixture chooses the value universe before any backend is widened. |
| Property testing | #4 after completed #60/#61 | Select one recursive predicate boundary from a real application | 1–2 weeks | Source-local and direct named-import unary specializations are complete; recursion, barrels, and higher-order predicates stay outside it. |
| Numeric/SHA-256 | #6 | Preserve bounds and element range through one non-escaping interprocedural typed-array alias | 1–2 weeks | Resize, sharing, and full SHA-256 composition remain separate children. |

Choose exactly one candidate by first landing its skipped acceptance test and
negative control, then create a child Issue with its own estimate and mark only
that child `status:active`. The table is a decision queue and does not claim
that any of these unsupported shapes already works.

The current planning cut is intentionally narrower than the complete research
backlog:

| Delivery cut | Included Issues | Remaining estimate | What it establishes |
| --- | --- | ---: | --- |
| Proof-boundary MVP | #20 plus the bounded #18 seeds through #57 | Completed; broader #18 is 1–3 weeks if justified by new evidence | Local evidence survives one supported project boundary, one exact async module dependency, and one exact top-level Promise launch/handler attachment. |
| General analysis foundation | Completed #23/#26/#27/#28/#29/#30/#31/#32/#33/#34/#35/#36/#37/#38/#39/#40/#41/#50/#51/#52/#53/#54/#55/#56 | 12–28 weeks for the remaining parent #25/#24/#8 epics | CFG, product-value, alias, and frontend facts can be reused instead of adding shape-specific exceptions. |
| Selected product line | Choose #2/#5 for temporal/Node Lease or #4/#6 plus #26 for generated tests/numeric code | 5–15 additional engineer-weeks after Phase 1 | One coherent application domain becomes materially useful; this is a choice, not a requirement to do both. |
| Entire open research backlog | 14 Issues / 13 non-overlapping epics | 51–110 engineer-weeks | Completed #63 establishes the bounded async/temporal integration; #64 owns the mature neutral DSL; completed children #60/#61 narrow #4; #62 owns public-surface stabilization; completed child #57 is reflected in #18; completed children #50/#51/#52/#53/#54/#55/#56 are reflected in #8; completed children #47/#48 are included within parent #25; completed children #42/#43/#44/#45/#58/#59 narrow parent #5. |

These are engineering-effort ranges, not calendar promises. `effort:XL` Issues
#6, #10, #13, #16, and #24 must be split into bounded child Issues before they
become active. See `docs/remaining-work-estimate.md` for assumptions and scope
cuts.

After these Phase 1 handoffs, select work from the phase-ordered issue index
below. Do not promote a queued Issue merely because a historical checkbox is
nearby in this file. A promotion must update the Issue status label, its next
executable Red/Green slice, and this queue in the same change.

## Active issue index

GitHub Issues and their priority labels are the active queue. The table is
ordered by execution phase and then dependency order, not by issue number.
Unchecked entries later in this file are historical detail mapped to these
issues; do not create a second work queue from them. Issue bodies own acceptance
criteria and the current supported/unsupported boundary.

`Status` is execution state, while `priority:P*` is assurance impact. A queued
P0 item therefore does not automatically pre-empt the active P1 reusable-core
slice after its bounded handoff criteria are complete. Only one
issue should be `active`; `next` means it is ready to follow that work,
`blocked` names a concrete dependency, and `queued` is intentionally deferred
by the phase ordering.

As of 2026-09-01 there are 14 open implementation Issues after the #23/#26/#27/#28/#29/#30/#31/#32/#33/#34/#35/#36/#37/#38/#39/#40/#41/#42/#43/#44/#45/#46/#47/#48/#49/#50/#51/#52/#53/#54/#55/#56/#57/#58/#59/#60/#61/#63 handoffs:
fourteen queued parent/epic Issues. Every open Issue has exactly one
priority label, one status label, one effort label, and one Phase milestone.
Closed Issues are historical evidence and must not retain an execution-status
label.

| Status | Phase | Issue | Area | Depends on | Remaining boundary |
| --- | --- | --- | --- | --- | --- |
| Queued | 1 | [#18](https://github.com/mizchi/uneffect/issues/18) | Module initialization | Completed #20 project evidence plus synchronous-ring and direct cross-project TLA seeds | Broader ESM/external/dynamic initialization semantics; widen after CFG or application evidence |
| Queued | 2 | [#25](https://github.com/mizchi/uneffect/issues/25) | General CFG values | Completed #23 source-keyed CFG | Independent scalar value joins, recurrence widening, and irreducible control |
| Queued | 2 | [#2](https://github.com/mizchi/uneffect/issues/2) | Temporal synthesis | Phase 1 proof boundaries | General polyhedral/quantified invariants and nested formulas |
| Queued | 2 | [#5](https://github.com/mizchi/uneffect/issues/5) | Temporal state | #2 only for quantified/correlated invariants; basic finite collections are independent | Wider collection correlation and remaining TLC values/traces |
| Queued | 2 | [#4](https://github.com/mizchi/uneffect/issues/4) | Property testing | Contract/refinement AST | Recursive, higher-order, multi-argument, barrel-traversing, and inferred predicates |
| Queued | 2 | [#6](https://github.com/mizchi/uneffect/issues/6) | Typed arrays | Completed #23 plus #24; #25 if general joins are required | Interprocedural aliases, resize/shared memory, and complete SHA-256 composition |
| Queued | 2 | [#64](https://github.com/mizchi/uneffect/issues/64) | Backend-neutral DSL | Stable high-level facades and versioned IR | Mature parser/typechecker/modules, conformance, migration, and dogfood |
| Queued | 3 | [#24](https://github.com/mizchi/uneffect/issues/24) | Dynamic refinement | Completed #23 for bounded CFG-sensitive aliases | Interprocedural aliases, higher-order values, dynamic dispatch, and abstraction relations |
| Queued | 3 | [#8](https://github.com/mizchi/uneffect/issues/8) | Native frontend | Stable neutral IR | Complete real Corsa checker fact parity |
| Queued | 3 | [#10](https://github.com/mizchi/uneffect/issues/10) | Event loop | #18 module semantics | Host-specific phases, dynamic cancellation, and polymorphic callbacks |
| Queued | 3 | [#7](https://github.com/mizchi/uneffect/issues/7) | Evidence | Stable proof fragments | Independently checkable certificates or a measured rejection |
| Queued | 3 | [#16](https://github.com/mizchi/uneffect/issues/16) | React | #9, #10, #24 | Dynamic component/Hook flow, server boundaries, and unbounded scheduling |
| Queued | 3 | [#62](https://github.com/mizchi/uneffect/issues/62) | Stability contract | Tested supported fragments and versioned schemas | Public API inventory, compatibility/deprecation rules, and release-policy enforcement |
| Queued | 4 | [#13](https://github.com/mizchi/uneffect/issues/13) | Optimization | #7, #8, completed #23, #24; #25 for general joins | Evidence-gated transformations; general optimization remains unimplemented |

Each active child Issue is widened one Red/Green acceptance slice at a time. Each slice
must retain an adjacent unsupported negative control and add a benchmark when
it expands solver or analysis work. The reusable completion contract delivered
by #3 and the completed #23 source-keyed CFG fed the completed #26 alias seed.
The completed #27 tests the first real checker-backed Corsa fact handoff.
Completed #28 carries one scalar environment through sibling handler regions
without equating structural reachability with a value proof. Completed #29
widens the environment cardinality to two independently checked integer
members. Completed #30 widens only the linear region cardinality from two to
three. Completed #31 introduces the first divergent value join instead of
adding a fourth linear region. Completed #32 moves one affine recurrence off the
private handler-shaped path. Completed #33 adds the first CFG diamond
recurrence. Completed #34 removes the remaining duplicate handler recurrence
representation. Completed #35 composes two sequential invariant diamonds, and
completed #36 adds the first bounded non-binary recurrence fan-out. Completed
#37 normalizes both evidence families and admits one mixed ordered sequence.
#38 added the first non-ranking scalar-to-scalar recurrence edge without
admitting general coupled recurrences.
#39 removes one statement-syntax dependency by lowering a loop-local
conditional value into the common recurrence predecessor IR.
Completed #40 adds one Boolean self-dependency without admitting geometric or
general self-amplifying recurrences.
Completed #41 admits the complementary entry-read triangular ordering without
claiming cyclic or general mutually coupled recurrence solving.

Closed issue history is retained in the relevant checked entries below. In
particular, bounded reachability/vacuity/deadlock work closed [#1](https://github.com/mizchi/uneffect/issues/1),
the reviewed DOM overlay expansion closed [#14](https://github.com/mizchi/uneffect/issues/14),
the common native/WASM Z3 execution layer closed [#17](https://github.com/mizchi/uneffect/issues/17),
reviewed external-registry configuration closed [#19](https://github.com/mizchi/uneffect/issues/19),
reviewed TypeScript traversal callback timing closed [#21](https://github.com/mizchi/uneffect/issues/21),
evidence-preserving external-verifier timeout recovery closed [#22](https://github.com/mizchi/uneffect/issues/22),
bounded Promise/exception/resource composition closed [#9](https://github.com/mizchi/uneffect/issues/9),
and exact project-boundary refinement provenance plus the first labeled Node
realm identity closed [#20](https://github.com/mizchi/uneffect/issues/20).
The bounded, source-keyed handler CFG handoff closed
[#23](https://github.com/mizchi/uneffect/issues/23); general value lattices and
recurrence widening continue in #25.
The TypeChecker-backed one-alias/one-helper region seed closed
[#26](https://github.com/mizchi/uneffect/issues/26); broader aliases remain #24.
The checker-backed inferred-`Console`/ordered-call handoff closed
[#27](https://github.com/mizchi/uneffect/issues/27); broader Corsa parity remains #8.
The one-integer, two-source-keyed-region value handoff closed
[#28](https://github.com/mizchi/uneffect/issues/28). The two-integer product
handoff closed [#29](https://github.com/mizchi/uneffect/issues/29). The
three-region composition handoff closed
[#30](https://github.com/mizchi/uneffect/issues/30). The first divergent product
join closed [#31](https://github.com/mizchi/uneffect/issues/31). The direct and
piecewise recurrence handoffs closed [#32](https://github.com/mizchi/uneffect/issues/32)
and [#33](https://github.com/mizchi/uneffect/issues/33). Handler/scalar
recurrence unification closed [#34](https://github.com/mizchi/uneffect/issues/34).
The two-diamond recurrence composition closed [#35](https://github.com/mizchi/uneffect/issues/35).
The finite-switch recurrence fan-out closed [#36](https://github.com/mizchi/uneffect/issues/36).
The common ordered join IR closed with #37, and the application-backed
recurrence children #38/#39/#40/#41 remain recorded in P2.23–P2.26 above.
The total finite-Map lookup and independently proved dynamic-key-domain slices
closed [#42](https://github.com/mizchi/uneffect/issues/42) and
[#43](https://github.com/mizchi/uneffect/issues/43). Per-key proof composition
for primary/backup selectors closed
[#44](https://github.com/mizchi/uneffect/issues/44); broader collection temporal
state remains parent #5. Joint membership preservation for the bounded failover
family closed
[#45](https://github.com/mizchi/uneffect/issues/45); general value lattices
remain parent #25. Three-shard integration coverage, versioned timing artifacts,
measured timeout calibration, and a real hard-deadline control closed
[#46](https://github.com/mizchi/uneffect/issues/46).

- [x] Emit `uneffect-refinement-action-analysis/v1` for one direct ranking-loop
  normal/typed-throw catch join, enforce a named CFG reachability worklist
  budget, retain payload/snapshot evidence only after exact affine action
  validation, and keep budget exhaustion plus an unaligned recurrence
  `unknown`. This is the #23 control-reachability seed; the general
  basic-block/value-lattice fixed point remains unchecked below.
- [x] Replace that seed's hard-coded reachability rounds with the reusable
  monotone `solveBasicBlockFixedPoint` engine and an abstract completion-value
  lattice that carries the normalized throw payload plus normal/catch snapshot
  identities and expression environments through the back-edge. Budget exhaustion and lattice conflicts
  fail closed. Numeric `TemporalExpression` environments still rely on the
  affine walker and remain part of #25.
- [x] Feed the direct try/catch predecessor `TemporalExpression` environments
  into that worklist, specialize them by the typed-throw condition, and create
  a condition-correlated phi environment in the join block before propagating
  it through the back-edge and exit. General recurrence iteration and arbitrary
  AST-to-basic-block lowering remain #25 work.
- [x] Carry the accepted affine loop's ranking counter, direction, one-iteration
  transformer, and closed-form summary as a recurrence certificate through the
  reusable worklist back-edge. Identical certificates stabilize; incompatible
  lattice values fail closed. The affine walker still constructs the summary,
  so independent summary validation and general recurrence widening remain #25.
- [x] Independently reparse and prove that certificate with Z3 base, inductive
  step, and well-founded ranking obligations. `analyzeRefinementActionBodiesWithZ3`
  downgrades a structural success to `unknown` on solver failure, while modified
  summaries and ranking metadata are refuted. Telemetry-drain dogfood consumes
  this stronger API; arbitrary CFG lowering remains #25.
- [x] Retain the lexical owner of a resource-free dynamic `for`, `for...of`,
  `for...in`, `while`, or `do...while` `continue` leaving a modeled catch.
  Unified Quint lowering preserves rejection routing and represents unknown
  cardinality by nondeterministic repeat-or-exit actions. Loops containing
  `using`/`await using`, unresolved labels, and resource-generation joins remain
  unsupported rather than inheriting this abstraction.
- [x] Emit a `handler-join-fixed-point` obligation for the application-backed
  direct `switch`/`catch`/mandatory-`finally` routing shape. The shared worklist
  retains normal/return/throw completion reachability, catch consumption, and
  block states under `cfg-fixed-point-iterations`; exhaustion is `unknown` and
  a rethrow remains an outgoing throw instead of being normalized to normal.
  Nested/general AST-to-basic-block lowering remains #25.
- [x] Replace the handler completion classifier with reusable AST-to-basic-block
  construction for nested `if` and finite exhaustive `switch` statements in one
  application-backed try/catch family. The graph retains source-keyed branch,
  statement, and abrupt-completion blocks; optional normal finally is supported.
  Attempted-family loops, incomplete switches, labeled transfers, nested try,
  and abrupt finally remain explicit `unsupported-control-flow` non-proofs.
- [x] Extend that builder across supported prefix/suffix statements around one
  top-level control root. Application-backed `returnOrRejectTelemetry` retains
  return/throw at the try completion and normal/return after catch/finally;
  return has no edge into the following throw suffix. Multiple sibling control
  roots remain an explicit unsupported candidate. The wider scan honestly
  exposes `rejectTelemetry` as control-converged but value-validation-unknown.
- [x] Restrict nested conditional values by an exact caught-path predicate at
  the catch join. `rejectTelemetry` now simplifies the duplicated `auditArmed`
  branch and verifies; changing the catch condition prevents both simplification
  and `pathCorrelation` evidence. The strict artifact records the predicate and
  `same-predicate-branch-restriction` rule. This is syntactic path evidence, not
  solver-derived logical equivalence.
- [x] Lower catch-less application `try`/`finally` with abrupt finalizer paths.
  `finalizeTelemetryRecovery` records normal/return/throw exit reachability and
  ordered `finallyOverrides: [return, throw]`; removing return changes both the
  override set and action result to a non-proof. Handler-local loops and other
  unsupported finalizer statements remain `unsupported-control-flow`.
- [x] Replace the canonical ranking-loop seed's private handler graph with the
  shared source-keyed handler blocks. The value lattice traverses if/throw,
  catch, join, finally, exit, and the loop back edge before retaining the affine
  recurrence and independent Z3 proof. The more detailed graph converges in 42
  evaluations, so the documented default budget is now 64; exhaustion remains
  an explicit non-proof.
- [x] Admit exactly two top-level sibling `if` roots in one try/finally region.
  The strict artifact records every source span plus
  `handler-control-roots: { limit: 2, observed }`; three roots and mixed
  `if`/`switch` siblings remain `unsupported-control-flow`, and fixed-point
  budget exhaustion remains a separate non-proof.
- [x] Unroll one handler-local `for...of` over one to four direct numeric or
  Boolean literal elements. Iteration-keyed source blocks and
  `handler-loop-iterations: { limit: 4, observed }` evidence retain normal and
  throw routing. Dynamic/empty/over-budget iterables, loop transfers, nested or
  catch/finally loops, and `using`/`await using` remain explicit non-proofs.
- [x] Compose one depth-two nested try/catch region through the shared CFG and
  emit `handler-nesting-depth: { limit: 2, observed }`. Inner catch rethrow
  reaches the outer catch; depth three, inner finally, return/break/continue,
  loops, resources, and catch/finally-local nested handlers remain non-proofs.
- [x] Replace singleton nested handler block names with source-start-keyed region
  IDs and initially compose two sibling inner try/catch regions. #30 later
  widened this same topology to three; depth three, inner finally, abrupt
  transfer, loop, resource, or catch/finally placement remains a non-proof.
- [x] Carry one integer environment through two source-keyed sibling regions,
  require an independent Z3 equivalence check, and retain intervening writes,
  budget exhaustion, solver failure, and action mismatch as non-proofs. (#28)
- [x] Represent one or two independently changed integers with the same ordered
  `members[]` product contract and require every member check before verifying
  the product. A third changed integer remains unsupported. (#29)
- [x] Widen only the sibling nested-try topology to three source-keyed regions,
  retaining the existing two-root budget for other handler shapes. A fourth
  region, member conflict, budget exhaustion, and wrong member fail closed. (#30)
- [x] Join a one- or two-member scalar environment from one direct `if/else`
  pair of source-keyed handler predecessors before a common successor. Record
  `predicate-correlated-phi` evidence; predicate loss, entry drift, inter-join
  mutation, budget exhaustion, and solver failure fail closed. (#31)
- [x] Infer one direct one- or two-member affine `while` recurrence at a
  source-keyed CFG back edge. Structural convergence remains provisional;
  independent Z3 base/step/ranking checks are required, and coupled,
  self-amplifying, path-dependent, budget, and solver controls fail closed. (#32)

An item is complete only when its code, regression tests, and relevant English
documentation are all updated.

- [x] Replace `extractions/setup-just` with the official Linux musl release asset pinned by version and SHA-256, removing its transitive Node 20 `setup-crate` action.
- [x] Upgrade the SHA-pinned `pnpm/action-setup` workflow dependency to Node 24-native v6.0.9 and retain `actions/setup-node` pnpm-store caching.
- [x] Isolate every solver-bearing test file in its own Vitest process so a Z3 WASM heap failure cannot poison later suites in the same CI tier.
- [x] Enforce a parent-process deadline for explicitly isolated solver tests so synchronous Z3 WASM cannot block Vitest's in-process timeout indefinitely, with only bounded whole-process retries.
- [x] Retry only classified child Quint process `ETIMEDOUT` failures at file granularity, retain every command/output/attempt in `verifier-retry-evidence/v1`, and upload it from every verifier CI tier. ([#22](https://github.com/mizchi/uneffect/issues/22))
- [x] Route `just dogfood` through the manifest-validated isolated tier runner, including validated single-file tier selection, so a Z3 WASM failure cannot poison the remaining dogfood cases.
- [x] Explain diagnostics instead of reporting solver verdicts: replay contract counterexamples over the invariant IR, trace effects to the operation that produces them, and locate unsupported constructs where they appear.
- [x] Commit a `fixtures/` corpus that pairs each input with its generated `.diag` report, and score every diagnostic against a committed quality rubric that CI holds at its current level.
- [x] Publish one `uneffect` binary with subcommands, strict option parsing, `--help`/`--version`, and documented streams and exit codes, replacing the four ad-hoc CLI entry points.
- [x] Check the toolchain before a run with `uneffect doctor`: Node, the peer TypeScript, `@types/node`, the selected native/WASM Z3 backend, and the optional Quint and Java runners, each naming what it blocks and how to satisfy it.
- [x] Add an `auto | native | wasm` SMT-LIB execution layer for Hoare contracts and ownership evidence: prefer optional native Z3, fall back only on classified infrastructure failure, never reinterpret semantic verdicts, and preserve attempts in evidence.
- [x] Complete migration of solver clients from direct WASM model objects to the common native/WASM execution layer. ([#17](https://github.com/mizchi/uneffect/issues/17))
  - [x] Migrate temporal semantic lint, bounded reachability, and structured scalar/Set/Map/record counterexample replay through named `get-value` observations; report backend failures instead of silently omitting lint findings.
  - [x] Migrate solver-backed property generation without losing model enumeration and shrinking.
  - [x] Migrate typed-array verification without losing structured obligation witnesses.
- [x] Restore the zero-unknown self-dogfood gate with reviewed, TypeChecker-identified synchronous callback contracts for the TypeScript compiler traversal APIs used internally; same-spelled user APIs remain unknown. ([#21](https://github.com/mizchi/uneffect/issues/21))
- [x] Eliminate an unreachable `catch` edge when the supported refinement fragment proves the `try` body has no throw completion, while keeping unknown/effectful try edges fail-closed. ([#3](https://github.com/mizchi/uneffect/issues/3))
- [x] Infer the member path a mutation writes, so `Mutate` names the property rather than only its container, and report a sibling-property declaration as an authority mismatch instead of a bare undeclared effect.
- [x] Add the initial opt-in React function component semantics: replayable render, inline JSX events, layout/passive Effect setup, cleanup phases, selected render purity checks, conditional built-in Hook checks, and capability-level acquire/release matching.
- [x] Resolve immutable component-local function/arrow callbacks and transitive `const` aliases used by JSX event attributes, while diagnosing reassigned or otherwise opaque handlers.
- [x] Resolve write-screened module-local functions and transitive `const` aliases used by JSX events and callback refs, preserving event/ref effects, cleanup/resource identity, and replay while rejecting reassigned/member/imported/dynamic references.
- [x] Resolve write-screened JSX event and callback-ref functions through TypeScript named aliases, barrels, default imports, and namespace imports, using the declaration module's effect and acquire/release contracts while preserving mutable/dynamic references as explicit unknowns.
- [x] Treat inline actions passed to named/default/namespace `startTransition` and the setter returned by `useTransition` as immediately executed in the enclosing React phase, so nested capabilities are not lost.
- [x] Resolve immutable component/custom-Hook-local transition actions through transitive `const` aliases and diagnose unresolved actions instead of dropping their capabilities.
- [x] Resolve write-screened Transition Actions through TypeScript named/barrel/default/namespace imports and analyze nested calls in the declaration module's effect environment; keep reassigned and dynamic imports fail-closed.
- [x] Diagnose `useState`/`useReducer`/`useOptimistic` updates after `await` in the supported JSX-event Transition fragment unless they re-enter `startTransition`, and generate a bounded Quint model for pending Actions, interruptible render, retry, and final commit.
- [x] Model aliased `useInsertionEffect` setup/cleanup as a commit phase before refs, layout, and passive Effects; reject direct or transitively aliased local state dispatchers in its callback and preserve the order in Quint.
- [x] Resolve local `useEffectEvent` callbacks and transitive `const` aliases into insertion/layout/passive setup and cleanup effects; reject render/JSX-event/transition calls and dependency-array entries.
- [x] Split `useSyncExternalStore` into client/server snapshot and commit subscription phases, resolve inline/module/local callbacks, carry subscription resource cleanup into replay/Quint, and reject opaque or obviously uncached snapshots.
- [x] Split named/default/namespace `useImperativeHandle` factories from externally invoked handle methods, compose both through custom Hooks, check dependencies and Hook order, and project factory lifecycles into replay/Quint.
- [x] Recognize comment-opted direct React `memo`/`forwardRef` component wrapper chains, preserve the wrapper variable identity, separate memo comparator work, and fail closed on effectful/opaque comparators or unsupported wrapper shapes.
- [x] Resolve source-local immutable function/arrow component arguments and transitive `const` aliases through direct React `memo`/`forwardRef` chains, preserving the annotated wrapper identity across Program imports and Suspense edges while rejecting mutable/imported/dynamic arguments.
- [x] Resolve module-local function-declaration component arguments and transitive `const` aliases when a conservative source write screen finds no reassignment, while failing closed on writes and shadowing uncertainty.
- [x] Cache the complete React fixed-point analysis by immutable TypeScript `Program` snapshot and expose the result as a `ReadonlyMap`, so repeated consumers do not recompute symbol, Hook, Suspense, and thenable facts.
- [x] Separate React 19 `useActionState` Actions from pure `useOptimistic` reducers, accept action/formAction dispatchers, reject opaque callbacks and effectful optimistic reducers, and require both returned dispatchers to run in an Action context.
- [x] Generate a bounded Quint model for one `useActionState` dispatcher queue, proving sequential reducer execution, pending-state consistency, and cancellation of queued tail work after a thrown Action with load-bearing fault injections.
- [x] Track direct typed throws in `useActionState` reducers and compose queue cancellation, Hook rethrow, and an explicitly selected nearest Error Boundary fallback in a load-bearing Quint model.
- [x] Compose an already-revealed extracted Suspense boundary with a bounded Transition, preserving stale content across suspension/interruption until resolution, retry, and final commit with load-bearing visibility faults.
- [x] Model fallback-eligible newly mounted Transition boundaries and urgent Suspense updates separately, requiring suspension before fallback and resolution before content commit with load-bearing faults.
- [x] Compose explicitly annotated custom Hooks through source-local calls and TypeScript-resolved named import aliases, fail closed on unresolved/directly recursive Hook calls, and compute the Program summary fixed point once per check.
- [x] Add opt-in React resource-result/cleanup-parameter identity contracts, exact-once local alias checks, and explicit production/development-Strict-Mode replay projections.
- [x] Check inline Effect/memo/callback dependency arrays against lexically captured owner bindings, including shadowing, member coverage, common stable React bindings, and fail-closed opaque/dynamic evidence.
- [x] Resolve immutable component/custom-Hook-local Effect and render callbacks through transitive `const` aliases for dependency completeness, phase effects, cleanup/resource identity, insertion safety, and replay; keep source-only imported and mutable/member/dynamic callbacks fail-closed.
- [x] Resolve write-screened Effect and reviewed render-Hook callbacks through TypeScript named aliases, barrels, default imports, and namespace imports, preserving definition-module effects, cleanup/resource identity, custom-Hook composition, render-purity diagnostics, and replay.
- [x] Apply the same definition-module callback environment to imported `useActionState`, `useOptimistic`, `useImperativeHandle`, `useSyncExternalStore`, and `memo` comparator callbacks, preserving typed throws, purity diagnostics, exposed methods, snapshots, and subscription lifecycle contracts.
- [x] Resolve write-screened JSX `action`/`formAction` callbacks through named/barrel/default/namespace imports and analyze them with definition-module effects and helper calls; keep React-returned dispatchers as opaque framework-owned Actions.
- [x] Preserve SourceFile-scoped callback import environments across transitive Program calls, so imported Transition Actions, JSX handlers, Effects, and specialized Hook callbacks use each definition module's contracts instead of colliding caller bindings.
- [x] Resolve direct custom-Hook call sites through TypeScript symbols across named aliases, barrels, namespaces, and default imports, and reject local/cross-module indirect recursion cycles.
- [x] Track destructured props, `useState`/`useReducer` snapshots, `useContext` values, and transitive local `const` aliases as immutable render regions, including assignment, update, and delete writes.
- [x] Reject direct `useRef` `.current` access during replayable render, and project inline callback refs as commit setup/returned-cleanup phases with resource matching and development Strict Mode replay.
- [x] Admit the predictable lazy-ref initialization exception for a null-initialized direct/aliased ref under one strict null guard and one same-ref assignment from the supported stable-expression fragment; keep factories, constructors, branches, and unguarded access diagnostic.
- [x] Resolve immutable component-local callback refs and transitive `const` aliases into the same identity-checked setup/cleanup lifecycle, while keeping source-only imported, prop, reassigned, member, and dynamic ref callbacks fail-closed.
- [x] Preserve individual Effect/callback-ref lifecycle instances, including repeated and transitive cross-module custom-Hook call paths, so replay entries associate each setup with its own cleanup effects.
- [x] Generate reviewable production/development-Strict-Mode Quint lifecycle models with per-instance setup/cleanup counters and a load-bearing early-cleanup invariant.
- [x] Distinguish committed and discarded render attempts, model one bounded concurrent interruption, and reject commit-side Effect/ref setup derived only from discarded work.
- [x] Associate lifecycle transitions with commit generations, model dependency-change cleanup/setup ownership, and reject setup attributed to an uncommitted generation.
- [x] Model one bounded Suspense suspension-resolution-retry trace and reject retry commits that precede resolution.
- [x] Model a bounded retry that suspends again and reject each retry before its immediately preceding suspension resolves.
- [x] Compose explicitly selected primary/fallback component summaries into a bounded Suspense fallback-commit, cleanup, and reveal model.
- [x] Extract direct named/aliased React Suspense primary/fallback edges from JSX, report unsupported shapes, and generate their boundary models.
- [x] Resolve direct Suspense primary/fallback components through TypeScript symbols across named aliases, barrels, and default exports.
- [x] Resolve React namespace Suspense tags and namespace-qualified primary/fallback component tags in Program analysis.
- [x] Extract direct nested Suspense chains, preserve parent/child boundary identity through Program symbol resolution, and generate a bounded nearest-boundary ownership model.
- [x] Flatten transparent JSX/React Fragments and multiple direct component/boundary children into a Program-resolved Suspense tree, with one-suspension fallback ownership checked by Quint.
- [x] Track named/default/namespace React `use(thenable)` through direct and cross-file custom-Hook calls, promote only TypeChecker-proven callable-`then` inputs, and optionally restrict Suspense-tree traces to causally supported leaves.
- [x] Track values thrown during opted-in component/custom-Hook render, classify callable-`then` values separately from ordinary errors with Program types, and use proven thrown thenables as Suspense-tree causes.
- [x] Unroll bounded numeric/boolean literal `for...of` loops into the exception-aware refinement completion flow, including early return and mandatory `finally`, and fix classic bounded `for` loops to preserve abrupt completion.

The product-level completion gates are the skipped executable scenarios in
`test/acceptance-roadmap.test.ts`. Before adding another narrow feature, select
the first relevant scenario, remove `.skip`, observe Red, and implement toward
that end-to-end result. See `docs/acceptance-roadmap.md`.

## Historical ledger section 0 — Specification foundations

- [x] Accept only the `uneffect:` block-comment marker.
- [x] Parse source annotations into capability, invariant, and temporal projections.
- [x] Reserve `effect none` and `module_effect none` as explicit empty upper bounds, distinguish checked function purity from an inferred empty inventory, reject mixed function/module/iterator sets as structured diagnostics, and preserve the empty set through TypeScript and Rust/Corsa projections.
- [x] Generate reviewable SMT-LIB for simple postcondition obligations and execute it with Z3.
- [x] Generate reviewable Quint safety models and execute them with the Quint simulator.
- [x] Replace string capabilities with one structured effect AST shared conceptually by TypeScript and Rust.
  - [x] Replace the Fetch-shaped Rust `ScopedEffect { operations, scopes }` with generic `Capability { name, arguments }`.
  - [x] Represent every Rust argument as `All | Finite<Atom> | Unknown` and reuse common subset code.
  - [x] Resolve argument containment through a versioned effect schema rather than effect-name conditionals in the lattice.
  - [x] Parse qualified parameterized user-defined effect names in the Rust core.
  - [x] Parse parameterized effects without splitting nested unions or quoted scopes in the Rust core.
  - [x] Preserve annotation and effect source spans in the TypeScript specification IR for diagnostics.
  - [x] Carry source spans through the Rust/Corsa parsing boundary and located effect set.
- [x] Implement the restricted scope-pattern language.
  - [x] Support exact URL paths, `*` within one path segment, and `**` across path segments in the Rust core.
  - [x] Reject wildcard schemes and hosts for URL authorities.
  - [x] Implement conservative pattern-language inclusion for the initial URL subset.
  - [x] Add positive and negative containment witnesses.
  - [x] Share the same structured representation with the TypeScript prototype.
  - [x] Complete WHATWG URL normalization and exact-or-unconstrained query semantics in the TypeScript prototype.
  - [x] Bring Rust URL normalization and query semantics to parity with the TypeScript frontend.
- [x] Emit parse errors for malformed or unsupported Uneffect directives instead of silently ignoring them.
  - [x] Apply directive-name and payload validation to the normal Effect/check path, emit structured `effect/invalid` diagnostics, and downgrade every function/module summary in the invalid source to `unknown`.
- [x] Split temporal action assignments with an expression-aware comma scanner so comparison operators are not misread as generic type delimiters.

## Historical ledger section 1 — Capability effects

- [x] Align operating-system capabilities with the Deno permission model.
  - [x] Use the common capability-set representation for every Deno category; only atom normalization and containment differ.
  - [x] Define the initial `FsRead<PathSet>` and `FsWrite<PathSet>` symbolic path containment in the Rust core.
  - [x] Parse reserved symbolic path anchors: `$WORKSPACE_ROOT`, `$PACKAGE_ROOT`, `$SOURCE_DIR`, `$CWD`, and `$TEMP`.
  - [x] Resolve `$TEMP` from the selected Node/Deno target profile instead of assuming the analyzer host's temp directory.
  - [x] Require explicit anchor bindings and include resolved bindings in permission artifact hashes.
  - [x] Reject arbitrary `$ENV_VAR` expansion in path atoms.
  - [x] Normalize separators, dot segments, platform case policy, and anchor-relative containment before comparison.
    - [x] Normalize separators/dot segments and reject traversal in the TypeScript parser and projection.
    - [x] Add target case policy and cross-anchor containment to both lattices.
  - [x] Define `Net<HostSet>`, including host, optional port, IP literals, and Deno-compatible subdomain wildcards.
  - [x] Define `Env<NameSet>` with Deno-compatible suffix wildcards and platform-aware case policy.
    - [x] Implement exact and final-`*` matching.
    - [x] Apply target-aware Windows case folding.
    - [x] Infer TypeChecker-resolved `process.env.NAME` and literal/finite-union element access as scoped `Env`, degrade dynamic keys/direct aggregate access to broad `Env`, cover writes/deletes without a redundant `Mutate`, and dogfood service configuration loading.
  - [x] Define `Run<ProgramSet>`, including the unscoped escalation case for dynamic-loader environment variables.
  - [x] Define `Sys<ApiSet>` from Deno's system-information descriptor names.
    - [x] Map TypeChecker-resolved `node:os` host-information calls to the equivalent finite Deno `Sys` descriptors, reject same-named local functions, and dogfood runtime diagnostic metadata.
  - [x] Define `Ffi<PathSet>` and treat it as a sandbox escape boundary.
  - [x] Define `Import<HostSet>` separately from runtime `Net` access.
  - [x] Represent unscoped category access without inventing a wildcard string.
  - [x] Keep allow/deny precedence in deployment policy, not in function effect unions.
  - [x] Generate a Deno-compatible permission manifest/CLI projection from verified requirements.
- [x] Introduce a versioned builtin contract IR with stable symbol keys.
  - [x] Add the initial typed builtin overlay entry for `node:os.tmpdir() -> Path<"$TEMP">`.
  - [x] Teach the TypeChecker frontend adapter to apply builtin return refinements at call sites.
- [x] Add a registry for builtin and user-defined effect schemas.
- [x] Add `GlobalVarsRead<KeySet>` and `GlobalVarsWrite<KeySet>` with implicit same-realm identity, TypeChecker-resolved `globalThis`/reviewed host-global/immutable local aliases, finite literal-key containment, assignment/update modes, and dynamic-key fail-closed behavior; do not equate declaration merging, module globals, iframe globals, or same-spelled local objects without evidence. ([#8](https://github.com/mizchi/uneffect/issues/8))
- [x] Scope `CookieRead`/`CookieWrite` and `LocalStorageRead`/`LocalStorageWrite` over the shared finite literal-set lattice; infer literal cookie write names and literal/finite-union Web Storage keys, retain aggregate operations as `All`, and fail closed on dynamic keys. Cookie path/domain and storage origin/area identity remain outside this fragment. ([#14](https://github.com/mizchi/uneffect/issues/14))
- [x] Map TypeChecker-resolved `Navigator.sendBeacon` to the shared `Net<HostSet>` lattice and retain separate exact/unknown `beacon` transport provenance; reject same-named user methods. ([#14](https://github.com/mizchi/uneffect/issues/14))
- [x] Add a catalog-driven `NewExpression` semantic path and use it for TypeChecker-resolved global `WebSocket`, projecting `ws:`/`wss:` endpoints to `Net<HostSet>` and distinct exact/unknown transport provenance while rejecting same-named constructors. Event/message/reconnect lifecycle remains separate. ([#14](https://github.com/mizchi/uneffect/issues/14))
- [x] Add a generic catalog `use` resource primitive, teach the resource collector to consume constructor events, and model WebSocket construction/send/close as acquire/use/release through immutable aliases; report send-after-close as an invalid trusted transition. Keep this explicit CFG fragment distinct from unimplemented external-completion and event-loop lifecycle semantics. ([#14](https://github.com/mizchi/uneffect/issues/14))
- [x] Move Web `EventTarget#addEventListener` callback ownership to the builtin catalog, resolve subtype overload redeclarations by TypeChecker owner assignability without accepting user lookalikes, and lower repeatable external completion plus event-task execution and nested microtask checkpoints into executable Web Quint with optional fairness. Statically visible `{ once: true }` is one-shot, literal `signal` options compose with abort/timeout/any cancellation, and direct same-function removal matches target/type/callback/capture identity through immutable aliases. Cross-function/dynamic removal, dynamic options, and WebSocket-specific event ordering remain open. ([#10](https://github.com/mizchi/uneffect/issues/10))
- [x] Diagnose unknown effect names; warning in gradual mode and error in strict mode.
- [x] Implement Fetch as the first scoped-effect vertical slice.
  - [x] Infer `GET` for a missing method.
  - [x] Infer literal methods and exact literal URLs.
  - [x] Infer restricted segment patterns from numerically constrained template literals.
  - [x] Degrade dynamic methods or URLs to explicit unknown scopes.
  - [x] Normalize URL authorities before inclusion checks in the TypeScript vertical slice.
  - [x] Emit the underlying Deno-compatible `Net<host[:port]>` requirement independently of HTTP method/path authority.
- [x] Move builtin recognition from source-text matching to Corsa/TypeChecker symbol identity.
  - [x] Resolve registered builtin call sites by TypeChecker symbol identity, including aliases and namespaces.
  - [x] Route all effect inference builtins through the symbol adapter and remove the legacy source-text recognizer.
- [x] Add the first structured scoped-effect parser and lattice implementation to the Rust hot path.

## Historical ledger section 1.5 — Custom validator specialization

- [x] Implement the custom-validator acceptance tests before adding narrower cardinality features.
  - [x] Register a validator by stable name, version, and symbol-identity sink matcher.
  - [x] Add the `0 | 1 | many | unknown` call-cardinality lattice with intraprocedural branch, sequence, loop, concurrent-argument, recursion, and unknown-callback handling.
  - [x] Compose cardinality through resolved local callees.
  - [x] Compose cardinality through aliases, re-exports, methods, and cross-module callees.
  - [x] Attach proof-grade specializations only after validator success; unresolved relative callees, recursion, and opaque callbacks remain `unknown` rather than becoming zero.
  - [x] Compose Generator and AsyncGenerator effects through `yield`, `yield*`, and iterator consumption count for resolved local functions.
  - [x] Validate an explicit application entrypoint so per-invocation bounds are not confused with process-wide uniqueness.

## Historical ledger section 2 — DOM semantic overlay

- [x] Split DOM operations into `AttributeRead`/`AttributeWrite`, `NodeRead`/`NodeWrite`, `TextRead`/`TextWrite`, `PropertyRead`/`PropertyWrite`, `LayoutRead`, `Create`, `Listen`, `Dispatch`, and `Parse`; selected call overlays and reviewed attribute collection, tree topology, text, and `HTMLInputElement.value` property access are executable, while broader Web IDL coverage remains [#14](https://github.com/mizchi/uneffect/issues/14).
- [x] Use receiver identity regions as proof-grade DOM scopes.
- [x] Record CSS selectors as query refinements, not authority boundaries.
- [x] Model compound contracts for tree ownership changes.
- [x] Mark event dispatch, custom-element reactions, getters, proxies, and coercions as possible user-code invocation.
- [x] Fingerprint the consumed `lib.dom.d.ts` and report unclassified API drift.

## Historical ledger section 3 — Invariants and Z3

- [x] Lint syntactically constant temporal invariants and actions consisting only of self-assignments.
- [x] Detect solver-level tautologies, inconsistent initial states, unreachable actions, vacuous invariants, duplicate/subsumed properties, and invariants preserved only because no progress is possible.
  - [x] Detect solver-level tautologies and contradictions over all typed states.
  - [x] Detect jointly inconsistent initial constraints.
  - [x] Detect action guards that are unsatisfiable over all typed states.
  - [x] Detect exact duplicates and properties implied by an earlier property.
  - [x] Detect actions unreachable from the transition system's initial states within explicit bounded, finite-state-complete, inductive, or proven-strengthening proof modes; retain general infinite-state cases as explicitly bounded/inconclusive results.
    - [x] Report depth-labelled bounded unreachability by unrolling init and complete stuttering transitions in Z3.
    - [x] Upgrade bounded-unreachable actions to an unbounded result when `!guard` is established at init and preserved by one-step induction across every transition.
    - [x] Accept explicitly selected temporal properties as strengthening invariants, but only after Z3 proves initialization and one-step preservation; combine multiple proven properties when required.
    - [x] Promote unreachable actions after a complete `state-count - 1` exploration bound for finite boolean/record/Set/Map state products.
    - [x] Opt in to automatic discovery among declared temporal properties, retaining only candidates whose initialization and preservation obligations Z3 proves.
    - [x] Opt in to synthesized integer-sign and boolean-polarity templates, admitting only candidates whose induction obligations pass.
    - [x] Opt in separately to pairwise integer equality/order templates so quadratic relational candidate growth is explicit.
    - [x] Derive coefficient-1 affine offset templates from pairs of constant integer initializers.
    - [x] Derive reduced small-coefficient `(2,1)` and `(1,2)` affine equality/order templates from constant initializers.
    - [x] Generalize reduced pairwise affine coefficients behind an explicit maximum coefficient (default two, hard limit eight).
    - [x] Synthesize pairwise affine sum conservation so oppositely moving counters can retain a fixed budget.
    - [x] Derive coefficient-1 three-variable conservation equalities from constant initializers.
    - [x] Generalize coefficient-1 conservation equalities to an explicitly bounded arity (maximum six) and cap generated conservation candidates.
    - [x] Generalize bounded conservation partitions to reduced positive integer coefficient vectors, sharing the explicit coefficient and candidate limits.
    - [x] Synthesize bounded multi-variable fixed-budget sums, including weighted sums, from constant initializers.
    - [x] Seed relational candidates from bounded arithmetic disequalities in action guards and validate synthesized candidates lazily until an obligation is discharged.
    - [x] Prioritize equality boundaries and comparison complements from strict arithmetic action guards within the shared conservation-candidate budget.
    - [x] Opt in separately to equality templates for same-shaped Set, Map, and record state pairs.
    - [x] Synthesize directional subset invariants for same-element finite `Set` state pairs and admit only inductively proven directions.
    - [x] Discover same-element `Set` equality/subset candidates recursively through record field paths.
    - [x] Treat finite `Map.keys()` domains, including record-nested maps, as derived Set views for directional subset synthesis.
    - [x] Treat scalar finite `Map.values()` domains as derived Set views without generalizing unsupported composite values.
    - [ ] Synthesize general affine/polyhedral, quantified, and richer field-correlated collection invariants. ([#2](https://github.com/mizchi/uneffect/issues/2))
      - [x] Validate that refinement manifests cover every temporal action and invariant without stale model names.
      - [x] Prove direct scalar action assignments, increments, stuttering, and one-level literal-specialized local class methods against temporal assignments.
      - [x] Compose repeated and cross-field scalar writes in TypeScript execution order before comparing them with simultaneous temporal updates.
      - [x] Preserve immutable action-local scalar snapshots so temporary-variable swaps refine simultaneous model updates; keep mutable locals unsupported.
      - [x] Add typed conditional expressions to the temporal IR with runtime, Quint, replay, and Z3 `ite` lowering, then merge scalar `if`/`else` action branches symbolically.
      - [x] Compose scalar `switch` entry, fallthrough, unlabeled `break`, and `default` paths into conditional temporal updates; reject dynamic labels, duplicate labels, labeled breaks, and other unsupported abrupt flow.
      - [x] Sequence mandatory `finally` updates after a normally completing action `try` block; reject catches and return/throw/break completion until the exception-aware completion lattice is implemented.
      - [x] Join a direct branch-local `return` with the continuing `if` path, applying trailing statements only to paths that continue and preserving updates made before the branch; the initial slice covered void returns and later generalized to supported pure value expressions.
      - [x] Route a direct primitive `throw` through a catch body and then an optional mandatory `finally`; ignore its unreachable lexical suffix while rejecting effectful throw expressions and unsupported catch-value-dependent flow.
      - [x] Split a top-level conditional primitive `throw` into exceptional and normal try paths, apply catch only to the exceptional path, join their symbolic state, and then sequence `finally` and trailing statements.
      - [x] Unwind a direct or top-level conditional void `return` through `finally`, applying post-try statements only to the normally continuing path before the symbolic join.
      - [x] Let a direct terminal void `return` in `finally` override a normally completed or already joined try/catch path and suppress all post-try statements.
      - [x] Separate symbolic state from an explicit action completion lattice and propagate nested branch returns through enclosing conditional joins.
      - [x] Generalize the same completion lattice to homogeneous `throw` paths, propagate nested throw predicates through conditionals, and execute catch only on the exceptional state before `finally`.
      - [x] Preserve distinct `returnWhen` and `throwWhen` predicates in heterogeneous joins, discharge only `throwWhen` through catch, and retain return completion across common `finally` at a terminal try boundary.
      - [x] Apply post-try statements only to the normally continuing path after catch discharges a heterogeneous throw completion, preserving the return path across the join.
      - [x] Compose catch-local conditional void returns and primitive rethrows with prior try completion, common finally, and normal-only post-try continuation.
      - [x] Give conditional void return and primitive throw completions originating in `finally` precedence over retained try/catch completion, while preserving prior completion where finally is normal.
      - [x] Compose direct switch-case returns and primitive throws through the action completion lattice, enclosing catch/finally, and normal-only continuation.
      - [x] Accept value-bearing returns whose non-call expression normalizes in the pure refinement-expression fragment across branches, switch, try/catch/finally, and finally override; validate the expression but do not claim return-result refinement, and reject effectful or unresolved calls fail-closed.
      - [x] Accept state-backed and otherwise normalizable pure `throw` expressions through the same completion lattice; the initial slice discarded payloads and kept effectful expressions fail-closed.
      - [x] Retain scalar `int`/`bool` throw payloads, including normalized numeric/boolean literals, across direct and conditional `if` completion joins and bind them as immutable catch locals; reject string/null/object payloads, effectful expressions, and unsupported joins when catch reads the value.
      - [x] Retain tracked scalar throw payloads across scalar `switch` case, fallthrough, and default selection, bind the selected value in `catch`, and reject any joined throw path whose payload is unavailable.
      - [x] Project scalar fields from a direct object-literal throw payload into immutable catch locals; reject string-valued, effectful, duplicate, computed, accessor, and otherwise unnormalized payload fields.
      - [x] Distribute catch-field reads across conditional joins of normalized object-literal throw payloads; a field missing from either branch remains unproved and is rejected by action equivalence.
      - [x] Unroll ascending literal-bound `for (let i = start; i < end; i++)` action loops up to 64 iterations; reject dynamic or oversized bounds.
      - [x] Compose acyclic direct calls to same-file action helpers over shared symbolic state with call-site scalar argument snapshots; reject recursion and nonlocal or dynamic calls.
      - [x] Compose void `return` and `return helper(runtime, ...)` in root action, same-file helper, and local method bodies; ignore unreachable lexical suffixes after unconditional completion.
      - [x] Stop action collection after an unconditional supported `return` or `throw`, preserving preceding updates and rejecting a model that depends on unreachable suffix writes.
      - [x] Lower a nested scalar member assignment, compound assignment, or increment into an immutable temporal record update and detect redirected writes.
      - [x] Merge sequential writes to distinct nested record members into one immutable update while preserving same-member data dependencies; compare record fields independent of source order.
      - [x] Normalize direct immutable TypeScript object-literal assignments with one leading state spread into temporal record updates; reject unresolved or later spreads.
      - [x] Lower type-matched native `Set.add` and `Map.set` calls, including record-nested collections, to immutable temporal `union(Set(...))` and `put(...)` updates.
      - [x] Lower type-matched native `Set.clear` and `Map.clear` calls to exact empty collection replacements without assuming a finite deletion universe.
      - [x] Lower native `Set.delete` to temporal set difference and `Map.delete` to typed key removal across runtime, replay, Quint, and Z3 backends.
      - [x] Add a TypeChecker-backed action-refinement path that accepts builtin `Set`/`Map` receiver identities through aliases and generic constraints while rejecting subclasses or same-shaped lookalikes.
      - [x] Resolve aliased imports and multi-hop direct action helpers by TypeChecker symbol identity in the Program-backed refinement path, with source-position recursion detection.
      - [x] Follow reassignment-free `const` function-value aliases to imported or local direct action helpers while rejecting mutable aliases.
      - [x] Resolve direct namespace-import helper calls when the selected property has a TypeChecker-resolved function declaration, without misclassifying builtin collection methods.
      - [x] Follow immutable aliases initialized from a namespace-import function property while rejecting the equivalent mutable alias.
      - [x] Prove exact scalar action guards through a leading negated early-return and reject missing, mismatched, or unexpected guards.
      - [x] Add an opt-in Z3 equivalence pass for normalized scalar action guards; retain real mismatches and solver `unknown` as diagnostics.
      - [x] Extend the opt-in Z3 equivalence pass to integer action updates, retaining syntax equality as the fast path and unsupported/non-equivalent expressions as diagnostics.
      - [x] Prove single-return scalar invariant functions against temporal safety-property expression ASTs.
      - [x] Add an opt-in Z3 equivalence pass for normalized scalar invariant predicates without weakening unsupported-body diagnostics.
      - [x] Normalize immutable local scalar constants and alias chains in invariant bindings without evaluating calls.
      - [x] Inline acyclic same-file single-return scalar invariant helper graphs with argument substitution; reject recursion and nonlocal calls.
      - [x] Resolve imported single-return invariant helpers and immutable function aliases through TypeChecker symbol identity in the Program-backed path; reject mutable aliases, ambiguity, and recursion.
      - [x] Resolve direct namespace-import invariant helper calls when the selected property has a TypeChecker-resolved function declaration.
      - [x] Prove supported create/observe adapters preserve every model state field by name, including transparent local-class construction and destructured observation.
      - [x] Inline acyclic same-file single-argument create/observe helper graphs while preserving the identity projection proof; reject recursion and nonlocal calls.
      - [x] Resolve imported create/observe wrappers and immutable function aliases through TypeChecker symbol identity in the Program-backed projection path; reject mutable aliases and recursion.
      - [x] Resolve direct namespace-import create/observe wrappers when the selected property resolves to a function declaration.
      - [x] Require Program-backed create/observe parameter and return types to match temporal scalar/nested-record state; reject `any`, `unknown`, optional/missing fields, and scalar-kind mismatches.
      - [x] Match temporal Set/Map state to exact builtin TypeScript collection symbols and compatible element/key/value types; accept transparent aliases while rejecting readonly variants, subclasses, and lookalikes.
      - [x] Canonicalize complete nested-record reconstruction at create/observe boundaries from temporal field types; reject missing, extra, or redirected nested fields.
      - [ ] Generalize refinement control flow from the currently proven TypeScript fragments to arbitrary adjacent implementation updates and temporal model actions; current dogfood verifies the supported fragments rather than the whole language. ([#25](https://github.com/mizchi/uneffect/issues/25))
        - [x] Track whole-runtime receiver updates and reads through lexical, non-escaping `const` alias chains; reject `let`, unknown escapes, cycles, member/destructuring aliases, and aliases outside their block.
        - [x] Specialize reviewed local runtime-class method calls through the same whole-runtime `const` alias chains while retaining mutable-alias and recursive-method rejection.
        - [x] Resolve imported runtime classes through Program TypeChecker symbol identity before specializing identifier-named methods; keep syntax-only imports and structural interface lookalikes unsupported.
        - [x] Reject local and Program-resolved method specialization when a known class declaration extends the runtime class; retain unscanned external subclasses and prototype mutation as explicit closed-world exclusions.
        - [x] Require exported runtime classes used for method specialization to declare `trust dispatch-sealing <reason>` and record that non-proof dependency with owner/expiration metadata in the cross-domain assumption ledger.
        - [x] Consume a statically named block's own `break` completion after mandatory `finally` work and before the outer continuation; reject labeled `continue`, cross/nested labels, and real returns in the labeled block.
        - [x] Compose bare lexical blocks into the action completion flow while keeping local constants and receiver aliases block-scoped.
        - [x] Reduce literal `while (false)` to zero iterations and `do...while (false)` to exactly one iteration; keep all dynamic `while` conditions unsupported rather than implying a loop fixed point.
        - [x] Unroll an adjacent `let i = start; while (i < end) { ...; i++ }` fragment up to 64 iterations through the existing exception-aware completion flow; reject dynamic bounds, non-unit steps, and other mutable-counter shapes.
        - [x] Preserve unlabeled `break` as a distinct conditional completion through bounded-loop branches and `try`/`finally`, consume it at the owning finite loop, and run the outer continuation exactly once.
        - [x] Preserve unlabeled `continue` through branches and `try`/`finally`, consume it at each advancement-guaranteed finite `for`/`for...of`/one-shot `do` iteration, and reject it in canonical `while` where it could bypass the modeled increment.
        - [x] Bind static finite-loop labels to target-aware `break`/`continue` completion maps, preserve outer-loop transfers through nested finite loops, branches, switch paths, and `try`/`finally`, and replace source-offset rewriting with capture-screened AST substitution so nested expansion remains source-safe.
        - [x] Summarize state-dependent `while (counter > L)`, `>= L`, `< U`, and `<= U` as directional symbolic affine fixed points for signed safe-integer bounds when the counter changes toward the bound by a positive safe-integer constant magnitude, every other state field has a safe-integer constant delta, and the body completes normally; derive exact overshoot with a backend-aligned nonnegative ceiling quotient and compose the closed form from symbolic state updates at loop entry.
        - [x] Extend the unit-countdown fixed point to state deltas that are affine in the loop-carried ranking counter, including triangular and scaled triangular totals; reject self-amplifying or other-state-coupled recurrences and retain update-order mismatches as negative controls.
        - [x] Compose one loop-invariant scalar conditional join whose two branches each have an affine ranking-counter delta; the initial slice rejected conditions mutated by the loop, counter-dependent conditions, nested piecewise joins, and non-affine branches.
        - [x] Generalize the same rule to a recursively nested decision tree capped at eight affine leaves; retain a nine-leaf rejection control so expression and solver growth cannot become implicit.
        - [x] Consume unlabeled `continue` in the symbolic affine loop only when the merged counter update still proves the ranking step on every path, including through mandatory `finally`; the initial slice rejected skipped steps and retained break/return/throw as unsupported abrupt exits.
        - [x] Split one loop-invariant early `break` from the repeating affine path, substituting supported entry-state updates into the condition and permitting up to eight independent non-counter affine break-side updates; the initial slice rejected counter/post-update breaks and continues to reject a ninth update, cross-state-coupled/non-affine updates, counter-dependent or mutated conditions, continue/break mixtures, and other abrupt exits.
        - [x] Join a caught scalar throw into that invariant break path and execute mandatory `finally` before consuming the break, permitting the ranking counter to advance once only when its delta exactly matches an ordinary iteration; reject different counter steps, rethrows, mutated conditions, and coupled catch updates.
        - [x] Join invariant catch-side `break` and `continue` policies when one mandatory `finally` proves the ordinary ranking delta on both outcomes; specialize true conjunctions into their invariant atoms while retaining false conjunctions, and reject skipped continue steps, dynamic/counter-dependent policies, rethrows, and coupled updates.
        - [x] Retain an aligned path-wise affine update tree for disjunctive invariant stop policies without selecting an arbitrary true disjunct; safely specialize a false disjunction on the repeating path, cap stopping trees at eight leaves, and reject cross-state/non-affine/different-counter/mutated-policy and ninth-leaf controls.
        - [x] Generalize invariant stop policies to nested aligned Boolean completion/update trees over at most 16 invariant atoms, specializing only propositionally entailed facts while retaining unresolved choices; keep dynamic/mutated policies, different ranking steps, model-misaligned updates, and over-budget trees as explicit non-proofs.
        - [x] Introduce a shared flow-value phi contract for state and initialized mutable scalar locals, and carry `=`, `+=`, and `-=` assignments through sequential normally completing `if` diamonds; reject uninitialized/`var`/`const` writes, opaque values, and throw/try/switch/loop/labeled local joins.
        - [x] Carry each `if` predecessor's mutable-local snapshot into its own continuation, allowing one arm to return without executing the suffix while the normal arm uses its path-specific local values; retain throw/try/switch/loop/labeled/standalone-block joins as non-proofs.
        - [x] Carry initialized mutable-scalar snapshots on supported typed scalar throw edges into `catch` while preserving the distinct normally completing `try` snapshot; join two conditional throwing snapshots with the shared phi contract and reject opaque payloads, catch-side local mutation, rethrow, and missing edge evidence.
        - [x] Join the outer-visible mutable-scalar snapshots owned by normal, direct-return, and supported typed throw/catch-return predecessors before mandatory `finally`, so its state updates observe the correct path value; retain finally-local mutation and missing edge evidence as non-proofs.
        - [x] Give each scalar `switch` entry/fallthrough path its own mutable-local environment, join normal continuation and return/throw edge snapshots by case selection (including unmatched default), and reject opaque discriminants, dynamic cases, nested-block mutation, and model-misaligned fallthrough.
        - [x] Carry initialized mutable-scalar snapshots from one bounded finite-loop iteration to the next and retain edge-owned `break`, `continue`, direct-return, and typed throw snapshots through mandatory `finally`; consume loop-owned transfers at the correct boundary and reject dynamic/over-budget loops, mutable-local labels, and model mismatches. Standalone nested blocks were added by the following slice.
        - [x] Project outer-visible mutable-scalar snapshots through ordinary standalone lexical blocks on normal and abrupt exits while keeping block-local constants scoped; reject shadowing, escaped block locals, catch/finally-side mutation, switch-case nested mutation, and label ambiguity.
        - [x] Carry outer-visible mutable-scalar snapshots through a statically owned labeled block and bounded `for`/literal-`for...of` owner label, consuming only that owner's `break`/`continue`; reject unknown targets, nested label capture, real returns in the block-label fragment, and dynamic or ambiguous ownership.
        - [x] Start a normally completing `catch` from the supported typed-throw snapshot, permit it to update outer-visible mutable scalars, and join its result with the normal `try` predecessor before the common continuation; reject catch mutation followed by return/rethrow or other abrupt completion and retain finally-side mutation as a non-proof.
        - [x] Replay a normally completing mandatory-`finally` mutable-scalar transformation over normal and every supported abrupt predecessor snapshot, attach the transformed maps to surviving completion edges, and reject local mutation combined with an abrupt/conditional finally override.
        - [x] Project a catch-side mutable-scalar update onto its direct-return edge and carry that snapshot through an enclosing mandatory `finally`; retain mutable-local rethrow, break/continue/label transfer, and conditional catch return as explicit non-proofs.
        - [x] Project a catch-side mutable-scalar update and normalized scalar payload onto a direct rethrow edge, carry both through mandatory `finally`, and bind them in an outer catch; reject conditional and opaque rethrows.
        - [x] Preserve distinct catch-side mutable-scalar snapshots for conditional direct return and normal catch completion, joining only the latter with the normal try predecessor before the suffix; reject conditional rethrow and catch-owned transfers.
        - [x] Preserve distinct catch-side mutable-scalar snapshots and a normalized payload for conditional rethrow versus normal catch completion, carrying the throw edge through mandatory `finally` into an outer catch; reject opaque payloads and catch-owned transfers.
        - [x] Project a conditional catch-owned `break` snapshot to outer-visible mutable scalars, carry it through mandatory `finally`, consume it at the owning bounded-loop boundary, and join it into the loop exit; retain unknown/cross label ownership as an explicit non-proof.
        - [x] Project a conditional catch-owned `continue` snapshot through mandatory `finally` into the next bounded iteration, skipping only the current suffix; accept the statically resolved owning-loop label and reject unknown/cross/nested label ownership.
        - [x] Replay a mutable-local mandatory `finally` over each predecessor while allowing its conditional direct return to override normal or supported abrupt completion; retain the finally-return snapshot for an outer `finally`, and reject finally-owned throw/break/continue/labels.
        - [x] Carry a conditional supported scalar throw and its mutable-local snapshot from mandatory `finally`, overriding prior normal/abrupt completion on the selected path and preserving the payload for an outer catch; reject opaque payloads and finally-owned break/continue/labels.
        - [x] Carry a conditional mutable-local `break` from mandatory `finally`, overriding prior normal/throw completion, consuming its snapshot at the owning bounded-loop boundary, and rejecting finally-owned continue/labels.
        - [x] Carry a conditional mutable-local `continue` from mandatory `finally`, overriding prior normal/throw completion and advancing the owning bounded loop from its snapshot; accept the statically resolved owner label and reject unknown/cross/nested label ownership.
        - [x] Extract a shared target-aware completion contract for refinement and Promise/resource flow; retain unresolved handler `break`/`continue` targets, diagnose them, and make unified async lowering fail closed instead of normalizing them to fallthrough.
        - [ ] Extend action-body refinement beyond bounded finite loops and documented affine summaries to general loop fixed points, arbitrary joins, and explicit proof-budget obligations. Multi-write sequencing, including distinct record members, is composed symbolically and scalar guard equivalence is solver-proven opt-in. ([#25](https://github.com/mizchi/uneffect/issues/25))
        - [ ] Extend action-body refinement from acyclic TypeChecker-resolved helpers to mutable/interprocedural aliases, higher-order values, computed/polymorphic methods, dynamic dispatch, and general abstraction relations. ([#24](https://github.com/mizchi/uneffect/issues/24))
        - [ ] Extend invariant-body refinement beyond normalized scalar predicates, immutable local constants, and acyclic TypeChecker-resolved pure helper graphs to collections, higher-order values, and dynamic dispatch. Logical equivalence within the normalized scalar fragment is now solver-proven opt-in. ([#24](https://github.com/mizchi/uneffect/issues/24))
          - [x] Preserve object-parameter substitutions across multiple imported helper layers without mistaking same-named parameters in distinct scopes for alias cycles.
          - [x] Normalize native `Set.has(value)` and `Set.size` predicates to temporal `contains` and `size`, while retaining mismatched members as refinement diagnostics.
          - [x] Normalize TypeChecker-identified builtin `Map.has(key)` to temporal `map.keys().contains(key)` and verify it in the collection-backed lease acceptance adapter.
          - [x] Support TypeChecker-identified builtin `Map.get(key)` only against a conjunctively membership-guarded temporal lookup, with Quint, runtime, replay, and Z3 lowering.
          - [x] Normalize TypeChecker-identified `Array.from(Set).every` subset predicates to temporal `Set.forall` with capture-safe callback binding.
          - [x] Extend the same quantified refinement to TypeChecker-identified builtin `Map.keys()` and `Map.values()` iterator views.
          - [x] Refine record-valued Map iterator field predicates and accept only expression callbacks or a block containing one direct return.
          - [x] Expand declaration-ordered immutable `const` aliases in quantified callback blocks while rejecting mutable locals and general statements.
          - [x] Normalize TypeChecker-identified `Array.from(Set|Map views).some` existential predicates and lower `exists` consistently to Quint, runtime assertions, and Z3.
          - [x] Preserve normalized invariant ASTs into Z3 mismatch discharge instead of reparsing runtime-oriented diagnostic strings.
          - [x] Normalize imported acyclic helpers that construct builtin `Set`/`Map` views matching a declared computed abstraction; require TypeChecker constructor identity and reject same-named lookalikes.
          - [x] Resolve immutable local/imported function-declaration predicate values passed to builtin array `every`/`some`, normalize their single-return bodies to collection quantifiers, and reject mutable aliases.
          - [x] Extend quantified predicate-value resolution to immutable exported/local arrow functions and function expressions through `const` alias chains, without widening action/helper dispatch resolution.
          - [x] Resolve function-valued predicate properties from a direct builtin `Object.freeze({...})` registry by TypeChecker identity; reject unfrozen registries and same-named `freeze` lookalikes.
          - [ ] Normalize collection-producing helpers, higher-order predicate values, and polymorphic/dynamic calls without assuming an implementation target. ([#24](https://github.com/mizchi/uneffect/issues/24))
        - [ ] Extend create/observe refinement beyond identity and complete nested-record projections plus acyclic TypeChecker-resolved wrappers to explicit abstraction relations, non-identity nested collection projections, and dynamic dispatch. ([#24](https://github.com/mizchi/uneffect/issues/24))
          - [x] Add versioned one-to-one top-level field abstraction relations and apply them consistently to create/observe types, action updates, invariant reads, manifests, and builtin Set dogfood.
          - [x] Extend one-to-one abstraction relations to non-overlapping dotted concrete property paths, including nested create reconstruction and Program-backed type traversal.
          - [x] Add a proof-directed `Set(arrayPath)` computed abstraction with builtin `Array.from`/`new Set` boundaries and `push`/`includes` action/invariant refinement.
          - [x] Close the basic array-backed Set update/read fragment with exact builtin `filter(item => item !== value)`, `length = 0`, and `length` normalization while rejecting general callbacks and array mutations.
          - [x] Accept a single-return filter callback block and immutable action-local deletion snapshots while rejecting mutable captures and general callback statements.
          - [x] Normalize TypeChecker-identified builtin `array.some(item => item === value)` membership, including a one-return callback block, through `Set(arrayPath)` abstractions.
          - [x] Refine builtin array-backed Set `every`/`some` quantifiers with declaration-ordered immutable callback locals while rejecting mutable locals and general statements.
          - [x] Add proof-directed `Map(entriesPath)` create/observe projection for builtin mutable `[K, V][]` storage and refine exact `push([key, value])` to temporal `put`.
          - [x] Refine exact entry-array key filtering to temporal Map removal and exact key equality `some` predicates to Map key membership.
          - [x] Refine entry-array `length = 0`/`length` to Map clear/size and support typed temporal `Map.size()` across runtime and Quint lowering.
          - [x] Refine entry-array value-only `every`/`some` predicates to Map value quantifiers and compare lambda bodies alpha-equivalently.
          - [x] Simplify a same-key entry-array filter-then-push upsert sequence to temporal `Map.put` while retaining different-key removals.
          - [x] Refine exact builtin entry-array `find(entry => entry[0] === key)![1]` reads to guarded temporal `Map.get(key)` without treating `!` as proof evidence.
          - [ ] Define composable abstraction relations for non-identity nested collections and dynamically dispatched create/observe adapters. ([#24](https://github.com/mizchi/uneffect/issues/24))
  - [x] Detect vacuity, deadlock, and invariants preserved only because the model cannot progress for the documented bounded, finite-state, inductive, and reachable-lasso fragments.
    - [x] Prove that no action is enabled at init, or that enabled initial transitions cannot change temporal state.
    - [x] Find the shortest later reachable deadlock within an explicit Z3 unrolling bound.
    - [x] Find the shortest bounded reachable state where actions are enabled but every enabled action stutters.
    - [x] Promote a reachable all-actions-stutter state to an explicit infinite no-progress execution witness.
    - [x] Report bounded property-specific vacuity when a safe property's referenced state cannot change on any bounded reachable transition.
    - [x] Upgrade property-specific vacuity to an unbounded result when no typed transition can change any referenced state.
    - [x] Use explicitly selected, proven strengthening invariants to promote reachability-specific frozen-state vacuity beyond a bound.
    - [x] Reuse automatically discovered, proven declared properties for frozen-state vacuity promotion.
    - [x] Reuse proven synthesized sign/polarity templates for frozen-state vacuity promotion.
    - [x] Reuse proven pairwise integer relations for frozen-state vacuity promotion.
    - [x] Reuse proven initial-difference affine templates for frozen-state vacuity promotion.
    - [x] Reuse proven same-shaped collection equality templates for frozen-state vacuity promotion.
    - [x] Find bounded reachable lassos violating `temporal_eventually`, enforcing weak and strong action fairness on the loop before reporting an unbounded witness.
    - [x] Diagnose an eventuality that is already true in every initial state and therefore imposes no future progress obligation.
    - [x] Add TypeScript-style `temporal_response name: trigger => response`, lower it to Quint `leadsTo`, and find fairness-respecting Z3 lasso violations.
    - [x] Reject response properties whose trigger is impossible or whose response is already guaranteed whenever the trigger holds.
    - [x] Distinguish bounded, inductively proven, and finite-state-complete response triggers that cannot occur from `init`.
    - [x] Reuse proven explicit, discovered, and synthesized strengthening invariants to exclude otherwise non-inductive response triggers.
    - [x] Add typed recurrence `temporal_repeatedly name: predicate`, lower it to `always(eventually(predicate))`, and find fairness-respecting Z3 lasso violations.
    - [x] Reject recurrence targets that are impossible or true in every typed state.
    - [x] Distinguish bounded, inductively proven, finite-state-complete, and strengthened recurrence targets that cannot occur from `init`.
    - [x] Add typed stabilization `temporal_stabilizes name: predicate`, lower it to `eventually(always(predicate))`, and find fairness-respecting Z3 lasso violations.
    - [x] Dogfood stabilization as a shutdown-drain property with a missing-fairness negative control.
    - [x] Distinguish bounded, inductively proven, finite-state-complete, and strengthened stabilization targets that cannot occur from `init`.
    - [ ] Synthesize general affine/polyhedral/quantified collection invariants and support arbitrary nested/general temporal formulas beyond the eventuality, response, recurrence, and stabilization fragments. ([#2](https://github.com/mizchi/uneffect/issues/2))
- [x] Generate QuickCheck-style property tests and shrinkers from `Int`, `Nat`, machine-number, bounded-array, union, and supported contract-refined boundaries.
  - [x] Generate deterministic standalone Vitest tests for scalar `Int`, `Nat`, `U8`, `U32`, and `I32` parameters with restricted `requires`/`ensures` expressions.
  - [x] Shrink scalar counterexamples toward zero without adding a production runtime dependency.
  - [x] Generate `BoundedUint8Array<N>`, `BoundedUint32Array<N>`, scalar/literal union values, and structure-aware array shrinkers.
  - [x] Enumerate satisfying numeric literal-union members with Z3 instead of relying on runtime precondition filtering, and dogfood a finite deployment-size contract.
  - [x] Preserve boolean literal unions as finite Z3 Bool domains and correlate feature flags with numeric deployment boundaries.
  - [x] Preserve string literal unions as finite Z3 String domains and correlate deployment regions without encoding strings as integers.
  - [x] Match JavaScript signed remainder and truncating integer division in solver-generated boundaries, excluding zero divisors from the integer refinement fragment.
  - [x] Derive tighter generators from the supported first-order contract refinements instead of filtering candidates only at runtime.
    - [x] Seed valid boundary-adjacent values from conjunctive integer comparisons (`>=`, `>`, `<=`, `<`, `===`), including reversed operands.
    - [x] Derive boundary unions from disjunctions and normalize single-variable affine arithmetic.
    - [x] Derive aligned boundary candidates from conjunctive positive-modulo refinements.
    - [x] Keep range/congruence hints branch-local through bounded DNF expansion.
    - [x] Combine compatible positive modulo refinements with safe-integer generalized CRT.
    - [x] Respect JavaScript's signed remainder semantics for statically negative ranges.
    - [x] Derive correlated tuples for affine equality graphs between scalar parameters and prioritize them before Cartesian samples.
    - [x] Enumerate bounded-count Z3 models for scalar nonlinear `requires` clauses and prioritize them as correlated tuples.
    - [x] Jointly shrink across known correlated tuples while rechecking the full precondition.
    - [x] Derive solver-backed structured/collection inputs and synthesize constraint-preserving shrink candidates.
      - [x] Enumerate bounded U8/U32 array lengths and literal-index elements with Z3, then reuse size-ordered satisfying tuples as constraint-preserving joint shrink candidates.
      - [x] Enumerate required scalar fields of closed TypeScript record literals with Z3 and shrink them field-by-field or through satisfying tuples.
      - [x] Lower bounded-array dynamic scalar indices to finite SMT selection with explicit in-bounds generation constraints.
      - [x] Extend solver-backed generation to nested records, Maps/Sets, and optional fields.
        - [x] Recursively generate, constrain, reconstruct, and shrink closed nested records.
        - [x] Generate scalar optional record fields with explicit SMT presence bits and omission-first shrinking.
        - [x] Generate finite `BoundedSet<T, N>` values with native-Set materialization, membership/size SMT constraints, and structural/element shrinking.
        - [x] Generate finite `BoundedMap<K, V, N>` values with JSON-safe key/value columns, native-Map materialization, lookup/membership/size SMT constraints, and shrinking.
        - [x] Generate optional object-valued fields with one shared parent presence bit across nested leaves.
        - [x] Separate nested optional child presence from its optional parent, enforce child-implies-parent in Z3, and dogfood a rollout configuration boundary.
      - [x] Minimize a shared structural-size objective and confirm minimality with repeated strict-bound SAT checks instead of trusting nonlinear `Optimize` results.
    - [ ] Derive constructive generators and shrinkers for unsupported higher-order, recursive, and user-defined contract predicates. ([#4](https://github.com/mizchi/uneffect/issues/4))
- [x] Persist minimized counterexamples and replay them against implementation/model refinement adapters.
  - [x] Persist and prioritize replay of versioned scalar and structured property-test counterexamples (`v1` remains scalar-only; `v2` adds JSON-safe arrays and literals).
  - [x] Optionally persist minimized failures from standalone generated Vitest files and replay the artifact before newly generated candidates.
  - [x] Replay model-checker counterexamples through TypeScript refinement adapters.
    - [x] Atomically persist normalized model traces and validate schema, backend, continuity, and expected model hash before replay.
    - [x] Define a versioned normalized model trace and replay explicit action/observation/invariant adapters with step-local mismatch artifacts.
    - [x] Parse Quint `run --mbt --out-itf` violation traces, including safe ITF big integers, into normalized traces automatically.
    - [x] Extract shortest bounded temporal-Z3 counterexamples with explicit action selectors into normalized traces automatically.
    - [x] Parse standalone scalar TLC counterexample output and recover unambiguous actions from the neutral temporal IR into normalized traces automatically.
    - [x] Parse multiline finite Set, scalar-key Map, and closed-record TLC console values and recover their neutral collection actions.
    - [ ] Support the remaining general TLA+ values and upstream machine-readable TLC traces when Quint exposes them. ([#5](https://github.com/mizchi/uneffect/issues/5))
- [x] Merge the direct Z3 checker and SMT-LIB generator onto one invariant IR.
- [x] Lower simple assignments and branches to SSA proof obligations.
- [x] Lower loop initialization, preservation, and exit obligations through the shared IR.
- [x] Preserve TypeScript numeric domains (`Int`, `Nat`, finite `Float`) in solver sorts and assumptions. (`Float` currently uses the documented real-arithmetic abstraction.)
- [x] Generate stable obligation identifiers and source mappings.
- [x] Treat Z3 `unknown` and unsupported syntax as non-proofs.
- [x] Save counterexample models in a machine-readable verification artifact.
- [x] Expose project-level Z3 obligations and optional explicit Valibot assertion emit through one build API.

## Historical ledger section 4 — Temporal logic and ownership

- [x] Encode a bounded two-node Node Lease clock-skew model and lock both the vulnerable counterexample and skew-grace candidate with Quint tests.
- [x] Add the documented finite collection-valued temporal-state fragment (`Set`, `Map`, closed records, and finite-domain quantifiers) so the covered Node Lease models do not require manual scalar flattening. ([#5](https://github.com/mizchi/uneffect/issues/5))
  - [x] Add `Set<int>`/`Set<bool>`, `Set(...)`, immutable `union`, `contains`, `size`, and finite `forall` to the neutral expression AST, Quint lowering, and runtime assertion lowering.
  - [x] Keep collection models explicit `unknown`/unsupported in scalar-only Z3 and TLC replay paths instead of coercing them to booleans.
  - [x] Replace per-node writer-presence fields with a finite Set in a Node Lease positive/negative Quint model.
  - [x] Add scalar-key/value `Map<K, V>`, TypeScript `Map([[k, v]])`, immutable `put`, and finite `keys`/`values` views without exposing partial `get`.
  - [x] Replace per-node resident epoch fields with a finite Map in the Node Lease model.
  - [x] Add record state, field reads, immutable spread updates, and nested collection value types.
  - [x] Add multiline collection-valued TLC replay for the supported Set/Map/record fragment.
  - [x] Encode scalar-element Set state as Z3 boolean arrays for semantic lint, bounded reachability, and JSON-safe shortest counterexample extraction over the literal finite universe.
  - [x] Encode scalar-key/value Map state as a Z3 domain/value datatype for semantic lint, bounded reachability, and JSON-safe shortest counterexample extraction over the literal finite universe.
  - [x] Encode closed scalar-field records as canonical Z3 datatypes with field reads, immutable spread updates, and JSON-object counterexample extraction.
  - [x] Recursively compose Z3 Set, Map, and record sorts for nested semantic lint and bounded reachability; recursively extract counterexamples where every Set has scalar elements and every Map key comes from the literal finite universe.
  - [x] Preflight Z3 expression support so infinite-domain Set cardinality returns an explicit unsupported/`unknown` non-proof instead of throwing or using a finite approximation.
  - [ ] Add the remaining general TLA+ TLC values and upstream machine-readable trace forms. ([#5](https://github.com/mizchi/uneffect/issues/5))
- [x] Add an extensible temporal semantic-domain registry; use optional wall-clock/monotonic-clock/skew contracts as one domain pack rather than privileged core semantics.
  - [x] Route protected logical-clock state/init/actions through a public directive registry and allow independently registered domain directives.
  - [x] Add an optional physical-clock pack that distinguishes protected monotonic ticks, rollback-capable wall clocks, and explicit transition-guarded skew assumptions.
- [x] Extend the physical-clock pack with host-clock observation adapters and platform conformance tests.
  - [x] Expand finite variable-rate ticks and nondeterministic bounded wall-clock jump magnitudes.
  - [x] Normalize injectable Node, browser, and Deno clock observations and check finite traces against rate, rollback, and skew assumptions.
- [x] Bind abstract model state/actions to TypeScript observations/calls and replay generated counterexamples against implementation adapters.
  - [x] Replay a Quint-produced Node Lease trace through a typed runtime adapter and reproduce `singleWriter` at the same step.
  - [x] Generate bindings from source annotations and connect them directly to backend-produced counterexamples.
- [x] Model delayed renewal completion, self-fencing, GC, CAS failure, crashes, and in-flight fenced writes in the Node Lease acceptance model, retaining an unfenced-commit negative control.
- [x] Build the product model between callback temporal summaries and Web event-loop queue transitions, verify application properties in project verification, and reject due callbacks whose preconditions no longer hold.
- [x] Define the initial restricted TypeScript-style temporal expression grammar independently of Quint syntax.
  - [x] Parse expressions into a neutral AST and generate Quint or runtime JavaScript assertions from it.
  - [x] Add symbol/type checking against state declarations and supported function parameters.
  - [x] Add the first function-summary grammar: `temporal_requires`, `temporal_ensures`, and `temporal_modifies`.
  - [x] Compose a local synchronous call sequence into a program-counter Quint model.
  - [x] Keep a broken composition with omitted precondition guards as a negative control.
  - [x] Add nondeterministic synchronous throw exits and empty `try/catch` discharge boundaries.
  - [x] Add explicit return, non-empty catch/finally, rejection, suspension, and cancellation exits.
- [x] Add source spans and explicit stuttering policy to temporal composition IR.
- [x] Generate safety properties and negative-control models.
- [x] Add liveness/fairness syntax after suspension/resume introduced the concrete requirement.
- [x] Model Transferable ownership in Quint.
  - [x] `Available -> Transferred/Detached` transition.
  - [x] Reject read, mutation, or second transfer after definite transfer.
  - [x] Preserve ownership after clone without transfer.
  - [x] Keep an intentionally broken use-after-transfer model as a regression oracle.
- [x] Add `Transfer`, `Clone`, and ownership state to the Rust neutral IR.
- [x] Instantiate contracts for `structuredClone`, `Worker.postMessage`, `MessagePort.postMessage`, and related platform APIs.
- [x] Add `structuredClone` clone-failure throws, synchronous catch discharge,
  and same-Program own-enumerable getter composition for finite object/array
  literals without claiming prototype or Proxy-trap execution.
- [x] Distinguish `SharedArrayBuffer` sharing from transfer.

## Historical ledger section 4.5 — Typed array refinements

- [x] Add `U8`, `BoundedUint8Array<MaxLength>`, and optional Valibot runtime refinements.
- [x] Prove direct Uint8Array constructor bounds and indexed u8 writes from helper-type domains and `requires` clauses.
- [x] Reject implicit coercion and retain compound/update writes as non-proofs.
- [x] Model direct bounded DataView `setUint8`/`setUint32` byte offsets and value domains, with optional Valibot refinement.
- [x] Model all standard bounded DataView accessor widths, integer setter domains, and reassignment-free local alias chains.
- [x] Dogfood DataView obligations against a DNS header codec and retain an off-by-one negative control.
- [x] Derive safe integer intervals from simple `requires` bounds and expose solver-query statistics; reduce DNS codec verification from six queries to zero.
- [x] Distinguish resizable capacity (`BoundedArrayBuffer`) from exact non-resizable length (`FixedArrayBuffer`) and verify explicit/implicit DataView constructor regions.
- [x] Compose fixed-buffer DataView constructor evidence with definite transfer/detachment ownership in project verification.
- [ ] Extend that composition through mutable/interprocedural aliases, resize transitions, conditional control flow, and SharedArrayBuffer concurrency. ([#6](https://github.com/mizchi/uneffect/issues/6))
- [x] Add `U32`, bounded Uint32Array runtime refinements, and ECMAScript-aware ranges for SHA-256-style shifts, masks, and explicit `>>> 0` normalization.
- [x] Generate independent bounded-index and dynamic shift-count obligations instead of trusting JavaScript out-of-range or modulo-32 behavior.
- [ ] Compose the verified SHA-256 building blocks interprocedurally and cover non-canonical control-flow bounds. ([#6](https://github.com/mizchi/uneffect/issues/6))
- [x] Derive canonical ascending-loop bounds for SHA-256 schedule reads/writes and recognize `toU32(sum)` as an explicit modular-addition boundary.
- [x] Provide explicit `u8`, `u32`, `i32`, and `f32` runtime coercion helpers with branded return domains, distinct from rejecting parsers.
- [x] Check TypedArray `.set()` copy bounds and reject implicit cross-element-domain narrowing.
- [x] Derive the conventional SHA-256 `(input.length + 9 + 63) & ~63` padding allocation bound from a bounded input.
- [x] Export scalar machine-domain constants and fold user `const` arithmetic into expressions and `typeof` bounded-array parameters.
- [x] Validate readonly constant tables such as SHA-256 `K[64]`, including element domains and table-index bounds.
- [x] Add Vitest benchmarks for scalar constant folding, SHA-256-sized tables, and repeated verified table reads.
- [x] Resolve constant tables through relative named imports, aliases, star exports, and named barrel re-exports.
- [x] Resolve constant tables through namespace imports.
- [x] Compose a generated table from verified same-domain table spreads and literal elements.
- [x] Track integer-valued ranges through `Math.floor`, `Math.ceil`, `Math.round`, and `Math.trunc`, including inferred `const` locals.
- [x] Reject fractional literals for machine-integer writes instead of checking bounds alone.
- [x] Resolve direct numeric builtins through TypeChecker/lib.d.ts symbol identity and reject structurally compatible shadowed objects.
- [x] Propagate numeric builtin identity through direct local aliases and object-binding destructuring.
- [x] Propagate numeric builtin identity through reassignment-free multi-hop aliases, imports, parameters, and object properties.
- [x] Add a reason-carrying function-level `trust typed-array` escape hatch whose obligations remain `trusted`, never `verified`.
- [x] Add narrower obligation/statement-level typed-array trust and a unified trust-policy/audit report across currently trusted verification domains.
- [x] Support package exports and bounded `Array.from({ length }, (_, index) => expr)` generated table initializers.
- [x] Benchmark project-level import/re-export resolution against the single-file baseline before optimizing it.

## Historical ledger section 5 — Evidence and optimization

- [x] Add a cross-domain assumption ledger for every currently emitted `trusted` builtin call, typed-array escape hatch, and temporal summary, with reason, scope, source span, expiration/owner metadata, and CI policy. Extend it when new trusted domains are introduced.
- [ ] Investigate proof certificates or independently checkable evidence for supported Z3/Quint fragments; current artifacts bind tool inputs and versions but are not proof terms. ([#7](https://github.com/mizchi/uneffect/issues/7))
- [x] Attach `verified`, `trusted`, `inferred`, or `unknown` evidence to every summary.
- [x] Attach a non-empty stable-coded `unknownReasons` ledger to every unknown Effect summary, require it in JSON Schema, surface it through assurance blockers, and reject unresolved top-level calls without analyzed/builtin/verified-contract evidence.
- [x] Model reviewed synchronous ECMAScript collection callbacks as inline Effect edges, add narrow pure Node/ECMAScript helper contracts, and resolve named imports from export-equals Node declarations without name-based matching.
- [x] Bind external builtin function contracts to exact package versions, reject missing runtime bindings in caller-owned package contracts, and record the dependency version in the assumption ledger.
- [x] Model version-bound higher-order callable results, including synchronously invoked captured callbacks, while rejecting mutable factory-result bindings.
- [x] Include compiler revision, tsconfig hash, source hash, builtin-contract digest, and Uneffect version in artifacts.
- [x] Make unknown evidence stop transformations without blocking gradual lint adoption.
- [x] Separate gradual lint success from explicit `no-unknown` and declaration-checked assurance profiles, with scoped blocker output and documented non-claims.
- [x] Add a `verified` check profile that requires declaration-checked summaries and a present, empty assumption ledger, so reviewed builtin semantics cannot be hidden behind a verified body declaration.
- [x] Expose assurance claims and exclusions as typed assessment data and print exclusions even on success, preventing CI consumers from treating a context-free green boolean as a whole-program proof.
- [x] Emit established assurance claims only for passing decisions; failed or unknown assessments expose an empty `claims` array and retain the unmet conditions as blockers.
- [x] Reject vacuous assurance when no proof-relevant evidence is emitted, report machine-readable coverage counts, and reject each explicitly selected file that contributes neither an effect summary nor a contract artifact.
- [x] Reject TypeScript syntax, semantic, and compiler-option errors, and downgrade every function/module summary from an ill-typed source to `unknown` instead of trusting parser recovery.
- [x] Apply the same fail-closed TypeScript boundary to `verifyUneffectProject`: report compiler diagnostics, downgrade contract/typed-array obligations, and suppress proof-grade temporal results for invalid sources.
- [x] Return a cross-domain project assurance assessment that aggregates TypeScript, effect, contract, typed-array, ownership, instrumentation, assumption-policy, temporal, and coverage blockers instead of requiring consumers to infer safety from partial evidence.
- [x] Preserve `verified`, assumption-dependent `assumed`, insufficient-evidence `unknown`, and concrete `violated` project outcomes while retaining the compatibility `passed` boolean and classifying every blocker.
- [x] Emit source-attributed `<module>` may-effect summaries for direct operations, TypeChecker-resolved calls/overloads, known inline and immutable local/imported callback identifiers, and static local import closure; reject reassigned callback bindings, compose cycles by a conservative fixed point, and keep unresolved calls/dynamic imports unknown.
- [x] Include executable namespace bodies and class heritage, computed member names, decorators, static initializers, and static blocks in module may-effects; resolve stable decorator identifiers and fail closed on dynamically produced decorators.
- [x] Resolve string-literal relative local dynamic imports through TypeScript module resolution and compose their dependency closure as conditional may-effects, including top-level await; computed, external, declaration-only, and unresolved specifiers fail closed.
- [x] Fail closed on unreviewed static external module initialization; bind reviewed contracts to the actually resolved exact package version or Node runtime major, classify matches as `trusted`, propagate that evidence through the local import closure, and record the dependency/version in the assumption ledger.
- [x] Expose a caller-owned registry extension API shared by effect analysis, project verification, assumption collection, and evidence digest validation; exact contracts shadow wildcards and version drift fails closed.
- [x] Load caller-owned static/scoped effect and module-initialization registry extensions from a strict versioned CLI JSON configuration, publish its JSON Schema, reject unknown/ambiguous/drifted inputs, and bind the effective registry into evidence. Specialized platform operation records remain curated. ([#19](https://github.com/mizchi/uneffect/issues/19))
- [x] Add an opt-in source-mapped `module-order/v1` partial-order IR and CLI/project assurance path for acyclic static dependencies, straight-line top-level-await resume/reject, unconditional synchronous throw, and blocked importers; conditional TLA, external/dynamic bodies, and TypeScript errors stay non-proof-grade.
- [x] Admit synchronous side-effect-only simple import rings with source spans/digests, compiler identity, dependency/revisit evidence, and ECMAScript depth-first postorder; runtime-binding, self, branching, multi-edge, and async cycles remain non-proof-grade. ([#18](https://github.com/mizchi/uneffect/issues/18))
- [x] Compose one exact child-project source/declaration containing one straight-line top-level await into one synchronous parent importer, preserving resume/reject and child-complete-before-importer-start evidence; conditional/looping await, await-then-throw, multiple/transitive children, transformed declarations, and broader importer shapes remain non-proof-grade. ([#18](https://github.com/mizchi/uneffect/issues/18))
- [x] Load consumer compiler options and root-file selection through `check --project <tsconfig.json>` instead of silently applying Uneffect defaults; reject malformed and empty projects.
  - [x] Resolve consumer/analyzer TypeScript package provenance and make exact-version parity, mismatch, or resolution failure machine-readable; assurance fails closed unless an explicitly supplied project has exact parity.
  - [x] Expand acyclic solution-style project references in `check --project`, analyze each referenced config as a separate compiler-option/provenance domain, publish child-first build order and source ownership, and fail closed on missing, malformed, cyclic, or duplicate-root graphs with `uneffect-workspace-check/v1`.
  - [x] Carry the referenced-config graph into the `verifyUneffectProject({ projectFile })` overload, run the existing verifier separately under every config's options/references/provenance, and aggregate graph, compiler, child-domain, assumption, claim, and exclusion state as `uneffect-project-workspace/v1`.
  - [x] Expose TypeScript SolutionBuilder dry-run freshness evidence for composite outputs and add opt-in `--require-build-artifacts` / `buildArtifacts: "require-fresh"` fail-closed gates for missing, stale, compiler-version-drifted, compiler-option-drifted, or incomplete buildinfo state.
  - [ ] Compose cross-project effect/refinement evidence through declaration boundaries without flattening compiler domains, and add content-integrity/semantic validation for emitted declarations beyond SolutionBuilder freshness. Exact same-compiler byte reproduction is complete; broader frontend/transform semantics are owned by [#8](https://github.com/mizchi/uneffect/issues/8).
    - [x] Re-emit child declarations in memory with the exact analyzer TypeScript Program, compare SHA-256-bound exact bytes with every `.d.ts` consumed by an Effect link, and fail closed on missing/mismatched outputs even when SolutionBuilder reports fresh.
    - [x] Add an opt-in exact-build gate that requires freshness and byte-compares all TypeScript-emitted runtime JavaScript and declarations, rejecting declaration-only/no-emit and transformed pipelines without a validated mapping.
    - [x] Make an empty cross-project Effect composition ledger `not-applicable` rather than vacuously `verified`, and lock the distinction with programmatic and CLI tests.
    - [x] Compose one locally verified unguarded scalar refinement action across a direct project reference, retain producer/consumer compiler/config and exact declaration provenance, and revalidate the parent action after summary substitution.
    - [x] Preserve a locally verified scalar action guard across an exact sole direct project-reference call, serialize the guard in the composition ledger, and reject guard mismatch, invalid producer guards, or wrappers with additional work.
    - [x] Compose one unguarded child scalar action through one TypeChecker-resolved, write-screened source-local function helper; retain the full call path and reject reassignment, extra updates, recursion, and deeper helper chains.
    - [x] Preserve a guarded child scalar action through that sole-call helper, binding the helper declaration to the exact child contract and rejecting helper-local guards, extra work, or conditional invocation.
    - [x] Generalize the sole-call chain to two write-screened local helpers, publish `helperDepthBudget: 2`, preserve the complete guarded call path, and reject a third helper.
    - [x] Add the version-matched `runtime adapter@version = globalThis` contract, share its identity with Effect composition, preserve it through two local helpers, and reject unannotated, shadowed, host-alias, Worker, iframe, descendant, duplicate, and version-mismatched forms.
    - [x] Reject stale/transformed, ambiguous, adapter-version-incompatible, and semantically incompatible scalar links with machine-readable blockers and adjacent negative controls.
    - [x] Reject `refinement` markers attached to class methods or other unsupported declaration shapes instead of silently producing `not-applicable`; retain a Workhub `StateStore.set`-derived project-reference fixture and an unannotated negative control.
    - [ ] Generalize the supported refinement fragment and validate any non-TypeScript declaration transforms or semantic mappings that cannot be established by exact same-compiler declaration re-emission. ([#8](https://github.com/mizchi/uneffect/issues/8))
      - [x] Accept one `embedded-typescript/v1` mapping only when a generated `.ts` file exactly equals a digest/compiler/transform-bound UTF-16 source span; publish strict manifest/report schemas and reject adjacent drift, unknown-profile, missing-span, and multi-input cases.
      - [ ] Define checkable semantic mappings for non-identity host-language transforms; exact embedded text identity does not discharge this remaining boundary. ([#8](https://github.com/mizchi/uneffect/issues/8))
- [x] Publish `check --json` as a versioned decision report containing normalized diagnostics, effect/contract evidence, assurance status, blockers, claims, exclusions, and coverage even when the check fails.
- [x] Make `no-unknown` reject unresolved capability argument sets such as `Fetch<POST, Unknown<dynamic-url>>`, not only summaries whose outer evidence status is `unknown`.
- [ ] Extend module initialization from may-effect closure to exact ESM evaluation/TLA/decorator ordering, side-effectful external packages, computed/external dynamic imports, dynamically selected or mutable callback identifiers, and dynamically produced decorator application. Immutable local/imported function identifiers for known callback owners are resolved by TypeChecker identity; reassigned live bindings fail closed. ([#18](https://github.com/mizchi/uneffect/issues/18))
- [x] Define one proof-obligation schema per optimizer transformation.
- [x] Prototype stable-read reuse only when no overlapping mutate/invalidate/transfer event exists.
- [x] Evaluate property mangling separately under closed-world reflection and escape constraints.
- [x] Gate generated ownership-assertion elision on matching proof-grade `ownership-evidence/v2`; never rewrite user-authored Promise control flow from ownership evidence alone.
- [x] Add an end-to-end ownership instrumentation path: unresolved direct calls emit runtime assertions, matching Z3 evidence removes only generated checks and their unused helper.
- [x] Add one-shot `--ownership` and `--verify-ownership` CLI modes with safe runtime fallback for unresolved or unavailable Z3 proofs.
- [x] Persist ownership artifacts, reuse matching proofs across builds, and report stale evidence separately from first-time unknowns.
- [x] Add a project-level stable-read authorization cache bound to source hashes, TypeScript revision, builtin contracts, and closed-world mode.
- [x] Restrict project stable-read proof to unique function-local `const` plain-object data properties, reject open parameters/getters/aliases/intervening calls, and forbid `trusted` evidence from authorizing optimizer transformations.

The schemas and narrow authorization prototypes above are implemented. A
production compressor/mangler that consumes them is intentionally deferred to
[#13](https://github.com/mizchi/uneffect/issues/13); these checked design items
must not be read as a claim that arbitrary source rewriting is implemented.

## Historical ledger section 6 — Native integration and productization

- [x] Compare the TypeScript declared-effect projection with the Rust Corsa schema consumer, including schema-drift and UTF-8 trivia controls.
- [ ] Extend frontend parity from declarations to inferred effects, call edges, ordered events, and real Corsa checker facts. ([#8](https://github.com/mizchi/uneffect/issues/8))
  - [x] Compare transitive inferred effects, resolved local call edges, and source-ordered call events through the Rust schema consumer.
  - [x] Carry mandatory fact provenance through schema v8 and fail closed when actual Corsa-checker facts are required but only reference-adapter records are available.
  - [x] Export the initial real checker-backed slice through the `corsa-oxlint` plugin context: top-level named functions and single immutable arrow/function-expression bindings, Corsa type text, direct call edges, and leading Uneffect trivia.
  - [x] Preserve Corsa symbol identity across project imports and place every frontend span in deterministic project-wide UTF-8 coordinates.
  - [x] Qualify duplicate top-level function spellings by source path in both adapters so cross-file edges cannot alias by name.
  - [x] Stop checker-backed call collection at unsupported nested function/callback boundaries instead of mislabeling deferred or unknown work as an immediate outer call.
  - [x] Export identifier-named methods of top-level classes and resolve direct cross-file method calls by checker symbol identity; reject explicitly annotated computed methods as uncovered instead of accepting empty parity.
  - [x] Export source-ordered named-function overload candidates and resolve call-site selections through Corsa signature identity using literal/base/union argument type alternatives; compare candidate text and selected index independently of normalized effect parity.
  - [x] Export one checker-inferred standard `console.log` Effect with builtin/declaration/symbol/compiler/operation-span evidence, compare its two ordered local calls through Rust normalization, and reject a same-spelled symbol-distinct object. ([#27](https://github.com/mizchi/uneffect/issues/27))
  - [ ] Export and compare actual facts collected by the `corsa-bind` type-aware Oxlint bridge instead of reference-adapter synthesized records. TypeScript Go Content Mappers transform non-TS files and map spans; they are not a semantic fact API for ordinary TypeScript. ([#8](https://github.com/mizchi/uneffect/issues/8))
    - [ ] Extend the checker-backed exporter beyond named-function overloads and identifier-named methods of top-level classes to method/generic edge-case overloads, computed/polymorphic methods, nested callbacks/timing, Promise/resource records, and the complete neutral IR. ([#8](https://github.com/mizchi/uneffect/issues/8))
    - [ ] Define a signed/pinned evidence envelope for persisted Corsa facts; copied provenance strings must never satisfy the in-process checker gate. ([#8](https://github.com/mizchi/uneffect/issues/8))
- [x] Define a frontend adapter boundary that can be implemented by Corsa.
- [x] Consume Corsa symbol, type, overload, and trivia information from Rust.
- [x] Add multi-file call graphs, aliases, re-exports, methods, arrows, overloads, and callbacks.
  - [x] Preserve synchronous `Throw<T>` discharge on caught program call-graph edges, including inline callbacks, without discharging deferred callbacks.
  - [x] Apply the same caught-edge discharge to implicit `using`/`await using` disposal calls in single-file and Program analysis.
  - [x] Stop synchronous `Throw<T>` propagation at async-function boundaries; async throws are Promise rejections handled by async-safety analysis.
  - [x] Defer Generator effects from iterator construction to direct `.next()`, `for..of`/`for await`, and `yield*` consumption edges in local and Program call graphs.
  - [x] Resolve acyclic definite-return generator factories at direct consumption sites while retaining the factory's own immediate effects.
  - [x] Expand every resolved candidate of branching/conditional generator factories only when all normal return paths are known; partial factories remain unsupported.
  - [x] Mark iterator-like consumption through unresolved/partial generator factories as `unknown` evidence and propagate that status transitively to callers.
  - [x] Preserve generator identities through immutable local iterator alias chains before `.next()`, loop, or `yield*` consumption.
  - [x] Preserve unknown evidence when an opaque or partial generator factory is stored and consumed through immutable local aliases.
  - [x] Treat spread syntax and `Array.from` as synchronous iterator consumers for direct factories and stored immutable bindings.
  - [x] Recognize destructuring, collection/typed-array constructors, `Object.fromEntries`, and Promise combinators by standard-library signature identity as iterator consumers.
  - [x] Convert generator-body `Throw<T>` during Promise combinator iteration to rejection while retaining synchronous factory-call throws.
  - [x] Mark iterator-like `.next()` through unresolved parameters/properties as unknown evidence while preserving standard-library pure iterator aliases.
  - [x] Specialize iterator-consuming function parameters at call sites from known generator factories/bindings, pure standard iterators, or explicit unknown arguments.
  - [x] Expose directly consumed iterator parameters as explicit polymorphic effect parameters in function summaries instead of misclassifying the generic definition as opaque.
  - [x] Forward iterator-effect parameters through symbol-resolved wrapper calls, preserving Promise rejection conversion.
  - [x] Add `effect_parameter p extends ...` bounds with call-site Generator specialization, stored-iterator evidence, transitive wrapper constraint checks, Promise rejection conversion, and fail-closed syntax/parameter diagnostics.
  - [x] Dogfood a telemetry batching Generator through `verifyUneffectProject`, including a negative bound-regression and project-assurance failure.
  - [x] Preserve iterator-effect parameters and formatted bounds in evidence schema v2 and the public `uneffect evidence` JSON command.
  - [x] Bind evidence schema v2 to the root identity and hashes of every non-declaration Program source, not only the command-line file.
  - [x] Upgrade effect evidence to schema v3 with mandatory per-summary source identity and a fail-closed validator for schema/tool/config/source-set/builtin/summary drift; this is TCB-relative freshness, not an independent proof certificate.
  - [x] Separate artifact freshness from proof eligibility; reject trusted/inferred/unknown summaries, nested unknown capability scopes, open iterator effects, duplicate identities, and vacuous inventories with machine-readable blockers.
  - [x] Keep parameter-derived and intrinsic generator unknown evidence separate so specialization cannot erase unrelated uncertainty.
  - [x] Track simple mutable iterator aliases flow-sensitively: kill/replace on straight-line assignment and may-join known, pure, and opaque states across conditional control flow.
  - [x] Track iterator identities in one-level local object slots with constant property keys, including local object aliases and flow-sensitive slot reassignment; keep dynamic keys unknown.
- [x] Add effect polymorphism and callback invocation timing.
- [x] Publish versioned CLI, library, and Rust crate interfaces.
- [x] Add CI tiers for unit tests, Z3 obligations, Quint simulation, and exhaustive model checking where available.
  - [x] Provision the Z3 CLI and Java 21, and serialize Quint evaluator warm-up before parallel Vitest workers.
  - [x] Bound CI solver integration concurrency and timeout separately from the faster local profile.
  - [x] Allow the Corsa parity subprocess 120 seconds for a cold Rust build while keeping an explicit configurable timeout diagnostic.
  - [x] Permit at most three isolated process attempts for recognized Z3 WASM out-of-bounds, fixed-heap growth OOM, internal assertion, and narrowly identified timeout signatures.
  - [x] Preserve digest-addressed SMT-LIB, backend attempts, process duration/memory, and the source test selector across isolated retry attempts; upload the bundle even when a later attempt passes.
  - [x] Classify comparable cross-process retry evidence as transient recovery, deterministic time/memory exhaustion, reproducible runtime failure, or inconclusive; never serialize a retry success as a clean first pass.
  - [x] Repeat the telemetry-routing conservation proof and negative control in three fresh WASM processes, require identical digest/call-count evidence, and enforce a 64-execution stress budget in CI.
  - [x] Split explicit and synthesized Node Lease strengthening proofs into separate processes so Z3 WASM contexts cannot accumulate past the fixed heap.
  - [x] Partition every TypeScript test into exactly one fast, Z3, Quint, or mixed integration tier with an executable no-gap/no-overlap manifest check.
  - [x] Keep generated child Vitest files runnable when they inherit a parent tier selection.

## Historical ledger section 7 — Explicit resource management

- [x] Model `using` disposal as an implicit reverse-order `finally` region, including nested lexical scopes.
- [x] Model `await using` disposal as an asynchronous cleanup transition and suspension point.
- [x] Resolve builtin and user-defined `[Symbol.dispose]` / `[Symbol.asyncDispose]` contracts by TypeChecker symbol identity. (Corsa parity is tracked below.)
- [x] Track `SuppressedError`, early return, throw, rejection, and partial initialization in the control projection.
- [x] Infer and check capability effects performed by implicit cleanup methods.
- [x] Preserve exact nested `SuppressedError` payload types in the analysis IR. (Quint retains the finite abstract state.)
- [x] Add positive models and broken controls for missing, duplicated, reordered, and non-awaited disposal.

## Historical ledger section 8 — Async/resource model hardening

- [x] Resolve builtin and user-defined disposal protocols by TypeChecker/Corsa symbol identity without escaped-name matching. (The v6 Corsa contract validates protocol-symbol edges and disjunctive correlated control paths; production Context Mapper emission remains tracked in P6.)
  - [x] Distinguish the standard `Symbol.dispose` and `Symbol.asyncDispose` symbols from shadowed or same-spelled properties.
  - [x] Cover typed aliases, interface inheritance, intersections, and generic constraints in the TypeChecker frontend.
- [x] Compose the documented bounded Promise chains, `await`, `try/catch`, and async disposal fragments into one control-flow model. ([#9](https://github.com/mizchi/uneffect/issues/9))
  - [x] Connect analyzed Promise-chain terminal states to await resume/rejection edges.
  - [x] Route disposal throw/rejection through catch and the async function's returned Promise in the shared IR.
  - [x] Preserve concrete catch/finally statement sequencing in the unified graph.
  - [x] Lower the single-function unified graph into one Quint transition module.
  - [x] Complete the bounded Promise/resource-specific awaited-chain, nested-cleanup, and completion-join scope owned by #9; general CFG and alias widening are tracked separately. ([#9](https://github.com/mizchi/uneffect/issues/9))
    - [x] Give sequential awaited chains distinct wait/resume states and preserve their source order before cleanup.
    - [x] Dispose resources from a straight-line nested scope before a following outer await, while retaining idempotent final cleanup on failure paths.
    - [x] Dispose a resource whose complete nested scope precedes the first modeled await before entering that await.
    - [x] Route a caught scope-exit disposal failure through the concrete catch sequence and resume a following straight-line await.
    - [x] Place straight-line resource acquisitions between surrounding awaits by source position instead of front-loading every acquisition.
    - [x] Preserve conditional acquisition/await as optional transitions and carry the classification through Corsa schema v4.
    - [x] Correlate nested `if` then/else operations through shared condition identity/polarity and carry it through validated Corsa schema v5; loop and general CFG joins remain conservative.
    - [x] Preserve top-level catch/finally `return` and `throw` completion so abrupt handlers do not fall through to later awaits.
    - [x] Give one awaited chain per top-level catch/finally statement dedicated terminal/resume states, including finally-before-outer-await ordering.
    - [x] Lower a labeled `continue` from mandatory `finally` to its canonical bounded outer `for`, completing reverse-order loop-scoped async disposal before reacquiring the next resource generation; reject unknown labels, non-canonical/dynamic bounds, intervening statements, and loops beyond the explicit eight-iteration proof budget.
    - [x] Lower the matching labeled `break` through a distinct reverse-order cleanup path to the first post-loop await, while ordinary completion still advances the bounded loop; retain non-canonical bounds and non-loop label owners as explicit non-proofs and reject a cleanup-skip fault in Quint.
    - [x] Route one caught awaited rejection through concrete catch/finally statements and two function-scoped sync/async resources, prove reverse acquisition order with an explicit Quint invariant, and reject reordered cleanup, skipped cleanup, and a floating Promise control.
    - [x] Join two independently rejecting awaits through a conditional catch recover/rethrow and mandatory finally, dispose an inner async scope before an outer awaited continuation, extend cleanup precedence across containing scopes, and retain reorder/skip/floating/unresolved-label controls.
    - [x] Keep one caught inner async-disposal rejection pending until the enclosing conditional catch recovers or rethrows it, traverse mandatory outer finally, finish remaining outer cleanup exactly once, and reject a handler-bypass fault in Quint.
    - [x] Complete a two-resource inner async disposal stack in reverse order before catch, retain a finite single-versus-suppressed failure kind, route protected body/acquisition failures through the same cleanup chain, and reject premature-handler, lost-suppression, skipped, and reordered controls.
    - [x] Preserve one finite Boolean `if`/`else` resource choice through branch-local async cleanup and a shared catch/finally join; require acquisition-path and dispose-after-acquire invariants and reject both-branch acquisition, wrong-branch cleanup, skipped cleanup, premature handler entry, and floating rejection.
    - [x] Preserve an exhaustive finite string-literal `switch` choice across three branch-local async resources and a shared catch/finally join; require finite-discriminant provenance, full path coverage, pairwise acquisition exclusion, and dispose-after-acquire, while rejecting missing default, fallthrough/overlap, open discriminants, multiple acquisition, wrong-case cleanup, skipped cleanup, premature handler entry, and floating rejection.
    - [x] Preserve one three-leaf nested Boolean resource decision through branch-local async cleanup and a shared catch/finally join; require Boolean-identifier provenance, complete/non-overlapping leaf coverage, pairwise acquisition exclusion, and an eight-condition proof budget, while rejecting expression predicates, incomplete/overlapping leaves, over-budget trees, multiple acquisition, wrong-leaf cleanup, skipped cleanup, premature handler entry, and floating rejection.
    - [x] Preserve one finite string-literal switch whose preferred case contains a Boolean resource choice and whose explicit default owns a backup resource; validate both provenance kinds, combined complete/non-overlapping leaf coverage, and one shared eight-condition budget while retaining cleanup, handler, acquisition, and floating-Promise negative controls.
    - [x] Preserve two independent finite resource decisions across an intermediate join; validate both stages and a combined eight-condition budget, keep exclusion local to each stage, require first-stage disposal before second-stage acquisition, and reject delayed/skipped/wrong cleanup, wrong-stage acquisition, incomplete/overlapping stages, disposed alias use, premature handler entry, and floating rejection.
    - [x] Preserve one non-uniform Boolean return-versus-normal resource decision: distinguish fallthrough guards from acquisition-decision conditions, dispose the return arm before completion, retain return through mandatory `finally`, and prevent later acquisition or outer continuation; keep await rejection routed through catch and retain return-fallthrough, normal-skip, cleanup-before-return, wrong/skipped cleanup, premature-handler, incomplete/overlapping, and floating-Promise controls.
    - [x] Preserve the bounded typed-throw-versus-normal counterpart with a distinct completion kind: dispose the throw arm before catch, distinguish handler recovery from rethrow, traverse mandatory `finally`, and prevent the throw path from entering the later decision; retain throw-fallthrough, cleanup-before-throw, handler-bypass, normal-skip, wrong/skipped cleanup, premature-handler, incomplete/overlapping, and floating-Promise controls.
    - [x] Land one canonical two-iteration outer `for` with a complete Boolean-selected async resource generation, cleanup before the iteration join, owned `continue`/`break`, and load-bearing stale-generation, reacquire-before-cleanup, wrong/skipped-cleanup, caught-rejection-bypass, floating-Promise, bound, predicate, incomplete-branch, and alias-escape controls. ([#9](https://github.com/mizchi/uneffect/issues/9))
    - [x] Give sequential and nested `try` statements stable control-region identities and route rejection to the innermost containing catch.
    - [x] Propagate top-level rethrows and single awaited handler failures through enclosing control regions, including pending completion through finally.
    - [x] Sequence multiple analyzed awaits in one top-level catch/finally statement and preserve enclosing failure propagation.
    - [x] Correlate analyzed awaits in top-level handler `if` then/else branches through shared condition identity and skip/join transitions.
    - [x] Preserve `return`/`throw` completion paths inside handler `if` branches, including branches ending in analyzed awaits.
    - [x] Model handler `switch` case selection as an ordered decision chain and retain top-level fallthrough/break completion.
    - [x] Add disjunctive control paths for operations reachable through both direct case entry and fallthrough, carried through Corsa schema v6.
    - [x] Correlate one-step zero-iteration handler loop bodies and preserve conditional break/continue completion paths.
    - [x] Propagate labeled `break`/`continue` through nested loops to the owning loop without inner-loop discharge.
    - [x] Add repeat/exit states for awaited catch/finally loops, giving arbitrary finite repetition in the control graph.
    - [x] Re-acquire and dispose lexical `using` / `await using` resources within each modeled handler-loop iteration.
    - [x] Give repeated lexical resources generation identities and require cleanup of the latest acquired generation.
    - [x] Diagnose direct outer-variable aliases used after their `using` resource's lexical disposal scope.
    - [x] Propagate resource identity through source-ordered local alias chains with conservative conditional kills.
    - [x] Track resource escape through static property and literal-index slots on local aggregate roots, including alias propagation and unconditional kills.
    - [x] Canonicalize nested static access paths across local aggregate-root alias chains and invalidate descendant facts when a parent slot is overwritten.
    - [x] Resolve computed resource-slot keys through reassignment-free local `const` string/number aliases while keeping mutable keys unknown.
    - [x] Resolve exported `const` resource-slot keys through named import aliases, barrel re-exports, and namespace imports in the Program frontend.
    - [x] Reject direct, aliased, object, and array returns of lexical resources that are disposed before the caller receives them.
    - [x] Reject returned direct/aliased/aggregate closures that capture a lexical resource and can run only after its disposal.
    - [x] Reject lexical resources passed to explicit `retains_resource` boundaries and infer transitive wrapper retention through reassignment-free local parameter aliases by symbol identity.
    - [x] Apply resource-retention contracts to annotated constructors and propagate them through factory wrappers.
    - [x] Add conservative `retains_resource_when`: discharge only a guard proven false through the shared boolean logic IR, for calls, constructors, and direct wrappers with literal/type/precondition facts and reassignment-free boolean aliases.
    - [x] Join exhaustive `if`/`else` terminal nullish clears for direct and static aggregate resource aliases while retaining one-branch clears conservatively.
    - [x] Join `default`-covered `switch` clauses that each terminally nullish-clear a resource alias; fallthrough and abrupt pre-clear paths remain conservative.
    - [x] Let empty grouped `switch` labels inherit a following mandatory resource-alias clear for direct and static aggregate slots; keep non-empty fallthrough conservative.
    - [x] Prove default-free resource-alias cleanup switches exhaustive over finite TypeScript string, number, and boolean literal unions.
    - [x] Treat terminal `return` paths, including exhaustive terminal `if`/`else` both inside and outside switches, as not reaching subsequent disposed-resource alias uses.
    - [x] Keep resource-alias kills inside `try` and `catch` conditional while recognizing mandatory `finally` clears, preventing exception-path false negatives.
    - [x] Harden loop-carried resource generations and alias diagnostics within the documented bounded fragment; general CFG joins and escaping aliases are tracked by #23 and #24.
      - [x] Join resource aliases introduced in `for`/`for...in`/`for...of`/`while`/`do...while` bodies when every executed iteration terminally clears or returns; preserve zero-iteration state and reject pre-clear abrupt completion.
      - [x] Compute a finite per-target loop exit summary so clear-before-`break`/`continue` paths join safely, while uncleared exits and clear-then-reassign paths remain escaping.
      - [x] Treat an unconditional direct/static-slot alias clear in a loop-local `finally` as the common exceptional, normal, and transfer exit; retain conditional or uncleared finally paths conservatively.
      - [x] Preserve acquisition index, repeated-site classification, and a stable symbolic generation snapshot on every reported resource-alias escape.
      - [x] Lower reported alias capture, lexical disposal, and post-scope use into unified Quint; compare the captured generation with `disposed_generation_N` and violate `resourceSafe` on a disposed-generation match.
      - [x] Add repeat/exit decisions for repeated alias acquisitions, recapturing the incremented generation on every arbitrary finite iteration and preserving a zero-iteration skip path.
      - [x] Share one repeat/exit decision across every alias snapshot of the same repeated acquisition, while retaining independent capture/use evidence for each alias.
      - [x] Verify source-ordered nested repeated acquisitions retain distinct generation state and repeat targets through async disposal and post-loop alias use in Quint; normalize generated alias identities by assignment order rather than use/report order.
      - [x] Classify alias generation relations as `single`, `latest`, or `conditional`; conditional assignments add an explicit capture-skip transition instead of inventing a mandatory snapshot.
      - [x] Preserve acquisition-relative control paths on conditional generations and correlate mutually exclusive `if`/`else` captures through one Quint branch identity.
      - [x] Reuse ordered switch entry/fallthrough paths for alias generations and correlate a restricted post-risk `try` continuation with its `catch` through one completion identity.
      - [x] Compose nested restricted try completion identities and recognize TypeChecker-resolved direct/literal-computed getters as preceding throw risks.
      - [x] Resolve computed getter candidates from exact const aliases and finite string/number literal-union key domains while retaining open keys as unknown.
      - [x] Treat property reads from a direct standard `Proxy` or cycle-safe immutable local receiver alias as a preceding throw risk; mutable receiver provenance remains unknown.
      - [x] Follow cycle-safe zero-argument single-return Proxy factories through TypeChecker-resolved local/imported functions, re-exports, and immutable wrapper chains; argument-dependent factories remain unknown.
      - [x] Accept zero-argument Proxy factories whose restricted `if`/`else` CFG has only Proxy-valued normal return paths; reject fallthrough, mixed returns, and unsupported control flow.
      - [x] Substitute supplied call arguments for identifier parameters through nested and imported/re-exported Proxy factory chains; reject missing, rest, and destructured parameter bindings.
      - [x] Specialize restricted factory `if` branches from substituted boolean literals, immutable aliases, negation, and boolean default parameters while retaining dynamic mixed branches as unknown.
      - [x] Fold strict equality and inequality between substituted string/number/boolean literals for factory branch specialization without applying coercive equality.
      - [x] Select static string/number/boolean `switch` entries with ordered case evaluation, default selection, and fallthrough until return or unlabeled break; dynamic labels and discriminants remain unknown.
      - [x] Fold boolean-only `&&` and `||` predicates in left-to-right short-circuit order; non-boolean truthiness and dynamic residual operands remain unknown.
      - [x] Select a static ternary Proxy-factory branch through the shared primitive evaluator; dynamic conditions still require both expression branches to prove Proxy provenance.
      - [x] Execute `for` initializers, loop conditions, `for...in`/`for...of` source expressions, and `for` incrementors in Promise-ownership loop closures, including zero-iteration and `continue` paths.
      - [x] Prune loop entry/exit edges for finite literal and immutable-const truthiness, including conditionless `for (;;)` and one-shot `do...while (false)` execution.
      - [x] Route guaranteed `never` + `Throw<E>` completions from loop conditions, `for` initializers/incrementors, and `for...in`/`for...of` source expressions into the enclosing structured catch.
      - [x] Preserve Promise observation across a loop-local catch/retry join with a statically primitive non-throwing prefix, a direct tracked `await`, and a suffix that does not replace the tracked generation; retain conservative entries for earlier throw risks or later reassignment.
      - [x] Join nested `if`/`else` catch-entry paths when a primitive non-throwing condition and both branches must observe the tracked Promise before any throw risk; keep one-sided observation and call/property conditions conservative.
      - [x] Join exhaustive finite-literal/default `switch` catch-entry paths, including empty-label fallthrough groups, when every possible entry must observe before risk; reject unobserved cases and throw-capable discriminants or labels.
      - [x] Compose nested `try`/`catch`/`finally` into an outer catch-entry proof when the inner try must observe first and its handlers do not replace the tracked generation; reject replacement-before-later-throw paths.
      - [x] Treat every TypeScript assignment operator, including logical assignment, as a tracked Promise generation replacement in the ownership fixed point.
      - [x] Materialize straight-line direct Promise reassignments as distinct
        ownership resources while retaining the structured fixed point for
        branch/loop/switch/try replacements.
      - [ ] Compute general CFG and loop data fixed points for exception-heavy scalar ownership state; keep Promise/resource generation lowering in #9. ([#25](https://github.com/mizchi/uneffect/issues/25))
      - [ ] Track Promise/resource generations through escaping aliases and dynamically dispatched ownership transfers. ([#24](https://github.com/mizchi/uneffect/issues/24))
- [x] Extend floating-Promise analysis from expression statements to initialized/deferred local binding ownership, aliases, reassignment loss, and path-sensitive observation.
  - [x] Track declarations, direct aliases, aggregate storage, argument transfer, return, and eventual observation within a function.
  - [x] Make explicit `void` abandonment policy configurable separately from proven rejection handling.
  - [x] Add restricted path-sensitive must-observe analysis for `if` branches, Promise reassignment, zero-iteration `while`/`for` paths, and at-least-once `do` loops.
  - [x] Cover finite exhaustive `switch` entry/fallthrough and conservative `try`/`catch` alternatives with mandatory `finally` execution.
  - [ ] Replace the restricted path walker with a general CFG fixed point covering arbitrary `switch`/`try`/`finally` joins and irreducible loops. ([#25](https://github.com/mizchi/uneffect/issues/25))
    - [x] Compute a finite abstract-state loop closure and propagate unlabeled/labeled `break` and `continue` without executing skipped statements.
    - [x] Route explicit `throw` completions into the nearest structured `catch` with their Promise ownership state, while retaining a conservative catch entry for expression-level synchronous throws.
    - [x] Treat a direct expression-statement call as a guaranteed catch edge only when TypeScript proves `never` return and the resolved declaration explicitly carries `Throw<E>`; keep unannotated `never` termination/divergence distinct.
    - [x] Preserve guaranteed `never` + `Throw<E>` completion through return, transparent wrappers, a single initializer, comma-tail evaluation, and all-throw ternary joins; keep partial ternaries and unresolved compounds conservative.
    - [x] Preserve guaranteed throw completion through `&&`/`||` when the left throws or finite literal/immutable-const truthiness proves the throwing right side is evaluated; retain unknown short-circuit paths conservatively.
    - [x] Preserve guaranteed throw completion through `??` when the left throws or a statically nullish literal, `void`, global `undefined`, or immutable alias proves the throwing right side is evaluated; retain nullable unions and shadowed identifiers conservatively.
    - [ ] Build a general exception-aware CFG fixed point for complex loop joins beyond the bounded, statically owned nested-label fragment. ([#25](https://github.com/mizchi/uneffect/issues/25))
  - [x] Define `consumes_rejection` callee contracts for explicit Promise rejection-responsibility transfer by parameter index.
  - [x] Validate malformed/out-of-range ownership contract indices and infer direct wrapper propagation.
  - [x] Add `consumes_callback_rejection` for Promise-returning callback ownership and diagnose unsafe async callbacks such as `forEach(async ...)`.
  - [x] Recognize standard Promise reaction callback assimilation by TypeScript declaration identity.
  - [x] Transfer rejection ownership from a standard `Array`/`ReadonlyArray.map(async ...)` result passed directly to standard `Promise.all`, `allSettled`, `race`, or `any`; keep detached, aliased, and user-defined aggregation fail-closed.
  - [x] Propagate callback ownership through direct unconditional higher-order wrappers, including named async callbacks.
  - [x] Add literal-guarded `consumes_rejection_when` and `consumes_callback_rejection_when`; only a proven `true` call-site guard becomes must-consume.
  - [x] Prove ownership guards from TypeScript boolean narrowing and local `requires guard` / `requires guard === true` preconditions.
  - [x] Parse compound boolean ownership guards through the shared logic IR and discharge finite propositional implications.
  - [x] Retain verified and unresolved ownership obligations with evidence in Async IR and emit SMT-LIB/Quint verifier programs.
  - [x] Import Z3 and Quint executions with backend version, program/obligation hashes, output, and exit status; only successful proofs become verified evidence.
  - [x] Add CI provisioning for the Java runtime required by Quint's TLC/Apalache verification backend.
- [x] Refine thenable assimilation within the finite, proof-supported static fragment; preserve arbitrary dynamic code as an explicit gradual unknown boundary.
  - [x] Model self-resolution rejection, direct local throwing `then` getters, and direct local hostile thenables with first-call-wins settlement.
  - [x] Model conditional local getters, direct `Proxy` thenables, and direct external/imported `PromiseLike` symbol identities as conservative fulfill/reject/pending assimilation with `InvokeUserCode` capability effects.
  - [x] Resolve exact finite computed selections, recursive local thenable cycles, and restricted conditional/forwarding Proxy trap behavior.
    - [x] Resolve `as const` tuple thenables selected by a reassignment-free literal `const` index while retaining mutable arrays as dynamic assimilation.
    - [x] Resolve `as const` object thenables selected by a reassignment-free string/number literal `const` key while retaining mutable records as dynamic assimilation.
    - [x] Follow cycle-safe immutable `const` alias chains for exact tuple/object containers and their literal selection keys.
    - [x] Resolve direct property access on immutable `as const` thenable tables, including shorthand properties, while retaining getters and mutable objects as dynamic.
    - [x] Expand finite conditional string/number keys over immutable object/tuple thenable tables into exact alternative adoption identities.
    - [x] Detect exact self and mutual cycles in the linked local thenable graph and keep the adopting Promise pending instead of inventing terminal outcomes.
    - [x] Resolve direct local factory calls whose every explicit return is an analyzable thenable literal.
    - [x] Preserve imported `PromiseLike` call results as conservative external assimilation nodes using their call-site type and span.
    - [x] Preserve arbitrary typed dynamic selections conservatively, and link direct conditional branches exactly by local thenable symbol identity.
    - [x] Preserve conservative fulfill/reject/pending outcomes when an exact nested target is unavailable.
    - [x] Resolve cycle-safe direct and immutable-const identity wrappers around a Proxy `then` callback by parameter symbol; reassigned, destructured, rest, defaulted, and non-definite wrappers remain dynamic.
    - [x] Specialize a Proxy callback wrapper's conditional-expression return from substituted/immutable boolean literals and negation; dynamic selectors remain conservative.
    - [x] Evaluate a Proxy `then` property guard through strict equality, immutable boolean aliases, negation, and left-to-right boolean `&&`/`||`; dynamic residual guards remain conservative.
    - [x] Select a static string/number/boolean `switch` entry in a callback wrapper with source-order labels, default, and empty-clause fallthrough; dynamic selectors and abrupt control remain conservative.
    - [x] Share one cycle-safe finite primitive evaluator across resource Proxy factories and Promise Proxy traps.
    - [x] Walk a restricted callback-wrapper block with static `if`/`else`, early return, nested blocks, and static `switch`; distinguish safe fallthrough from unsupported flow.
    - [x] Resolve declaration-ordered immutable local callback selectors when every initializer is proof-pure; effectful, mutable, and destructured declarations remain conservative.
    - [x] Link a local thenable resolving to an earlier analyzed local thenable symbol and recursively emit the nested settlement actions.
    - [x] Link external and forward local nested symbols, replacing forward placeholders in place when the initializer is analyzed.
    - [x] Register inline nested thenable literals as anonymous nodes and recursively link their exact settlement behavior.
    - [x] Recognize a direct standard `Proxy` with an object-literal `get` trap whose only statement throws; conditional and forwarded traps remain dynamic.
    - [x] Analyze a direct Proxy `get` trap whose sole return is a concrete arrow/function then callback.
    - [x] Select a concrete callback from the canonical `if (property === "then") return callback; return forwardingValue` Proxy trap shape.
    - [x] Select a concrete callback from a single exhaustive static `if`/`else` Proxy trap while retaining dynamic guards conservatively.
    - [x] Follow the fallthrough side of a static negated Proxy guard clause into its trailing callback return.
    - [x] Resolve identifier and literal-computed `get` property names on Proxy handler objects; dynamic computed names remain conservative.
    - [x] Resolve literal keys through cycle-safe immutable `const` aliases for computed Proxy handler properties; mutable and unresolved keys remain conservative.
    - [x] Resolve immutable Proxy handler object spreads in reverse last-write-wins order; opaque spreads, dynamic computed overrides, and cycles remain conservative.
    - [x] Replace ad-hoc Proxy trap branch matching with a restricted return walker for nested blocks, static `if`/`else`, early returns, and proof-pure local `const` declarations; effectful statements remain conservative.
    - [x] Walk static Proxy trap `switch` routing with source-ordered case-label evaluation, default selection, and empty-clause fallthrough; reached effectful labels remain conservative.
    - [x] Propagate statically selected `throw` completion through nested Proxy trap control flow; opaque prefixes remain conservative for nontermination and hidden effects.
    - [x] Consume an unlabeled `break` at the selected Proxy trap switch and continue into following statements; labeled breaks remain unsupported.
    - [x] Compose restricted Proxy trap `try/finally` completions so normal cleanup preserves the try result and abrupt cleanup overrides it; catches and effectful cleanup remain conservative.
    - [x] Execute a restricted Proxy trap `catch` only for a selected throw completion, skip unreachable catch bodies, and retain unknown try bodies conservatively.
    - [x] Select the `then` callback from the equivalent conditional-expression Proxy forwarding shape while keeping other property selectors dynamic.
    - [x] Follow cycle-safe immutable local `const` aliases for a selected Proxy `then` callback while retaining mutable callback bindings as dynamic.
    - [x] Follow cycle-safe immutable local `const` aliases for an object-literal Proxy handler while retaining mutable handlers as dynamic.
    - [x] Resolve an object-literal Proxy `get` property through an immutable local function alias, including concise arrow bodies, while retaining mutable traps as dynamic.
  - [x] Link direct executor resolution and inline reaction returns to another analyzed Promise chain by TypeChecker symbol identity instead of only nondeterministic terminal adoption.
  - [x] Link a directly chained `new Promise(...).catch/then/finally` root to its constructor executor without requiring an intermediate variable.
- [x] Refine iterator-based Promise combinators for finite local/imported iterables; preserve unbounded dynamic cardinality as an explicit gradual boundary.
  - [x] Model sparse array holes as fulfilled `undefined` slots and route statically typed thenable elements through assimilation.
  - [x] Model direct local standard-iterator acquisition failure and linear local-generator step failure before Promise reactions settle.
  - [x] Model throwing local iterator `next` accessors as acquisition failure and throwing `done`/`value` result accessors as step failure.
  - [x] Flatten nested array-literal spreads with exact cardinality and element order.
  - [x] Preserve `AggregateError.errors` slot order independently of Promise rejection order.
  - [x] Model finite imported custom iterables and concrete aggregate rejection reasons while retaining non-array dynamic spread cardinality as unsupported.
    - [x] Classify non-literal/custom iterator execution as `InvokeUserCode`; retain unbounded dynamic cardinality as an explicit unsupported verifier boundary.
    - [x] Bound direct conditional array iterables of equal length slot-by-slot, joining differing branch kinds to conservative assimilation.
    - [x] Add one correlated choice and per-slot presence guards for direct finite conditional arrays of differing lengths.
    - [x] Flatten immutable local `as const` tuple aliases and their spreads while keeping mutable `const` arrays dynamic.
    - [x] Make `Promise.any` aggregate rejection cardinality depend on the selected finite conditional-array branch.
    - [x] Preserve literal `Promise.reject` and direct `new Error` reasons in `Promise.any` input order and emit stable Quint artifact constants.
    - [x] Preserve the same concrete `Promise.any` rejection reasons after finite imported generator/custom-iterable expansion.
    - [x] Resolve immutable local `const` aliases of literal and direct `new Error` rejection reasons by symbol identity.
    - [x] Bound direct builtin `Set` construction over a static array, preserving insertion order and only removing statically provable duplicate identities while leaving custom or mutable Sets dynamic.
    - [x] Resolve imported finite generator functions by TypeChecker symbol identity and substitute directly yielded parameters with their call-site arguments.
    - [x] Preserve call-site substitutions inside finite generator call/constructor arguments and literal `+`, including concrete Promise rejection and Error message evidence without inventing dynamic reasons.
    - [x] Substitute finite generator parameters through template-literal spans and fold only fully concrete rejection reasons.
    - [x] Project nested static property/literal-index reads from direct immutable object arguments without evaluating getters, spreads, or dynamic keys.
    - [x] Project canonical literal indices from direct array/readonly-tuple arguments while rejecting spread-, hole-, range-, and dynamic-index ambiguity.
    - [x] Fold conditional expressions in finite generator yield arguments only when call-site substitution proves a literal boolean guard.
    - [x] Fold direct boolean negation in finite generator expression substitution without deciding dynamic truthiness.
    - [x] Fold literal-left `&&` and `||` in finite generator expression substitution while preserving short-circuit reachability and dynamic truthiness.
    - [x] Fold strict equality and inequality between substituted primitive literals without applying coercive equality.
    - [x] Admit generator-local computed `const` aliases only when call-site substitution reduces them to a primitive literal.
    - [x] Treat fully concrete template literals and restricted literal concatenations as primitive generator-local constants.
    - [x] Resolve imported immutable object literals whose standard iterator is a finite linear generator method, preserving yield order and thenable classification.
    - [x] Specialize imported single-return factories that construct the same finite iterable object, substituting directly yielded parameters with call-site arguments.
    - [x] Flatten finite imported generator/custom-iterable spreads inside array literals while retaining `InvokeUserCode`, step failure, order, cardinality, and concrete `Promise.any` reasons.
    - [x] Preserve finite iterable evidence through cycle-safe, reassignment-free local `const` aliases before direct or spread consumption; mutable aliases remain dynamic.
    - [x] Model nested/consecutive direct generator `if`/`else` (including an implicit empty else) as finite correlated paths, including unequal lengths, call-site substitution, and abrupt completion.
    - [x] Retain conditional-generator `Promise.any` reasons per selected path instead of unsoundly projecting one path onto all executions.
    - [x] Guard path-specific generator step failure with the correlated iterable choice, preserve normal join actions on the non-failing path, and exclude suffix yields after abrupt completion.
    - [x] Compose multiple correlated generator spreads with deterministic array prefix/suffix as a finite choice product while retaining effects, branch kinds, reason order, and path-specific failure guards.
    - [x] Correlate repeated TypeChecker-resolved boolean conditions and negated generator arguments across finite paths, removing contradictory choice products before Quint lowering.
    - [x] Fold literal generator guards and reject call/property/general-expression guards from the finite fragment instead of ignoring condition-evaluation effects or throws.
    - [x] Treat a bare generator `yield;` as an exact fulfilled `undefined` Promise-combinator slot.
    - [x] Flatten `yield*` over recursively finite arrays/readonly tuples and direct finite builtin Sets.
    - [x] Compose `yield*` delegation to resolved local/imported finite generators, including substitutions, correlated paths, step failures, and cycle-safe recursion rejection.
    - [x] Extend finite `yield*` delegation and cycle rejection to resolved single-return custom-iterable factories and immutable iterable objects.
    - [x] Unroll synchronous generator `for...of` over the same direct finite builtin iterable subset with symbol-based direct-yield substitution and literal guard folding.
    - [x] Specialize generator-local immutable identifier/primitive aliases for restricted guards and direct yields while rejecting mutable, destructured, and effectful initializers.
    - [x] Preserve lexical alias scope across nested generator blocks, conditional branches, and finite-loop iterations.
    - [x] Dogfood imported finite-loop and local-alias specialization in the dashboard Promise batch across a multi-file TypeScript Program.
    - [x] Bound finite iterable choice products at 32 paths and fall back to an explicit unsupported dynamic boundary instead of truncating proof state.
    - [x] Bound every finite Promise-combinator path at 256 elements and report `finite-element-limit` before generating an oversized formal model.
    - [x] Distinguish `finite-path-limit` from general `dynamic-cardinality` in async IR and rejected Quint generation.
    - [x] Report recognized but unsupported generator guards/loops/delegation as `unsupported-generator-control-flow` rather than generic dynamic cardinality.
    - [x] Flatten a direct finite builtin `Set` used as an array-literal spread while retaining stored mutable Sets as an unbounded dynamic boundary.
- [ ] Extend timer/event-loop ownership. ([#10](https://github.com/mizchi/uneffect/issues/10))
  - [x] Add a Web event-loop profile for timer tasks, intervals, draining microtask checkpoints, animation-frame callbacks, and paint opportunities.
  - [x] Model direct `cancelAnimationFrame` handles and recurring `setInterval` scheduling.
  - [x] Resolve reassignment-free local timer-handle alias chains for direct cancellation.
  - [x] Preserve versioned timer identity through direct handle reassignment and aliases captured before reassignment.
  - [x] Model `AbortSignal.timeout` as a static active-time deadline, one-shot timer-source task tagged with abstract `TimeoutError` semantics, and `Timer` capability.
  - [x] Model static `AbortSignal.any` source order, already-aborted inputs, timeout/external sources, and first-reason-wins in Web Quint.
  - [x] Link inline `AbortSignal.timeout(...)` entries in static `AbortSignal.any` arrays to their concrete timer-source tasks.
  - [x] Preserve source order and reason text for inline pre-aborted `AbortSignal.abort(...)` entries in static `AbortSignal.any` arrays.
  - [x] Propagate first-abort state through statically resolved local `AbortSignal.any` composition chains.
  - [x] Track direct timer-handle escape through opaque arguments, property storage, and return as optional external cancellation.
  - [x] Track timer-handle escape through direct array/object aggregates and inline returned closures.
  - [x] Resolve timer-handle aggregate and inline-closure escape through immutable local bindings.
  - [x] Preserve TypeScript-visible numeric browser and object-valued Node timer handle domains in async IR.
  - [x] Model static `scheduler.postTask` priority, FIFO, minimum delay, pre-abort, and Promise-returning task boundaries.
  - [x] Model top-level `scheduler.yield` at default priority and inline `postTask` continuations with inherited static priority and parent-time enqueue.
  - [x] Cancel modeled `scheduler.postTask` jobs after timeout/composition abort and inherit the same cancellation source across inline `scheduler.yield` continuations.
  - [ ] Track computed properties and imported closure factories, host-specific Node/browser timer phases and cross-host cancellation compatibility, dynamic/imported/interprocedural abort compositions, TaskSignal reprioritization, direct external-signal state, and dynamically resolved parent callbacks. ([#10](https://github.com/mizchi/uneffect/issues/10))
    - [x] Resolve direct property-access and literal computed-property method callbacks by TypeChecker symbol identity, including microtasks scheduled from their bodies.
    - [x] Resolve direct imported source callback factories when exactly one function-valued return is present in the analyzed Program.
    - [x] Preserve a direct external `AbortSignal` passed to `scheduler.postTask` as a nondeterministic cancellation state and transition, including inherited `scheduler.yield` continuations.
    - [x] Resolve `AbortSignal.timeout` returned by a direct local or imported-source factory with exactly one explicit return and bind the scheduler task to its timer source.
    - [x] Resolve static `AbortSignal.any` returned by the same source-factory subset, retaining external sources, nested timeout sources, first-abort composition identity, and scheduler cancellation.
    - [x] Substitute source-factory parameters with concrete call arguments by symbol identity, preserving pre-aborted inputs and per-call timeout/composition instances.
    - [x] Resolve immutable `scheduler.postTask` option aliases, object spreads, and literal-computed keys with last-write-wins semantics; retain mutable, accessor, dynamic-key, and opaque-spread overrides as unknown.
    - [x] Model direct synchronous `TaskController` construction and literal `setPriority` changes as ordered dynamic-priority transitions; propagate the final priority to `scheduler.yield`, while explicit `postTask` priority remains immutable.
    - [x] Add an initial Node callback-checkpoint profile for `process.nextTick`, V8 microtasks, timers, and `setImmediate`, with CLI/project verification and a broken-order oracle. ESM top-level and complete libuv phase/I/O semantics remain open.
    - [x] Merge definitely queued Promise reactions and `queueMicrotask` jobs into the Node V8 microtask FIFO below the next-tick queue.
    - [x] Match cancellation by semantic handle family: timeout/interval, Immediate, and animation-frame; incompatible clear APIs no longer prove cancellation, while Node object and browser numeric timeout handles remain the same family.
    - [x] Add explicit checkpoint, timers, abstract poll, check, and close/next-iteration phase state to the Node profile, returning through a callback checkpoint after every modeled timer/immediate callback.
    - [x] Enqueue statically resolved nested `process.nextTick` and `queueMicrotask` jobs when their parent Node callback runs instead of treating them as initially pending.
    - [x] Enqueue nested `setImmediate` registrations dynamically and defer an Immediate created inside any executing callback to the next event-loop iteration.
    - [x] Normalize static Node `setTimeout`/`setInterval` delays to the documented signed-32-bit timer range and integer semantics without changing Web or abort-timeout models.
    - [x] Preserve Fs authority and add nondeterministically completed poll-phase callbacks for reviewed one-shot `node:fs` completion APIs; streams, remaining callbacks, and readiness/order details remain open.
    - [x] Model TypeChecker-resolved `node:fs` `watch`/`watchFile` listeners as repeatable external poll work, propagate listener effects, and dogfood configuration change reporting.
    - [x] Give watcher results a distinct handle family and suppress later external arrivals after a direct definite TypeChecker-resolved `FSWatcher#close`; conditional, callback-local, and interprocedural closure remain open.
    - [x] Register nested one-shot fs/deferred poll callbacks dynamically, retain an integer registration count across repeating parents, and dogfood `watch`-triggered configuration reloads without forcing external completion.
    - [x] Keep independent fs poll completions unordered instead of inventing timer-style FIFO from source registration order.
    - [x] Classify reviewed fs callbacks as deferred by resolved builtin identity in the program call graph, preserving callback effects in the parent's capability summary across aliases.
    - [x] Dynamically register static nested Node timeout/interval calls from non-repeating callbacks.
    - [ ] Model repeated-parent timer instances, concrete poll/I/O and close callbacks, ESM top-level ordering, dynamic abort composition, and polymorphic parent callback dispatch. ([#10](https://github.com/mizchi/uneffect/issues/10))
      - [x] Preserve the multiplicity of pending one-shot timeout instances registered by a repeating parent with an unbounded integer count.
      - [x] Preserve exact FIFO due times for repeated-parent one-shot timeout instances with a Quint `List[int]` queue.
      - [x] Model repeated creation of recurring intervals by retaining each instance and rotating its next due time through the same FIFO queue.
      - [x] Analyze top-level timer/microtask and Promise-reaction calls and add an explicit Node ESM mode where initial V8 jobs precede initial `nextTick` jobs.
      - [x] Resolve the imported `node:net` `Server.close(callback)` member by TypeChecker identity and model its external completion and close-phase execution without matching user-defined `close` methods.
      - [x] Propagate capability effects from inline and named deferred builtin callback bodies into the enclosing callable summary without treating callback registration itself as that capability; keep synchronous `Throw` separate across the deferred boundary.
      - [x] Model TypeChecker-resolved `node:dns` `lookup` and `lookupService` as `Net`-capable externally completed poll callbacks while ignoring shadowed names; narrow literal `lookup` hostnames to `Net<"host">` and retain dynamic/reverse lookups as broad `Net`.
      - [x] Model TypeChecker-resolved `node:net` `connect`/`createConnection` listeners as `Net`-capable externally completed poll callbacks, narrow literal host/port overloads to `Net<"host:port">`, and dogfood the dynamic boundary on a TCP client adapter.
      - [x] Apply the same poll-phase and scoped `Net` semantics to TypeChecker-resolved `node:net` `Socket#connect`, reject same-named lookalikes, and dogfood a reconnect adapter.
      - [x] Model TypeChecker-resolved `node:crypto` `randomBytes` as `Random`, add poll completion only for the callback overload, reject same-named lookalikes, and dogfood asynchronous token generation.
      - [x] Model TypeChecker-resolved `node:http`/`node:https` `request` and `get` response listeners as poll work, distinguish callback-omitting overloads by callable type, narrow literal URL/options authority, and dogfood an HTTPS health check.
      - [x] Track TypeChecker-resolved `node:net` `Server#listen` as scoped `Net` authority, enqueue its optional listening callback on Node's next-tick queue, reject same-named lookalikes, and dogfood an HTTP health server.
      - [x] Model TypeChecker-resolved `node:net`/`node:http`/`node:https` `createServer` listeners as repeatable externally completed poll work, propagate their callback effects, and verify repeated request arrivals in Quint.
      - [x] Count one-shot close registrations created by repeating request listeners, compose their close-phase microtasks, and dogfood a request-triggered shutdown while documenting the conservative post-close arrival gap.
      - [x] Link callback-bearing `Server.close` calls to the matching immutable `createServer` result, prohibit later request arrivals after nested close registration, and initialize directly closed sources as closed.
      - [x] Apply the same source closure when `Server.close()` omits its optional callback, both inside a request listener and before the modeled loop starts.
      - [x] Refuse to prove source closure for conditional/loop-contained `Server.close` calls while conservatively retaining possible callback work.
      - [x] Track TypeChecker-resolved `node:child_process` execution as Deno-compatible `Run`: keep shell-based `exec`/`execSync` and `fork` broad, narrow literal `execFile`/`execFileSync`/`spawn`/`spawnSync`, model only completion callbacks as poll work, and dogfood a scoped Git adapter.
      - [x] Preserve complete source paths for direct conditional arrays passed to `AbortSignal.any`, including path-specific pre-abort state and scheduler guards in the Web Quint profile.
      - [x] Resolve an immediately consumed, preceding-statement `const` alias of a conditional abort-source array while rejecting intervening mutation.
      - [x] Extend conditional abort-source aliases across unrelated statements when symbol-identity analysis proves the `const` array has no intervening reference, while retaining conservative rejection for mutation and escape.
      - [x] Preserve finite conditional timer callback alternatives in IR and emit exclusive Node/Web parent actions instead of enqueueing every branch's nested jobs together.
      - [x] Generalize exclusive callback-alternative actions to Node next-tick/microtask/poll/check/close and Web microtask/animation-frame/scheduler parents.
      - [x] Specialize callback parameters of non-exported, non-escaping local higher-order functions when every direct call supplies a finite source callback candidate set.
      - [ ] Model remaining concrete poll/I/O and close event/listener callbacks, escaped/mutated dynamic abort composition, and open/imported polymorphic callback-parameter dispatch. ([#10](https://github.com/mizchi/uneffect/issues/10))
  - [x] Unify definitely queued Promise reactions, `queueMicrotask`, and modeled microtask checkpoints.
  - [x] Preserve dynamic FIFO enqueue order between Promise reactions created by reactions and already queued jobs.
  - [x] Extract `queueMicrotask` calls made inside inline callbacks and enqueue them dynamically rather than only modeling top-level registrations.
  - [x] Resolve local/imported named function and variable callback bodies by TypeChecker identity and propagate dynamically scheduled microtasks.
  - [x] Resolve proof-supported methods, finite callback-factory returns, and finite dynamically selected callback values.
    - [x] Resolve direct property-access and literal computed-property methods; polymorphic receiver dispatch remains dynamic.
    - [x] Resolve direct local or imported-source callback factories with exactly one explicit function-valued return.
    - [x] Resolve every branch of a finite conditional scheduled callback when all branches have TypeChecker-resolved bodies; partial or external selections remain dynamic.
    - [x] Resolve finite literal-key selections from immutable `as const` callback tables through local alias chains; mutable records, getters, missing keys, and unresolved members remain dynamic.
    - [x] Specialize callback-factory parameter symbols from finite literal call arguments, including identity factories and immutable callback-table selection.
    - [x] Bind `this` to immutable object-literal method-factory receivers for finite callback-table selection; mutable and polymorphic receivers remain dynamic.
    - [x] Avoid `InvokeUserCode` coercion effects for TypeChecker-proven string/number key unions while preserving accessor effects for every finite literal property candidate.
    - [x] Resolve all callbacks from a definite-return factory CFG subset, including `if`/`else`, early return, concise conditional functions, and immutable arrow/function bindings; fallthrough and unsupported control flow remain dynamic.
- [x] Bring Promise/resource IR to Rust/Corsa parity.
  - [x] Serialize Promise observation, rejection ownership, resource scopes, async disposal, and exact `SuppressedError` payloads.
  - [x] Add cross-frontend parity fixtures and reject schema drift.
- [x] Dogfood against representative external TypeScript programs.
  - [x] Integrate program-wide gradual effect checking into `verifyUneffectProject`; annotated capability upper bounds now fail through the unified project diagnostics.
  - [x] Return program-wide effect summaries from `verifyUneffectProject` so adoption tooling can inspect attributed authority as well as failures.
  - [x] Compose uniquely resolved, verified child-project function Effect summaries into parent project calls and emit an `effectComposition` provenance ledger.
  - [x] Compose uniquely resolved, verified child-project `<module>` Effect summaries into runtime imports, including transitive initialization effects; trusted/unknown/ambiguous summaries fail closed.
  - [x] Extend cross-project Effect composition beyond the verified parameter-rooted `Mutate` fragment to stable exported non-parameter/module region identities and iterator Effect parameters.
    - [x] Preserve function parameter metadata, substitute `Mutate<typeof parameter.member>` through resolved import aliases and addressable nested member arguments, and diagnose uninstantiable arguments as unknown.
    - [x] Define source-stable identity for exported non-parameter function and module mutation regions across declaration outputs.
      - [x] Bind an exported function-closure mutation root to a project/source/export identity, verify its current declaration with TypeChecker identity, and substitute only a matching named or namespace import in the parent; inaccessible, same-named-different, and non-exported roots remain unknown.
      - [x] Extend the same identity contract to module-initialization mutation regions and multi-hop re-export chains; the importing module must expose an exact TypeChecker-resolved binding or its module evidence becomes unknown.
      - [x] Define `globalThis` as the explicit `ecmascript:realm.globalThis` identity for function and module mutation composition within one runtime realm.
      - [x] Define the first opt-in host identity for Node ambient `global`, binding the `@types/node` major and an explicit realm label while rejecting incompatible labels, versions, and local shadows. Broader browser/Worker/iframe identities remain with [#10](https://github.com/mizchi/uneffect/issues/10).
    - [x] Instantiate fully bounded iterator Effect parameters across project-reference call boundaries, including direct/stored/pure/forwarded arguments, bound mismatch diagnostics, and Promise `Throw` conversion; unbounded or opaque inputs remain unknown.
  - [x] Share cross-project Effect composition with the `uneffect check --project` CLI workspace path and expose the same provenance/blocker ledger in JSON.
  - [x] Attach stable source identity and spans to Program-produced effect summaries so same-named callables remain distinguishable.
  - [x] Dogfood a scoped Node settings read whose fs callback composes Console/Timer authority with poll and checkpoint ordering, including a missing-Console negative control.
  - [x] Add a controlled Node CLI, browser DOM app, and Worker transfer corpus with adoption KPI reporting.
  - [x] Run inference-only frontend compatibility over the pinned external `effect` Function module graph; this does not enforce external boundaries.
  - [x] Record false-positive rate, unknown-summary rate, builtin drift, annotation density, verifier time, and frontend time in one machine-readable adoption report.
    - [x] Record controlled-corpus false positives, unknown summaries, annotation density, enforced boundaries, and frontend time.
    - [x] Record external Effect graph source/function counts, unknown summaries, diagnostics, builtin declaration drift, and frontend time.
    - [x] Add a reviewed external Effect `pipe` adapter boundary with a positive Console authority check and missing/unused-effect negative control.
    - [x] Verify an affine Hoare contract through an external Effect `pipe` adapter with Z3 and record verifier time.
    - [x] Verify Web task/microtask queue safety for an external Effect `pipe` timer adapter with Quint and record verifier time.
  - [x] Compare equivalent native Promise, Uneffect, and Effect TS implementations.
    - [x] Compare observable recovered output and an explicit common authority manifest.
    - [x] Model Effect TS `tryPromise` failure ownership by package symbol identity and compare the actual `catchAll` recovery path rather than a normalized Effect outcome.

## Path-sensitive contract integration

- [x] Preserve each supported return/loop completion as
  `uneffect-contract-control-flow/v1` evidence with a source-stable basic-block
  identity and the exact path assumptions supplied to Z3.
- [x] Lower one-to-eight-clause numeric/Boolean literal `switch` statements
  into explicit entry paths, including default, fallthrough, nested
  `if`/`try` propagation, and target-owned unlabeled `break`; compose throw
  exits with catch/discharge and reject dynamic, duplicate, mixed-sort, labeled,
  or escaping control.
  - [x] Connect TypeChecker-validated readonly string discriminants, including
    immutable aliases, to the same switch entries/default/fallthrough and
    narrowed payload facts without introducing an unconstrained SMT string;
    reject open/mutable discriminants and literals outside the finite family.
- [x] Give invariant-backed `while`, canonical scalar `for`, and `do...while`
  loops target-owned unlabeled `break`/`continue` completions. Prove `continue`
  at the back edge (`for` after its assignment or `++/--` update), normalize
  `break` as an exit, preserve ownership through nested switch/try/finally, and
  reject labels, missing invariants, multi-binding/sequence headers, or escaped
  control.
- [x] Reuse one symbolic identifier updater for statement-level and canonical
  `for` `++`, `--`, `=`, `+=`, `-=`, and `*=`. Reject property/sequence
  mutation and keep `/=`/`%=` unsupported until JS division/remainder semantics
  are represented rather than silently using Z3 integer `div`/`mod`; reviewed
  Boolean logical assignments are handled by the path evaluator below.
  - [x] Route ordinary-statement `+=`, `-=`, and `*=` right operands through
    the shared path evaluator, so conditional expressions, reviewed Math calls,
    and the supported signed-remainder fragment retain their branches. Require
    matching numeric IR sorts; canonical loop-header updates remain deliberately
    single-path.
- [x] Remove direct `/` and `%` from the Hoare expression lowering after a
  negative-control demonstrated that SMT `mod` could verify `result >= 0` for
  JavaScript's negative remainder. Reject manual unknown SMT operators too;
  raw division/remainder must not create proof evidence.
  - [x] Reintroduce `%` for an Int-valued left operand and a direct nonzero
    safe-integer literal divisor. Split on dividend sign and encode the negative
    path as `-mod(-value, abs(divisor))`, matching JavaScript signed remainder.
- [ ] Reintroduce `/`, dynamic/zero/Real `%`, `/=`, and `%=` only with JavaScript truncation, finite/nonzero divisor obligations, signed remainder, and domain-correct Int/Real result sorts. ([#6](https://github.com/mizchi/uneffect/issues/6))
  - [x] Reuse the reviewed signed-Int remainder lowering for statement-level
    `%=` with a direct nonzero safe-integer literal divisor. Dynamic, zero, and
    Real divisors remain fail-closed; `/` and `/=` still require a sound
    fractional-result and finite-number model.
  - [ ] Add a finite JavaScript-number abstraction before admitting `/`, `/=`, ([#6](https://github.com/mizchi/uneffect/issues/6))
    or dynamic/Real remainder; require explicit nonzero-divisor evidence and
    preserve truncation, fractional results, NaN, and infinities without
    coercing them into SMT Int arithmetic.
- [x] Apply one lexical-scope join to bare blocks and supported `if`, loop,
  `try`, `catch`, and `finally` block bodies. Retain writes to outer and
  function-scoped `var` bindings, remove block-local `let`/`const` at exit, and
  reject lexical or catch bindings that shadow a tracked scalar until the
  environment is keyed by TypeChecker symbol identity.
  - [x] Admit explicitly typed, uninitialized block-scoped `let` bindings for
    `number`/`Int`/`Nat`/`Float`/`boolean` only when the exact TypeScript Program
    has no definite-assignment error. Seed an unconstrained placeholder so
    try/catch joins retain binding identity, then require supported assignments
    to replace it before use; record Program-bound narrowing evidence. Inferred,
    nullable, destructured, `var`, and erroneous declarations remain unknown.
- [x] Split recursive scalar conditional expressions into explicit true/false
  path assumptions for direct return values, initialized identifier bindings,
  and plain assignments. Keep call-conditioned, non-scalar, and abrupt/effectful
  branches outside this evaluator rather than encoding an opaque `ite`.
- [x] Lower direct TypeChecker-resolved standard-library `Math.abs` and one-to-
  four-argument `Math.min`/`Math.max` calls into comparison-selected scalar
  paths. Require the merged global `Math` receiver, exact standard `lib.*.d.ts`
  member and signature identity, and numeric arguments; shadowed objects, zero/over-
  budget arity, and call/effect-valued arguments fail closed.
  - [x] Resolve reassignment-free `const abs = Math.abs`, `const { min: name } =
    Math`, and identifier-only `const` alias chains by exact binding/member
    identity. Keep `let`, shadowed receivers, computed properties, defaults,
    rest bindings, and dynamic aliases outside the reviewed call set.
  - [x] Add TypeChecker-resolved `Math.floor`, `Math.ceil`, `Math.trunc`, and
    `Math.round` over the contract integer/finite-Real abstraction. Emit SMT
    `to_int` for floor, derive ceil by negation, split trunc by sign, and model
    round as floor of `x + 0.5`; retain NaN, infinities, and signed zero outside
    the claim and accept aliases only through standard `lib.*.d.ts` identity.
  - [x] Lower standard `Math.sign` through the same identity and immutable-alias
    layer into exhaustive negative/zero/positive paths over the Int/finite-Real
    abstraction. Keep NaN and negative-zero identity outside the claim.
  - [x] Lower numeric `base ** exponent` and reviewed `Math.pow(base, exponent)`
    to repeated multiplication when the exponent is a direct non-negative
    integer literal from zero through eight. Evaluate the base once, reuse Math
    aliases by symbol identity, and reject dynamic, negative, over-budget, or
    shadowed forms.
- [x] Split TypeChecker-proven Boolean `&&` and `||` expressions in the same
  scalar evaluator, preserving left-to-right short-circuit reachability through
  nested return, initialized binding, and plain assignment forms. Reject
  JavaScript truthiness and call/effect-valued operands instead of eagerly
  encoding them as Boolean SMT expressions.
- [x] Reuse those Boolean short-circuit paths for identifier-only `&&=` and
  `||=` logical assignment. Read the prior binding once, preserve it on the
  skipped path, and evaluate/assign the right operand only on the selected
  path; non-Boolean and call/effect-valued operands fail closed.
- [x] Add identifier-only numeric or Boolean `??=` by splitting the
  TypeChecker-backed nullable presence state and evaluating the right side only
  on the nullish path. A scalar RHS establishes presence; a compatible nullable
  RHS copies its payload and presence, so subsequent coalescing and guards never
  reuse stale evidence. Properties, mutable aliases, incompatible absence
  domains, and call-valued right sides remain fail-closed. ([#25](https://github.com/mizchi/uneffect/issues/25))
- [ ] Import sound TypeChecker narrowing facts into the contract logic IR; each ([#25](https://github.com/mizchi/uneffect/issues/25))
  admitted narrowing form needs a same-spelled/shadowed negative control.
  - [x] Admit one-to-sixteen-member safe-integer literal unions, including
    imported type aliases, and bind the evidence to TypeScript version, compiler
    options, and every non-declaration Program source digest. Programs with
    TypeScript errors and plain `number` aliases contribute no finite-range fact.
  - [x] Admit TypeChecker-validated `typeof` guards for exact `number | string`
    and `boolean | string` unions, accepting either the scalar member or its
    string complement, plus nullish equality guards for nullable numeric or
    Boolean scalars; bind each guard to the exact parameter symbol and
    comparison source span.
  - [x] Treat `typeof value ===/!== "undefined"` as the complement of the
    presence fact only for exact numeric or Boolean `T | undefined`. Keep
    `T | null | undefined` unsupported because one Boolean presence fact cannot
    distinguish null from undefined.
  - [x] Correlate nullable Boolean presence with truthiness by asserting
    `!defined => !payload`; this admits direct Boolean conditions without
    pretending absent values may be true. Route ternary, `if`, loop, and
    reviewed assertion conditions through one Boolean-sort gate so nullable
    numeric and other JavaScript truthiness remain explicit non-proofs.
  - [x] Lower TypeChecker-bound nullable Boolean equality with `true`/`false`
    as `defined && payloadMatches`, and inequality as its complement, for both
    strict and loose operators. This keeps null/undefined distinct from false.
    Reject a mutable direct scalar copy while its use-site type remains nullable;
    permit the same initialization or assignment after TypeChecker narrowing
    excludes nullish values.
  - [x] Make a plain assignment to a nullable numeric or Boolean identifier
    update its payload and set presence to true on every RHS path. Reject a
    nullable RHS that cannot establish presence and property targets rather than
    retaining stale pre-assignment evidence.
  - [x] Accept a direct `null` or TypeChecker-exact `undefined` assignment when
    that absent member belongs to the target union, set presence to false, and
    set nullable Boolean payloads to false for truthiness. Reject the wrong
    absent member and call/dynamic nullish producers.
  - [x] Generalize nullable assignment RHS evaluation across recursive scalar
    conditionals and compatible nullable identifiers. Copy payload and presence
    together only when the source absence domain is contained by the target;
    retain mutable local aliases without their own presence state as unsupported.
  - [x] Fail closed when a nullable parameter is mutated while a tracked immutable
    alias shares its presence state. Read-only aliases remain supported; precise
    declaration-point snapshots after source mutation remain future work.
  - [x] Split direct numeric or Boolean `value ?? fallback` expressions using that same
    TypeChecker-validated presence fact, keeping the Boolean defined state and
    scalar payload separate through return, initialized binding, and plain
    assignment. Preserve immutable identifier aliases; mutable aliases,
    property/optional-chain operands, and call-valued fallbacks fail closed.
  - [x] Admit direct equality/inequality guards over a two-to-eight-member
    readonly string-discriminated object union as an explicit exactly-one
    Boolean family, bound to the parameter symbol and comparison span;
    same-spelled objects, open strings, and mutable discriminants remain
    unsupported.
  - [x] Resolve named and namespace `node:assert/strict` `ok(condition)` through
    its exact import binding and TypeScript assertion signature, split normal
    continuation from `Throw<AssertionError>`, retain the reviewed builtin in
    the assumption ledger, and reject same-shaped user assertion functions.
  - [x] Generalize the reviewed Node assertion binding through the common
    frontend adapter for named, namespace, default, and import-equals forms.
  - [x] Register non-strict `node:assert` named `ok` and default callable
    bindings through catalog `default` export semantics; do not infer narrowing
    from coercive equality helpers.
  - [x] Register `strictEqual` and `notStrictEqual` from `node:assert/strict` and
    `node:assert`, and split matching-sort non-nullable scalar equality or
    inequality into normal and trusted `Throw<AssertionError>` paths. Nullable
    and mismatched operands remain fail-closed rather than losing presence or
    sort evidence.
  - [x] Register `fail` from both Node assertion modules as an unconditional
    trusted `Throw<AssertionError>` completion and route it directly through
    the existing catch/discharge CFG. Same-named user functions remain unknown.
  - [x] Register `ifError` from both Node assertion modules and map a tracked
    nullable numeric/Boolean or presence-only object identifier/immutable alias
    to `!defined` normal continuation and `defined` `Throw<AssertionError>`.
  - [x] Represent a TypeChecker-exact union consisting only of one-or-more
    object types plus null and/or undefined by a payload-free Boolean presence
    fact. Keep mixed primitive/object unions and all heap contents opaque.
  - [x] Update payload-free object presence on direct null/undefined assignment,
    a TypeChecker-proven present object identifier, or a compatible nullable
    identifier copy. Reuse alias-mutation fail-closed checks.
  - [x] Admit empty object/array literals and direct standard
    `Error`/`TypeError`/`RangeError`/`ReferenceError`/`SyntaxError`/`URIError`/
    `EvalError` construction with zero or one static string argument as fresh
    present objects, including conditional RHS branches. Shadowed constructors,
    effectful arguments, non-empty literals, calls, properties, and incompatible
    absence domains remain unknown.
  - [x] Route identifier-only `??=` for presence-only object unions through the
    same defined/nullish split and nullable assignment evaluator. Reviewed fresh
    producers and non-null object identifiers can establish presence; shared
    immutable aliases and effectful RHS values remain fail-closed.
  - [x] Lower a direct readonly discriminant payload access to its
    TypeChecker-narrowed safe-integer/Boolean literal at the exact access span;
    pre-narrow unions, mutable payloads, and same-spelled objects fail closed.
  - [x] Represent direct readonly scalar `number`/`boolean`/`Int`/`Nat`/`Float`
    payloads as member-scoped solver variables after TypeChecker discriminant
    narrowing; preserve `Nat` bounds and leave plain `number` unconstrained.
  - [x] Preserve discriminant and payload facts through TypeChecker-resolved
    identifier-only immutable object alias chains, while excluding their
    declarations from the scalar environment; mutable and destructured aliases
    fail closed.
  - [x] Admit one unambiguous one-to-four-segment readonly parameter property
    path as a discriminated-union root when it is first selected into an
    identifier-only immutable alias; mutable, computed, cyclic, over-depth, or
    ambiguous roots fail closed.
  - [x] Lower a readonly dot-property path from the narrowed union root to a
    terminal scalar literal or `number`/`boolean`/`Int`/`Nat`/`Float` value;
    every intermediate property must be readonly and computed access fails
    closed.
  - [x] Lower `const` object destructuring of narrowed readonly scalar payloads,
    including renamed bindings and readonly nested payload sources, by exact
    binding/property identity; pre-narrow, mutable, defaulted, rest, and
    computed forms fail closed.
  - [x] Lower fixed non-negative literal index reads and `const` array
    destructuring from narrowed readonly tuple payloads. Require a readonly
    rooted property path and readonly tuple identity; mutable/ordinary arrays,
    dynamic indexes, holes, defaults, rest, and nested bindings fail closed.
  - [ ] Extend narrowing to composite object/array values and further reviewed assertion APIs. ([#25](https://github.com/mizchi/uneffect/issues/25))
- [x] Route `return`, synchronous `throw`, and TypeChecker-resolved direct
  `never` calls with declared `Throw<E>` through one
  exception-aware contract exit model without treating Promise rejection as a
  synchronous throw.
- [x] Make effect `discharge` path-sensitive over that shared exit model and
  retain rejected/unknown paths in the evidence ledger.
- [x] Dogfood the combined model on an application adapter containing narrowing,
  early returns, caught throws, capability boundaries, and Promise ownership.
- [x] Extend the bounded exception-aware contract CFG through supported
  `finally` completion override, scalar catch-payload binding, and a direct
  TypeChecker-identified builtin `await Promise.reject(value)` rejection edge.
  Rejection remains distinct from synchronous `Throw<E>` and therefore is not
  required in the synchronous Effect boundary.
- [x] Connect TypeChecker-resolved Promise-returning calls carrying a trusted
  `temporal_contract rejects E` declaration to may-reject contract paths, while
  preserving declared `temporal_contract throws E` as separate synchronous
  edges and rejecting annotations attached to non-Promise return types.
- [x] Compose scalar fulfilled values from a trusted callee
  `contract ensures` summary through one direct `const value = await call()` or
  `return await call()`; record the declaration/call spans and clauses as
  `relationalCalls`.
- [x] Emit one source-mapped `call-precondition` obligation per callee
  `contract requires` clause and prove it from the exact caller path conditions;
  a failed implication is a counterexample rather than an assumed precondition.
- [x] Reconcile same-file relational calls with local callee artifacts to a
  fixed point: promote acyclic fully verified chains from `trusted` to
  `verified`, propagate a failing/unknown callee back to callers as `unknown`,
  and retain external declarations and circular proof chains as `trusted`.
- [x] Generalize the reconciler across source files in one checked TypeScript
  Program, bind each relation to declaration file/span/SHA-256 and exact
  TypeScript version, expose the reconciler publicly, and run it from project
  verification. Stale declaration evidence downgrades the caller to `unknown`.
- [x] Define `uneffect-contract-summary/v1` producer bundles for fully verified
  direct named exports, including exact package/version, compiler-options,
  producer source, declaration, TypeChecker signature, clauses, and artifact
  IDs; validate every digest and reject counterexample/trusted dependencies.
- [ ] Generalize exception-aware contracts to inferred/unannotated Promise-producing calls, ([#25](https://github.com/mizchi/uneffect/issues/25))
  assignment/property/destructured awaited values, opaque/non-scalar catch
  payloads, `.d.ts`/export-map/tarball consumer linkage for persisted package
  summaries, publisher authenticity, and interprocedural scalar/heap state.
  - [x] Route direct `identifier = await call()` through the same trusted scalar
    fulfillment, precondition, rejection, synchronous-throw, catch, and
    relational-evidence path as initialized bindings and `return await`.
    Property/destructured targets remain fail-closed.
  - [x] Make direct nullable numeric/Boolean identifier await assignment
    presence-aware: verified scalar fulfillment updates payload and presence on
    the normal edge only, while rejection and synchronous throw retain the
    incoming state. Shared immutable aliases and presence-only object targets
    remain fail-closed.
  - [x] Infer verified scalar fulfillment for the exact standard-library
    `Promise.resolve(value)` identity when `value` itself is numeric or Boolean.
    Shadowed members, omitted arguments, Promise/thenable assimilation, and
    non-scalar payloads remain fail-closed.
  - [x] Resolve standard `Promise.resolve` and `Promise.reject` producers by
    TypeChecker signature declaration identity rather than callee spelling, so
    immutable callable aliases share the builtin semantics without admitting
    same-named user implementations.
  - [x] Infer a verified scalar fulfillment relation from a local `async`
    function declaration, `const` arrow, or `const` function expression whose
    implementation is exactly one pure scalar `return` expression closed over
    identifier parameters and direct immutable safe-integer/Boolean literal
    `const` captures. Direct calls and immutable callable aliases are supported;
    mutable or computed/object captures, default/rest or destructured
    parameters, mutable callables, multi-statement bodies, and Promise/thenable
    returns remain fail-closed.
  - [x] Extend that implementation-derived fulfillment to one Boolean
    `if (condition) return a; return b` or exhaustive `if/else` return split.
    Lower the branches as two path-conditioned scalar clauses rather than
    assuming one return globally; non-Boolean truthiness and non-returning
    branches remain fail-closed.
  - [x] Normalize a top-level scalar conditional return expression (including
    an expression-bodied async arrow) into the same two branch clauses.
    TypeChecker-rejected/non-Boolean truthiness remains fail-closed.
  - [x] Compose a leading sequence of single-binding
    `const identifier = pureScalarExpression` declarations into the inferred
    local async summary. Each initializer is substituted through the preceding
    symbolic environment before return/branch/throw normalization. `let`/`var`,
    destructuring, multi-declaration statements, calls, and unsupported scalar
    operators remain fail-closed.
  - [x] Infer the common local async guard shape
    `if (bad) throw new StandardError(staticMessage); return value`, its
    `if (valid) return value; throw` inverse, and exhaustive `if/else`
    return/throw forms as one product of verified `Reject<Error>` and normal
    fulfillment. The selected guard is a normal-path clause, so catch discharge
    and the returned refinement remain correlated. Calls/computed error
    producers remain fail-closed.
  - [x] Track `const pending = producer(args); await pending` in the contract
    PathState. Snapshot scalar arguments and synchronous throws at creation,
    settle fulfillment/rejection at await, propagate immutable identifier
    aliases, and prove callee preconditions from the call-time path. Repeated
    observation is allowed; a pending Promise that leaves its lexical/function
    scope without any observation is fail-closed.
  - [x] Preserve synchronous exception identity inside an async body for local
    `try/catch`, then convert any uncaught `Throw<E>` completion to
    `Reject<E>` exactly at the async function boundary. This applies uniformly
    to direct throw, declared never-call, assertion, and call-time throw edges.
  - [x] Infer definite rejection for a local async producer whose entire body
    is one direct `throw new StandardError(staticMessage)`, including immutable
    callable aliases and stored Promise observation. Call-produced or computed
    Error values remain fail-closed.
  - [ ] Add general inferred Promise producers, presence-only object fulfillment, ([#25](https://github.com/mizchi/uneffect/issues/25))
    property/destructured targets, opaque catch payloads, persisted consumer
    linkage/authenticity, and interprocedural heap state.

## Current validation commands

```sh
just check
just build
just formal
just spec-ir examples/spec.ts
just spec-z3 examples/spec.ts inc
just spec-quint examples/spec.ts
just formal-z3
just formal-quint
just formal-exhaustive # requires Java/Apalache
just package-check
just dogfood
```
## Semantics modules

- [x] Add fail-closed `uneffect-module/v1` manifests for namespaced effect schemas and reviewed registry overlays, with an evidence digest ledger.

## Trusted Types

- [x] Add provenance-based checks for the initial W3C `TrustedScript` sink fragment without treating TypeScript casts as trust evidence.
