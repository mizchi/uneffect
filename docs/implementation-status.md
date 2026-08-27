# Implementation status

This document is the concise, user-facing summary of the completed entries in
`TODO.md`. The checklist remains a historical implementation ledger; open work
is tracked in GitHub Issues and summarized in `roadmap.md`. For a compact view
that puts tested fragments next to their unsupported boundaries, see
`feature-matrix.md`.

The project is an experimental prototype. "Implemented" below means that the
documented fragment has executable regression tests. It does not mean that the
same property is proved for arbitrary TypeScript.

## Annotation and contract surface

- Existing TypeScript remains valid: Uneffect reads only `/* uneffect: ... */`
  block comments and reports malformed or unsupported directives.
- The typed annotation AST separates capability effects, Hoare-style
  preconditions/postconditions/invariants, and temporal specifications.
- Contracts can remain zero-runtime metadata or be emitted as optional runtime
  assertions. Escape hatches are explicit and recorded as assumptions.
- Helper types and values cover `Int`, `Nat`, bounded machine numbers, integer
  casts such as known `Math.floor` cases, and `u8`/`f32` runtime refinements.

## Capability effects

- Effect declarations are checked as upper bounds, propagated through resolved
  call graphs, and diagnosed when declared but unused.
- Builtins are identified by TypeScript symbol identity, including supported
  aliases and namespace imports, rather than by source spelling.
- TypeScript 6.0.3 compiler traversal contracts synchronously compose callbacks
  for reviewed `Node.forEachChild`, `forEachChild`, `visitNode`,
  `visitEachChild`, and array-literal `transform` TransformerFactory chains.
  User-defined lookalikes and other compiler versions remain unknown.
- Structured effects include `Console`, `Fetch`, `Throw`, DOM operations,
  mutation regions, transfer ownership, and Deno-compatible permission
  categories (`FsRead`, `FsWrite`, `Net`, `Env`, `Run`, `Sys`, `Ffi`, and
  `Import`). User-defined, qualified, parameterized effects are supported by a
  versioned schema registry.
- Fetch authority combines method sets, restricted URL patterns, and a separate
  Deno-compatible network-host requirement.
- Filesystem scopes support explicit `$WORKSPACE_ROOT`, `$PACKAGE_ROOT`,
  `$SOURCE_DIR`, `$CWD`, and target-profile `$TEMP` anchors. Separator, dot
  segment, case-policy, and containment normalization are implemented.
- DOM contracts distinguish attribute, node-topology, text, Web IDL property,
  and layout operations from creation, listeners, dispatch, and parsing.
  Authority is based on receiver identity regions; selectors are refinements
  rather than security boundaries. The executable overlay infers a reviewed
  call subset including reviewed attribute/tree/text methods and compound
  clone/normalize/adjacent-content operations, plus reviewed
  attribute-collection and tree-topology reads,
  direct/immutable-alias `NamedNodeMap` origin projection,
  receiver- and parent-scoped markup serialization/parsing, layout metrics, `Node.textContent`,
  `Node.nodeValue`, `CharacterData.data`, and
  `HTMLInputElement.value` reads and writes. Other ordinary Web IDL properties
  remain open.
- Transferable values are modeled as ownership transitions with invalidation
  and use-after-transfer diagnostics.

## Contracts and formal backends

- A shared typed specification IR generates reviewable SMT-LIB obligations for
  Z3 and reviewable Quint models for temporal checking and simulation.
- The supported Hoare fragment checks integer and machine-number expressions,
  assignments, selected control flow, preconditions, postconditions, and loop
  invariants. Runtime assertion generation is optional.
- Temporal declarations compose calls between modeled functions, preserve
  source locations, and support runtime execution, replay, Z3 lowering, Quint
  generation, and normalized counterexample traces for the documented subset.
- The linter detects syntactic and solver-level constant properties,
  contradictory initial constraints, globally impossible guards, duplicate or
  subsumed properties, bounded unreachability, and several inductively proved
  unreachability cases.
- Bounded invariant synthesis covers boolean polarity, integer sign/order,
  affine relations and conservation laws, and selected record/Set/Map
  equality/subset views. Candidate budgets are explicit.
