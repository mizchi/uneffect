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

- Existing TypeScript remains valid: Uneffect reads only `/* uneffect:temporal ... */`
  block comments and reports malformed or unsupported directives.
- The typed annotation AST separates capability effects, Hoare-style
  preconditions/postconditions/invariants, and temporal specifications.
- Contracts can remain zero-runtime metadata or be emitted as optional runtime
  assertions. Escape hatches are explicit and recorded as assumptions.
- Helper types and values cover `Int`, `Nat`, bounded machine numbers, integer
  casts such as known `Math.floor` cases, and `u8`/`f32` runtime refinements.

## Capability effects

- The first shared region resolver follows non-escaping `const` alias chains
  and static property paths for direct call arguments. Effect-call mutation
  substitution uses this resolver and fails closed for mutable bindings,
  computed keys, extra uses/escape, cycles, and property paths whose runtime
  data descriptor cannot be established. Other region consumers have not yet
  migrated completely. The Program-backed typed-array checker now uses the
  same evidence for bounded DataView receiver aliases: repeated reviewed
  builtin accessor calls are permitted, while passing the alias elsewhere
  produces an explicit `unknown` bounds obligation. General backing-buffer
  identity, offsets, overlap, resize, detach, and transfer remain open. The
  Program-backed refinement action-helper obligation also consumes the shared
  resolver and now admits immutable alias chains without widening its direct,
  monomorphic, source-resolved helper or independently checked `Mutate`
  requirements. Immutable FixedArrayBuffer aliases now retain their size for
  DataView construction, and ownership transfer/read events carry the same
  source-stable region ID. Project reconciliation invalidates backing evidence
  even when the transfer and later DataView construction use different aliases.
  Overlapping views, resize, conditional detach, and escaping views remain
  outside this slice. Local DataView construction with literal
  byte offset/length now emits a separate backing-range obligation and gives
  immutable aliases a bounded accessor range. Literal in-range Uint8/Uint32
  `subarray` and `slice` windows similarly propagate their bounded length;
  dynamic windows become `unknown` on indexed use. Shared-versus-copied
  backing identity and overlap-sensitive writes are not yet modeled.
- Effect declarations are checked as upper bounds, propagated through resolved
  call graphs, and diagnosed when declared but unused.
- The experimental backend-neutral callable-summary API covers direct function,
  method, arrow, and function-expression bodies plus immutable local callback
  aliases. It records callback cardinality (`0`, `0..1`, `exactly-1`, `0..n`,
  or `unknown`), declared effect bounds, may-effects, synchronous throws,
  direct `Promise.reject` types, mutated regions, and source spans. Reviewed
  Array callbacks propagate throws inline, Promise reactions convert callback
  throws to rejection, and timers, microtasks, and event listeners report a
  deferred host boundary. `instantiateCallableSummary` checks concrete callback
  effects against the declared bound. This is not yet a proof for imported/open,
  returned, reentrant, concurrent, escaping, or dynamically selected callbacks;
  those cases remain `unknown`, and the older full effect analyzer still limits
  its own `effect_parameter` validation to iterator consumers.
- `uneffect-host-neutral-transitions/v1` is the first shared async/temporal
  contract. It projects callable invocation, first-settlement-wins Promise
  executors and reactions, and synchronous/asynchronous `using` disposal into
  source-attributed transitions with `inline`, `microtask`, `host-task`,
  `external`, or `unknown` lanes. `analyzeHostNeutralTransitions` connects the
  existing Program analyses and removes duplicate Promise-reaction observations.
  A bounded host projection maps inline and microtask work plus reviewed timers
  and Web EventTarget delivery to separate Web/Node queue vocabulary. Ambiguous
  Node EventTarget delivery and other unreviewed host tasks remain `unknown`.
- `generateHostTransitionModel` now joins that projection to the existing
  executable Web/Node Quint event-loop generators. It preserves exact compatible
  timer cancellation links and Node poll/close external-completion links.
  Optional `fairnessBound` emits per-transition `bounded-host-progress`
  assumptions and excludes definitely cancelled work. These fairness entries
  are explicitly `assumed`, not verified. Separately, `fairness: "weak"` or
  `"strong"` emits executable Quint temporal fairness constraints over the
  complete generated host-state tuple. It covers callback execution and Node
  poll/close external completion, combines finite callback alternatives into
  one fair action, and omits definitely cancelled work. Generated Web and Node
  fairness models are Quint-typechecked in CI. Fairness remains an explicit
  environment assumption used for liveness, not a JavaScript safety theorem;
  compatible conditional `clearTimeout` is now an explicit nondeterministic
  cancellation-versus-execution action in both host models, while definite
  cancellation disables initial pending work. Cancellation branches themselves
  are not made fair. The combined resource/Promise/external product remains
  open. Queue order, cancellation, and external-completion safety retain their
  existing checked properties.
- Abort control is also represented in the neutral layer. Local builtin
  `AbortController` construction and identity-checked `abort(reason)` calls
  produce source-attributed inline transitions; same-spelled user classes are
  ignored. Static `AbortSignal.any` entries of the form `controller.signal` are
  linked to their controller and retain source position/reason. A definite,
  unconditional abort in the same synchronous owner updates the initial Web
  abort-composition state and disables an already-cancelled scheduler task.
  Conditional abort remains the existing nondeterministic composition source.
  Async owners, controller aliases/escape, direct controller signals without
  `AbortSignal.any`, fetch and general abortable API cancellation are not yet
  claimed.
- Program-backed local binding identity is based on the TypeScript symbol's
  declaration source and offset, not its spelling. AbortController composition,
  timer handles, TaskController handles, and locally bound abort signals use
  this identity, including block-shadowing negative controls. Names remain only
  presentation data. Ownership now falls back to declaration identity when a
  stable region cannot be established. The older source-only numeric lowering
  fails closed (never `verified`) for functions containing same-spelled
  bindings. The Program-backed numeric frontend carries per-expression
  declaration keys for parameters, locals, typed arrays, buffers, and views,
  so block-shadowed arrays are analyzed independently. Runtime-contract
  alias maps are restricted to one module-level declaration scope and use the
  TypeChecker control-flow bridge whenever aliases need resolution. React's
  remaining direct-body callback maps reject a tracked name if another lexical
  declaration shadows it; this prevents a textual collision from producing a
  verified callback summary. The Program-backed JSX event-handler path also
  indexes direct local callbacks by declaration symbol, so a shadowed nested
  callback no longer blocks analysis of the referenced outer handler. The same
  lookup is used by Effect Events, ref callbacks, and annotated custom-Hook
  callback environments. Source-only React analysis retains the conservative
  shadowing gate because it has no TypeChecker identity.
