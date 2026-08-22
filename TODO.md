# Uneffect implementation roadmap

This file is the implementation ledger. Work proceeds top to bottom within each priority unless a prerequisite or verifier result forces a redesign. An item is complete only when its code, regression tests, and relevant English documentation are all updated.

- [x] Replace `extractions/setup-just` with the official Linux musl release asset pinned by version and SHA-256, removing its transitive Node 20 `setup-crate` action.
- [x] Upgrade the SHA-pinned `pnpm/action-setup` workflow dependency to Node 24-native v6.0.9 and retain `actions/setup-node` pnpm-store caching.
- [x] Isolate every solver-bearing test file in its own Vitest process so a Z3 WASM heap failure cannot poison later suites in the same CI tier.

The product-level completion gates are the skipped executable scenarios in
`test/acceptance-roadmap.test.ts`. Before adding another narrow feature, select
the first relevant scenario, remove `.skip`, observe Red, and implement toward
that end-to-end result. See `docs/acceptance-roadmap.md`.

## P0 — Specification foundations

- [x] Accept only the `uneffect:` block-comment marker.
- [x] Parse source annotations into capability, invariant, and temporal projections.
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

## P1 — Capability effects

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
  - [x] Define `Run<ProgramSet>`, including the unscoped escalation case for dynamic-loader environment variables.
  - [x] Define `Sys<ApiSet>` from Deno's system-information descriptor names.
  - [x] Define `Ffi<PathSet>` and treat it as a sandbox escape boundary.
  - [x] Define `Import<HostSet>` separately from runtime `Net` access.
  - [x] Represent unscoped category access without inventing a wildcard string.
  - [x] Keep allow/deny precedence in deployment policy, not in function effect unions.
  - [x] Generate a Deno-compatible permission manifest/CLI projection from verified requirements.
- [x] Introduce a versioned builtin contract IR with stable symbol keys.
  - [x] Add the initial typed builtin overlay entry for `node:os.tmpdir() -> Path<"$TEMP">`.
  - [x] Teach the TypeChecker frontend adapter to apply builtin return refinements at call sites.
- [x] Add a registry for builtin and user-defined effect schemas.
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

## P1.5 — Custom validator specialization

- [x] Implement the custom-validator acceptance tests before adding narrower cardinality features.
  - [x] Register a validator by stable name, version, and symbol-identity sink matcher.
  - [x] Add the `0 | 1 | many | unknown` call-cardinality lattice with intraprocedural branch, sequence, loop, concurrent-argument, recursion, and unknown-callback handling.
  - [x] Compose cardinality through resolved local callees.
  - [x] Compose cardinality through aliases, re-exports, methods, and cross-module callees.
  - [x] Attach proof-grade specializations only after validator success; unresolved relative callees, recursion, and opaque callbacks remain `unknown` rather than becoming zero.
  - [x] Compose Generator and AsyncGenerator effects through `yield`, `yield*`, and iterator consumption count for resolved local functions.
  - [x] Validate an explicit application entrypoint so per-invocation bounds are not confused with process-wide uniqueness.

## P2 — DOM semantic overlay

- [x] Add DOM operation kinds: `Read`, `LayoutRead`, `ValueWrite`, `TreeWrite`, `Create`, `Listen`, `Dispatch`, and `Parse`.
- [x] Use receiver identity regions as proof-grade DOM scopes.
- [x] Record CSS selectors as query refinements, not authority boundaries.
- [x] Model compound contracts for tree ownership changes.
- [x] Mark event dispatch, custom-element reactions, getters, proxies, and coercions as possible user-code invocation.
- [x] Fingerprint the consumed `lib.dom.d.ts` and report unclassified API drift.

## P3 — Invariants and Z3