- Refinement checks connect selected adjacent TypeScript implementations to
  their temporal actions and invariant predicates. Supported forms include
  scalar and nested-record updates, selected native Set/Map operations,
  conditionals, scalar switch fallthrough and direct return/throw entries,
  bounded ascending `for` loops, canonical adjacent local-counter `while`
  loops, finite numeric/boolean literal `for...of` loops,
  exact zero-shot `while (false)` and one-shot `do...while (false)`, and
  acyclic symbol-resolved helpers. Whole-runtime reads and writes may pass
  through lexical, non-escaping `const` alias chains; mutable, escaping,
  member, destructured, or cyclic aliases remain unsupported. A Program-resolved
  acyclic invariant helper may also return a builtin `new Set(array)`
  or `new Map(entries)` view when that constructor and argument exactly match a
  declared computed abstraction. This requires TypeChecker identity; local
  same-named constructors and conversions without an abstraction relation are
  not treated as proof evidence. Builtin array `every` and `some` calls may use
  a TypeChecker-resolved local or imported function declaration, arrow
  function, or function-expression predicate with one supported return body;
  immutable `const` aliases are followed. A direct property initialized inside
  a builtin `Object.freeze({...})` registry is also accepted by TypeChecker
  identity. Mutable aliases, unfrozen registries, same-named `freeze` functions,
  and dynamic function values remain unsupported. A reviewed local
  runtime-class method may use the same alias chain as its receiver; its body is
  specialized with the existing argument substitution and recursion guard.
  In the Program-backed path, the runtime class may be imported: its parameter
  type alias must resolve through the TypeChecker to an actual class
  declaration. A same-shaped interface is not accepted. This remains exact
  declaration-body specialization, not proof of closed-world dynamic method
  dispatch. A subclass declaration known to the source or Program disables the
  specialization (using TypeChecker symbol identity in Program mode). An
  exported runtime class additionally requires an explicit
  `trust dispatch-sealing <reason>` marker. That dependency enters the
  cross-domain assumption ledger with `trusted` evidence and optional enforced
  owner/expiration metadata; it never upgrades dispatch to `verified`.
  Unscanned external subclasses, proxies, and prototype mutation remain excluded.
  Literal-false while reductions are syntactic execution-count facts only;
  The canonical while form is `let i = start; while (i < end) { ...; i++ }`
  with literal safe-integer bounds and at most 64 iterations. Dynamic bounds,
  other steps, and general loop invariants remain unsupported. Within the
  separate symbolic affine fragment, `while (counter > L)`, `>= L`, `< U`, and
  `<= U` are summarized for signed safe-integer constant bounds without
  expansion when the counter changes toward the bound by a positive
  safe-integer constant magnitude and the body either completes normally or
  only continues after taking the ranking step. Other
  state writes may have safe-integer constant per-iteration deltas. A unit
  countdown additionally admits deltas affine in the ranking counter and
  derives exact triangular totals. A scalar conditional decision tree with at
  most eight leaves is supported when every condition is invariant across the
  loop and every outcome has an affine ranking-counter delta. Non-unit steps
  derive a ceiling quotient from a guarded nonnegative distance and divide only
  the remainder-subtracted, exactly divisible numerator, keeping JavaScript,
  Quint, and Z3 results aligned while preserving final counter overshoot.
  Supported symbolic state updates before the loop are
  snapshotted and substituted into its guard, trip count, and closed-form
  results before the lexical suffix is composed. Dynamic or unsafe bounds or
  steps, direction mismatches, other loop guards, mutated/counter-dependent or
  over-budget piecewise conditions, mutually coupled or self-amplifying recurrences,
  opaque entry updates, and break/return/throw exits remain unsupported. An
  unlabeled `continue` is consumed when the merged update proves every path
  already took the ranking step; mandatory `finally` work is included in that
  iteration. A continue that can skip the step remains unsupported. Within the
  same symbolic fragment, one loop-invariant early `break` can choose a path
  with up to eight independent non-counter affine state updates before
  stopping. Supported state updates before the loop are substituted into its
  condition and updates. A caught scalar throw may select the break path, and a
  mandatory `finally` may advance the ranking counter once when its delta
  exactly matches the ordinary iteration. A second invariant policy may choose
  continue instead; both completion paths share the mandatory ranking update,
  and the continuing path contributes its affine recurrence. Disjunctive
  invariant stop policies are retained as aligned conditional update trees;
  false disjunctions are specialized only on the repeating path, where every
  constituent is known false. Nested Boolean stop policies are also retained
  when their completion and update trees stay aligned: a bounded propositional
  check over at most 16 invariant atoms removes only logically entailed choices
  and preserves every unresolved branch. The break-side tree is limited to
  eight affine leaves.
  Different counter deltas, a ninth update or leaf, cross-state coupling,
  non-affine updates, unaligned boolean formulas, counter-dependent or mutated
  policies, and dynamic completion selection remain unsupported. Within the
  finite-loop fragment, an unlabeled `break` is retained separately from
  return/throw through conditional and try/finally completion, consumed by the
  loop, and followed by the outer continuation. An ascending finite `for` also
  accepts `break label` and `continue label` for a statically known owning
  finite loop. Target-aware completion maps preserve transfers to an outer
  finite loop through nested finite loops, branches, supported switch paths,
  and `try`/`finally`; capture-screened AST substitution permits nested finite
  expansion without reusing source offsets from a synthetic tree. The nested
  trip-count product is capped at 64 and total expansions per action at 256.
  Dynamic,
  duplicate, or ambiguous switch/loop ownership remains unsupported. An unlabeled
  `continue` is additionally tracked through branches and `try`/`finally`, but
  consumed only at finite `for`, literal `for...of`, and one-shot `do` iteration
  boundaries where advancement is guaranteed. Canonical `while` rejects it
  because it can bypass the required terminal increment.

