# Feature matrix

This is the release-boundary view of Uneffect as of 2026-08-29. It condenses
the historical checklist in `TODO.md` into user-visible capability areas.

Status has a deliberately narrow meaning:

- **Tested fragment**: executable regression tests cover the documented
  subset. This is not a claim about arbitrary TypeScript.
- **Partial**: useful end-to-end paths exist, but composition or language
  coverage still has a tracked soundness boundary.
- **Planned**: design or scaffolding may exist, but no user-facing proof claim
  should depend on it yet.

Unsupported syntax, unresolved symbols, stale evidence, and solver limits must
produce a diagnostic or an explicit `unknown`; they must not be interpreted as
successful verification.

## Current capability surface

| Area | Status | What can be relied on today | Main boundary / next issue |
| --- | --- | --- | --- |
| Local mutation alias evidence | Tested fragment | `analyzeRefinementActionBodiesInProgram` verifies one `const` object alias of the action receiver passed once to one direct, monomorphic, same-file, TypeChecker-resolved helper. The `local-alias-helper` obligation retains source/compiler/symbol spans and a stable source-keyed region ID. A separately checked `Mutate<typeof parameter.member>` declaration is source-correlated but is not treated as equivalent to refinement evidence. Program Effect analysis reduces the same non-escaping alias to its parent-visible mutation root. | Reassignment, a second use or escape, computed access, nested/helper-local functions, generic or dynamically selected helpers, missing `Mutate` declarations, imported helpers, alias chains/member aliases, multiple regions, proxies, and unknown calls remain explicit non-proofs. An unresolved mutable alias emits `Mutate<unknown-alias>` and unknown Effect evidence rather than disappearing as a local mutation. Broader alias work remains [#24](https://github.com/mizchi/uneffect/issues/24). |
| Gradual comment syntax | Tested fragment | `/* uneffect:temporal ... */` annotations coexist with ordinary TypeScript and parse into capability, invariant, and temporal projections. Optional runtime assertions are separate from zero-runtime metadata. | The annotation expression language is intentionally smaller than TypeScript. |
| Capability effects and module initialization | Partial | Declared effects are upper bounds; inferred effects propagate through supported symbol-resolved function call graphs. Source-attributed `<module>` summaries cover direct operations, resolved calls/overloads, known inline callbacks, immutable local/imported callback identifiers, executable namespaces, class heritage/computed names/stable decorators/static initialization, static local import cycles, TypeScript-resolved string-literal relative local dynamic imports as may-effect sets, and exact-version/Node-major-bound reviewed external initialization as trusted assumptions. TypeScript 6.0.3 traversal contracts compose reviewed `Node.forEachChild`, `forEachChild`, `visitNode`, `visitEachChild`, and array-literal `transform` TransformerFactory/Transformer callbacks synchronously by TypeChecker symbol identity. Unknown summaries expose non-empty stable-coded reasons, and unreviewed top-level calls fail closed unless resolved to an analyzed function, reviewed builtin, or verified external contract. Solution workspaces compose uniquely resolved `verified` function and module Effect summaries child-first, instantiate parameter-rooted mutation, exact-imported exported function-closure and module-initialization mutation roots through re-exports, same-realm `globalThis`, and fully bounded iterator Effect parameters, and expose accepted/blocked links in `effectComposition`; an empty ledger is `not-applicable`, not verified. Every consumed child declaration is byte-compared with an in-memory declaration re-emission by the selected TypeScript compiler; a missing or mismatched output blocks the link even when SolutionBuilder reports the project fresh. A separate opt-in `module-order` IR verifies dependency-completion, straight-line TLA resume/reject, unconditional throw constraints for acyclic Program-visible graphs, specification-DFS execution order for synchronous side-effect-import simple rings, and one TypeChecker-resolved source-local async `main().catch(handler)` launch followed by standard Promise rejection-handler attachment. Function-local awaits do not create module TLA events. Its edges retain source span/digest and semantic rule; the artifact binds TypeScript/compiler-options identity. Programmatic callers and the strict versioned `check`/`evidence --config` loader may extend static/scoped contracts while preserving assumption-ledger and evidence-digest binding. | The compiler traversal contract is exact-version and only admits direct stable callbacks plus array-literal TransformerFactory chains with one statically returned Transformer; dynamic arrays, spreads, mutable factories, deeper returned-callable chains, user-defined lookalikes, and other TypeScript versions remain unknown. The declaration-content check trusts the selected TypeScript compiler and is not an independent compiler-correctness proof. Runtime-binding, self, branching, multi-edge, or asynchronous cycle order; sibling/decorator ordering; conditional TLA; Promise execution/completion after a top-level launch; member/renamed/reassigned/non-standard/multiple launch forms; external or dynamic import bodies; cross-project inaccessible/non-exported roots; host-global aliases and cross-realm mutation identity; unbounded or opaque iterator arguments; configurable specialized platform operation records; mutable or dynamically selected callbacks; dynamic dispatch; reflection; proxies; and native addons remain unknown or conservative boundaries. |
| Deno-compatible permissions | Tested fragment | `FsRead`, `FsWrite`, `Net`, `Env`, `Run`, `Sys`, `Ffi`, and `Import` share finite/unbounded authority-set semantics. Filesystem scopes support explicit symbolic anchors including `$TEMP`. | Deployment allow/deny policy is outside function effect unions. |
| Fetch, DOM, browser storage, external scripts, and transfer ownership | Tested fragment | Fetch method/URL scopes, reviewed attribute/tree/text methods, compound DOM calls, `NamedNodeMap` origin projection, receiver- and parent-scoped markup operations, layout metrics, reviewed Web IDL property access, and Worker transferable invalidation have regression coverage. `Document.cookie` and Web Storage symbol identities produce separate read/write permissions. One direct, same-block `createElement("script")` configuration followed by `appendChild` emits URL-, SRI-, CORS-, and host-scoped `ScriptLoad`, `ExecuteExternalCode`, and `Net` effects. Effect summaries retain direct and propagated `fetch`/`script` transport evidence separately from the common `Net` set. | Cookie names and storage keys are not scoped yet. Beacon/WebSocket evidence producers remain planned. The script fragment proves the loader boundary, not downloaded code. Aliases, escape, conditional configuration, event timing, redirects, CSP, child scripts, parent-presence refinement, reassigned/escaping live collections, unreviewed Web IDL members, full shared-memory, and Atomics semantics are not modeled. Dynamic DOM keys fall back to `Dom<All, Scope>`. |
| W3C TrustedScript sinks | Experimental tested fragment | Direct global `eval`, string timers, direct `Function` construction, and proven `HTMLScriptElement` text properties reject plain strings, assertions, and forged local policies. Direct immutable values from `trustedTypes.createPolicy(...).createScript(...)` and `trustedTypes.emptyScript` are accepted as trusted provenance. | This does not establish CSP deployment or policy correctness. Indirect eval, derived function constructors, text-node/SVG insertion, event-handler attributes, Worker variants, default policies, cross-file flow, `isScript` narrowing, `TrustedHTML`, and `TrustedScriptURL` are not covered. |
| User-defined effects and validators | Tested fragment | Versioned effect schemas and proof-backed validator specializations are available. The cardinality lattice covers supported local/cross-module and Generator paths. Iterator consumers expose polymorphic parameters; `effect_parameter p extends ...` checks direct/stored factories and symbol-resolved wrapper constraints. | Opaque callbacks, dynamic iterator dispatch/escape, recursion that cannot establish a forwarding contract, and unsupported iterator control flow remain `unknown`. |
| Hoare contracts and Z3 | Partial | Restricted integer/machine-number preconditions, postconditions, invariants, assignments, selected path-sensitive control flow, property model enumeration, and typed-array obligations generate reviewable SMT-LIB. Return/loop obligations retain versioned source-block and path-condition evidence. Exact error-free TypeScript Programs additionally contribute finite safe-integer literal-union parameter facts through local or imported type aliases, direct nullish guards over number/null/undefined unions, and direct `typeof` number guards over number/string unions. A bounded exception CFG routes direct throws and direct TypeChecker-resolved `never` + declared `Throw<E>` calls through catch, records path-local discharge and escaping edges, and joins them with the enclosing effect summary. Missing escaping effects downgrade the contract artifact to `unknown`; Promise rejection stays separate. Every current solver client prefers native Z3 in `auto` mode and falls back to bundled WASM only for infrastructure failure. | General TypeScript narrowing, discriminated object unions, assertion functions, arbitrary expressions, heap aliasing, termination, and general loops are not proved. Contract exception lowering does not yet admit `finally`, catch-binding values, async rejection, relational non-`never` call summaries, or general exception fixed points. Plain `number`, unions larger than sixteen, non-integer literals, a source mismatch, or a Program with TypeScript errors contributes no narrowing fact. See [#25](https://github.com/mizchi/uneffect/issues/25) and [#24](https://github.com/mizchi/uneffect/issues/24). |
| TypeScript CFG bridge | Experimental tested fragment | Contract runtime exit checks combine Uneffect's structured CFG with TypeScript's public `noImplicitReturns` semantic diagnostics. Versioned evidence binds source digest, compiler version/options, diagnostic codes, neutral endpoint, and parity status; exhaustive literal-union switches can refine a conservative neutral result. Existing Programs are reused across files by declaration-node identity. Function declarations, static-named methods/accessors, directly `const`-bound block/expression arrows and function expressions, nested direct declarations, lexical/imported/re-exported immutable callable aliases, and direct callable properties of builtin-frozen static object literals are reported and runtime-lowered. Alias contracts relocate to the source callable without wrappers. Getter results and setter preconditions are distinct. Linked contract failures retain original specification AST provenance. | TypeScript's internal `flowNode` is observation-only because it is not a public Compiler API. Mutable bindings, incompatible compiler options, setter postconditions, dynamic computed names, unfrozen/getter/proxy-backed objects, targets outside the selected source project, and general value/path proofs remain unknown or rejected. See [TypeScript control-flow bridge](./typescript-control-flow.md). |
| Temporal models and Quint | Partial | Typed state/actions, safety, bounded reachability, selected liveness fragments, replay, and reviewable Quint generation are implemented for documented finite/bounded models. `generateTemporalModel` composes user temporal state and callback summaries with supported Promise, timer, microtask, and Web/Node event-loop observations through one host-aware public entry. A selected root's `using`/`await using` acquisition and disposal lifecycle is co-verified through the same result and project pipeline. Straight-line `await using` also has a bounded resource/host state product requiring disposal resumption inside a microtask checkpoint. Scalars include `int`, `bool`, and exact string identities; strings support equality and finite Set/string-keyed Map membership without numeric coercion. Finite `Map.getOrElse(key, fallback)` is total across Quint, runtime assertions/replay, and bounded Z3 for literal keys and proved immutable finite-Set membership fragments. Multiple direct scalar keys first use independent proofs; one bounded failover family may instead prove the complete membership conjunction, with joint assumptions named in evidence. Record fallbacks are supported. An exact finite Set of directly written scalar-field record literals can be decoded from native/WASM Z3 and normalized with Quint/TLC replay. | Promise ownership is not yet lowered into the unified model. Conditional/loop resource acquisition remains outside the resource/host product as `resource-host-scheduling`; arbitrary callback interleavings remain `resource-host-callback-interleavings`. Direct async/Promise/event-loop Quint generators are experimental under `@mizchi/uneffect/experimental`. String arithmetic/order, control characters in SMT strings, unbounded string generation, and an incomplete string observation universe are unsupported. Record-valued Set extraction does not admit state-derived/dynamic elements, record spreads, nested collection fields, or an unbounded universe. Ordinary `Map.get` remains partial and requires a matching conjunctive domain guard. Dynamic construction/mutation, compound keys, a key with a missing/mutable/ambiguous domain, failed initiation or joint preservation, and solver failure keep the whole observation universe `unknown`; arbitrary collection correlations, formulas, synthesis, and broader TLC interoperability remain open. See [#63](https://github.com/mizchi/uneffect/issues/63), [#2](https://github.com/mizchi/uneffect/issues/2), [#5](https://github.com/mizchi/uneffect/issues/5), and [#59](https://github.com/mizchi/uneffect/issues/59). |
| Cross-project scalar refinement | Tested fragment | A direct project reference can compose a locally verified scalar child action into an annotated parent action. Bindings attach only to exported top-level function declarations; a marker attached to a class method or another unsupported declaration shape is a source-attributed violation rather than silently `not-applicable`. Calls may be direct or pass through at most two TypeChecker-resolved, write-screened source-local function helpers whose bodies are exactly the next call; `callPath` records the bounded edge and `helperDepthBudget: 2` makes the admitted depth explicit. A guarded action retains its formatted guard through every supported shape. `runtime adapter@version = globalThis` preserves the builtin current-Realm global identity. `runtime adapter@version = node:global@24#main` instead requires matching Node major/realm labels and the TypeChecker-resolved ambient `global` from the matching `@types/node` major; the exact host identity is retained in evidence. A configured `embedded-typescript/v1` declaration transform may bind one generated `.ts` input to an exactly equal UTF-16 source span, with full-file source/output SHA-256 digests, transform name/version, and exact compiler version retained in evidence. The ledger also retains producer/consumer compiler/config provenance and exact declaration digests; the parent action is revalidated after summary substitution. | Class/instance methods, async action completion, higher-order/reassigned/cyclic or three-level helpers, helper-local guards or extra/conditional work, guarded wrappers with additional work, collection updates, abstraction transforms, ambiguous exports, adapter/version drift, unannotated/shadowed/descendant identities, browser/Worker/iframe realm identities, non-identity transforms, multiple transformed inputs per declaration, surrounding host/template/runtime semantics, runtime verification of declared realm topology, and general semantic source mappings remain non-proofs. Broader realms belong to [#10](https://github.com/mizchi/uneffect/issues/10); frontend mappings belong to [#8](https://github.com/mizchi/uneffect/issues/8). |
| TypeScript-to-model refinement | Partial | Selected scalar/record/Set/Map updates, scoped bare lexical blocks, lexical non-escaping whole-runtime `const` alias chains, statically known local and Program-resolved imported runtime-class declaration bodies through those aliases, known-subclass rejection, auditable `trust dispatch-sealing` for exported classes, conditionals, scalar switch fallthrough and direct return/throw entries, unreachable suffix and proven-no-throw catch-edge elimination, one statically named block's own `break` through `finally`, bounded ascending `for` and canonical local-counter `while` loops, conditional unlabeled `break` consumed by those finite loops after mandatory `finally`, conditional unlabeled `continue` consumed per advancement-guaranteed finite `for`/`for...of`/one-shot `do` iteration, target-aware outer-label `break`/`continue` through nested finite loops and `try`/`finally`, finite numeric/boolean literal `for...of`, exact zero-iteration `while (false)`, exact one-iteration `do...while (false)`, acyclic helpers, and a return/throw/catch/finally completion subset are compared with model actions. Program-resolved acyclic invariant helpers may construct builtin `Set`/`Map` views when the conversion exactly matches a declared computed abstraction; TypeChecker identity prevents same-named constructors from being trusted. Builtin array `every`/`some` also accepts immutable local/imported function declarations, arrow functions, and function expressions with a supported single-return body, including `const` alias chains and direct properties of a builtin-`Object.freeze` predicate registry. Finite-loop early returns and breaks suppress later iterations without skipping the current iteration's `finally`; continue also runs `finally` and advances only where the loop construct guarantees it. Pure return expressions are validated before their result is discarded; tracked `int`/`bool` throw payloads, including normalized numeric/boolean literals, can bind catch-local scalar control flow across direct, conditional `if`, and scalar `switch` throws. Scalar fields of direct or conditionally joined normalized object-literal payloads can also be projected in `catch`. Unknown or effectful try edges remain fail-closed. A strict budgeted artifact additionally records source-keyed basic blocks and normal/return/throw completion sets for application-backed nested `if` and finite exhaustive `switch` try/catch roots with optional finally and supported prefix/suffix statements; caught throw is consumed, return has no edge into its suffix, budget exhaustion is `unknown`, and a rethrow stays visible. Exactly two sibling top-level `if` roots may share the region under the named `handler-control-roots` limit; every root span and observed count is retained. One top-level handler-local `for...of` over one to four direct numeric or Boolean literals is structurally unrolled into iteration-qualified blocks and emits `handler-loop-iterations` evidence. One outer handler may contain one or two direct sibling inner try/catch regions at total depth two; handled inner throw and inner-catch rethrow are routed separately through source-keyed region blocks, and `handler-nesting-depth` evidence records the limit and observed depth. Catch-less supported finalizers may contain conditional direct return/throw overrides; normal paths preserve input completion and the artifact lists `finallyOverrides`. An exact syntactically identical caught predicate may restrict a nested conditional value to its implied branch, with explicit `same-predicate-branch-restriction` evidence. | Dispatch sealing remains `trusted`, not verified. Mutable callback aliases, unfrozen or dynamically constructed function registries, runtime-selected or polymorphic predicate values, polymorphic collection producers, dynamic or non-canonical `while`/`do...while`, canonical-`while` continue that can bypass its modeled increment, return-result equivalence, string/null payloads, missing or dynamically shaped object fields, effectful or unresolved completion expressions, unknown/dynamic labels, ambiguous nested switch/loop ownership, three-or-more or mixed-shape sibling try-region handler roots, three-or-more sibling or depth-three nested try, general exception-aware CFG fixed points, mutable/escaping/member aliases, syntax-only imported or computed/polymorphic methods, unscanned subclasses, proxies/prototype mutation, and general dynamic dispatch remain fail-closed or outside the declaration-body claim. Handler-local iteration is unsupported when it is dynamic, empty, spread, destructured, `for await`, over four iterations, contains break/continue or `using`/`await using`, is nested, or occurs in catch/finally. Attempted-family incomplete switches, labeled transfers, other loops, nested try with inner finally/return/break/continue/resources or placement in catch/finally, unsupported finalizer statements, over-budget/mixed try-region roots, and non-identical predicate implication are explicit non-proofs. The handler obligation remains coupled to the existing action validator; structural loop unrolling, override metadata, and exact predicate restriction are not a general path-sensitive value proof or Z3 implication result. See [#25](https://github.com/mizchi/uneffect/issues/25) and [#24](https://github.com/mizchi/uneffect/issues/24). |
| Promise and resource safety | Partial | Floating rejections, major Promise combinators, selected `try`/`catch`, explicit-throw ownership routing, a restricted loop-local catch/retry join with non-throwing prefixes, direct awaits, both-branches-must-observe `if`/`else`, exhaustive finite `switch` fallthrough, nested non-reassigning handlers, and non-reassigning suffixes, structured and statically selected `&&`, `||`, ternary, and nullish-coalescing `never` + `Throw<E>` expression edges, `using`, `await using`, reverse disposal order, selected exactly-once obligations, and mandatory loop-local `finally` clears of escaped resource aliases have executable models. Promise/resource and refinement analysis share target-aware normal/return/throw/break/continue vocabulary and loop-owner matching. A canonical one-to-eight-iteration outer `for` with leading lexical `using` declarations and a final `try` lowers statically owned labeled `continue` and `break` after reverse-order async cleanup. Continue advances the resource generation; break reaches the first post-loop await through a distinct cleanup edge. Resource-free dynamic `for`, `for...of`, `for...in`, `while`, and `do...while` loops retain lexically owned `continue` and lower unknown cardinality as nondeterministic repeat-or-exit. A function-scoped fragment routes one caught awaited rejection through concrete catch/finally and mixed sync/async cleanup. A nested fragment routes either of two awaited rejections through conditional recover/rethrow and mandatory finally, releases the inner async scope before an outer await, and checks inner-before-outer cleanup precedence. A second nested fragment keeps one inner async-disposal rejection pending until the enclosing catch recovers or rethrows it, then traverses mandatory finally and remaining outer cleanup. Its two-resource extension routes protected body/acquisition failures through the same reverse cleanup chain and retains a finite single/suppressed completion before catch. One Boolean `if`/`else` may instead acquire exactly one differently named branch-local async resource; Quint retains the condition polarity through cleanup and the shared handler join. An exhaustive finite string-literal `switch` may select one of three such resources when it has literal cases, explicit default, no fallthrough, and at most eight case conditions; analysis records discriminant provenance and generation validates full, non-overlapping path coverage. One three-leaf nested Boolean tree receives the same treatment when every predicate is a Boolean identifier and the complete tree stays within eight conditions. One finite string-literal switch may contain that Boolean choice in its preferred case and a backup resource in its explicit default; both provenance kinds, mixed leaf coverage, and a shared eight-condition budget are checked together. Two independent finite decisions may also run sequentially: their exclusion groups remain separate, each stage and a combined eight-condition budget are validated, and `sequentialResourceJoinSafe` requires first-stage disposal before second-stage acquisition. One bounded non-uniform extension permits the first Boolean decision's selected async-resource arm to dispose before early `return` or a directly typed `throw`. Return stays distinct through mandatory `finally`; throw stays distinct through cleanup, enters conditional catch recovery/rethrow, and then traverses `finally`. Neither abrupt path enters the later switch, and return cannot enter the outer continuation; rejection before the abrupt statement still routes through cleanup and catch. `returnCompletionSafe`, `throwCompletionSafe`, and `normalContinuationSafe` have dedicated load-bearing faults. One canonical two-iteration outer `for` may contain a complete Boolean-identifier `if`/`else` whose branches each acquire one async resource and perform only direct awaited statements before a final owned-transfer `try`; `loopGenerationSafe` requires branch cleanup before the iteration join and prevents stale first-iteration disposal from satisfying second-iteration cleanup. Dynamic/over-budget resource bounds, expression predicates, incomplete branches, intervening resource work, and alias escape fail closed. Quint also rejects intermediate-cleanup delay, handler bypass, premature handler entry, lost suppression, multiple-branch acquisition, wrong-branch cleanup, reordered/skipped cleanup, floating-Promise, and unresolved-label controls. | Unknown/cross/nested or non-loop labels, resource-bearing non-canonical/dynamic/larger loops, arbitrary loop-body joins, three-or-more-resource failure stacks, cleanup across multiple nested scopes, other mixed/general branch-correlated resource trees, indirect or general expression-level non-uniform throw production, more than two sequential stages, multiple resources per leaf, expression-valued Boolean predicates, open or expression-valued resource-switch discriminants, switch fallthrough, over-eight-condition resource decisions, conditional/complex finally alias joins, general expression-level throw edges, exception-heavy loop joins, nullable-union selection, and a general shared control-flow fixed point remain open. Dynamic repeat-or-exit preserves ownership but proves neither termination nor fairness. Exact nested `ResourceError` payloads exist in the analysis IR; the unified Quint model retains only a finite failure kind. Unsupported transfers and unsupported resource-decision joins are rejected rather than normalized to fallthrough. See [#9](https://github.com/mizchi/uneffect/issues/9). |
| Event-loop semantics | Partial | Web timers, intervals, microtasks, animation frames, scheduler tasks, and a reviewed Node phase subset can generate bounded models. | Concrete host I/O ordering, repeated/dynamic parents, ESM details, abort composition, and polymorphic callbacks remain incomplete. See [#10](https://github.com/mizchi/uneffect/issues/10). |
| React function components | Partial | Explicitly annotated TSX components and custom Hooks separate replayable render, pure memo/optimistic reducers, React Actions, inline JSX events, inline or immutable-local Effect/render callbacks, inline callback-ref commits, external-store reads/subscriptions, imperative-handle factories/exposed methods, and cleanup. Direct named/default/namespace React `memo`/`forwardRef` chains preserve wrapper-variable identity through Program imports and Suspense edges; observable or opaque custom comparators fail closed. Source-local and TypeScript-symbol-resolved named/barrel/namespace/default Hook calls compose. React 19 `useActionState` and `useOptimistic` callbacks are classified separately, opaque callbacks fail closed, and returned setters require a recognized Action context. An explicit bounded Quint projection checks sequential Action queues, pending consistency, and cancellation of the remaining queue after failure; a companion projection composes direct typed Action throws, Hook rethrow, and an explicitly selected Error Boundary fallback. JSX-event Transition Actions diagnose direct state updates after `await` unless a nested Transition restores the synchronous scope; a second bounded projection checks aggregate pending, arbitrary Action settlement order, interruption/retry, and final commit. An analysis-backed already-revealed Transition/Suspense projection preserves stale content and suppresses fallback through suspension/interruption until resolution and retry commit. Separate explicit newly-mounted-Transition and urgent-update projections permit fallback only after suspension, require resolution before content commit, and remove fallback on commit. The tested fragment rejects direct render capabilities, selected non-idempotent reads, writes through local immutable props/state/context regions and `const` aliases, render-time `.current` access, conditional/unresolved/indirectly-recursive Hooks, unmatched capability acquisition, wrong/duplicate local resource cleanup, missing local Hook dependencies, opaque external-store callbacks, and opaque imperative-handle factories. Production/Strict-Mode replay keeps Effect/ref/subscription/handle setup and cleanup paired by source-derived instance paths through custom-Hook composition. Bounded interruption, dependency-change, and single/repeated Suspense-retry replay distinguish discarded/suspended renders, lifecycle-owning commit generations, and resolution causality. A two-component boundary projection keeps primary/fallback instances separate and rejects reveal before resolution or primary setup before same-phase fallback teardown. Named, aliased, default/namespace-qualified React Suspense is extracted from JSX. Transparent Fragments and multiple direct component/boundary children normalize into a Program-resolved tree; a bounded Quint projection rejects a fallback not owned by the selected suspended leaf's nearest boundary. Direct and custom-Hook-composed React `use` calls and render-thrown values carry source evidence, and an opt-in causal mode admits only TypeChecker-proven thenable leaves while excluding ordinary thrown errors. | Dynamic/higher-order Hook resolution, referenced/imported/custom/dynamic component wrapper arguments, comparator call-graph effects/equivalence, symbol-resolved dependency aliases and custom stability, reassigned/interprocedural region flow, unresolved/prop/dynamically selected callback refs, lazy ref initialization, spread/prototype/dynamic imperative handles, cross-component ref-call flow, custom-Hook-returned Action dispatcher flow, automatic Action queue/Transition/prior-visibility/urgency extraction, value-level optimistic rollback, automatic Error Boundary ownership and general event/async failure routing, general resource alias/ownership flow, Suspense subtrees through host wrappers or expressions, runtime call reachability and thenable pending/fulfillment/rejection state, boundary/fallback-originated suspension, error-boundary composition, unbounded priority-lane/Offscreen scheduling, server components, and Z3 lifecycle projection remain open. See [#16](https://github.com/mizchi/uneffect/issues/16). |
| Contract-derived testing | Partial | Deterministic Vitest generation and shrinking cover scalar machine domains, literal unions, bounded arrays, selected records, optional fields, bounded Set/Map values, supported refinements, and one explicit finite specialization for an exported source-local or directly named-imported unary user predicate. TypeChecker symbol identity binds cross-file declarations. The generated test rechecks the real predicate and rejects zero valid candidates. | Recursive, higher-order, multi-argument, inferred, nested, barrel/namespace/default-import predicate specializations and general solver-backed shrinking remain open. See [#4](https://github.com/mizchi/uneffect/issues/4). |
| Typed arrays and bit operations | Partial | Supported allocation/index/range checks, integer casts, shifts, and SHA-256 building blocks have regression coverage and optional runtime refinements. | Interprocedural alias/resize/control-flow composition and a complete SHA-256 proof are open. See [#6](https://github.com/mizchi/uneffect/issues/6). |
| Evidence and diagnostics | Partial | Artifacts bind inputs, configuration, tool versions, and outcomes. Diagnostics include source locations and replayable witnesses for supported checks. `check --assurance no-unknown` rejects unknown effect/contract evidence; `declared` additionally requires declaration-checked effect summaries; `verified` also requires the collected assumption ledger to be present and empty. Solution builds can opt into freshness or exact same-compiler declaration/runtime-output byte comparison. | Assurance profiles cover emitted evidence for explicit files and opted-in domains, not arbitrary TypeScript. Exact output comparison does not validate bundler/post-emit transforms or prove compiler correctness. Z3/Quint artifacts are reproducible evidence, not independently checkable proof certificates. See [#7](https://github.com/mizchi/uneffect/issues/7). |
| Native Rust/Corsa frontend | Partial | A neutral IR, Rust parser/lattice, deterministic project-wide UTF-8 spans, transitive reference parity, mandatory producer provenance, and a real corsa-bind multi-file exporter for top-level function declarations, single immutable arrow/function-expression bindings, identifier-named methods of top-level classes, named-function overload candidates/selections, direct intra-project calls, type text, and trivia exist. Standard `console.log` emits checker-inferred `Console`; exact named `node:fs/promises` `readFile`/`access`/`readdir` emit `FsRead`, while `writeFile`/`appendFile`/`mkdir` emit `FsWrite`; one exact function-local shorthand `const { readFile } = await import("node:fs/promises")` also emits `FsRead` and its import await; standard global `fetch` emits `Fetch`. Facts retain builtin/compiler/operation-span evidence and either a library declaration or exact source import binding. Direct calls used as the immediate operand of unconditional `await`, beneath exactly one enclosing `if` branch, inside exactly one catch-protected try block, or returned unconditionally with at most one `as Promise<T>` wrapper emit source-ordered owner/source/span Promise observations. The conditional slice records owner-local file-offset condition identity and polarity; the protected-try slice records caught rejection ownership; the Promise owner and project-wide span distinguish same-named cross-file records. Promise metadata parity compares all observation kinds. Workhub-shaped corpora reach full parity for these exact fragments. Same-spelled local objects, declarations, and local-module imports remain effect-free, nested callback awaits do not leak into the outer owner, and metadata drift fails checker parity. `requireCorsaCheckerFacts` passes only with authenticated checker-backed input. | Namespace/default/CommonJS imports, renamed/namespace/non-literal/mutable/multi-binding or other dynamic imports, general module initialization/resolution, sync/other/compound filesystem operations, path/URL/method scope inference, other builtin inference, computed/polymorphic methods, callback timing, method/generic overload edge cases, nested/loop handler control, awaits in catch/finally, conditional/non-call/nested-wrapper return observations, rejection-binding ownership, chains/combinators, resource records, persisted fact authentication, Content Mapper semantics, and the rest of the neutral IR are not checker-exported. Unsupported Promise observations produce an explicit evidence mismatch. `checkerMetadataEquivalent` remains a supported-atom projection, not a general claim of full semantic parity. See [#8](https://github.com/mizchi/uneffect/issues/8). |
| Proof-guided optimization | Planned | Narrow authorization and ownership-assertion-elision prototypes establish the fail-closed shape of a transformation. | General compression, mangling, reordering, and dead-code elimination are not implemented. See [#13](https://github.com/mizchi/uneffect/issues/13). |

For the TypeScript-to-model refinement row, the dynamic-`while` boundary has
one explicit exception: `while (counter > L)`, `>= L`, `< U`, and `<= U` are
summarized for signed safe-integer constant bounds when the counter changes
toward the bound by a positive safe-integer constant magnitude and the body
completes normally or only continues after the ranking step.
A remainder-subtracted exact
quotient derives the ceiling trip count without relying on backend-specific
negative or fractional division, and the final counter preserves overshoot.
Supported symbolic updates at loop entry are substituted through the guard,
trip count, and final values. For a unit countdown, another state field may
change by an affine function of the ranking counter; the checker derives its
triangular closed form. A scalar conditional decision tree is accepted when
every condition is unchanged by the loop and every leaf has an affine delta;
conditions are evaluated from loop-entry state and the tree is capped at eight
leaves. Update order remains significant. Dynamic or unsafe bounds or steps,
other loop guards, mutated or counter-dependent branch conditions, larger
piecewise trees, mutually coupled or self-amplifying recurrences, opaque entry
updates, and break/return/throw exits outside the explicitly recognized forms
below remain unsupported. An unlabeled
`continue` is consumed only when symbolic merging proves that every continuing
path has already taken the affine ranking step; a skipped step is rejected as a
possible nontermination path. Mandatory `finally` updates remain part of that
merged iteration. One loop-invariant early `break` may select a path with up to
eight independent non-counter affine state updates before stopping; its
condition and update inputs are read from loop-entry state. This includes the
zero-update case and affine `finally` updates when the model accounts for them.
The break path may advance the ranking counter by exactly the same delta as an
ordinary iteration; this admits a caught scalar failure whose `finally` block
advances and audits once before the catch-side break is consumed. The same
caught failure may choose an invariant break or continue policy; the common
`finally` must prove the ordinary ranking delta on both paths. True
conjunctions in the break condition are specialized into their invariant
constituents, while false conjunctions are not unsafely decomposed. A
disjunctive invariant stop condition retains its aligned path-wise affine
update tree instead of selecting an arbitrary true atom; on the repeating path,
the false disjunction is safely specialized into false constituent atoms. The
same rule accepts nested aligned Boolean completion/update trees over at most
16 invariant predicate atoms. It enumerates the bounded propositional model and
specializes only facts entailed by the selected stop or repeat path; unresolved
choices remain explicit conditional updates. The stopping tree is capped at
eight affine leaves. A different counter delta, a ninth
non-counter update or leaf, cross-state-coupled or non-affine break-side
updates, a mutated or counter-dependent policy, unaligned completion/update trees,
and dynamically selected completion remain unsupported. This is a closed-form
affine rule, not a general loop fixed point.

One additional direct-join seed exposes the affine rule through
`uneffect-refinement-action-analysis/v2`: a ranking loop whose direct `try` has
normal and supported scalar throw/catch predecessors emits the same
`scalar-recurrence-fixed-point` artifact as an ordinary direct affine loop,
with a `handlerCompletion` extension and an eight-member compatibility budget.
It must converge within the named `cfg-recurrence-iterations` worklist budget.
Only a fully matching action records retained throw payload and normal snapshot.
Budget exhaustion and an unaligned recurrence remain `unknown`. A reusable monotone basic-block engine
carries the normalized throw payload and normal/catch snapshot facts, rejects
lattice conflicts, and joins direct predecessor `TemporalExpression`
environments into a condition-correlated phi snapshot. The worklist also carries
the accepted affine ranking counter, direction, one-iteration transformer, and
closed-form summary through the back-edge and requires that certificate to
stabilize, but structural convergence reports only
`unknown: independent-proof-required`. The shape-specific affine lowering still
constructs that summary. One additional direct-loop family lowers exactly one
loop-local conditional expression into a source-bound predecessor-value join:
an unchanged Boolean state selects two affine values, and the strict artifact
retains its expression span, expression-keyed predecessor blocks and values,
common join, order, and named one-join budget. Nested/multiple conditionals,
mutable/local/non-Boolean selectors, unused selections, and non-affine branches
remain unsupported. The opt-in async
`analyzeRefinementActionBodiesWithZ3` API independently reparses the certificate
and proves a base case, an inductive step for every scalar state, and a
well-founded guard-distance ranking obligation. A modified summary or ranking
metadata is `refuted`; solver failure and an unstabilized certificate are
`unknown`. The legacy `ranking-loop-fixed-point` v2 artifact is no longer
emitted or accepted by the v2 schema. This does not generalize the accepted
recurrence shape: nested/arbitrary handler loops, resources, aliases, widening,
and arbitrary basic-block shapes remain owned by #25/#24.

One further direct-loop family admits exactly one Boolean involution beside a
unit integer countdown. It retains the Boolean update span and named
one-involution budget, derives an exact modulo-two summary, and requires the
same independent Z3 base/step/ranking checks. Multiple, compound,
path-dependent, repeated, or helper-mediated toggles and non-unit ranking remain
unsupported. One direct integer self-amplification is admitted only as
`x *= k` with safe integer `k > 1`, a unit countdown, and the exact
function-scoped contract `requires counter >= 0 && counter <= N` for
`1 <= N <= 8`. Uneffect emits a finite piecewise summary and Z3 checks it under
that recorded assumption. The assumption, counter, multiplier, iteration,
update, and named expansion budget must agree or the certificate is refuted.
This is a conditional bounded result: call-site satisfaction, unbounded
exponentiation, additive/nonlinear forms, repeated writes, and multiple
self-amplifying members remain non-proofs.
The same finite rule may compose with one exact try/catch/mandatory-finally
loop when one unchanged Boolean state selects the caught predecessor, the catch
contains the sole `x *= k` update, and the normal predecessor stutters `x`.
Evidence records the selector, Boolean branch, `catch` predecessor, update span,
and existing handler completion graph. Mutable or non-Boolean selectors,
updates on both predecessors, early handler exits, and arbitrary path-dependent
self-amplification remain non-proofs.

The v2 artifact also defines `handler-scalar-environment-join` for one or two
changed integers carried across two or three source-keyed sibling nested-handler
regions. Region entry/exit expressions come from the refinement evaluator and
must hand off exactly on the shared CFG worklist. The product is represented by
ordered `members[]`, so the one-member case is not a separate schema. Structural
convergence yields only `unknown: independent-proof-required`; the Z3 API must
prove every member equivalent to its declared action before the obligation
becomes `verified`. Intervening unmodeled writes, budget exhaustion, a third
changed integer, a fourth region, one wrong member, and solver failure remain
explicit non-proofs. Heap regions, aliases, cross-member recurrence, general
path implication, recurrence widening, and irreducible CFGs are unsupported.

One additional bounded topology selects exactly one nested handler region in
each arm of a direct `if/else`, joins their environments with the exact route
predicate, and enters one common nested handler region. The artifact records
`if-handler-predecessors`, ordered then/else region identities, the successor
identity, and `predicate-correlated-phi`. Predicate correlation is accepted
only when every changed integer action contains the corresponding outer
conditional and its branch-local handler conditions. Correlation loss or an
unmodeled predecessor/successor-boundary write cannot verify. Switch fan-out,
missing branches, nested choices, loops, aliases, and general path implication
remain unsupported.

An ordinary direct `while` can additionally emit
`scalar-recurrence-fixed-point` when the refinement evaluator derives one
affine ranking recurrence over one or two integer members. One additional
bounded family admits exactly three changed integers: the ranking member, one
constant-delta driver, and one dependent with a single acyclic affine edge from
that driver. A reusable worklist
carries the transformer from a source-keyed `statement:*` block to its
`while-header:*` back edge under `cfg-recurrence-iterations`. Structural
stability is provisional; Z3 must independently prove base and step for every
member plus the ranking obligation. Coupled ranking updates, self-amplifying
members, counter-dependent path deltas, more than two members outside that
exact upper-triangular family, nested/handler
loops, budget exhaustion, and solver failure do not verify.

The single driver/dependent family supports both source orderings. When the
dependent executes after the driver, the edge records `read: updated`; when it
executes first, it records `read: entry`. The `order` and `updates` arrays are
the exact source order in both cases, and the two orders derive different
triangular offsets. A driver-only dependent delta is not a stutter. This does
not admit dependency cycles, multiple edges, repeated writes, or general
matrix recurrence solving.

One or two sequential direct `if/else` statements inside that loop may select
piecewise affine member updates when they use distinct unchanged Boolean
states. An omitted else is represented by a source-keyed identity predecessor.
The artifact binds each Boolean selector, source-ordered predecessor blocks,
join block, and `predicate-correlated-affine-phi` in ordered `controlJoins`; the
composed recurrence step/summary still require Z3. Source correlation and
execution order are structural rather than solver-derived. Reused, mutated, or
ranking-dependent predicates, nested or third diamonds, and unmatched
piecewise expressions remain unsupported.

Alternatively, one direct `switch` may select a piecewise affine update from
exactly two distinct non-negative numeric-literal cases and one explicit default. The
integer discriminant must be a declared loop-invariant state, every clause must
end in an unlabeled `break`, and the switch union member binds all three
predecessor blocks plus the common join under
`cfg-recurrence-switch-cases`. Exactly one Boolean diamond followed by one such
switch is also admitted as a two-element ordered sequence. Z3 still proves the
composed recurrence. Switch-then-if order, fallthrough, mutation,
ranking-counter or dynamic selectors, duplicate/non-literal/third cases,
nested/excess control, and solver failure remain unsupported rather than being
treated as an identity path. The old syntax-specific join fields are not
emitted.

The three-member family preserves sequential TypeScript update order in
`affineDependencies`. Its single edge is marked `entry` or `updated`, and the
closed form includes the resulting arithmetic-series term. The application
fixture uses `batch++; sent += batch; pending--`, so `sent` reads the updated
driver. Reversing those source statements produces a different summary and
cannot verify against the same action. Multiple edges, cycles, driver
self-amplification, counter-dependent or path-dependent drivers, nonlinear
terms, aliases, and a fourth changed member remain explicit non-proofs. Z3
still independently proves every base/step equation and the ranking obligation.

Outside loops, initialized scalar `let` bindings may be assigned with `=`,
`+=`, or `-=` and joined through sequential `if` diamonds. Normally completing
arms produce phi values; when one arm returns, only the normal predecessor's
local snapshot is passed to the continuation and the return path retains its
pre-continuation state.
For a supported typed scalar throw, the throw edge owns its mutable-local
snapshot and `catch` starts from that snapshot; the normally completing `try`
predecessor retains its separate environment. Two conditional throwing arms
may join their snapshots through the same phi contract.
A mandatory `finally` projects every incoming edge to bindings visible outside
the protected region, joins normal, direct-return, and supported typed
throw/catch-return snapshots by their completion predicates, and evaluates its
state updates over that joined environment. A `try/finally` without `catch`
retains the normal predecessor explicitly.
Scalar `switch` evaluates each case entry over its own local environment,
retains source-ordered fallthrough and unlabeled break behavior, uses the
pre-switch environment for an unmatched default-free path, and joins normal,
return, and supported typed throw/catch snapshots by the selected case.
For a bounded ascending `for`, finite literal `for...of`, or canonical bounded
local-counter loop, each expanded iteration receives the preceding normal
mutable-local snapshot; guaranteed-advancement `for` forms also consume a
continue snapshot. Unlabeled `break` contributes its
snapshot to the loop's normal exit, while direct return and supported typed
throw retain their edge snapshots; mandatory `finally` observes the snapshot
owned by every completion path before the transfer is consumed or propagated.
An ordinary standalone lexical block evaluates with a nested local map, then
projects normal and abrupt snapshots back to bindings visible at block entry;
block-local constants cannot escape.
A statically owned non-loop label consumes its own labeled-block `break` and
joins that edge's outer-visible local snapshot with normal completion. Bounded
ascending `for` and finite literal `for...of` owner labels likewise retain
their own break/continue snapshots through expansion and mandatory `finally`.
A normally completing `catch` starts from its typed-throw local snapshot,
projects mutations to bindings visible before `try`, and joins them with the
normal try snapshot before the shared continuation.
A catch that returns directly after mutating an outer-visible scalar projects
that mutation onto its return edge. An enclosing mandatory `finally` observes
the catch-owned snapshot, while only the normal try predecessor reaches the
post-try continuation.
A catch that directly rethrows a supported normalized scalar after mutation
projects both the changed snapshot and payload onto its throw edge. Mandatory
`finally` preserves both, and an outer catch may bind the payload against the
same local environment.
A catch that conditionally returns after mutation retains a return-edge
snapshot at the branch and a separate normally completing snapshot after the
branch. Only the normal catch snapshot joins the normal try predecessor and
reaches the post-try continuation.
A catch that conditionally rethrows a supported normalized scalar retains the
branch snapshot and payload on its throw edge and a separate normally
completing snapshot after the branch. Mandatory `finally` and an outer catch
consume the matching throw evidence.
A catch that conditionally breaks its owning bounded loop after mutating an
outer-visible scalar retains a separate break snapshot. Mandatory `finally`
observes that snapshot before the loop consumes break and joins it into the
post-loop local environment; only normal catch completion reaches the loop
suffix.
A catch that conditionally continues its owning bounded loop after mutation
retains a separate continue snapshot. Mandatory `finally` observes it before
the loop advances the next bounded iteration from that snapshot; the current
iteration suffix runs only after normal catch completion. A statically resolved
owning-loop label is accepted with the same semantics.
A normally completing mandatory `finally` may mutate outer-visible scalars.
The checker evaluates state updates over the joined incoming environment and
replays the local transformation over each normal/return/throw/break/continue
snapshot before attaching it to the surviving edge.
A mutable-local mandatory `finally` may also conditionally return or throw a
supported normalized scalar. Its abrupt snapshot overrides the selected
predecessor completion and remains available to an outer `finally` or catch;
the throw payload and snapshot are kept paired. When finally completes normally,
the transformed predecessor edge survives. A finally-owned break may override
normal or abrupt completion and is consumed at its owning bounded-loop boundary.
A finally-owned continue may similarly override its predecessor and advances
the owning bounded loop from its snapshot. The statically resolved owner label
has the same semantics. Cross/nested labels and opaque throw payloads remain
unsupported.
The state and local environments use the same explicit phi-value contract;
branch-local declarations do not escape their lexical arm, and equal values do
not create redundant conditionals. Uninitialized locals, `var`, writes to
`const`, opaque right-hand sides or throw payloads, catch-side mutation followed
by an unknown/cross/nested label transfer or an opaque rethrow payload,
mutable-local mutation combined with cross/nested finally-owned label
completion, mutable-local flow through dynamic or
over-budget loops, unknown/cross/nested label ownership, shadowing or escaped block locals, opaque switch discriminants,
dynamic/duplicate case labels, and nested-block case mutation remain
unsupported rather than being approximated.

For the React row, event handlers and callback refs also include immutable
component-local and write-screened module-local function/arrow callbacks
reached through transitive `const` aliases. Program analysis also accepts
write-screened functions reached through named aliases, barrels, default imports, and namespace
imports and reads their effect/lifecycle declarations from the defining
module. The open referenced-callback boundary means unresolved imports, props,
arbitrary members, reassigned functions, or dynamically selected references.
Effect and reviewed render-Hook callbacks use the same Program resolution and
definition-module contracts; imported functions cannot capture caller-local
bindings, while finite dependency-array shape and unstable entries are still
checked.
The same callback environment covers imported Actions, optimistic reducers,
imperative-handle factories, external-store callbacks, and memo comparators,
including typed throws, purity diagnostics, exposed methods, snapshot effects,
and subscription lifecycle identity.
The same row's lazy-ref support means only a direct/aliased `useRef(null)`, one
strict null guard without `else`, and one same-ref assignment from the stable
literal/object/array fragment. General factory/constructor purity and
control-flow dominance remain open.
For component wrappers, a referenced argument is now supported when it is a
source-local immutable function/arrow or a write-screened module-local function
declaration reached only through `const` identifier aliases. The declaration
screen conservatively rejects any syntactic assignment, update, or loop-target
write and may reject shadowed-name uncertainty. Mutable/imported/member/dynamic
arguments and custom HOCs remain outside the wrapper claim; the annotated
wrapper name is the Program/Suspense component identity.

The module-initialization row also includes the strict
`uneffect-workspace-module-order/v1` seed: one exact child declaration maps
back to one source module with one straight-line TLA, and child normal
completion precedes one synchronous importer start. Conditional/looping await,
await-then-throw, multiple/transitive child dependencies, transformed
declarations, and asynchronous or multi-module importers remain `unknown`.

## Verification confidence

The strongest current claims are local and fragment-specific:

1. the source construct is recognized by symbol identity or the documented
   syntax subset;
2. the generated obligation or model is retained for review;
3. the configured backend reports success for that obligation; and
4. a negative regression demonstrates that the check is load-bearing.

Bounded search, simulation, and controlled-corpus adoption metrics are reported
as such. They are never promoted to unbounded proofs or ecosystem-wide quality
claims.

## Where to continue

- Use [Implementation status](./implementation-status.md) for a narrative of
  completed functionality.
- Use [Roadmap and known gaps](./roadmap.md) for priority and dependency order.
- Use [GitHub Issues](https://github.com/mizchi/uneffect/issues) as the active
  queue for unfinished work.
- Use [`TODO.md`](../TODO.md) only as the detailed historical ledger.