- [x] Lint syntactically constant temporal invariants and actions consisting only of self-assignments.
- [ ] Detect solver-level tautologies, inconsistent initial states, unreachable actions, vacuous invariants, duplicate/subsumed properties, and invariants preserved only because no progress is possible.
  - [x] Detect solver-level tautologies and contradictions over all typed states.
  - [x] Detect jointly inconsistent initial constraints.
  - [x] Detect action guards that are unsatisfiable over all typed states.
  - [x] Detect exact duplicates and properties implied by an earlier property.
  - [ ] Detect actions unreachable from the transition system's initial states.
    - [x] Report depth-labelled bounded unreachability by unrolling init and complete stuttering transitions in Z3.
    - [x] Upgrade bounded-unreachable actions to an unbounded result when `!guard` is established at init and preserved by one-step induction across every transition.
    - [x] Accept explicitly selected temporal properties as strengthening invariants, but only after Z3 proves initialization and one-step preservation; combine multiple proven properties when required.
    - [x] Promote unreachable actions after a complete `state-count - 1` exploration bound for finite boolean/record/Set/Map state products.
    - [x] Opt in to automatic discovery among declared temporal properties, retaining only candidates whose initialization and preservation obligations Z3 proves.
    - [x] Opt in to synthesized integer-sign and boolean-polarity templates, admitting only candidates whose induction obligations pass.
    - [x] Opt in separately to pairwise integer equality/order templates so quadratic relational candidate growth is explicit.
    - [x] Derive coefficient-1 affine offset templates from pairs of constant integer initializers.
    - [x] Derive reduced small-coefficient `(2,1)` and `(1,2)` affine equality/order templates from constant initializers.
    - [x] Derive coefficient-1 three-variable conservation equalities from constant initializers.
    - [x] Generalize coefficient-1 conservation equalities to an explicitly bounded arity (maximum six) and cap generated conservation candidates.
    - [x] Opt in separately to equality templates for same-shaped Set, Map, and record state pairs.
    - [x] Synthesize directional subset invariants for same-element finite `Set` state pairs and admit only inductively proven directions.
    - [x] Discover same-element `Set` equality/subset candidates recursively through record field paths.
    - [x] Treat finite `Map.keys()` domains, including record-nested maps, as derived Set views for directional subset synthesis.
    - [x] Treat scalar finite `Map.values()` domains as derived Set views without generalizing unsupported composite values.
    - [ ] Synthesize general affine/polyhedral, quantified, and richer field-correlated collection invariants.
      - [x] Validate that refinement manifests cover every temporal action and invariant without stale model names.
      - [x] Prove direct scalar action assignments, increments, stuttering, and one-level literal-specialized local class methods against temporal assignments.
      - [x] Compose repeated and cross-field scalar writes in TypeScript execution order before comparing them with simultaneous temporal updates.
      - [x] Preserve immutable action-local scalar snapshots so temporary-variable swaps refine simultaneous model updates; keep mutable locals unsupported.
      - [x] Add typed conditional expressions to the temporal IR with runtime, Quint, replay, and Z3 `ite` lowering, then merge scalar `if`/`else` action branches symbolically.
      - [x] Unroll ascending literal-bound `for (let i = start; i < end; i++)` action loops up to 64 iterations; reject dynamic or oversized bounds.
      - [x] Compose acyclic direct calls to same-file action helpers over shared symbolic state with call-site scalar argument snapshots; reject recursion and nonlocal or dynamic calls.
      - [x] Prove exact scalar action guards through a leading negated early-return and reject missing, mismatched, or unexpected guards.
      - [x] Add an opt-in Z3 equivalence pass for normalized scalar action guards; retain real mismatches and solver `unknown` as diagnostics.
      - [x] Prove single-return scalar invariant functions against temporal safety-property expression ASTs.
      - [x] Add an opt-in Z3 equivalence pass for normalized scalar invariant predicates without weakening unsupported-body diagnostics.
      - [x] Normalize immutable local scalar constants and alias chains in invariant bindings without evaluating calls.
      - [x] Inline acyclic same-file single-return scalar invariant helper graphs with argument substitution; reject recursion and nonlocal calls.
      - [x] Prove supported create/observe adapters preserve every model state field by name, including transparent local-class construction and destructured observation.
      - [ ] Prove a refinement mapping between adjacent TypeScript implementation updates and temporal model actions; current dogfood checks the model independently.
        - [ ] Extend action-body refinement beyond the current sequential scalar fragment, scalar `if`/`else` merging, bounded literal `for` unrolling, and acyclic same-file direct helpers to general loops, abrupt completion, collections, imported calls, aliases, and dynamic dispatch. Multi-write sequencing is composed symbolically and scalar guard equivalence is solver-proven opt-in.
        - [ ] Extend invariant-body refinement beyond normalized scalar predicates, immutable local constants, and acyclic same-file pure helper graphs to collections, imported helpers, aliases, and dynamic dispatch. Logical equivalence within the normalized scalar fragment is now solver-proven opt-in.
        - [ ] Extend create/observe refinement beyond identity field projections to explicit abstraction relations, nested records/collections, and TypeChecker-backed runtime shape evidence.
  - [ ] Detect vacuity, deadlock, and invariants preserved only because the model cannot progress.
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
    - [ ] Synthesize general affine/polyhedral/quantified collection invariants and support nested/general temporal formulas beyond `eventually`.