- Initialized scalar `let` values now flow through sequential `if` diamonds. A
  shared `joinFlowValues` contract constructs state
  and local phi values over bindings visible at the common predecessor, so
  branch-scoped declarations cannot leak. Assignment supports `=`, `+=`, and
  `-=`. For one returning arm, `applyContinuation` now evaluates the normal arm
  with that predecessor's local snapshot instead of the enclosing snapshot;
  the returned arm does not execute the suffix. Throw/exception, switch, loop,
  labeled-block, and standalone nested-block local joins initially remained
  explicit non-proofs pending the general CFG fixed point. A subsequent narrow
  exception slice records the mutable-scalar environment on a supported typed
  scalar throw edge, starts `catch` from that edge-owned snapshot, and preserves
  the distinct normally completing `try` snapshot. Two conditional throwing
  arms use the shared phi contract. Opaque payloads, catch-side local mutation,
  and rethrow remain non-proofs. A mandatory-`finally` extension records direct
  return snapshots as well, projects catch-local environments to bindings
  visible outside the protected region, and joins normal, return, and supported
  typed throw/catch-return predecessors before evaluating finally state writes.
  `try/finally` without `catch` also preserves its normal local environment.
  A scalar-switch extension assigns a separate local map to every expanded case
  entry/fallthrough path, merges normal values by case selection, and carries
  selected return/throw maps into the existing completion lattice. Default-free
  unmatched input retains the pre-switch environment. Opaque discriminants,
  dynamic/duplicate cases, nested-block case mutation, finally-local mutation,
  loop, label, and standalone-block flow remain non-proofs.
  Finite loops are
  expanded into the same completion sequence as straight-line code, so an early return suppresses
  later iterations while a surrounding `finally` still runs. The
  same completion machinery consumes a statically named block's own `break`
  after its mandatory `finally` work and then executes the outer continuation.
  An unconditional supported `return` or `throw` terminates collection of its
  lexical suffix; preceding updates remain visible, while unreachable writes
  cannot satisfy a temporal action. Bare lexical blocks propagate the same
  normal/return/throw completion state into the enclosing sequence, but their
  local constants and receiver aliases do not escape the block.
  Non-loop labeled blocks still support only their own `break`; labeled
  `continue`, nested block labels, and real returns inside that block-rewrite
  fragment remain unsupported. The action-control subset
  keeps return and throw completion predicates distinct,
  lets catch discharge only the throw paths, and runs a common finally block at
  their shared boundary. If the supported refinement fragment proves that the
  try body has no throw completion, its catch block is excluded as unreachable;
  an unresolved or effectful try statement still makes the action unsupported
  rather than silently removing a possible exception edge. Post-try statements run only on the remaining normal
  paths before joining with retained abrupt paths. Catch-local conditional void
  returns and supported pure rethrows are composed through the same predicates.
  Conditional returns and supported pure throws from finally override prior
  completion on exactly their paths. A value-bearing non-call return is
  accepted only when its expression normalizes in the pure refinement fragment;
  its result is not compared with the temporal action. Scalar `int`/`bool`
  throw payloads are retained through direct, conditional `if`, and scalar
  `switch` completion and can bind immutable catch-local predicates. Normalized
  integer and boolean literals are tracked, including switch fallthrough and
  default paths. Switch joins require every selected throwing path to carry a
  tracked payload. Direct and conditionally joined normalized object-literal
  throws may expose fields present on every joined branch through catch-local
  property reads. Missing/dynamic object fields, effectful or unresolved return
  calls, string/null payloads, other
  abrupt finally forms, dynamic/spread/destructured/`for await` iteration,
  labels, and arbitrary exception-aware CFGs remain
  unsupported. The opt-in Z3 validator proves equivalent boolean guards and
  integer updates when their normalized syntax differs.
- Evidence artifacts bind source/model inputs, configuration, tool versions,
  and outcomes. They deliberately do not claim to be independently checkable
  proof terms.

## Async, resources, and event loops

- Promise executors, reactions, `await`, `try`/`catch`, floating rejection
  diagnostics, and the major Promise combinators have executable models for
  the documented fragments. The ownership fixed point routes explicit `throw`
  completions and a structured expression fragment proven both `never` and
  `Throw<E>` into the nearest `catch`, including `return fail()` without
  misclassifying it as a completed return. Literal/immutable-const truthiness
  selects supported `&&`, `||`, and ternary paths. Statically nullish literals,
  `void`, global `undefined`, and immutable aliases select a supported `??`
  right side; nullable unions and shadowed identifiers remain unknown.
  Arbitrary expressions still retain a conservative possible-throw catch entry.