- CI also runs a cross-domain rename-invariance fixture. It renames local
  bindings in abortable fetch, typed-array, ownership, and React examples and
  compares normalized semantic results rather than source spelling or spans.
- The first bounded async product recognizes TypeChecker-identified builtin
  `fetch` with a direct local `AbortController.signal`, a non-reassigned local
  signal alias, or a statically extracted local `AbortSignal.any` composition,
  plus an immutable Promise binding. Request options may be inline or a local
  `const` object literal whose only non-declaration use is the fetch call;
  binding. Its Quint state distinguishes pending, fulfilled, rejected, and
  aborted outcomes; every terminal transition is guarded by pending state, so
  settlement is first-wins. Conditional abort competes with external completion,
  while a definite synchronous abort initializes the request as aborted.
  A statically pre-aborted `AbortSignal.any` initializes the request as aborted;
  other sources compete with external completion. Mutable, reused, dynamic, or
  escaping options/signal aliases, dynamic `AbortSignal.any` source arrays, retries,
  response-body streams and resource-disposal composition remain open beyond
  the direct body-consumption fragment below.
  The same product now consumes the existing Promise-ownership analysis for
  each immutable fetch binding. It records await/return/catch observations and
  emits `abortableFetchObserved = false` when any modeled request remains
  floating. This connects rejection ownership to the cancellation/settlement
  model, but does not yet compose retry attempts.
  For `const response = await request`, direct builtin
  `json/text/arrayBuffer/blob/formData/bytes` calls are treated as body
  consumption and projected to `abortableFetchBodiesConsumed`. A missing call
  is unconsumed; a conditional call is unknown and therefore cannot satisfy the
  property. Response aliases, `body.getReader()`, clone/tee, piping, and
  cross-function consumption remain unsupported.
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
- `Random` is a normal capability boundary rather than an implicit purity
  exception. Reviewed sources include `Math.random`, Web Crypto
  `getRandomValues`/`randomUUID`, and Node crypto `randomBytes`, `randomFill`,
  `randomFillSync`, `randomInt`, and `randomUUID`; async callbacks compose their
  effects through the existing poll model. User-defined lookalikes do not match.
- The bounded numeric fragment recognizes builtin `Math.imul` as signed Int32
  output and `Math.clz32` as `0..32`, which is sufficient for corresponding
  DataView value obligations. This does not yet provide general IEEE-754
  semantics; NaN, infinities, negative zero, and rounding remain open. RegExp
  and Date semantics are intentionally deferred.
- A separate TypeChecker-backed exact IEEE fragment classifies builtin NaN,
  positive/negative infinity, negative zero, finite literal arithmetic, and
  exact `Math.fround` results. It rejects shadowed globals and methods. This is
  expression evidence only: it is not yet propagated through general mutable
  locals, branches, calls, Hoare obligations, or a Z3 FloatingPoint encoding.
  The typed-array checker separately propagates builtin `Math.fround` for a
  statically finite input range within Float32 capacity, retaining integer
  evidence only up to the exact Float32 integer boundary. Inputs that may be
  NaN, infinite, or overflow Float32 remain unknown.
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

- A public, backend-neutral completion algebra now represents normal, return,
  throw, break, and continue outcomes with typed lexical targets. Sequencing,
  catch routing, finally override, and loop-transfer consumption are shared by
  the structural contract CFG; unlabeled `break` is distinguished from
  `continue` because a switch may own the former. Promise/resource/refinement
  consumers still retain richer domain-local payload joins and are not yet all
  lowered through this algebra.
- A shared typed specification IR generates reviewable SMT-LIB obligations for
  Z3 and reviewable Quint models for temporal checking and simulation.
- The supported Hoare fragment checks integer and machine-number expressions,
  assignments, selected control flow, preconditions, postconditions, and loop
  invariants. Each supported return, loop entry, and loop back-edge emits
  versioned `uneffect-contract-control-flow/v1` evidence. Its source-stable
  block identity and exact solver path assumptions make branch-local proof and
  counterexample results reviewable. This is the checker's restricted neutral
  CFG, not a claim that TypeScript's private compiler CFG has been exported.
  When verification receives the exact checked `ts.Program`, a parameter whose
  TypeChecker type is a union of one to sixteen safe-integer literals contributes
  its finite-set assumption. This works through imported type aliases. The
  evidence records the TypeScript version and a digest over compiler options and
  all non-declaration Program sources. A source mismatch or any TypeScript error
  disables these facts; a plain `number` alias never receives a finite range.
  The same Program-backed layer accepts direct equality guards for
  `number | undefined`, `number | null`, and `number | null | undefined`, plus
  direct `typeof value === "number"`/`!==` guards for `number | string`. Guard
  evidence is tied to the exact parameter symbol and comparison source span;
  shadowed values and locally redefined `undefined` do not match. A Boolean
  discriminator is explicit in SMT rather than pretending the inactive union
  member has an integer value. Discriminated object unions and assertion
  functions remain unsupported.
  A bounded exception-aware extension routes direct synchronous `throw` and
  TypeChecker-resolved direct `never` calls carrying an explicit `Throw<E>`
  declaration into `try`/`catch`. Each return artifact records the throw edges
  discharged on that exact path, while uncaught edges remain escaping. Project
  verification joins this `uneffect-contract-exception-flow/v1` evidence with
  the exact enclosing Program effect summary as
  `uneffect-contract-effect-boundary/v1`. An escaping throw missing from the
  inferred summary downgrades the whole contract artifact to `unknown`.
  Promise rejection is deliberately not a synchronous throw edge. The same
  bounded completion model runs supported `finally` blocks on normal, return,
  throw, and rejection paths; an abrupt finalizer overrides the retained
  completion. Scalar explicit-throw payloads may bind a catch identifier.
  A directly awaited, TypeChecker-identified builtin
  `Promise.reject(value)` produces a distinct `Reject<E>` edge which catch can
  discharge, without requiring a synchronous `Throw<E>` declaration. A
  TypeChecker-resolved Promise-returning call may instead use a trusted
  `temporal-summary rejects E` declaration; it branches into fulfilled and
  rejected completion, while `temporal-summary throws E` declarations produce
  separate synchronous edges. Unannotated Promise-producing calls, opaque catch
  payloads, and general exception fixed points are not accepted. A scalar
  Promise-returning callee may expose a trusted
  `contract ensures` relation. One direct `const value = await call()` or
  `return await call()` introduces a fresh fulfilled value, substitutes scalar
  arguments into that relation, and records a source-bound `relationalCalls`
  ledger entry. Each scalar callee `requires` clause becomes a separate
  source-mapped `call-precondition` obligation. Z3 must prove it from the exact
  caller path conditions; a failed implication is a counterexample and the
  precondition is never silently assumed. Property/destructuring targets and
  arbitrary awaited expressions remain fail-closed. For same-file
  implementations, a post-solver fixed point promotes relational edges only
  when every callee obligation and every transitive relational dependency is
  verified. A failed local callee downgrades callers to `unknown`; declarations
  without bodies and circular proof chains remain `trusted`. The public
  reconciler also composes source files in one checked TypeScript Program.
  Relation evidence carries schema v1, declaration file/span/SHA-256, and exact
  TypeScript version; stale or incompatible evidence downgrades the caller to
  `unknown`. Project verification applies this pass after solving every file.
  Persisted package summaries, compiler-option identity, and exported-symbol
  provenance are not consumed at call sites yet. The standalone
  `uneffect-contract-summary/v1` producer/validator now emits package/version,
  TypeScript/compiler-options, source/declaration/signature digests, clauses,
  and supporting artifact IDs only for fully verified direct named exports.
  It validates integrity against the producer Program. `.d.ts`, export-map,
  tarball, bundled-runtime, and publisher-authenticity linkage remain open.
  Runtime assertion generation is optional.