- [ ] Generate QuickCheck-style property tests and shrinkers from `Int`, `Nat`, machine-number, bounded-array, union, and contract-refined boundaries.
  - [x] Generate deterministic standalone Vitest tests for scalar `Int`, `Nat`, `U8`, `U32`, and `I32` parameters with restricted `requires`/`ensures` expressions.
  - [x] Shrink scalar counterexamples toward zero without adding a production runtime dependency.
  - [x] Generate `BoundedUint8Array<N>`, `BoundedUint32Array<N>`, scalar/literal union values, and structure-aware array shrinkers.
  - [ ] Derive tighter generators from arbitrary contract refinements instead of filtering candidates only at runtime.
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
      - [x] Minimize a shared structural-size objective and confirm minimality with repeated strict-bound SAT checks instead of trusting nonlinear `Optimize` results.
- [ ] Persist minimized counterexamples and replay them against implementation/model refinement adapters.
  - [x] Persist and prioritize replay of versioned scalar and structured property-test counterexamples (`v1` remains scalar-only; `v2` adds JSON-safe arrays and literals).
  - [x] Optionally persist minimized failures from standalone generated Vitest files and replay the artifact before newly generated candidates.
  - [x] Replay model-checker counterexamples through TypeScript refinement adapters.
    - [x] Define a versioned normalized model trace and replay explicit action/observation/invariant adapters with step-local mismatch artifacts.
    - [x] Parse Quint `run --mbt --out-itf` violation traces, including safe ITF big integers, into normalized traces automatically.
    - [x] Extract shortest bounded temporal-Z3 counterexamples with explicit action selectors into normalized traces automatically.
    - [x] Parse standalone scalar TLC counterexample output and recover unambiguous actions from the neutral temporal IR into normalized traces automatically.
    - [x] Parse multiline finite Set, scalar-key Map, and closed-record TLC console values and recover their neutral collection actions.
    - [ ] Support the remaining general TLA+ values and upstream machine-readable TLC traces when Quint exposes them.
- [x] Merge the direct Z3 checker and SMT-LIB generator onto one invariant IR.
- [x] Lower simple assignments and branches to SSA proof obligations.
- [x] Lower loop initialization, preservation, and exit obligations through the shared IR.
- [x] Preserve TypeScript numeric domains (`Int`, `Nat`, finite `Float`) in solver sorts and assumptions. (`Float` currently uses the documented real-arithmetic abstraction.)
- [x] Generate stable obligation identifiers and source mappings.
- [x] Treat Z3 `unknown` and unsupported syntax as non-proofs.
- [x] Save counterexample models in a machine-readable verification artifact.
- [x] Expose project-level Z3 obligations and optional explicit Valibot assertion emit through one build API.

## P4 — Temporal logic and ownership

- [x] Encode a bounded two-node Node Lease clock-skew model and lock both the vulnerable counterexample and skew-grace candidate with Quint tests.
- [ ] Add collection-valued temporal state (`Set`, `Map`, records) and finite-domain quantifiers so node-indexed lease models do not require manual flattening.
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
  - [ ] Add the remaining general TLA+ TLC values and upstream machine-readable trace forms.
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
- [x] Distinguish `SharedArrayBuffer` sharing from transfer.

## P4.5 — Typed array refinements