- Standard-library identity recognizes a direct
  `Promise.{all,allSettled,race,any}(values.map(async ...))` pipeline as
  transferring every mapped callback rejection to the aggregate Promise.
  Detached maps, intermediate aliases, user-defined collectors, and exotic
  proxy/accessor iteration remain unproved or diagnostic.
- Promise ownership loop closure preserves a directly awaited generation across
  a retry `try` with statically primitive local preparation, a direct expression
  or variable-initializer `await`, non-reassigning post-await work, and a catch
  that replaces the generation before continuing. A possible throw before the
  `await`, or replacement followed by a possible throw, restores conservative
  catch entry, so general exception-heavy loop joins remain unsupported.
- The same catch-entry proof joins nested `if`/`else` paths when the condition
  is a primitive identifier (or supported static primitive expression) and
  both branches must reach the tracked `await`. A missing `else`, one
  unobserved branch, or a call/property condition remains a non-proof.
- Exhaustive finite-literal-union or default-covered `switch` statements use
  per-clause entry paths through unlabeled-break fallthrough. Every possible
  entry must observe before risk; call/property discriminants, effectful case
  labels, or one unobserved entry retain the conservative catch state.
- Nested `try`/`catch`/`finally` composes into the outer catch-entry proof when
  the inner try must observe first and neither handler replaces the tracked
  Promise generation. Handler calls may throw after observation; replacement
  in `catch` or `finally` remains conservative because a later throw can lose
  the replacement.
- `using` and `await using` track reverse-order disposal, exceptional exits,
  and selected exactly-once lifetime obligations. The finite loop alias summary
  accepts a direct or static-slot alias cleared by a common `finally` for every
  continuing input state; a conditional clear remains a disposed-use error.
- Web and Node event-loop models cover the implemented ordering fragments for
  timers, intervals, microtasks, animation frames, Promise jobs, cancellation,
  and selected Node phases. Host-specific gaps remain explicit.
- Real-time annotations use logical clocks, guards, deadlines, and bounded
  exploration. They are opt-in and are not assumed for ordinary programs.

## React function components

- `/* uneffect: react component */` opts function declarations and
  variable-bound function expressions/arrows into a TSX-specific semantic
  check without changing runtime output.
- A comment on a wrapper variable may cross direct named/default/namespace
  React `memo` and `forwardRef` chains around an inline function or a
  source-local immutable function/arrow or write-screened module-local
  function declaration reached through transitive `const` aliases. The
  variable identity survives Program imports and Suspense resolution. Optional
  memo comparators form a pure `memo-compare` phase; observable or opaque
  comparators and unsupported wrapper shapes fail closed. The declaration
  write screen is conservative and may reject shadowed-name uncertainty;
  mutable/imported/member/dynamic component arguments and custom wrappers
  remain unsupported.
- The initial phase projection distinguishes replayable render, inline JSX
  event callbacks, immutable component-local and write-screened module-local
  referenced/aliased event callbacks, `useInsertionEffect`, `useLayoutEffect`, `useEffect` setup, and returned
  cleanup functions. Inline JSX callback refs plus immutable component-local
  and write-screened module-local callback functions/arrows reached through
  transitive `const` aliases form a
  separate commit setup and returned-cleanup phase. Source-only analysis keeps
  imported, prop, member, or dynamic callback refs as explicit unknowns.
  Program analysis resolves write-screened JSX event/ref functions through
  named aliases, barrels, default imports, and namespace imports while retaining the
  declaration module's effect and acquire/release contracts. Reassigned,
  unresolved imported/prop/member, or dynamic callbacks remain unknown. Reassigned
  or opaque referenced event handlers are rejected rather than assumed pure.
  Aliased named imports from `react` are recognized.
- Render-time `.current` access remains rejected except for a direct or
  transitively aliased `useRef(null)` binding guarded by one strict null test
  and assigned once, without `else`, from the supported stable literal/object/
  array expression fragment. This is a syntactic predictable-initialization
  proof; constructor/factory purity and general dominance are not claimed.
- Insertion Effect setup is ordered before callback refs, layout Effects, and
  passive Effects in replay and Quint. Direct `useState`/`useReducer`
  dispatchers and their transitive local `const` aliases are rejected inside
  insertion callbacks, as is local `useRef.current` access before ref
  attachment. Host DOM mutation timing and cross-component
  insertion-cleanup/setup interleaving are not claimed.
- Effect and reviewed render-Hook callbacks resolve inline functions plus
  immutable component/custom-Hook-local functions through transitive `const`
  aliases. Program analysis additionally resolves write-screened named,
  barrel, default, and namespace imports, retaining definition-module effects,
  setup/cleanup resource identity, custom-Hook composition, render-purity
  diagnostics, and replay. Imported callbacks have no caller-local capture
  obligations; mutable/unresolved-member/dynamic callbacks remain fail-closed.