- Temporal declarations compose calls between modeled functions, preserve
  source locations, and support runtime execution, replay, Z3 lowering, Quint
  generation, and normalized counterexample traces for the documented subset.
- The temporal scalar contract includes exact strings for identity values.
  Finite `Set<string>` and string-keyed `Map` state preserve those values through
  Quint, native/WASM Z3 bounded extraction, TLC console traces, and refinement
  replay. Strings admit equality but not arithmetic, ordering, or unbounded
  generation.
- A finite Set whose elements are directly written records with scalar fields
  has exact bounded Z3 observation and canonical Quint/TLC/replay values. A
  dynamic record element, spread, nested collection field, or incomplete
  composite universe remains `unknown`.
- Solution workspaces compose a locally verified scalar refinement action
  through a direct referenced-project call. A guarded action is admitted only
  through a sole direct wrapper call, whose inherited guard is checked against
  the parent model and recorded in `refinementComposition`. The parent action
  is checked again after summary substitution, while producer/consumer
  compiler/config and exact declaration evidence remain visible.
- A scalar child call may pass through at most two TypeChecker-resolved,
  write-screened source-local function helpers. The link records the complete
  `callPath` and `helperDepthBudget: 2`; reassignment, recursion, a third helper,
  and semantically visible helper updates fail closed.
- Refinement binding markers are consumed only when attached to exported
  top-level function declarations. A marker on a class method or any other
  unsupported declaration shape is a source-attributed project-composition
  violation; it cannot disappear into an empty `not-applicable` ledger.
- The same sole-call chain may carry a guarded child action. Every helper
  declaration is bound to the exact child contract, so guard identity reaches
  parent revalidation; helper-local guards, extra work, and conditional
  invocation remain rejected.
- A version-matched `runtime adapter@version = globalThis` annotation binds the
  refinement runtime to the builtin global object in the current Realm. Direct
  and two-helper links retain `ecmascript:realm.globalThis`; unannotated,
  shadowed, host-alias, descendant-property, Worker, and iframe identities fail
  closed.
- A versioned `runtime adapter@version = node:global@24#main` annotation binds
  the TypeChecker-resolved ambient `global` from `@types/node` major 24 to an
  explicit realm label. Exact producer/consumer identity composes; a different
  label, typings major, or local shadow fails closed with a source-attributed
  runtime-identity diagnostic. Labels remain user contracts rather than
  deployment-topology proof.
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
  One bounded three-member recurrence family additionally records a single
  acyclic driver/dependent edge. Both updated-driver and entry-driver reads are
  supported: source spans determine the emitted update order and read kind,
  and the summary uses the corresponding `n(n+1)/2` or `n(n-1)/2` offset.
  Structural convergence is not proof; Z3 still checks base, member steps, and
  ranking. Multiple/cyclic edges and general coupled recurrences remain
  unsupported.
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