- [x] Add `U8`, `BoundedUint8Array<MaxLength>`, and optional Valibot runtime refinements.
- [x] Prove direct Uint8Array constructor bounds and indexed u8 writes from helper-type domains and `requires` clauses.
- [x] Reject implicit coercion and retain compound/update writes as non-proofs.
- [x] Model direct bounded DataView `setUint8`/`setUint32` byte offsets and value domains, with optional Valibot refinement.
- [x] Model all standard bounded DataView accessor widths, integer setter domains, and reassignment-free local alias chains.
- [x] Dogfood DataView obligations against a DNS header codec and retain an off-by-one negative control.
- [x] Derive safe integer intervals from simple `requires` bounds and expose solver-query statistics; reduce DNS codec verification from six queries to zero.
- [x] Distinguish resizable capacity (`BoundedArrayBuffer`) from exact non-resizable length (`FixedArrayBuffer`) and verify explicit/implicit DataView constructor regions.
- [x] Compose fixed-buffer DataView constructor evidence with definite transfer/detachment ownership in project verification.
- [ ] Extend that composition through mutable/interprocedural aliases, resize transitions, conditional control flow, and SharedArrayBuffer concurrency.
- [x] Add `U32`, bounded Uint32Array runtime refinements, and ECMAScript-aware ranges for SHA-256-style shifts, masks, and explicit `>>> 0` normalization.
- [x] Generate independent bounded-index and dynamic shift-count obligations instead of trusting JavaScript out-of-range or modulo-32 behavior.
- [ ] Compose the verified SHA-256 building blocks interprocedurally and cover non-canonical control-flow bounds.
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

## P5 — Evidence and optimization

- [x] Add a cross-domain assumption ledger for every currently emitted `trusted` builtin call, typed-array escape hatch, and temporal summary, with reason, scope, source span, expiration/owner metadata, and CI policy. Extend it when new trusted domains are introduced.
- [ ] Investigate proof certificates or independently checkable evidence for supported Z3/Quint fragments; current artifacts bind tool inputs and versions but are not proof terms.
- [x] Attach `verified`, `trusted`, `inferred`, or `unknown` evidence to every summary.
- [x] Include compiler revision, tsconfig hash, source hash, builtin-contract digest, and Uneffect version in artifacts.
- [x] Make unknown evidence stop transformations without blocking gradual lint adoption.
- [x] Define one proof-obligation schema per optimizer transformation.
- [x] Prototype stable-read reuse only when no overlapping mutate/invalidate/transfer event exists.
- [x] Evaluate property mangling separately under closed-world reflection and escape constraints.
- [x] Gate generated ownership-assertion elision on matching proof-grade `ownership-evidence/v1`; never rewrite user-authored Promise control flow from ownership evidence alone.
- [x] Add an end-to-end ownership instrumentation path: unresolved direct calls emit runtime assertions, matching Z3 evidence removes only generated checks and their unused helper.
- [x] Add one-shot `--ownership` and `--verify-ownership` CLI modes with safe runtime fallback for unresolved or unavailable Z3 proofs.
- [x] Persist ownership artifacts, reuse matching proofs across builds, and report stale evidence separately from first-time unknowns.
- [x] Add a project-level stable-read authorization cache bound to source hashes, TypeScript revision, builtin contracts, and closed-world mode.

## P6 — Native integration and productization

- [x] Compare the TypeScript declared-effect projection with the Rust Corsa schema consumer, including schema-drift and UTF-8 trivia controls.
- [ ] Extend frontend parity from declarations to inferred effects, call edges, ordered events, and real Corsa checker facts.
  - [x] Compare transitive inferred effects, resolved local call edges, and source-ordered call events through the Rust schema consumer.
  - [ ] Export and compare actual facts collected by the `corsa-bind` type-aware Oxlint bridge instead of reference-adapter synthesized records. TypeScript Go Content Mappers transform non-TS files and map spans; they are not a semantic fact API for ordinary TypeScript.
- [x] Define a frontend adapter boundary that can be implemented by Corsa.
- [x] Consume Corsa symbol, type, overload, and trivia information from Rust.
- [x] Add multi-file call graphs, aliases, re-exports, methods, arrows, overloads, and callbacks.
- [x] Add effect polymorphism and callback invocation timing.
- [x] Publish versioned CLI, library, and Rust crate interfaces.
- [x] Add CI tiers for unit tests, Z3 obligations, Quint simulation, and exhaustive model checking where available.
  - [x] Provision the Z3 CLI and Java 21, and serialize Quint evaluator warm-up before parallel Vitest workers.
  - [x] Bound CI solver integration concurrency and timeout separately from the faster local profile.
  - [x] Partition every TypeScript test into exactly one fast, Z3, Quint, or mixed integration tier with an executable no-gap/no-overlap manifest check.
  - [x] Keep generated child Vitest files runnable when they inherit a parent tier selection.

## P7 — Explicit resource management