- Inline and immutable local actions passed to named/default/namespace
  `startTransition` or the setter returned by `useTransition` are traversed in
  the enclosing phase, including transitive `const` aliases.
  This preserves nested capabilities. In the supported JSX-event fragment,
  direct `useState`/`useReducer`/`useOptimistic` updates after `await` must enter
  another recognized Transition. A separate bounded Quint projection models
  aggregate pending Actions, arbitrary settlement order, interruptible render,
  retry, and final commit. Imported, reassigned, higher-order,
  custom-Hook-returned, and otherwise opaque async flow remains outside this proof.
- An explicit analysis-backed Transition/Suspense projection applies the
  already-revealed-boundary rule: suspension and interruption preserve stale
  content and suppress fallback until resolution, retry, and final commit.
  A distinct analysis-backed fallback projection accepts either
  `newlyMountedTransition` or `urgentUpdate`, permits fallback only after
  suspension, requires resolution before retry content commits, and removes
  fallback when content commits. The scenario remains an explicit input;
  prior visibility and update urgency are not inferred runtime facts.
- Named/default/namespace `useActionState` and `useOptimistic` calls separate
  side-effecting Action callbacks from pure optimistic reducers. JSX
  `action`/`formAction` accepts a directly returned Action dispatcher, while
  direct render/event calls to Action and optimistic setters are rejected
  unless nested in a recognized transition Action. A separate bounded Quint
  projection proves single-active sequential queue ordering, pending-state
  consistency, and cancellation of queued tail work after failure. Direct
  Action throws retain `Throw<ErrorType>` or `Throw<unknown>` evidence. A
  Program-resolved write-screened imported Action/reducer uses its
  definition-module effects, helper graph, and throw evidence. A companion
  projection composes failure cancellation, Hook rethrow, fallback
  render, and fallback commit for explicitly selected action/fallback
  component summaries. It is not automatically derived from dispatcher call
  cardinality or JSX Error Boundary ownership and does not model state values,
  optimistic rollback, or progressive enhancement.
- Local named/aliased `useEffectEvent` callbacks and transitive `const` aliases
  compose into insertion/layout/passive setup and cleanup phases. Their
  bindings are omitted from dependency requirements; explicit dependency-array
  entries and calls from render, JSX events, or transition actions are
  diagnosed. Prop/import/higher-order Effect Event flow remains unsupported.
- `useSyncExternalStore` resolves inline, module-local, immutable local, and
  Program-resolved write-screened imported subscribe/client-snapshot/server-
  snapshot callbacks. Snapshot capabilities
  occupy specialized client/server phases; subscribe setup and returned
  cleanup form an identity-checked commit lifecycle that reaches Quint.
  Opaque callbacks, missing returned unsubscribe functions, and direct fresh
  object/array snapshots fail closed. Member
  callbacks, general cache proofs, exact call counts, transition fallback, and
  hydration equality remain unsupported.
- `useImperativeHandle` resolves named/default/namespace calls and local,
  module-local, or Program-resolved write-screened imported factories. Factory
  work is a layout-commit lifecycle; methods,
  accessors, and function properties on directly returned object literals are
  separate externally invoked capabilities. Dependency omissions, conditional
  calls, and opaque factories fail closed. Object spread, prototype/member
  factories, and cross-component ref-call flow remain unsupported.
- `/* uneffect: react hook */` adds the same replayable boundary to custom
  Hooks. Source-local calls and TypeScript-symbol-resolved named aliases,
  barrels, namespace properties, and default imports compose their phase
  summaries into components through a Program-level fixed point. The complete
  result is cached by immutable TypeScript `Program` identity and exposed as a
  `ReadonlyMap`; a changed project requires a new Program snapshot.
- Local and cross-module custom-Hook call cycles are diagnosed on each
  participating edge, including indirect recursion.
- The tested fragment rejects direct render capabilities, selected
  non-idempotent host reads, and control-flow-dependent built-in Effect Hook
  calls. It also treats identifier/destructured props, direct `useState` /
  `useReducer` snapshots, direct `useContext` results, and transitive local
  `const` aliases as immutable render regions for assignment, update, and
  delete writes. Direct `useRef` results and local `const` aliases reject
  `.current` reads/writes in replayable render while remaining usable in event,
  Effect, and callback-ref phases.
- Other named React Hooks receive stable-order checks. Reviewed inline
  `useMemo`, lazy `useState`, and `useReducer` initializer callbacks are
  executed in render summaries, while retained `useCallback` bodies are not.
- `react acquire Capability` and `react release Capability` contracts require
  setup acquisition to have a matching returned cleanup release. Optional
  `acquire Capability result` / `release Capability parameter N` contracts
  additionally prove exact-once cleanup for direct result bindings and local
  immutable identifier aliases.