- The first explicit refinement CFG fixed-point seed wraps the existing affine
  ranking-loop summary with a monotone worklist for one direct `try` containing
  a normal predecessor and one supported scalar throw entering a normally
  completing `catch`. `analyzeRefinementActionBodies` emits
  `uneffect-refinement-action-analysis/v1`, names the
  `cfg-fixed-point-iterations` budget, binds the source SHA-256, TypeScript
  version, and loop/try spans, records convergence, and marks the throw payload
  and normal snapshot retained only when the shared completion/value
  lowering validates the complete model action. Budget exhaustion, an
  unaligned/cross-state recurrence, lattice conflict, or any other action
  diagnostic yields `unknown`. The worklist is now the reusable monotone
  `solveBasicBlockFixedPoint` engine: a caller-defined lattice carries the
  normalized throw payload plus normal/catch snapshot identities through the
  loop back-edge. The shared completion lowering also supplies each direct
  predecessor's `TemporalExpression` updates; the worklist specializes them by
  the throw condition and its join block constructs a correlated phi
  environment before the back-edge and exit. It now also carries the accepted
  affine recurrence certificate—ranking counter/direction, one-iteration
  transformer, and closed-form summary—through the back-edge and requires an
  identical stable value at convergence. Full loop-recurrence summary
  construction still comes from the affine walker. The opt-in async analysis
  independently reparses that certificate and asks Z3 to prove its base case,
  inductive step for each scalar state, and ranking measure. It rejects modified
  summaries/ranking metadata and turns solver failure into `unknown`. This is
  still not a general recurrence fixed point, arbitrary AST-to-basic-block lowering,
  Program/external-action analysis,
  irreducible-loop analysis, or CLI assurance artifact.

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
  arms use the shared phi contract. A following narrow extension lets a
  normally completing catch update outer-visible mutable scalars, projects out
  its catch binding, and joins the caught result with the normal try snapshot
  before the common continuation. A direct catch return may now retain that
  projected mutation on its return edge, including through an enclosing
  mandatory `finally`; the normal try predecessor remains distinct and alone
  reaches the suffix. A direct supported scalar rethrow also projects its
  transformed snapshot and normalized payload onto the throw edge, including
  through mandatory `finally`, so an outer catch starts from matching evidence.
  A conditional catch return now retains the pre-return snapshot on its return
  edge and the post-branch snapshot on normal completion; only the latter joins
  the normal try predecessor before the suffix. A conditional supported scalar
  rethrow similarly retains its branch snapshot and payload on the throw edge,
  while a later normal catch mutation reaches the suffix; mandatory `finally`
  and an outer catch preserve that pairing. A conditional catch-owned break now
  retains its projected mutation through mandatory `finally`, is consumed by
  its owning bounded loop, and joins the post-loop local environment while the
  normal catch snapshot alone reaches the loop suffix. Catch-owned continue
  now has the corresponding projected edge: mandatory `finally` observes it,
  the owning bounded loop advances the next iteration from it, and the current
  suffix is skipped. The statically resolved owning-loop label is accepted;
  unknown/cross/nested labels and opaque rethrow payloads remain non-proofs. A
  mandatory-`finally` extension records direct
  return snapshots as well, projects catch-local environments to bindings
  visible outside the protected region, and joins normal, return, and supported
  typed throw/catch-return predecessors before evaluating finally state writes.
  `try/finally` without `catch` also preserves its normal local environment.
  A normally completing mandatory-finally block may now mutate outer-visible
  scalars. State updates are evaluated once over the joined incoming map, while
  the local-only transformation is replayed over the normal and each supported
  abrupt predecessor map. The transformed snapshots are attached to surviving
  return/throw/break/continue edges, so a nested outer finally observes the
  post-finally value. Mutation combined with a conditional or abrupt finally
  override previously remained fail-closed. A narrow extension now permits a
  conditional direct return: the finally transformation is replayed over each
  predecessor, its return snapshot overrides normal or abrupt completion, and
  an outer finally observes the selected transformed snapshot. The same narrow
  rule now accepts a supported normalized scalar throw, preserving its payload
  with the finally-owned snapshot for an outer catch. A finally-owned break may
  likewise override normal or throw completion and is consumed with its
  transformed snapshot at the owning bounded-loop boundary. A finally-owned
  continue likewise overrides its predecessor and advances the next bounded
  iteration from that snapshot. A statically resolved owner label is accepted;
  opaque payloads and cross/nested label capture remain fail-closed.
  A scalar-switch extension assigns a separate local map to every expanded case
  entry/fallthrough path, merges normal values by case selection, and carries
  selected return/throw maps into the existing completion lattice. Default-free
  unmatched input retains the pre-switch environment. Opaque discriminants,
  dynamic/duplicate cases, nested-block case mutation, finally-local mutation,
  label, and standalone-block flow remain non-proofs.
  A bounded finite-loop extension now passes the preceding iteration's normal
  or consumed-continue local map into the next expansion. Break, continue,
  direct-return, and supported typed throw completions own distinct snapshots;
  loop-owned transfers are consumed only at the loop boundary, and mandatory
  `finally` reads the snapshot for each incoming edge. Dynamic or over-budget
  loops and mutable-local labeled transfers remain non-proofs.
  Ordinary standalone lexical blocks now use a nested local map and project
  every normal/return/throw/break/continue snapshot back to names visible at
  block entry. Block-local constants remain usable inside the block but cannot
  escape; shadowing, catch/finally-side mutation, nested switch-case mutation,
  and labeled mutable-local ownership initially remained non-proofs.
  A following owner-label slice removed the synthetic return rewrite for
  non-loop labeled blocks. The original TypeScript AST now records an owned
  `break` edge with its local snapshot, joins it with normal completion, and
  evaluates the outer continuation once. Bounded ascending `for` and literal
  `for...of` labels use the same edge ownership for their own break/continue
  transfers. Unknown targets, nested labels, cross-label mutable-local
  capture, and real returns inside the non-loop label fragment remain
  fail-closed.
  Finite loops are expanded into the same completion sequence as straight-line
  code, so an early return suppresses later iterations while a surrounding
  `finally` still runs. The
  same completion machinery consumes a statically named block's own `break`
  after its mandatory `finally` work and then executes the outer continuation.
  An unconditional supported `return` or `throw` terminates collection of its
  lexical suffix; preceding updates remain visible, while unreachable writes
  cannot satisfy a temporal action. Bare lexical blocks propagate the same
  normal/return/throw completion state into the enclosing sequence, but their
  local constants and receiver aliases do not escape the block.
  Non-loop labeled blocks support only their own `break`; labeled `continue`,
  nested block labels, and real returns inside that fragment remain
  unsupported. The action-control subset
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
- Refinement analysis emits a budgeted `handler-join-fixed-point` artifact for
  application-backed nested `if` and finite exhaustive `switch` control roots
  inside `try`, followed by a supported catch and optional normally completing
  finally. A reusable AST-to-basic-block builder retains source-keyed branch,
  statement, normal/return/throw, catch, join, finally, and exit states. Caught
  throw becomes normal catch entry, while return remains abrupt through normal
  finally. Budget exhaustion and action mismatch are non-proofs; attempted-family
  loops, incomplete switches, labeled transfers, nested try, and abrupt finally
  produce `unknown: unsupported-control-flow`. One control root, or exactly two
  top-level sibling `if` roots, may have supported prefix and suffix statements;
  abrupt blocks have no edge into their suffix. The artifact records all root
  spans and the named `handler-control-roots` limit of two. Three roots, mixed
  sibling shapes, general handler joins, and independent path-correlated value
  proof remain outside this bounded fragment.
- One top-level handler-local `for...of` over one to four direct numeric or
  Boolean literal elements is structurally unrolled. Repeated source statements
  receive iteration-qualified block IDs, and verified evidence includes the
  named `handler-loop-iterations` limit and observed cardinality. Dynamic,
  empty, spread, destructured, `for await`, over-four, break/continue,
  resource-bearing, nested, catch-local, and finally-local loops fail closed.