- [x] Model `using` disposal as an implicit reverse-order `finally` region, including nested lexical scopes.
- [x] Model `await using` disposal as an asynchronous cleanup transition and suspension point.
- [x] Resolve builtin and user-defined `[Symbol.dispose]` / `[Symbol.asyncDispose]` contracts by TypeChecker symbol identity. (Corsa parity is tracked below.)
- [x] Track `SuppressedError`, early return, throw, rejection, and partial initialization in the control projection.
- [x] Infer and check capability effects performed by implicit cleanup methods.
- [x] Preserve exact nested `SuppressedError` payload types in the analysis IR. (Quint retains the finite abstract state.)
- [x] Add positive models and broken controls for missing, duplicated, reordered, and non-awaited disposal.

## P8 — Async/resource model hardening

- [x] Resolve builtin and user-defined disposal protocols by TypeChecker/Corsa symbol identity without escaped-name matching. (The v6 Corsa contract validates protocol-symbol edges and disjunctive correlated control paths; production Context Mapper emission remains tracked in P6.)
  - [x] Distinguish the standard `Symbol.dispose` and `Symbol.asyncDispose` symbols from shadowed or same-spelled properties.
  - [x] Cover typed aliases, interface inheritance, intersections, and generic constraints in the TypeChecker frontend.
- [ ] Compose Promise chains, `await`, `try/catch`, and async disposal into one control-flow model.
  - [x] Connect analyzed Promise-chain terminal states to await resume/rejection edges.
  - [x] Route disposal throw/rejection through catch and the async function's returned Promise in the shared IR.
  - [x] Preserve concrete catch/finally statement sequencing in the unified graph.
  - [x] Lower the single-function unified graph into one Quint transition module.
  - [ ] Generalize unified lowering to multiple awaited chains, nested scopes, and arbitrary control-flow joins.
    - [x] Give sequential awaited chains distinct wait/resume states and preserve their source order before cleanup.
    - [x] Dispose resources from a straight-line nested scope before a following outer await, while retaining idempotent final cleanup on failure paths.
    - [x] Dispose a resource whose complete nested scope precedes the first modeled await before entering that await.
    - [x] Route a caught scope-exit disposal failure through the concrete catch sequence and resume a following straight-line await.
    - [x] Place straight-line resource acquisitions between surrounding awaits by source position instead of front-loading every acquisition.
    - [x] Preserve conditional acquisition/await as optional transitions and carry the classification through Corsa schema v4.
    - [x] Correlate nested `if` then/else operations through shared condition identity/polarity and carry it through validated Corsa schema v5; loop and general CFG joins remain conservative.
    - [x] Preserve top-level catch/finally `return` and `throw` completion so abrupt handlers do not fall through to later awaits.
    - [x] Give one awaited chain per top-level catch/finally statement dedicated terminal/resume states, including finally-before-outer-await ordering.
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
    - [ ] Add loop-carried data invariants, resource-generation identity for escaping aliases, and general CFG joins.
- [x] Extend floating-Promise analysis from expression statements to initialized/deferred local binding ownership, aliases, reassignment loss, and path-sensitive observation.
  - [x] Track declarations, direct aliases, aggregate storage, argument transfer, return, and eventual observation within a function.
  - [x] Make explicit `void` abandonment policy configurable separately from proven rejection handling.
  - [x] Add restricted path-sensitive must-observe analysis for `if` branches, Promise reassignment, zero-iteration `while`/`for` paths, and at-least-once `do` loops.
  - [x] Cover finite exhaustive `switch` entry/fallthrough and conservative `try`/`catch` alternatives with mandatory `finally` execution.
  - [ ] Replace the restricted path walker with a CFG fixed point covering `switch`, `try`/`finally`, labeled control flow, and complex loop joins.
    - [x] Compute a finite abstract-state loop closure and propagate unlabeled/labeled `break` and `continue` without executing skipped statements.
  - [x] Define `consumes_rejection` callee contracts for explicit Promise rejection-responsibility transfer by parameter index.
  - [x] Validate malformed/out-of-range ownership contract indices and infer direct wrapper propagation.
  - [x] Add `consumes_callback_rejection` for Promise-returning callback ownership and diagnose unsafe async callbacks such as `forEach(async ...)`.
  - [x] Recognize standard Promise reaction callback assimilation by TypeScript declaration identity.
  - [x] Propagate callback ownership through direct unconditional higher-order wrappers, including named async callbacks.
  - [x] Add literal-guarded `consumes_rejection_when` and `consumes_callback_rejection_when`; only a proven `true` call-site guard becomes must-consume.
  - [x] Prove ownership guards from TypeScript boolean narrowing and local `requires guard` / `requires guard === true` preconditions.
  - [x] Parse compound boolean ownership guards through the shared logic IR and discharge finite propositional implications.
  - [x] Retain verified and unresolved ownership obligations with evidence in Async IR and emit SMT-LIB/Quint verifier programs.
  - [x] Import Z3 and Quint executions with backend version, program/obligation hashes, output, and exit status; only successful proofs become verified evidence.
  - [x] Add CI provisioning for the Java runtime required by Quint's TLC/Apalache verification backend.
