# Uneffect implementation roadmap

This file is the implementation ledger. Work proceeds top to bottom within each priority unless a prerequisite or verifier result forces a redesign. An item is complete only when its code, regression tests, and relevant English documentation are all updated.

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

## P2 — DOM semantic overlay

- [x] Add DOM operation kinds: `Read`, `LayoutRead`, `ValueWrite`, `TreeWrite`, `Create`, `Listen`, `Dispatch`, and `Parse`.
- [x] Use receiver identity regions as proof-grade DOM scopes.
- [x] Record CSS selectors as query refinements, not authority boundaries.
- [x] Model compound contracts for tree ownership changes.
- [x] Mark event dispatch, custom-element reactions, getters, proxies, and coercions as possible user-code invocation.
- [x] Fingerprint the consumed `lib.dom.d.ts` and report unclassified API drift.

## P3 — Invariants and Z3

- [x] Merge the direct Z3 checker and SMT-LIB generator onto one invariant IR.
- [x] Lower simple assignments and branches to SSA proof obligations.
- [x] Lower loop initialization, preservation, and exit obligations through the shared IR.
- [x] Preserve TypeScript numeric domains (`Int`, `Nat`, finite `Float`) in solver sorts and assumptions. (`Float` currently uses the documented real-arithmetic abstraction.)
- [x] Generate stable obligation identifiers and source mappings.
- [x] Treat Z3 `unknown` and unsupported syntax as non-proofs.
- [x] Save counterexample models in a machine-readable verification artifact.

## P4 — Temporal logic and ownership

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

## P5 — Evidence and optimization

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

## P6 — Native integration and productization

- [x] Define a frontend adapter boundary that can be implemented by Corsa.
- [x] Consume Corsa symbol, type, overload, and trivia information from Rust.
- [x] Add multi-file call graphs, aliases, re-exports, methods, arrows, overloads, and callbacks.
- [x] Add effect polymorphism and callback invocation timing.
- [x] Publish versioned CLI, library, and Rust crate interfaces.
- [x] Add CI tiers for unit tests, Z3 obligations, Quint simulation, and exhaustive model checking where available.

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
  - [ ] Add CI provisioning for the Java runtime required by Quint's TLC/Apalache verification backend.
- [ ] Refine thenable assimilation.
  - [ ] Model throwing `then` getters, proxy/getter `InvokeUserCode`, hostile multiple settlement, and self-resolution rejection.
  - [ ] Link an adopted Promise to another analyzed Promise chain instead of only nondeterministic terminal adoption.
- [ ] Refine iterator-based Promise combinators.
  - [ ] Model iterator acquisition/step failure, custom iterables, thenable elements, sparse arrays, and ordered `AggregateError.errors`.
- [ ] Extend timer/event-loop ownership.
  - [ ] Track timer-handle aliases and escape, `setInterval`, Node/browser handle differences, `AbortSignal.timeout`, and `scheduler.postTask`.
  - [ ] Unify `queueMicrotask`, Promise reactions, and modeled microtask checkpoints.
- [ ] Bring Promise/resource IR to Rust/Corsa parity.
  - [ ] Serialize Promise observation, rejection ownership, resource scopes, async disposal, and exact `SuppressedError` payloads.
  - [ ] Add cross-frontend parity fixtures and reject schema drift.
- [ ] Dogfood against representative external TypeScript programs.
  - [ ] Record false-positive rate, unknown-summary rate, builtin drift, annotation density, verifier time, and frontend time.
  - [ ] Compare equivalent native Promise, Uneffect, and Effect TS implementations.

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