- Component and custom-Hook summaries expose production, development Strict
  Mode initial-mount, one bounded concurrent-interruption, dependency-change,
  and single/repeated Suspense-retry projections. These distinguish committed, discarded, and
  suspended render attempts and model render multiplicity and
  Effect/callback-ref setup/cleanup cycles without claiming total host
  scheduling order. Source-derived instance paths preserve each setup's own
  cleanup effects through repeated and transitive custom-Hook calls.
- Dependency-change replay assigns the old setup/cleanup to its original commit
  generation and the replacement setup to the next generation. A lifecycle
  transition cannot be justified by a different or uncommitted generation.
- Bounded Suspense replays give each suspended attempt an identity, resolve it
  explicitly, and permit either another suspending retry or the replacement
  commit only afterward. They do not claim unbounded retry, general fallback-tree,
  or scheduler coverage.
- An explicit two-component Suspense boundary projection preserves primary and
  fallback lifecycle instances separately, requires resolution before reveal,
  and requires same-phase fallback teardown before primary setup. Boundary
  selection can be caller-supplied. The analyzer also extracts named/aliased
  React Suspense edges when fallback and primary are single direct annotated
  component elements, and reports recognized unsupported child shapes.
  Program analysis resolves these direct tags through named aliases, barrels,
  namespace imports, and default exports and retains canonical component keys.
  Transparent JSX/React Fragments and multiple direct component/boundary
  children normalize into ordered `primaryNodes`; Program resolution retains
  canonical component keys and parent/child boundary identities. A bounded
  one-suspension Quint model permits only the selected leaf's nearest fallback
  to commit. A fallback in an ancestor or sibling branch violates the invariant.
  React `use(value)` records a suspension source; Program analysis promotes it
  only when every argument-type constituent has callable `then`, including
  evidence composed through resolved custom Hooks. An opt-in causal generator
  excludes unknown and non-suspending leaves. Direct and custom-Hook-composed
  render throws use the same TypeChecker-backed classification while retaining
  `non-thenable` evidence for ordinary errors.
- The replay IR generates reviewable production, development Strict Mode,
  interrupted-render, dependency-change, or single/repeated Suspense-retry Quint with
  per-instance setup/cleanup counters.
  `reactLifecycleSafe` rejects cleanup-before-setup, commit-side setup without a
  committed render, retry-before-resolution, and counter-bound violations
  and preserves insertion/ref/layout/passive setup order.
- Inline dependency arrays for `useEffect`, `useInsertionEffect`, `useLayoutEffect`, `useMemo`, and
  `useCallback` are checked against lexically captured owner bindings. The
  checker understands member-path coverage, block/function shadowing, common
  stable React return positions, and rejects opaque/dynamic/unstable evidence.
- Dynamic/higher-order Hook calls, symbol-resolved dependency callback aliases,
  custom stability contracts, general/reassigned state-context aliases,
  interprocedural region flow, prop callback refs and unresolved/dynamic imports,
  general lazy-ref factory/constructor initialization and dominance, imperative
  handles,
  general/dynamic Suspense subtrees through wrappers or expressions, runtime
  reachability and thenable pending/fulfillment/rejection state, suspension
  originating in a boundary or fallback, transition/Offscreen
  scheduling, server components, and Z3 lifecycle projection remain unsupported
  rather than implicitly verified.
- The checked-in telemetry dashboard dogfood composes state, memoized render
  calculation, custom subscription setup/cleanup, an identity-checked callback
  ref, and a Fetch event. Removing Effect/ref cleanup, substituting another
  resource identity, removing a dependency, or mutating props is a
  load-bearing negative control.
- A checked-in multi-file dashboard additionally exercises named barrel,
  namespace, and default custom-Hook composition through TypeScript symbols.

## Validators, generators, and numeric memory safety

- Registered custom validators can attach proof-backed specializations. The
  call-cardinality lattice tracks `0 | 1 | many | unknown` through supported
  local, cross-module, Generator, and AsyncGenerator call paths.
- Contract-derived property tests support primitive and machine-number
  boundaries, literal unions, records, nested optional presence, and bounded
  arrays, with deterministic counterexamples for the supported subset.
- Typed-array analysis checks supported allocation bounds, index bounds,
  element ranges, bitwise/shift semantics, and optional runtime refinements.
  SHA-256 building blocks are covered, but the complete interprocedural proof
  is not yet available.

## Native integration, CI, and performance

- The analyzer core is separated from frontend adapters. A Rust neutral IR and
  schema-v7 consumer cover structured declarations, source spans, inferred
  effects, calls, and ordered events. These are currently TypeScript-reference
  facts passed through Rust, with machine-readable provenance. An optional
  real corsa-bind exporter covers a fail-closed multi-file top-level function
  declaration, single immutable arrow/function-expression binding, and
  identifier-named top-level class method direct-call/type/trivia slice with
  named-function overload candidate/selection facts and project-wide byte
  coordinates; broader
  neutral-IR export remains incomplete.
