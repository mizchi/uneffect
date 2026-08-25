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

The analyzer currently projects component work into six phases:

| Phase | Execution meaning | Initial rule |
| --- | --- | --- |
| `render` | Replayable calculation of the next UI value | Must be idempotent and free of observable capabilities |
| `event` | JSX event callback invoked by an external interaction | Capabilities are recorded but are not charged to render |
| `layout-effect` | `useLayoutEffect` setup after commit | Capabilities are recorded separately |
| `passive-effect` | `useEffect` setup after commit | Capabilities are recorded separately |
| `ref-callback` | Inline JSX callback ref invoked during commit | Setup capabilities are separate from render |
| `cleanup` | Function returned by an Effect or callback-ref setup | May release a setup acquisition |

Creating JSX is a render calculation, not a `DomWrite`. React's later host DOM
commit is outside the component function. Direct writes through `document` or
`window` during render are `DomWrite` and are rejected.

Named imports of `useEffect` and `useLayoutEffect` from `react`, including
aliases, establish the Effect boundaries. An unrelated same-named local
function is not treated as a built-in Hook boundary. Annotated custom Hooks
compose their render, Effect, and cleanup summaries into callers. The
Program-backed checker resolves each custom-Hook call site through its
TypeScript symbol to the annotated declaration. Named aliases, barrel
re-exports, namespace properties, and default imports therefore share one
resolution path across files. Hook summaries reach a fixed point once for the
Program.

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
diagnostics.
`analyzeReactProgram(program)` and `analyzeReactSemanticsInProgram` add
TypeScript-resolved cross-file composition. `uneffect check` computes the
Program result once and includes the same diagnostics. The analysis is
metadata-only and adds no runtime dependency.

`generateReactLifecycleQuint(moduleName, component, scenario)` projects the
`production`, `strictModeDevelopment`, `concurrentInterruption`, or
`dependencyChange`, or `suspenseRetry` replay into reviewable Quint. It uses
separate
attempted/committed/discarded render counts, one flag per commit generation,
separate suspended/resolved flags, and one setup/cleanup counter pair per
lifecycle instance. A lifecycle
transition requires its owner generation to have committed, while different
commit instances remain unordered. The
`reactLifecycleSafe` invariant requires cleanup never to lead setup, setup to
lead cleanup by at most one, and both counters to stay within the selected
scenario's bounds. Test-only early-cleanup, setup-after-discard,
wrong-generation setup, and retry-before-resolution transitions demonstrate
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
- event extraction covers inline JSX function callbacks, not referenced
  handlers or callbacks passed through component props;
- immutable snapshot tracking is local and syntactic. It covers destructured
  props, direct named-import state/context Hook results, and transitive `const`
  aliases. Reassigned bindings, mutation through calls, properties stored in
  containers, and interprocedural region flow need a flow-sensitive
  ownership analysis;
- callback-ref extraction covers inline JSX functions only; referenced refs,
  ref props, imperative handles, and the predictable lazy-initialization
  exception for render-time `.current` access are not modeled;
- dependency completeness is checked for the documented inline lexical
  fragment; referenced callbacks, custom stability contracts, module mutation,
  and TypeScript-symbol-level aliasing remain unsupported;
- identity-aware setup/release matching is local to direct return bindings and
  immutable identifier aliases; general aliasing and interprocedural ownership
  remain unsupported;
- Suspense fallback trees and nested boundaries, transition priority, Offscreen trees, server components, hydration,
  insertion effects, and React compiler assumptions are not
  modeled;
- React lifecycle replay has a Quint safety projection; Z3 projection and
  concurrent scheduler refinement are not generated yet.

Unsupported behavior must not be interpreted as verified purity. The phase
summary only claims coverage for the constructs listed above.

## Dogfood

`examples/dogfood/react-telemetry-dashboard.tsx` combines `useState`, a pure
`useMemo` calculation, a custom subscription Hook, an identity-checked inline
callback ref, matching cleanup, and an inline Fetch event. Its regression test
removes Effect/ref cleanup, substitutes another resource, removes a dependency,
and mutates props as independent negative controls. The same component also
generates the bounded interrupted-render model and locks the rule that only a
committed render authorizes its subscription/ref setup. Its dependency-change
projection additionally distinguishes the generation owning old cleanup from
the one owning replacement setup. Its Suspense projection locks the
suspend-resolve-retry ordering. The checked-in
`react-symbol-*` modules additionally compose a
component through a named barrel, namespace property, and default custom-Hook
import using the Program-backed checker. These are controlled fixtures rather
than an ecosystem false-positive measurement.
