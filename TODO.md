# Uneffect implementation roadmap

This file is the implementation ledger. Work proceeds top to bottom within each priority unless a prerequisite or verifier result forces a redesign. An item is complete only when its code, regression tests, and relevant English documentation are all updated.

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
    - [ ] Prove unbounded unreachability with induction or a finite-state completeness bound.
  - [ ] Detect vacuity, deadlock, and invariants preserved only because the model cannot progress.
    - [x] Prove that no action is enabled at init, or that enabled initial transitions cannot change temporal state.
    - [ ] Detect later reachable deadlocks, property-specific vacuity, and progress failures beyond init.
- [ ] Generate QuickCheck-style property tests and shrinkers from `Int`, `Nat`, machine-number, bounded-array, union, and contract-refined boundaries.
  - [x] Generate deterministic standalone Vitest tests for scalar `Int`, `Nat`, `U8`, `U32`, and `I32` parameters with restricted `requires`/`ensures` expressions.
  - [x] Shrink scalar counterexamples toward zero without adding a production runtime dependency.
  - [x] Generate `BoundedUint8Array<N>`, `BoundedUint32Array<N>`, scalar/literal union values, and structure-aware array shrinkers.
  - [ ] Derive tighter generators from arbitrary contract refinements instead of filtering candidates only at runtime.
    - [x] Seed valid boundary-adjacent values from conjunctive integer comparisons (`>=`, `>`, `<=`, `<`, `===`), including reversed operands.
    - [x] Derive boundary unions from disjunctions and normalize single-variable affine arithmetic.
    - [x] Derive correlated tuples for a single affine equality between scalar parameters and prioritize them before Cartesian samples.
    - [ ] Derive correlated generators for multiple dependent relations, nonlinear arithmetic, and solver models.
- [ ] Persist minimized counterexamples and replay them against implementation/model refinement adapters.
  - [x] Persist and prioritize replay of versioned scalar and structured property-test counterexamples (`v1` remains scalar-only; `v2` adds JSON-safe arrays and literals).
  - [x] Replay model-checker counterexamples through TypeScript refinement adapters.
    - [x] Define a versioned normalized model trace and replay explicit action/observation/invariant adapters with step-local mismatch artifacts.
    - [x] Parse Quint `run --mbt --out-itf` violation traces, including safe ITF big integers, into normalized traces automatically.
    - [x] Extract shortest bounded temporal-Z3 counterexamples with explicit action selectors into normalized traces automatically.
    - [x] Parse standalone scalar TLC counterexample output and recover unambiguous actions from the neutral temporal IR into normalized traces automatically.
    - [ ] Support collection-valued TLC states and upstream machine-readable TLC traces when Quint exposes them.
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
- [ ] Add an extensible temporal semantic-domain registry; use optional wall-clock/monotonic-clock/skew contracts as one domain pack rather than privileged core semantics.
- [x] Bind abstract model state/actions to TypeScript observations/calls and replay generated counterexamples against implementation adapters.
  - [x] Replay a Quint-produced Node Lease trace through a typed runtime adapter and reproduce `singleWriter` at the same step.
  - [x] Generate bindings from source annotations and connect them directly to backend-produced counterexamples.
- [ ] Model delayed renewal completion, self-fencing, GC, CAS failure, crashes, and in-flight fenced writes in the Node Lease acceptance model.
- [ ] Build the product model between callback temporal summaries and Web event-loop queue transitions; project verification currently checks the generated Web queue model independently.
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
- [ ] Model DataView writes, byte offsets, resizable ArrayBuffer bounds, aliases, and SharedArrayBuffer concurrency.
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
- [ ] Propagate numeric builtin identity through reassignment-free multi-hop aliases, imports, parameters, and object properties.
- [x] Add a reason-carrying function-level `trust typed-array` escape hatch whose obligations remain `trusted`, never `verified`.
- [ ] Add narrower obligation/statement-level trust and a unified trust-policy/audit report across verification domains.
- [ ] Support package exports and additional non-literal generated table initializers.
- [x] Benchmark project-level import/re-export resolution against the single-file baseline before optimizing it.

## P5 — Evidence and optimization

- [ ] Add a cross-domain assumption ledger for every `trusted` result, with reason, scope, source span, expiration/owner metadata, and CI policy.
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
- [ ] Extend frontend parity from declarations to inferred effects, call edges, ordered events, and real Context Mapper output.
- [x] Define a frontend adapter boundary that can be implemented by Corsa.
- [x] Consume Corsa symbol, type, overload, and trivia information from Rust.
- [x] Add multi-file call graphs, aliases, re-exports, methods, arrows, overloads, and callbacks.
- [x] Add effect polymorphism and callback invocation timing.
- [x] Publish versioned CLI, library, and Rust crate interfaces.
- [x] Add CI tiers for unit tests, Z3 obligations, Quint simulation, and exhaustive model checking where available.
  - [x] Provision the Z3 CLI and Java 21, and serialize Quint evaluator warm-up before parallel Vitest workers.
  - [x] Bound CI solver integration concurrency and timeout separately from the faster local profile.