- CI separates unit, Z3, Quint simulation, exhaustive Quint, and integration
  jobs. Dependencies and solver/tool inputs are pinned, and solver-bearing test
  files run in separate processes. Z3 tests that need heap-failure containment
  can be isolated by selector; Quint-bearing files are captured and retried at
  file granularity only for a child `spawnSync pnpm ETIMEDOUT` signature.
- Hoare-contract, ownership-evidence, and temporal SMT-LIB share an
  `auto | native | wasm` execution boundary. Auto mode prefers an available
  native process, falls back only after classified infrastructure failure, and
  preserves every attempt in evidence; semantic `sat`, `unsat`, and `unknown`
  verdicts and malformed SMT-LIB are not retried. A canonical-command guard
  prevents an ignored WASM parser command from becoming an empty query.
  Temporal semantic lint, bounded reachability, structured trace decoding,
  property model enumeration, and typed-array obligations all use the same
  boundary; structured values are reconstructed from named scalar observations.
- Verifier-process retries preserve an opt-in, source-linked
  `uneffect.verifier-retry-evidence/v1` bundle. It contains digest-addressed
  SMT-LIB, backend attempts, output,
  the exact runner command, verdict/failure kind, exit status, duration, and
  process memory snapshots. Captured stdout/stderr are stored beside the
  manifest with SHA-256 digests.
  A clean first attempt is removed; failed/retried attempts are uploaded from CI
  even if a later attempt passes. This makes transient failures reviewable but
  classifies only comparable cross-process observations: transient recovery,
  repeated time/memory exhaustion, reproducible runtime failure, or
  inconclusive evidence. External Quint process recovery is classified
  separately and never treats invariant violations, parse/type errors, or test
  timeouts as retryable. The WASM CI job repeats the telemetry-routing
  conservation dogfood in three fresh processes with identical digest/call-count
  checks and a 64-execution budget.
- Diagnostics from every checker share one reportable shape with explanation
  notes: a counterexample is replayed over the invariant IR as concrete values,
  an effect is traced back to the operation that produces it, and a construct
  outside the verified subset is located where it appears. The `fixtures/`
  corpus commits each input next to its `.diag` output, and
  `fixtures/quality.md` scores every diagnostic against a rubric that CI holds
  at its current level.
- The published surface is one `uneffect` binary with subcommands, strict option
  parsing, and uniform exit codes. `uneffect doctor` checks the toolchain a run
  depends on before it is depended on. `check --json` emits a versioned
  `uneffect-check/v1` decision on success or failure, keeping normalized
  diagnostics, evidence, assurance blockers, claims, exclusions, and coverage
  together instead of asking CI to infer a safety result from text. An
  unknown Effect summary includes non-empty stable-coded `unknownReasons`, and
  unresolved top-level calls no longer become verified merely because no
  dynamic import is present. An
  explicitly supplied project also records analyzer/consumer TypeScript
  package provenance; unresolved or non-exact versions make assurance unknown.
  A no-positional-file solution root is expanded into separate Programs rather
  than flattened: `uneffect-workspace-check/v1` records the reference graph,
  child-first build order, config roots/provenance, child decisions, and
  aggregate assurance. Missing/malformed references, cycles, empty leaves, and
  duplicate source ownership fail closed. The CLI and programmatic workspace
  API compose uniquely resolved `verified` function and module Effect summaries
  child-first and emit a provenance ledger. Verified parameter-rooted function
  `Mutate` effects are instantiated for addressable identifier/member arguments;
  exported function-closure and module-initialization mutation roots carry a
  project/source/export identity and are instantiated only through an exact
  TypeChecker-resolved named or namespace import, including re-export chains;
  same-realm `globalThis` mutation uses the explicit
  `ecmascript:realm.globalThis` identity without equating host aliases or other realms;
  fully bounded iterator Effect parameters reuse the Program call graph's
  generator/stored/pure/forwarded specialization and bound checks across the
  boundary. Inferred/trusted/unknown summaries, ambiguous matches, unstable
  mutation arguments, inaccessible/non-exported roots, host aliases and cross-realm globals, unbounded iterator
  parameters, and opaque iterator arguments block assurance.
  Every declaration consumed by an Effect link must exactly match an in-memory
  same-compiler re-emission, with expected/actual SHA-256 digests in the ledger;
  an empty ledger is `not-applicable`, while `verified` requires an accepted link;
  SolutionBuilder freshness remains a separate reportable/required gate. This
  is content integrity, not an independently checkable TypeScript compiler proof.
  An optional exact-build gate also compares every TypeScript-emitted runtime
  JavaScript file and declaration with the same Program's in-memory emit; it
  rejects declaration-only/no-emit and transformed build pipelines.