- One outer handler may contain one direct inner try/catch at total nesting
  depth two. The shared graph routes a handled inner throw through the inner
  join and an inner-catch rethrow into the outer catch, and evidence records
  `handler-nesting-depth` with limit two. Depth three, inner finally,
  return/break/continue, loops, resources, multiple nested regions, and nested
  handlers in catch/finally fail closed.
- Two or three sibling inner try/catch regions may compose sequentially under a
  shape-specific root limit of three. Every nested try-completion, catch, catch-completion, and
  join block includes the inner try source start, so handled throws and rethrows
  cannot collide between regions. A fourth sibling remains an explicit
  `handler-control-roots` over-budget non-proof.
- `uneffect-refinement-action-analysis/v2` additionally carries one changed
  integer state through exactly two of those source-keyed regions. The existing
  refinement evaluator records each region's entry and exit expression, and the
  shared CFG worklist accepts the handoff only when the predecessor exit exactly
  matches the successor entry. An intervening scalar write is a
  `lattice-conflict`; a one-step worklist budget remains
  explicit non-proofs. Structural convergence alone reports
  `independent-proof-required`. `analyzeRefinementActionBodiesWithZ3` reparses
  the final and declared expressions and is the only path that upgrades this
  obligation to `verified`; a wrong action is refuted and solver unavailability
  stays `unknown`. Objects, aliases, arbitrary region
  counts, recurrence widening, and irreducible CFGs remain outside this slice.
- The same v2 obligation represents its bounded value lattice as a
  `members[]` product rather than a distinguished scalar. It accepts one or two
  independently changed integer members; each member retains its own declared
  expression, emitted expression, and two or three source-keyed region snapshots. Z3
  records a check for every member and the product is verified only when all
  checks succeed. One refuted member refutes the product, solver failure leaves
  both checks unknown, and a third changed integer reports
  `scalar-cardinality-unsupported`. This does not establish relational
  widening, cross-member recurrence reasoning, heap products, or arbitrary
  environment cardinality.
- The three-region product uses the same worklist and `members[]` contract. The
  scalar region budget is explicitly three, while other handler root shapes
  retain their existing limit of two. Every member must preserve all three
  source-keyed handoffs and pass its own Z3 equivalence check. A fourth nested
  region, inter-region write, worklist exhaustion, or wrong member remains a
  machine-readable non-proof. This is not arbitrary reducible CFG support.
- One direct conditional product topology is supported: a top-level `if/else`
  contains one source-keyed nested handler per arm and is followed by one common
  nested handler. The worklist labels then/else predecessor environments and
  applies `predicate-correlated-phi` only when both changed integer actions
  retain the matching route and branch conditions. The artifact records both
  predecessor spans/region IDs and the successor region ID. Predicate loss,
  predecessor drift, an inter-join mutation, budget exhaustion, refutation, and
  solver failure remain non-proofs. Other mixed roots and arbitrary reducible
  joins are not implied.
- An exact same-predicate catch join may restrict an inner conditional value to
  the branch implied by the caught path. The artifact records the normalized
  predicate and `same-predicate-branch-restriction`; predicate drift emits no
  such evidence and remains an action mismatch. This rule is syntactic and does
  not claim general logical implication or solver-backed path feasibility.
- Catch-less `try`/`finally` is included when a supported finalizer contains the
  selected control roots. Normal finalizer paths preserve incoming completion;
  direct return/throw blocks replace it and are listed in `finallyOverrides`.
  Unsupported finalizer loops and statements produce an explicit non-proof.
- The direct affine ranking-loop analysis now reuses those same source-keyed
  handler blocks before its loop back edge. Its payload/snapshot lattice is a
  `handlerCompletion` extension on the common `scalar-recurrence-fixed-point`
  artifact; the recurrence certificate and independent Z3 proof use the same
  fields as direct loops. Structural convergence is provisional. The default
  named recurrence budget is 64 and the migrated handler seed retains an
  explicit eight-member compatibility cap; general handler loops and recurrence
  widening remain unsupported. The legacy v2 `ranking-loop-fixed-point` type,
  schema branch, and Z3 dispatch path have been removed.
- The shared `scalar-recurrence-fixed-point` obligation also supports one
  direct affine `while` without try/catch. It binds the final body
  statement and loop header as the machine-readable back edge, carries one or
  two integer transformer members through the shared worklist, and reports
  only `independent-proof-required` after structural convergence. The Z3 path
  upgrades it only after every base/step check and the ranking check succeeds.
  Coupled, self-amplifying, path-dependent, over-cardinality, budget, and
  solver controls remain `unknown`; arbitrary loop CFGs are not claimed.
- The obligation binds its admitted direct recurrence choices through one
  ordered `controlJoins` discriminated union. One or two sequential
  loop-invariant Boolean diamonds record Boolean selectors, then/else source
  blocks (using an explicit identity block for an omitted else), each common
  join, and `predicate-correlated-affine-phi`. Predicates must be distinct
  declared Booleans, unchanged by the iteration, and each must occur in the
  emitted composed piecewise transformer.
- A control join can instead be one direct finite `switch` over an
  unchanged integer state. The admitted fragment has exactly two distinct
  non-negative numeric-literal cases plus one explicit default; every clause ends in its own
  unlabeled `break`. The union member records the integer selector,
  case/default source blocks, common join, and named two-case budget. One
  bounded mixed sequence admits exactly one Boolean diamond followed by one
  such switch. Structural evidence stays provisional and the composed
  recurrence still requires independent Z3 base/step/ranking validation.
  Reordered/mutated/nested/excess joins, fallthrough, ranking-counter or dynamic
  selectors, duplicate/non-literal/excess cases, and solver failure remain
  non-proofs. The earlier `conditionalJoins` and `finiteJoin` output fields were
  removed rather than retained as parallel compatibility paths.
- One direct ranking loop may additionally carry exactly one source-ordered
  upper-triangular affine scalar edge. The strict artifact records driver then
  dependent order and whether the dependent reads the entry or updated driver.
  The admitted application family has one constant-delta driver, one dependent,
  and one ranking member; its arithmetic-series summary remains provisional
  until independent Z3 base/step/ranking checks pass. Cycles, multiple edges,
  self-amplification, path-dependent drivers, nonlinear terms, aliases, and
  additional changed members remain unsupported.