- [ ] Refine thenable assimilation.
  - [x] Model self-resolution rejection, direct local throwing `then` getters, and direct local hostile thenables with first-call-wins settlement.
  - [x] Model conditional local getters, direct `Proxy` thenables, and direct external/imported `PromiseLike` symbol identities as conservative fulfill/reject/pending assimilation with `InvokeUserCode` capability effects.
  - [ ] Resolve exact general computed selections, recursive thenable cycles, and complex conditional/forwarding Proxy trap behavior.
    - [x] Resolve direct local factory calls whose every explicit return is an analyzable thenable literal.
    - [x] Preserve imported `PromiseLike` call results as conservative external assimilation nodes using their call-site type and span.
    - [x] Preserve arbitrary typed dynamic selections conservatively, and link direct conditional branches exactly by local thenable symbol identity.
    - [x] Preserve conservative fulfill/reject/pending outcomes when an exact nested target is unavailable.
    - [x] Link a local thenable resolving to an earlier analyzed local thenable symbol and recursively emit the nested settlement actions.
    - [x] Link external and forward local nested symbols, replacing forward placeholders in place when the initializer is analyzed.
    - [x] Register inline nested thenable literals as anonymous nodes and recursively link their exact settlement behavior.
    - [x] Recognize a direct standard `Proxy` with an object-literal `get` trap whose only statement throws; conditional and forwarded traps remain dynamic.
    - [x] Analyze a direct Proxy `get` trap whose sole return is a concrete arrow/function then callback.
    - [x] Select a concrete callback from the canonical `if (property === "then") return callback; return forwardingValue` Proxy trap shape.
  - [x] Link direct executor resolution and inline reaction returns to another analyzed Promise chain by TypeChecker symbol identity instead of only nondeterministic terminal adoption.
- [ ] Refine iterator-based Promise combinators.
  - [x] Model sparse array holes as fulfilled `undefined` slots and route statically typed thenable elements through assimilation.
  - [x] Model direct local standard-iterator acquisition failure and linear local-generator step failure before Promise reactions settle.
  - [x] Model throwing local iterator `next` accessors as acquisition failure and throwing `done`/`value` result accessors as step failure.
  - [x] Flatten nested array-literal spreads with exact cardinality and element order.
  - [x] Preserve `AggregateError.errors` slot order independently of Promise rejection order.
  - [ ] Model imported custom iterables, non-array dynamic spread cardinality, and more concrete aggregate rejection reasons.
    - [x] Classify non-literal/custom iterator execution as `InvokeUserCode`; retain unbounded dynamic cardinality as an explicit unsupported verifier boundary.
    - [x] Bound direct conditional array iterables of equal length slot-by-slot, joining differing branch kinds to conservative assimilation.
    - [x] Add one correlated choice and per-slot presence guards for direct finite conditional arrays of differing lengths.
    - [x] Flatten immutable local `as const` tuple aliases and their spreads while keeping mutable `const` arrays dynamic.
    - [x] Make `Promise.any` aggregate rejection cardinality depend on the selected finite conditional-array branch.
    - [x] Preserve literal `Promise.reject` and direct `new Error` reasons in `Promise.any` input order and emit stable Quint artifact constants.
    - [x] Resolve immutable local `const` aliases of literal and direct `new Error` rejection reasons by symbol identity.
