# React function component semantics

Uneffect treats React function components as replayable computations whose
observable work is split across lifecycle phases. The initial implementation
is opt-in and zero-runtime: it reads comments and TypeScript/TSX source but does
not transform the component or import React at runtime.

## Opting in

Annotate a function declaration, function expression, or variable-bound arrow
function explicitly. Custom Hooks use the parallel `react hook` role:

```tsx
/* uneffect: react component */
export function Counter(props: { label: string }) {
  return <button>{props.label}</button>
}

/* uneffect: react hook */
export function useCounterTelemetry() {
  // Hook body and nested built-in Effects receive phase semantics.
}
```

Capitalization, JSX return syntax, and `React.FC` alone do not opt a function
in. This prevents a gradual check from silently changing the meaning of legacy
code. Ordinary JSDoc remains untouched.

## Phase model

The analyzer currently projects component work into twelve phases:

| Phase | Execution meaning | Initial rule |
| --- | --- | --- |
| `render` | Replayable calculation of the next UI value | Must be idempotent and free of observable capabilities |
| `event` | JSX event callback invoked by an external interaction | Capabilities are recorded but are not charged to render |
| `imperative-handle-method` | Method exposed to a ref consumer by `useImperativeHandle` | Method capabilities are recorded as externally invoked work, not factory work |
| `external-store-snapshot` | `useSyncExternalStore` client `getSnapshot` read during replayable rendering | Read capabilities are recorded at the specialized boundary |
| `server-snapshot` | Optional `getServerSnapshot` read during SSR or hydration | Capabilities remain distinct from the client snapshot |
| `external-store-subscribe` | External-store subscription setup after mount | Acquisition and returned cleanup are paired without claiming exact host timing |
| `insertion-effect` | `useInsertionEffect` setup during commit, before refs and layout/passive Effects | Capabilities are recorded; local state dispatch is rejected |
| `layout-effect` | `useLayoutEffect` setup after commit | Capabilities are recorded separately |
| `imperative-handle` | `useImperativeHandle` factory during the layout commit | Factory capabilities and lifecycle replay are separate from exposed methods |
| `passive-effect` | `useEffect` setup after commit | Capabilities are recorded separately |
| `ref-callback` | Inline JSX callback ref invoked during commit | Setup capabilities are separate from render |
| `cleanup` | Function returned by an Effect or callback-ref setup | May release a setup acquisition |

Creating JSX is a render calculation, not a `DomWrite`. React's later host DOM
commit is outside the component function. Direct writes through `document` or
`window` during render are `DomWrite` and are rejected.

JSX event attributes accept inline callbacks and immutable component-local
function/arrow callbacks reached through `const` identifier aliases. Their
capabilities belong to the `event` phase, not render. Reassigned identifiers,
member expressions, imported callbacks, and other unresolved handler shapes
produce `unknown-event-handler` instead of being silently treated as pure.

Inline or immutable component/custom-Hook-local action callbacks passed to named or aliased `startTransition`,
`React.startTransition`, a React namespace object, or the second tuple element
returned by `useTransition` execute in the caller's current phase. Uneffect
therefore retains capabilities inside the action: a Fetch nested under
`startTransition` in an event handler is an `event` capability, while the same
call during render is a `render-effect` error. This is effect tracking for the
synchronous action invocation. It does not yet model transition priority,
pending state, interruption, or the eventual rendering work as a scheduler.
Transitive `const` aliases are resolved. Imported, reassigned, member-based, or
otherwise opaque actions produce `unknown-transition-action` rather than losing
their capabilities silently.