- One loop-local conditional expression may feed a changed affine recurrence
  member through a `loop-invariant-cfg-value-join`. The artifact retains the
  exact expression span, Boolean state selector, two expression-keyed
  predecessor blocks and values, common join identity, source order, and the
  named `cfg-recurrence-value-joins` one-join budget. The value join is
  provisional until the shared Z3 base/step/ranking verifier accepts the
  resulting recurrence. Nested or multiple conditionals, local/mutable/non-
  Boolean selectors, non-affine branches, unused selected values, and solver
  failure remain non-proofs. This is predecessor-value evidence for one
  expression family, not arbitrary expression CFG lowering.
- One direct unit-countdown loop may additionally carry exactly one Boolean
  involution `state' = !state`. The strict artifact records the direct update
  span and named one-involution budget; the closed form selects the entry value
  or its negation from the iteration-count parity. The Boolean member travels
  through the shared scalar recurrence and remains provisional until Z3 proves
  its base/step obligations and the integer ranking obligation. Multiple,
  compound, path-dependent, helper-mediated, or repeated toggles and non-unit
  ranking steps remain unsupported. General self-amplification and unbounded
  geometric/exponential summaries remain explicit non-proofs.

- The completed P2.31 slice admits one deliberately finite self-affine exception.
  A direct unit-countdown loop may carry exactly one integer update `x *= k`
  when the annotated function has the exact normalized precondition
  `requires counter >= 0 && counter <= N`, `k` is a safe integer greater than
  one, and `1 <= N <= 8`. Structural analysis expands an exact finite piecewise
  summary and remains provisional. Independent Z3 base, step, and ranking
  checks run under the explicit precondition. The certificate binds that
  assumption to counter/state/multiplier/update-span and named-budget metadata;
  narrowing or deleting the assumption, changing the multiplier, or deleting
  the structured metadata is `refuted`. This does not prove the contract at
  every call site and does not admit general exponentiation, unbounded retry
  counts, additive/nonlinear updates, repeated writes, or multiple self-affine
  members.

- Completed P2.32 composes the finite self-affine rule with one shared handler CFG.
  An unchanged Boolean state must route exactly one throw into catch, the catch
  must contain the only multiplicative update, and a mandatory `finally` must
  perform the unit countdown. The strict evidence adds
  `activation: { selector, when, predecessor: "catch" }`; the verifier binds
  this metadata to the actual conditional iteration and refutes deleted,
  inverted, non-Boolean, or otherwise mismatched activation. The success path
  stutters the self-affine state. Dynamic/mutable selectors, both-path updates,
  early exits, additive forms, and general handler recurrence solving remain
  unsupported.

## Async, resources, and event loops

- `completion-flow.ts` defines the shared completion kinds, loop-target identity,
  concrete conditioned paths, and predicate-joined payload/snapshot summary used
  by refinement and async safety. Handler-local loops consume only their own
  break/continue. A canonical one-to-eight-iteration outer `for` whose block is
  leading lexical `using` declarations followed by one final `try` can consume
  statically owned labeled `continue` and `break` after reverse-order async
  disposal. Continue advances the resource generation; break reaches the first
  post-loop await through a distinct cleanup edge. Quint tracks acquisition
  generations and rejects stale or skipped transfer cleanup. Other outer
  A resource-free dynamic `for`, `for...of`, `for...in`, `while`, or
  `do...while` can also retain a lexically owned `continue`; unified Quint
  lowers unknown cardinality as nondeterministic repeat-or-exit. This preserves
  routing but proves neither termination nor fairness. Resource-bearing dynamic
  loops, unresolved labels, and unsupported nested ownership remain visible in
  `completionPaths`, emit `unsupported-control-transfer`, and make unified
  lowering refuse the model.
- A function-scoped mixed-disposal acceptance model routes one caught awaited
  rejection through concrete catch and mandatory finally statements, then
  disposes an async resource before an earlier sync resource. Quint checks an
  explicit same-scope reverse-order invariant; reordered cleanup, skipped
  cleanup, and a source-level floating Promise are load-bearing controls.
- A nested acceptance model lets either of two awaits reject into one finite
  conditional recover/rethrow catch, traverses mandatory finally, and releases
  an inner async resource before an outer awaited continuation. The cleanup
  invariant includes containing-scope precedence; reordered terminal cleanup,
  skipped normal scope cleanup, floating rejection, and unresolved outer-label
  transfer are negative controls.
- A caught-disposal acceptance model declares one async resource inside a
  protected inner scope. Disposal rejection remains pending until the enclosing
  conditional catch recovers or rethrows it; mandatory finally and remaining
  outer cleanup still run. Quint rejects a transition that bypasses the handler.
  The model records handled/pending state, not a concrete rejection payload or
  multi-disposal `SuppressedError` tree.
- A two-resource protected-scope model routes body rejection and later-resource
  acquisition failure through the same reverse disposal chain. One or both
  disposals may reject; catch begins only after both finish, and Quint records a
  finite single/suppressed kind. Premature handler entry, lost suppression,
  skipped scope cleanup, reordered cleanup, and floating rejection are
  load-bearing controls. Exact nested error payloads remain in the analysis IR,
  not in this finite Quint state.
- A branch-correlated protected-scope model accepts one finite Boolean
  `if`/`else` where exactly one of two differently named async resources is
  acquired. The generated Quint model retains the shared condition polarity,
  requires every acquisition to imply its source branch, and forbids disposal
  of an unacquired resource before entering the shared catch/finally join.
  Both-branch acquisition, wrong-branch cleanup, skipped cleanup, premature
  handler entry, and floating rejection are load-bearing controls. Nested
  branch trees, dynamic discriminants, multiple branch-local resources, and
  arbitrary joins remain unsupported.
- An exhaustive-switch extension accepts a finite string-literal union
  identifier, literal cases, an explicit default, no fallthrough, at most eight
  case conditions, and exactly one differently named async resource per path.
  The analysis IR records discriminant provenance; model generation proves the
  finite path set covers every selection and that resource paths do not overlap.
  Quint additionally checks pairwise acquisition exclusion. Missing default,
  fallthrough, open `string` discriminants, multiple acquisition, wrong-case
  cleanup, skipped cleanup, premature handler entry, and floating rejection are
  load-bearing controls. This is not support for arbitrary switch expressions
  or CFG joins.
