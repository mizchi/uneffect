# React function component semantics

Uneffect treats React function components as replayable computations whose
observable work is split across lifecycle phases. The initial implementation
is opt-in and zero-runtime: it reads comments and TypeScript/TSX source but does
not transform the component or import React at runtime.

## Opting in

Annotate a function declaration, function expression, or variable-bound arrow
function explicitly:

```tsx
/* uneffect: react component */
export function Counter(props: { label: string }) {
  return <button>{props.label}</button>
}
```

Capitalization, JSX return syntax, and `React.FC` alone do not opt a function
in. This prevents a gradual check from silently changing the meaning of legacy
code. Ordinary JSDoc remains untouched.

## Phase model

The analyzer currently projects component work into five phases:

| Phase | Execution meaning | Initial rule |
| --- | --- | --- |
| `render` | Replayable calculation of the next UI value | Must be idempotent and free of observable capabilities |
| `event` | JSX event callback invoked by an external interaction | Capabilities are recorded but are not charged to render |
| `layout-effect` | `useLayoutEffect` setup after commit | Capabilities are recorded separately |
| `passive-effect` | `useEffect` setup after commit | Capabilities are recorded separately |
| `cleanup` | Function returned by an Effect setup | May release a setup acquisition |

Creating JSX is a render calculation, not a `DomWrite`. React's later host DOM
commit is outside the component function. Direct writes through `document` or
`window` during render are `DomWrite` and are rejected.

Named imports of `useEffect` and `useLayoutEffect` from `react`, including
aliases, establish the Effect boundaries. An unrelated same-named local
function is not treated as a Hook boundary.

## Render obligations

The tested fragment reports:

- observable `Console`, `Fetch`, `DomWrite`, or annotated user-function effects
  executed directly during render;
- `Date.now`, `Math.random`, `crypto.randomUUID`, and `performance.now`, whose
  results are not idempotent for fixed props, state, and context;
- member assignment through an identifier parameter such as `props.title =`;
- recognized Hooks called below a condition, loop, switch arm, short-circuit
  expression, or nested function.

Malformed React payloads are errors. The accepted initial forms are exactly
`react component`, `react acquire Capability`, and
`react release Capability`; misspellings and missing or excess fields are not
silently ignored.

Inline JSX event callbacks are analyzed as `event`, so their capabilities do
not produce render diagnostics.

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

## Public result

`analyzeReactSemantics(fileName, source)` returns opted-in component summaries,
phase-local effect sets, and diagnostics. `uneffect check` includes the same
diagnostics. The analysis is metadata-only and adds no runtime dependency.

## Current limits

This is a tested initial fragment, not a complete React semantics:

- component and Hook recognition is source-local; re-exported/custom Hooks and
  namespace/default React imports are not resolved yet;
- event extraction covers inline JSX function callbacks, not referenced
  handlers or callbacks passed through component props;
- props mutation currently covers member writes rooted at an identifier
  parameter; destructured props, state snapshots, context values, refs, aliases,
  and mutations performed by callees need flow-sensitive regions;
- Effect dependency completeness and stale closure analysis are not checked;
- setup/release matching is capability-level and does not yet prove identity of
  individual acquired resource handles or exactly-once cleanup;
- Suspense, transitions, Offscreen trees, server components, hydration,
  ref callbacks, insertion effects, and React compiler assumptions are not
  modeled;
- no Quint lifecycle model or Z3 invariant projection is generated yet.

Unsupported behavior must not be interpreted as verified purity. The phase
summary only claims coverage for the constructs listed above.