- Performance-sensitive paths have Vitest Bench baselines. Benchmarks are
  regression signals, not proof that arbitrary applications will meet a fixed
  latency target.

## Explicit non-claims

- Uneffect does not prove arbitrary TypeScript, termination, arbitrary dynamic
  dispatch, or full JavaScript host behavior.
- A bounded model check or simulation is not reported as an unbounded proof.
- Unsupported syntax, unresolved calls, solver timeouts, and abstraction gaps
  must remain `unknown` or diagnostics; they must not be silently accepted.
- TypeScript syntax, semantic, and compiler-option errors are source-attributed
  Uneffect errors. Function and `<module>` summaries from an ill-typed source
  are `unknown`; parser recovery is never presented as proof-grade evidence.
  `verifyUneffectProject` also downgrades contract and typed-array obligations
  from that source and refuses to report a verified temporal property.
- `verifyUneffectProject` returns a cross-domain `assurance` assessment with
  source-attributed blockers, coverage, claims, and exclusions. It prevents a
  verified leaf artifact from being used as a project-level green result while
  another supplied function or semantic domain remains unknown.
- `verifyUneffectProject({ projectFile })` loads solution references and runs
  that verifier independently for each source-bearing config with its native
  options, reference edges, root set, and compiler provenance. The versioned
  workspace result aggregates graph and child blockers without flattening the
  Programs. Only the narrow verified function/module-Effect interface described above
  is linked across projects. Cross-project refinements, contracts, ownership,
  temporal models and refinement evidence remain explicit non-claims. Declaration
  bytes used by Effect links are validated; exact TypeScript runtime emit can be
  opted into, while bundler/post-transform semantic mappings remain unvalidated.
- Default `check` remains a gradual lint result. The opt-in `no-unknown`
  assurance profile rejects unknown effect summaries and non-verified emitted
  contract artifacts; `declared` additionally rejects inferred effect
  summaries. Both profiles are scoped to explicit files and opted-in analyses,
  and neither is described as a whole-program proof. Their public assessment
  objects carry machine-readable claims and exclusions; claims are emitted only
  on success and are an empty array on failure. Machine-readable
  coverage counts prevent empty results and per-file coverage gaps from passing
  vacuously; a selected file with neither an effect summary nor a contract
  artifact is an assurance blocker. Each TypeScript source now contributes a
  `<module>` may-effect summary covering direct operations, resolved calls and
  known inline and immutable local/imported callback identifiers, plus static
  local import closure. Reassigned callback bindings fail closed. Cycles
  converge by effect-set fixed point; unresolved calls and dynamic imports are unknown.
  Runtime namespace bodies and class heritage, computed names, stable decorator
  invocation, static fields, and static blocks also contribute may-effects;
  dynamically produced decorators remain unknown.
  TypeScript-resolved string-literal relative local dynamic imports contribute their
  conditional dependency closure, while computed/external/unresolved dynamic
  imports remain unknown. This is still not an ESM/TLA ordering proof.
  Reviewed static external-package initialization is an exact package-version
  or Node-major-bound trusted assumption; unreviewed or drifted packages remain
  unknown. Programmatic API consumers can extend the registry and pass the same
  instance through analysis, assumption collection, and evidence validation;
  these entries remain trusted assumptions. `check` and `evidence` load the
  same extension from a strict `uneffect-registry/v1` JSON configuration.
  Specialized platform operation records are still code-owned rather than
  configurable. A separate opt-in `module-order` artifact now extracts a
  source-mapped acyclic partial order for dependency completion, straight-line
  top-level-await resume/reject choices, and unconditional top-level throw.
  Cycles, conditional TLA, external/dynamic bodies, sibling initiation order,
  and decorator ordering remain explicit non-claims.
  Dogfood includes the executable `src/cli.ts` entrypoint.
- Direct Generator iterator consumers now expose polymorphic
  `iteratorEffectParameters` in effect summaries. Known call sites specialize
  the lazy body effects, while opaque arguments remain unknown. `no-unknown`
  accepts the represented parameter but reports that it is not a closed
  concrete effect set. `effect_parameter iterator extends ...` supplies an
  independently checked lazy-effect upper bound; complete valid bounds permit
  `declared` evidence while ordinary `effect` continues to describe only the
  function body. Symbol-resolved wrapper
  calls forward the parameter transitively and retain Promise iterable
  `Throw`-to-rejection conversion; dynamic dispatch and escaped iterator aliases
  remain explicit unsupported boundaries. The telemetry Generator dogfood checks
  a realistic 64 KiB batching producer through the public project API and
  demonstrates that narrowing away `Throw<RangeError>` fails project assurance.
- Optimizer transformations require verified evidence for the exact supported
  schema. Only narrow authorization and ownership-assertion-elision prototypes
  exist; a general proof-driven compressor or mangler is not implemented.