- A nested-Boolean extension accepts one complete three-leaf tree formed by an
  outer Boolean identifier and one nested Boolean identifier. Analysis records
  predicate provenance; generation enumerates at most eight Boolean conditions
  to prove complete, pairwise non-overlapping leaf coverage before Quint checks
  pairwise acquisition exclusion. Expression predicates, incomplete leaves,
  multiple resources on one leaf, and deeper over-budget trees are explicit
  non-proofs. Multiple acquisition, wrong-leaf cleanup, skipped cleanup,
  premature handler entry, and floating rejection remain load-bearing controls.
- A mixed extension accepts one finite string-literal `switch` whose preferred
  case contains one Boolean-identifier choice and whose explicit default owns a
  backup resource. Generation validates both provenance kinds, complete and
  pairwise non-overlapping mixed leaves, and one shared eight-condition budget
  before Quint checks path implication, pairwise acquisition exclusion, and
  dispose-after-acquire. Expression predicates, open discriminants, missing or
  overlapping leaves, multiple resources per leaf, and larger mixed trees are
  explicit non-proofs. Cleanup, handler, acquisition, and floating-Promise fault
  injections remain load-bearing.
- A sequential extension accepts two independent finite resource decisions in
  one protected `try`, with the first lexical resource scope ending before the
  second begins. It validates each stage and one shared eight-condition budget,
  keeps pairwise exclusion local to each decision, and emits a load-bearing
  `sequentialResourceJoinSafe` invariant requiring first-stage disposal before
  second-stage acquisition. Incomplete or overlapping stages, aliases used
  after the intermediate join, delayed/skipped/wrong cleanup, wrong-stage
  acquisition, premature handler entry, and floating rejection are explicit
  negative controls. This is not a general CFG fixed point.
- A non-uniform completion extension accepts one Boolean first-stage decision
  where one async-resource arm completes with early `return` or a directly
  typed `throw`, and the other completes normally into a later finite switch.
  Analysis distinguishes fallthrough conditions from acquisition decisions.
  Quint gives return and pending typed throw distinct completion kinds, disposes
  the selected abrupt resource first, routes throw to catch for conditional
  recover/rethrow, and traverses mandatory `finally`. Neither abrupt path may
  reach later acquisitions; return also cannot reach the outer continuation.
  Rejection before the abrupt statement still enters catch after cleanup rather
  than being mislabeled. Dedicated fallthrough, cleanup-before-completion,
  throw-handler-bypass, and normal-continuation-skip faults prove
  `returnCompletionSafe`, `throwCompletionSafe`, and `normalContinuationSafe`
  load-bearing. Incomplete/overlapping paths, wrong/skipped cleanup, premature
  handler entry, and floating rejection remain negative controls. Indirect or
  expression-level throw production, more than two stages, and arbitrary CFGs
  remain unsupported.
- A generation-aware loop extension accepts one canonical two-iteration outer
  `for` whose body contains one complete Boolean-identifier `if`/`else`. Each
  branch acquires exactly one lexical async resource and performs only direct
  awaited expression statements before a final `try` owns the already supported
  labeled `continue`/`break`. `loopGenerationSafe` prevents disposal evidence
  from iteration one satisfying iteration two, while branch cleanup completes
  before the iteration join. Stale-generation reuse, reacquisition before prior
  cleanup, wrong/skipped cleanup, caught-rejection bypass, floating Promise,
  dynamic/over-budget bounds, expression predicates, incomplete branches, and
  alias escape are negative controls. This is deliberately not a loop fixed
  point or escaping-alias analysis; those remain #23 and #24 respectively.
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
  and selected Node phases. `generateTemporalModel` is the stable public entry:
  both profiles compose user temporal state, callback summaries, and safety
  properties with those extracted observations. A selected root's
  `using`/`await using` lifecycle is co-verified as a second projection through
  the same result and project pipeline. Promise ownership and synchronization
  between conditional/loop resource disposal and host queues remain explicit
  exclusions. Straight-line `await using` has a bounded host product that
  requires resumption inside a microtask checkpoint, but arbitrary callback
  interleavings remain excluded. Direct low-level generators live under
  `@mizchi/uneffect/experimental` while #63 tracks the remaining composition.
  Host-specific gaps remain explicit.
- Real-time annotations use logical clocks, guards, deadlines, and bounded
  exploration. They are opt-in and are not assumed for ordinary programs.

## React function components

- `/* uneffect:react-component */` opts function declarations and
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
- `/* uneffect:react-hook */` adds the same replayable boundary to custom
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
- A versioned explicit property-predicate registry admits one exported,
  source-local or directly named-imported unary function used exactly as
  `requires predicate(parameter)`. Cross-file resolution binds the TypeChecker
  symbol to its canonical declaration file and exported name.
  Its finite primitive candidates are rechecked by the real predicate in the
  generated Vitest; zero valid candidates fail as vacuous, and shrinking stays
  within smaller registered candidates that preserve the precondition.
  Recursive, higher-order, multi-argument, nested-call, barrel/namespace/default
  import, and inferred predicate domains remain unsupported.
- Typed-array analysis checks supported allocation bounds, index bounds,
  element ranges, bitwise/shift semantics, and optional runtime refinements.
  SHA-256 building blocks are covered, but the complete interprocedural proof
  is not yet available.

## Native integration, CI, and performance

- The analyzer core is separated from frontend adapters. A Rust neutral IR and
  schema-v8 consumer cover structured declarations, source spans, inferred
  effects, calls, and ordered events. These are currently TypeScript-reference
  facts passed through Rust, with machine-readable provenance. An optional
  real corsa-bind exporter covers a fail-closed multi-file top-level function
  declaration, single immutable arrow/function-expression binding, and
  identifier-named top-level class method direct-call/type/trivia slice with
  named-function overload candidate/selection facts and project-wide byte
  coordinates. It also exports one checker-inferred `Console` fact for the
  standard `console.log` identity, including builtin key, operation span,
  checker symbol, declaration, and compiler provenance; the same-spelled local
  object is a negative control. The application-backed follow-up also exports
  named exact-module `node:fs/promises` reads/writes and standard global fetch
  as `FsRead`, `FsWrite`, and `Fetch`, with ordered spans, import-binding or
  library-declaration evidence, same-spelled local/local-module controls, and
  builtin-key tamper detection. The completed direct-await follow-up exports five
  source-ordered unconditional Promise observations with exact owner/source/span
  evidence, making the Workhub-shaped corpus fully equivalent for that bounded
  fragment. The application-backed single-`if` follow-up also exports one exact
  owner-local condition ID, then/else polarity, and singleton control path.
  Nested/loop/catch conditional await evidence still differs explicitly, nested
  callback awaits stay outside the outer owner, and metadata tampering fails.
  The direct-return follow-up additionally exports unconditional checker-resolved
  Promise-call returns, including one `as Promise<T>` wrapper, with the full
  expression source/span. Promise metadata parity now compares all observation
  kinds. Conditional, non-call, and nested-wrapper returns remain explicit gaps.
  The Workhub filesystem follow-up adds exact named async imports `access` and
  `readdir` as `FsRead`, plus `appendFile` and `mkdir` as `FsWrite`, preserving
  ordered checker/import/span evidence and symbol-distinct negative controls.
  Broader
  neutral-IR export remains incomplete.