Named or aliased `useEffectEvent` creates a dedicated local callback class.
Calls from insertion, layout, or passive Effect setup/cleanup expand the Event's
capabilities into the calling phase, including transitive `const` aliases and
Effect-Event-to-Effect-Event calls. The binding is exempt from captured
dependency requirements, while explicitly listing it produces
`effect-event-dependency`. Calling it during render, from a JSX event callback,
or from a transition action produces `invalid-effect-event-call`; it is not
silently treated as an ordinary event handler. This implements the local,
inline fragment of the [React `useEffectEvent` contract](https://react.dev/reference/react/useEffectEvent).

Named, default-object, or namespace-qualified `useSyncExternalStore` calls resolve inline,
module-local, and immutable component/custom-Hook-local callback arguments.
Client and optional server snapshot capabilities are not charged as ordinary
render violations: the Hook is the explicit external-read boundary. The
subscribe callback forms an `external-store-subscribe` commit instance, and a
returned cleanup participates in the same resource identity checks and Quint
lifecycle projection as Effects. Subscription and passive Effect phases have
no imposed relative order because React's public API does not promise one.
Opaque callbacks produce `unknown-external-store-callback`. A snapshot that
directly returns a fresh object or array produces
`uncached-external-store-snapshot`; a subscribe callback without a returned
unsubscribe function produces `missing-external-store-cleanup`, following the
[React external-store contract](https://react.dev/reference/react/useSyncExternalStore).

Named, default-object, or namespace-qualified `useImperativeHandle` calls
resolve inline, module-local, and immutable component/custom-Hook-local handle
factories. Factory capabilities occupy an `imperative-handle` commit instance;
methods, getters, setters, and function-valued properties on a directly
returned object occupy `imperative-handle-method`, because a ref consumer may
invoke them later. Dependency arrays use the same lexical capture checks as
Effects, and opaque factories produce `unknown-imperative-handle-callback`.
The lifecycle replay includes React's setup/cleanup/setup development stress
cycle without claiming a user-visible cleanup callback from the factory. This
is the reviewed local fragment of the
[React `useImperativeHandle` contract](https://react.dev/reference/react/useImperativeHandle).

Named imports of `useEffect`, `useLayoutEffect`, and `useInsertionEffect` from `react`, including
aliases, establish the Effect boundaries. An unrelated same-named local
function is not treated as a built-in Hook boundary. Annotated custom Hooks
compose their render, Effect, and cleanup summaries into callers. The
Program-backed checker resolves each custom-Hook call site through its
TypeScript symbol to the annotated declaration. Named aliases, barrel
re-exports, namespace properties, and default imports therefore share one
resolution path across files. Hook summaries reach a fixed point once for the
Program.

Insertion Effect instances are normalized ahead of callback refs, layout
Effects, and passive Effects even when source order differs. The Quint
lifecycle projection requires each later phase's setup count not to exceed the
preceding phase's setup count. Calls through the local dispatcher returned by
`useState` or `useReducer`, including transitive `const` aliases, produce
`insertion-effect-state-update`; local `useRef` `.current` access and its
transitive aliases produce `insertion-effect-ref-access`. These checks follow
the [React `useInsertionEffect` contract](https://react.dev/reference/react/useInsertionEffect).
Uneffect does not claim whether host DOM mutation has already occurred.

## Render obligations

The tested fragment reports:

- observable `Console`, `Fetch`, `DomWrite`, or annotated user-function effects
  executed directly during render;
- `Date.now`, `Math.random`, `crypto.randomUUID`, and `performance.now`, whose
  results are not idempotent for fixed props, state, and context;
- assignment, update, or deletion through an immutable render snapshot. The
  tested region sources are identifier or destructured props, the value
  position of directly imported `useState`/`useReducer`, directly imported
  `useContext` results, and transitive local `const` aliases;
- reads or writes of `.current` through a direct named-import `useRef` result
  or transitive local `const` alias during render. Passing the ref object as
  `ref={host}` is not a `.current` access, and event/Effect/ref callbacks are
  separate phases;
- recognized Hooks called below a condition, loop, switch arm, short-circuit
  expression, or nested function.
- annotated custom Hook arguments are checked as immutable snapshots, and
  their direct render effects and non-idempotent operations are diagnosed at
  the Hook boundary;
- named React Hooks participate in stable-order checks. Inline `useMemo` and
  lazy `useState` callbacks, plus the third `useReducer` initializer argument,
  execute in the replayable render phase; a `useCallback` callback is retained
  rather than executed and is not charged to render;
- unresolved `useX` calls and direct custom-Hook recursion fail closed instead
  of producing a pure summary.
- local and cross-module indirect custom-Hook cycles are diagnosed on every
  participating call edge.

## Dependency and stale-closure checks

Inline callbacks and inline dependency arrays for named imports (including
aliases) of `useEffect`, `useLayoutEffect`, `useMemo`, and `useCallback` are
checked inside opted-in components and custom Hooks. The initial lexical
analysis:

- collects component/Hook parameters and render-local bindings captured by the
  callback, with nested function and block shadowing;
- preserves member paths such as `props.service`; a dependency on `props`
  conservatively covers that path;
- treats the setter/dispatch position returned by `useState`, `useReducer`, and
  `useTransition`, and a direct `useRef` result, as stable identities;
- excludes declarations local to the Hook callback, including values retained
  only by its cleanup;
- reports the sorted missing capture set as one `missing-hook-dependency`
  diagnostic;
- fails closed when a supplied dependency list is computed or spread, or when
  a supplied inline array accompanies an opaque callback;
- rejects object, array, function, call, and `new` expressions written directly
  as dependencies because they create a new identity during render.

Omitting the dependency argument is not stale: React reruns/recomputes after
every render, so this check emits no missing-dependency diagnostic. An explicit
empty array is checked normally. `useCallback` bodies remain retained work and
are not charged as render effects, but their captured values are checked.

This is not a replacement for TypeScript-symbol-based exhaustive-deps yet.
Imported/module bindings are assumed stable, custom stability conventions are
not inferred, unnecessary but stable dependencies are not rejected, and
mutations behind an otherwise stable object identity are outside this proof.

Malformed React payloads are errors. The accepted forms are `react component`,
`react hook`, `react acquire Capability`, `react release Capability`, and the
identity-aware lifecycle forms described below. Misspellings and unsupported
fields are not silently ignored.

Inline JSX event callbacks are analyzed as `event`, so their capabilities do
not produce render diagnostics.

Inline JSX callback refs are analyzed as `ref-callback` commit work. Their
returned inline function is cleanup, and the same acquire/release capability
and local resource-identity checks used for Effects apply. Development Strict
Mode projects callback refs as `setup, cleanup, setup`. Referenced callback
identifiers and callback refs passed through component props are not resolved
yet.

## Acquisition and cleanup contracts

Capability effects alone do not imply resource ownership. A boundary must
state that it acquires or releases a lifecycle capability:

```tsx
/* uneffect: react acquire Subscription */
declare function subscribe(): void

/* uneffect: react release Subscription */
declare function unsubscribe(): void

/* uneffect: react component */
function Feed() {
  useEffect(() => {
    subscribe()
    return () => unsubscribe()
  }, [])
  return null
}
```

An acquisition in Effect setup must have a matching release capability in the
returned cleanup. Returning an unrelated cleanup does not discharge it. This
models React development Strict Mode's setup, cleanup, setup stress cycle and
ordinary dependency-change/unmount cleanup without pretending that every
effectful operation requires reversal.

Phase summaries expose these transitions as `Acquire<Capability>` and
`Release<Capability>` entries even when the boundary has no ordinary Uneffect
capability-effect declaration.

Capability matching cannot distinguish two resources of the same kind. A
boundary can opt into local resource identity with `result` and `parameter N`:

```tsx
interface Subscription { readonly id: string }

/* uneffect: react acquire Subscription result */
declare function subscribe(): Subscription

/* uneffect: react release Subscription parameter 0 */
declare function unsubscribe(value: Subscription): void

/* uneffect: react component */
function Feed() {
  useEffect(() => {
    const subscription = subscribe()
    const cleanupTarget = subscription
    return () => unsubscribe(cleanupTarget)
  }, [])
  return null
}
```

Within an inline Effect setup and its returned inline cleanup, the analyzer
tracks the acquired result through identifier-bound immutable aliases. It
rejects a release of an unrelated expression, duplicate release of one
identity, an unreleased second identity of the same capability, and
control-flow-dependent acquisition or release that cannot establish an
exactly-once lifecycle. This is a
local syntactic identity proof: mutable/reassigned aliases, properties,
collections, closures returned from helper functions, and interprocedural
ownership transfer are not accepted as evidence yet.

## Replay model

Every component and custom-Hook summary exposes a zero-runtime `replay` model.
The production initial-mount scenario has one render invocation and one setup
transition for each present layout/passive/ref-callback phase. The development
Strict Mode scenario has two render invocations and models each present Effect
or inline callback-ref instance as `setup, cleanup, setup`. The dependency-change
scenario commits two render generations and associates the old generation's
`setup, cleanup` with the replacement generation's final `setup`. Every replay entry
has a source-derived `instance` path and preserves that setup's own
`cleanupEffects`. Custom-Hook composition prefixes the nested instance with
each caller site, so repeated Hook calls remain distinct.

Each scenario also records ordered render attempts as committed, discarded, or
suspended.
The bounded `concurrentInterruption` scenario discards one interrupted attempt,
then commits a replacement attempt. Its Effect and callback-ref setup entries
belong only to the committed result; discarded render work cannot authorize a
commit-side effect. This is a minimal interruption law, not a React scheduler
implementation.

The bounded `suspenseRetry` scenario records a suspended render separately from
a discarded render. The suspension has a model-local identity; an explicit
resolution transition must occur before the retry may commit. Effect and ref
setup still belong only to the retry's commit generation. This captures the
minimal no-effects-before-successful-retry law without modeling fallback trees.

The bounded `repeatedSuspenseRetry` scenario extends the same law across two
distinct suspension identities. A retry may suspend again, but it cannot create
the second suspension before the first one resolves; the final commit cannot
occur before the second suspension resolves. Commit-side Effect and ref setup
still occurs only once, for the final successful generation. This is a finite
causal trace, not an unbounded retry or thenable model.

`generateReactSuspenseBoundaryQuint(moduleName, primary, fallback)` composes
two separately analyzed component summaries. Its bounded trace permits the
primary render to suspend, commits and sets up the fallback, resolves the
primary suspension, authorizes the primary reveal commit, tears down fallback
instances, and sets up primary instances. Within each commit phase, every
primary setup requires all fallback instances in that phase to have crossed
their cleanup barrier. The model preserves `primary/` and `fallback/` instance
names and their effect metadata instead of merging the components' effects.
Fault-injection tests show that reveal-before-resolution and primary
setup-before-fallback-cleanup violate `suspenseBoundarySafe`.

For the supported direct JSX fragment, the analyzer recognizes a React
`Suspense`, a `fallback` containing one direct annotated component element,
and one or more direct annotated component or nested-boundary primary nodes.
JSX fragments, imported `Fragment`, and `React.Fragment` are transparent and
recursively flattened. Each boundary stores the ordered normalized nodes in
`primaryNodes`. Missing, indirect, intrinsic-wrapper, or expression-valued
children remain in `unsupportedSuspenseBoundaries` with a reason.
`generateReactSuspenseBoundaryQuintFromAnalysis` remains the stricter
single-primary/two-component generator and fails closed for a tree.

The Program-backed analyzer additionally resolves direct component tags
through TypeScript symbols across named import aliases, namespace-qualified
tags, re-export barrels, and default exports. Both named/aliased `Suspense` and
`React.Suspense` from a React namespace or default import are recognized. Each component node stores a canonical `file:name` key;
`generateReactSuspenseBoundaryQuintFromProgram` resolves those keys against the
complete Program result map and rejects missing or duplicate summaries. The
source-local API deliberately cannot authorize an imported component that has
not been resolved by a Program.

A direct nested chain retains the compatibility `primaryBoundary` field, while
all supported trees use `primaryNodes` plus each child's `parentBoundary`.
`generateReactSuspenseTreeQuintFromAnalysis` and its Program-backed variant
choose one component-leaf suspension per bounded trace and record that leaf's
nearest owner. Only that boundary may commit its fallback; a fallback in an
ancestor or sibling branch violates `suspenseTreeSafe`. Resolution then permits
the leaf reveal. The older nested-chain generator remains available. Suspension
while rendering a boundary or fallback and dynamic boundary selection are not
inferred.

Each component summary also exposes `suspensions`. A named, aliased,
default-object, or namespace-object React `use(value)` call is recorded as
`react-use` evidence. Source-only analysis retains `certainty: "unknown"`:
syntax alone cannot distinguish a Context or arbitrary value from a thenable.
Program analysis promotes the evidence to `certainty: "thenable"` only when
every member of the TypeScript argument type has a callable `then` property.
Mixed unions therefore remain unknown. The evidence carries its definition
file and composes through local or symbol-resolved cross-file custom Hooks.

A value thrown directly during opted-in component or custom-Hook render is
recorded as `throw-thenable` evidence. Program analysis classifies a type whose
every constituent has a callable `then` as `thenable`, a type where none of
the constituents does as `non-thenable`, and mixed, `any`, or `unknown` types as
`unknown`. Consequently, an ordinary thrown `Error` is not admitted as a
Suspense cause, while a thrown `Promise<T>` is. Source-only analysis remains
unknown and does not pretend that syntax proves the runtime value.

Passing `{ requireKnownSuspension: true }` to either Suspense-tree generator
removes leaves without proven thenable evidence and fails closed if none
remain. The default remains the explicitly conservative any-leaf model for
callers that want to explore hypothetical suspension. This proves a typed
may-suspend cause, not that React will reach the call, that the thenable is
currently pending, that a branch containing it is reachable, or that it will
fulfill rather than reject. It also does not replace React error-boundary
semantics for non-thenable throws.

Uneffect does not yet prove that a render reaches a pending thenable or
distinguish a user cleanup callback from an empty phase teardown barrier. The
generator is therefore bounded lifecycle evidence for the extracted direct
relationship, not a general React tree or suspension proof.

Committed render attempts carry a stable model-local generation such as
`commit@0`. Each lifecycle entry stores both its transition and owning commit.
Consequently, the identical transition spelling used by Strict Mode replay and
dependency changes does not erase whether the final setup belongs to the same
commit or its replacement.

This is deliberately a lifecycle projection, not a claim about total ordering
between all layout, passive, and callback-ref instances, browser tasks,
Suspense, or concurrent commits. Production cleanup occurs on a later
dependency change or unmount and therefore is not placed into the initial-mount
transition list.

## Public result

`analyzeReactSemantics(fileName, source)` returns opted-in component and custom
Hook summaries, phase-local effect sets, per-instance replay entries, and
diagnostics. It also returns supported and unsupported direct JSX Suspense
boundary facts.
`analyzeReactProgram(program)` and `analyzeReactSemanticsInProgram` add
TypeScript-resolved cross-file composition. `uneffect check` computes the
Program result once and includes the same diagnostics. The analysis is
metadata-only and adds no runtime dependency.

`generateReactLifecycleQuint(moduleName, component, scenario)` projects the
`production`, `strictModeDevelopment`, `concurrentInterruption`,
`dependencyChange`, `suspenseRetry`, or `repeatedSuspenseRetry` replay into
reviewable Quint. It uses
separate
attempted/committed/discarded render counts, one flag per commit generation,
separate suspended/resolved flags, and one setup/cleanup counter pair per
lifecycle instance. A lifecycle
transition requires its owner generation to have committed, while different
commit instances remain unordered. The
`reactLifecycleSafe` invariant requires cleanup never to lead setup, setup to
lead cleanup by at most one, and both counters to stay within the selected
scenario's bounds. Test-only early-cleanup, setup-after-discard,
wrong-generation setup, and retry-before-resolution transitions (including a
retry that suspends again) demonstrate
that the invariant is load-bearing under the Quint simulator. This is bounded
lifecycle evidence, not a proof of React's scheduler or host commit order.

The public generator validates externally supplied replay IR before emitting a
model. Render-attempt counts, committed/discarded generation ownership, and the
legacy transition view must agree with the generation-aware lifecycle steps;
inconsistent input is rejected rather than weakened into a model.

## Current limits

This is a tested initial fragment, not a complete React semantics:

- direct identifier/property calls of annotated custom Hooks resolve through
  named, barrel, namespace, and default imports; element access, dynamically
  selected Hooks, higher-order aliases, and runtime dispatch remain unknown;
- event extraction covers inline callbacks and immutable component-local
  function/arrow callbacks through `const` aliases. Imported handlers, member
  expressions, callbacks passed through props, and general data flow remain
  explicit unknowns;
- immutable snapshot tracking is local and syntactic. It covers destructured
  props, direct named-import state/context Hook results, and transitive `const`
  aliases. Reassigned bindings, mutation through calls, properties stored in
  containers, and interprocedural region flow need a flow-sensitive
  ownership analysis;
- callback-ref extraction covers inline JSX functions only; referenced refs,
  ref props, and the predictable lazy-initialization
  exception for render-time `.current` access are not modeled;
- dependency completeness is checked for the documented inline lexical
  fragment; referenced callbacks, custom stability contracts, module mutation,
  and TypeScript-symbol-level aliasing remain unsupported;
- identity-aware setup/release matching is local to direct return bindings and
  immutable identifier aliases; general aliasing and interprocedural ownership
  remain unsupported;
- Intrinsic/component wrapper subtrees, expression-valued children, dynamic
  component selection, reachability/pending-state proof for `use`, suspension originating in a boundary or fallback,
  rejected thenables, unbounded retries, transition priority/pending state,
  imported/interprocedural transition actions, Offscreen trees,
  server components, hydration,
  insertion Effect component-by-component cleanup/setup interleaving,
  Effect Events passed through props/imports or higher-order containers,
  external-store member callbacks, general cache/immutability proofs,
  exact snapshot invocation counts, transition fallback-to-blocking behavior,
  server/client snapshot equality, non-object/member/aliased imperative-handle
  return values, methods introduced through object spread or prototype flow,
  cross-component calls through refs, and React compiler assumptions are not
  modeled;
- React lifecycle replay has a Quint safety projection; Z3 projection and
  concurrent scheduler refinement are not generated yet.

Unsupported behavior must not be interpreted as verified purity. The phase
summary only claims coverage for the constructs listed above.

## Dogfood

`examples/dogfood/react-telemetry-dashboard.tsx` combines `useState`, a pure
`useMemo` calculation, a custom subscription Hook, an identity-checked inline
callback ref, matching cleanup, an imperative handle exposing a Fetch method,
and an inline Fetch event. Its regression test
removes Effect/ref cleanup, substitutes another resource, removes a dependency,
and mutates props as independent negative controls. The same component also
generates the bounded interrupted-render model and locks the rule that only a
committed render authorizes its subscription/ref setup. Its dependency-change
projection additionally distinguishes the generation owning old cleanup from
the one owning replacement setup. Its Suspense projections lock both the
single and repeated suspend-resolve-retry ordering. The checked-in
`react-suspense-boundary.tsx` fixture additionally exercises automatic direct
JSX edge extraction and the bounded boundary generator. The checked-in
`react-suspense-symbol-*` fixture uses `React.Suspense` and namespace-qualified
component tags, then resolves them through a barrel to default and named
component exports before generating the same model. The checked-in
`react-nested-suspense.tsx` fixture combines a Fragment sibling with a nested
boundary and generates the tree ownership model, distinguishing the outer
navigation leaf from the inner account leaf. Its account component calls
`use(accountPromise)`; Program analysis proves the argument thenable and the
causal model excludes the static navigation leaf. The checked-in
`react-symbol-*` modules additionally compose a
component through a named barrel, namespace property, and default custom-Hook
import using the Program-backed checker. These are controlled fixtures rather
than an ecosystem false-positive measurement.