## P7 — Explicit resource management

- [x] Model `using` disposal as an implicit reverse-order `finally` region, including nested lexical scopes.
- [x] Model `await using` disposal as an asynchronous cleanup transition and suspension point.
- [x] Resolve builtin and user-defined `[Symbol.dispose]` / `[Symbol.asyncDispose]` contracts by TypeChecker symbol identity. (Corsa parity is tracked below.)
- [x] Track `SuppressedError`, early return, throw, rejection, and partial initialization in the control projection.
- [x] Infer and check capability effects performed by implicit cleanup methods.
- [x] Preserve exact nested `SuppressedError` payload types in the analysis IR. (Quint retains the finite abstract state.)
- [x] Add positive models and broken controls for missing, duplicated, reordered, and non-awaited disposal.

## P8 — Async/resource model hardening

- [ ] Resolve builtin and user-defined disposal protocols by TypeChecker/Corsa symbol identity without escaped-name matching. (TypeChecker complete; Corsa pending.)
  - [x] Distinguish the standard `Symbol.dispose` and `Symbol.asyncDispose` symbols from shadowed or same-spelled properties.
  - [x] Cover typed aliases, interface inheritance, intersections, and generic constraints in the TypeChecker frontend.
- [ ] Compose Promise chains, `await`, `try/catch`, and async disposal into one control-flow model.
  - [x] Connect analyzed Promise-chain terminal states to await resume/rejection edges.
  - [x] Route disposal throw/rejection through catch and the async function's returned Promise in the shared IR.
  - [x] Preserve concrete catch/finally statement sequencing in the unified graph.
  - [x] Lower the single-function unified graph into one Quint transition module.
  - [ ] Generalize unified lowering to multiple awaited chains, nested scopes, and arbitrary control-flow joins.
- [ ] Extend floating-Promise analysis from expression statements to binding ownership.
  - [x] Track declarations, direct aliases, aggregate storage, argument transfer, return, and eventual observation within a function.
  - [x] Make explicit `void` abandonment policy configurable separately from proven rejection handling.
  - [x] Add restricted path-sensitive must-observe analysis for `if` branches, Promise reassignment, zero-iteration `while`/`for` paths, and at-least-once `do` loops.
  - [ ] Replace the restricted path walker with a CFG fixed point covering `switch`, `try`/`finally`, labeled control flow, and complex loop joins.
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
  - [ ] Model throwing `then` getters, proxy/getter `InvokeUserCode`, hostile multiple settlement, and self-resolution rejection.
  - [ ] Link an adopted Promise to another analyzed Promise chain instead of only nondeterministic terminal adoption.
- [ ] Refine iterator-based Promise combinators.
  - [ ] Model iterator acquisition/step failure, custom iterables, thenable elements, sparse arrays, and ordered `AggregateError.errors`.
- [ ] Extend timer/event-loop ownership.
  - [x] Add a Web event-loop profile for timer tasks, intervals, draining microtask checkpoints, animation-frame callbacks, and paint opportunities.
  - [x] Model direct `cancelAnimationFrame` handles and recurring `setInterval` scheduling.
  - [ ] Track timer-handle aliases and escape, Node/browser handle differences, `AbortSignal.timeout`, and `scheduler.postTask`.
  - [x] Unify definitely queued Promise reactions, `queueMicrotask`, and modeled microtask checkpoints.
  - [x] Preserve dynamic FIFO enqueue order between Promise reactions created by reactions and already queued jobs.
  - [x] Extract `queueMicrotask` calls made inside inline callbacks and enqueue them dynamically rather than only modeling top-level registrations.
  - [ ] Resolve named callback bodies and propagate their dynamically scheduled jobs through the call graph.
- [ ] Bring Promise/resource IR to Rust/Corsa parity.
  - [ ] Serialize Promise observation, rejection ownership, resource scopes, async disposal, and exact `SuppressedError` payloads.
  - [ ] Add cross-frontend parity fixtures and reject schema drift.
- [ ] Dogfood against representative external TypeScript programs.
  - [x] Add a controlled Node CLI, browser DOM app, and Worker transfer corpus with adoption KPI reporting.
  - [ ] Record false-positive rate, unknown-summary rate, builtin drift, annotation density, verifier time, and frontend time.
    - [x] Record controlled-corpus false positives, unknown summaries, annotation density, enforced boundaries, and frontend time.
    - [ ] Run the same report over independently maintained external projects and include actual verifier time.
  - [ ] Compare equivalent native Promise, Uneffect, and Effect TS implementations.
    - [x] Compare observable recovered output and an explicit common authority manifest.
    - [ ] Model Effect TS Promise callback ownership and compare the actual `catchAll` recovery path rather than a normalized Effect outcome.

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