- CI separates unit, Z3, Quint simulation, exhaustive Quint, and integration
  jobs. Dependencies and solver/tool inputs are pinned, and solver-bearing test
  files run in separate processes. Z3 tests that need heap-failure containment
  can be isolated by selector; Quint-bearing files are captured and retried at
  file granularity only for a child `spawnSync pnpm ETIMEDOUT` signature.
  The integration manifest is additionally partitioned into three checked
  matrix shards. Each execution emits a versioned timing event stream retained
  as a CI artifact, while one empirically slow native-project test has a
  documented 45-second budget. Sharding and calibration do not add a retry path
  for semantic failures and do not remove any test from the manifest.
  Checker-backed dogfood additionally uses a named 20-second local/60-second CI
  timeout policy tied to the isolated-test limit; its call site is tested so a
  shorter literal cannot silently override the CI allowance.
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
- Project and CLI verification accept the strict
  `uneffect-declaration-transforms/v1` manifest for the single
  `embedded-typescript/v1` profile. It binds complete source/generated SHA-256
  digests, exact TypeScript compiler version, transform name/version, and a
  UTF-16 source span whose text must exactly equal the generated `.ts` input.
  Verified evidence is attached to consumed declaration integrity; drift,
  missing files/spans, unknown profiles, and multiple transformed inputs for one
  declaration fail closed. This is exact text identity, not proof of the host
  language or a non-identity transform.
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
  source-mapped partial order for acyclic dependency completion, straight-line
  top-level-await resume/reject choices, and unconditional top-level throw. It
  also admits synchronous side-effect-only simple import rings, recording the
  dependency request, evaluating-module revisit, DFS execution postorder,
  source digests/spans, and TypeScript/compiler-options identity in a strict
  published schema. Runtime-binding, self, branching, multi-edge, and async
  cycles, conditional TLA, external/dynamic bodies, sibling initiation order,
  and decorator ordering remain explicit non-claims.
  The same artifact now recognizes one Workhub-shaped top-level
  `main().catch(handler)` only when TypeChecker identity proves a source-local
  top-level async function and the standard `Promise.catch` member. It emits
  synchronous launch/handler-attachment events and no longer misclassifies an
  `await` nested inside a function declaration as module TLA. Promise execution,
  completion, handler execution, process exit, and host queues remain explicit
  exclusions; bare or unsupported launches fail closed.
  A separate strict `uneffect-workspace-module-order/v1` composition discharges
  one parent external-import boundary through an exact child declaration
  re-emission/source mapping. It admits only one direct child module with one
  straight-line top-level await and normal completion, retains the
  resume/reject choice, and adds the child-complete to importer-start edge.
  Conditional/looping await, await-then-throw, multiple/transitive children,
  transformed declarations, and asynchronous or multi-module importers remain
  explicit unknowns.
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
- Program-backed refinement analysis now emits one `local-alias-helper`
  obligation for a `const` object alias of the action receiver passed exactly
  once to one direct, monomorphic, same-file helper. The artifact retains the
  alias span, stable source-keyed region ID, helper call/declaration spans,
  TypeChecker symbol identity, TypeScript version, and source digest. Its
  `Mutate<typeof parameter.member>` correlation names a separately checked
  capability declaration and explicitly does not equate capability evidence
  with refinement evidence. Program Effect propagation reduces this exact
  non-escaping alias to the parent-visible root. Escape, reassignment, computed
  access, polymorphism, dynamic/unresolved selection, missing capability
  declarations, additional alias uses, and imported helpers fail closed;
  unresolved mutation aliases produce `Mutate<unknown-alias>` and unknown
  evidence.
- Optimizer transformations require verified evidence for the exact supported
  schema. Only narrow authorization and ownership-assertion-elision prototypes
  exist; a general proof-driven compressor or mangler is not implemented.
- The completed P2.27 slice adds total finite temporal Map lookup through
  `getOrElse(key, fallback)`. The neutral AST type-checks matching keys and
  values, Quint lowers to an explicit domain-membership conditional, runtime
  assertions/replay use `Map.has`, and Z3 uses the corresponding domain-array
  `ite`. Literal keys support JSON-safe bounded counterexamples. Ordinary
  `Map.get` remains partial; unavailable solvers produce `unknown` rather than
  a safety claim.
- The completed P2.28 slice admits one state-derived scalar `getOrElse` key only
  after independently proving membership in an immutable non-empty literal Set
  state. Its evidence records the exact domain, key, property, values,
  satisfiable initialization, initiation, structural stability, and inductive
  preservation, including each solver backend/version/result. At that handoff,
  dynamic construction/mutation, compound or multiple keys, ambiguous domains,
  failed proof, and solver failure remained `unknown`.
- The completed P2.29 slice extends the same rule to multiple direct scalar keys.
  Every key must have exactly one immutable non-empty literal Set and one named
  membership property, and Z3 proves initiation and preservation for each key
  separately. Evidence is ordered by key name. A missing, compound, mutable,
  ambiguous, or non-inductive key makes the whole observation universe
  `unknown`; partial success is not exposed as completeness.
- The completed P2.30 failover slice retains independent proof as the preferred
  path, then permits one joint fallback only after every membership property is
  separately initiated. Z3 assumes all immutable-domain equalities and the
  complete membership conjunction at the current state and refutes loss of any
  member after one action. Evidence uses a distinct jointly-inductive rule,
  `verified-jointly`, the ordered property assumption set, and one group solver
  result. Failed group preservation remains `unknown`.