- [ ] Extend timer/event-loop ownership.
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
  - [ ] Track computed properties and imported closure factories, host-specific Node/browser timer phases and cross-host cancellation compatibility, dynamic/imported/interprocedural abort compositions, TaskSignal reprioritization, direct external-signal state, and dynamically resolved parent callbacks.
    - [x] Resolve direct property-access and literal computed-property method callbacks by TypeChecker symbol identity, including microtasks scheduled from their bodies.
    - [x] Resolve direct imported source callback factories when exactly one function-valued return is present in the analyzed Program.
    - [x] Preserve a direct external `AbortSignal` passed to `scheduler.postTask` as a nondeterministic cancellation state and transition, including inherited `scheduler.yield` continuations.
    - [x] Resolve `AbortSignal.timeout` returned by a direct local or imported-source factory with exactly one explicit return and bind the scheduler task to its timer source.
    - [x] Resolve static `AbortSignal.any` returned by the same source-factory subset, retaining external sources, nested timeout sources, first-abort composition identity, and scheduler cancellation.
    - [x] Substitute source-factory parameters with concrete call arguments by symbol identity, preserving pre-aborted inputs and per-call timeout/composition instances.
    - [x] Model direct synchronous `TaskController` construction and literal `setPriority` changes as ordered dynamic-priority transitions; propagate the final priority to `scheduler.yield`, while explicit `postTask` priority remains immutable.
    - [x] Add an initial Node callback-checkpoint profile for `process.nextTick`, V8 microtasks, timers, and `setImmediate`, with CLI/project verification and a broken-order oracle. ESM top-level and complete libuv phase/I/O semantics remain open.
    - [x] Merge definitely queued Promise reactions and `queueMicrotask` jobs into the Node V8 microtask FIFO below the next-tick queue.
    - [x] Match cancellation by semantic handle family: timeout/interval, Immediate, and animation-frame; incompatible clear APIs no longer prove cancellation, while Node object and browser numeric timeout handles remain the same family.
    - [x] Add explicit checkpoint, timers, abstract poll, check, and close/next-iteration phase state to the Node profile, returning through a callback checkpoint after every modeled timer/immediate callback. Poll/I/O and close callbacks remain open.
    - [x] Enqueue statically resolved nested `process.nextTick` and `queueMicrotask` jobs when their parent Node callback runs instead of treating them as initially pending.
    - [x] Enqueue nested `setImmediate` registrations dynamically and defer an Immediate created inside any executing callback to the next event-loop iteration.
    - [x] Normalize static Node `setTimeout`/`setInterval` delays to the documented signed-32-bit timer range and integer semantics without changing Web or abort-timeout models.
    - [x] Preserve Fs authority and add nondeterministically completed poll-phase callbacks for reviewed one-shot `node:fs` completion APIs; watchers, streams, remaining callbacks, and readiness/order details remain open.
    - [x] Keep independent fs poll completions unordered instead of inventing timer-style FIFO from source registration order.
    - [x] Classify reviewed fs callbacks as deferred by resolved builtin identity in the program call graph, preserving callback effects in the parent's capability summary across aliases.
    - [x] Dynamically register static nested Node timeout/interval calls from non-repeating callbacks; repeated-parent multi-instance call sites remain open.
  - [x] Unify definitely queued Promise reactions, `queueMicrotask`, and modeled microtask checkpoints.
  - [x] Preserve dynamic FIFO enqueue order between Promise reactions created by reactions and already queued jobs.
  - [x] Extract `queueMicrotask` calls made inside inline callbacks and enqueue them dynamically rather than only modeling top-level registrations.
  - [x] Resolve local/imported named function and variable callback bodies by TypeChecker identity and propagate dynamically scheduled microtasks.
  - [ ] Resolve methods, callbacks returned from calls, and dynamically selected callback values.
    - [x] Resolve direct property-access and literal computed-property methods; polymorphic receiver dispatch remains dynamic.
    - [x] Resolve direct local or imported-source callback factories with exactly one explicit function-valued return.
- [x] Bring Promise/resource IR to Rust/Corsa parity.
  - [x] Serialize Promise observation, rejection ownership, resource scopes, async disposal, and exact `SuppressedError` payloads.
  - [x] Add cross-frontend parity fixtures and reject schema drift.
- [x] Dogfood against representative external TypeScript programs.
  - [x] Integrate program-wide gradual effect checking into `verifyUneffectProject`; annotated capability upper bounds now fail through the unified project diagnostics.
  - [x] Return program-wide effect summaries from `verifyUneffectProject` so adoption tooling can inspect attributed authority as well as failures.
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
