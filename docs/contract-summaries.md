# Persisted contract summaries

`uneffect-contract-summary/v1` is the shared package envelope for publishing
verified scalar Hoare contracts and Effect summaries. A direct named function
export, or a single immutable exported `const` initialized by an arrow/function
expression, is included when at least one of those domains is explicitly declared and
verified. Hoare entries require every local obligation and transitive
relational dependency to be `verified`; Effect entries require the declared
upper bound to match the analyzed implementation.

```ts
import {
  bindContractSummaryBundleToProgram,
  createContractSummaryBundle,
  loadContractSummaryBundle,
  validateContractSummaryBundle,
} from "@mizchi/uneffect"

const bundle = createContractSummaryBundle({
  packageName: "@example/math",
  packageVersion: "1.2.3",
  fileName,
  source,
  program,
  artifacts,
})

const validation = validateContractSummaryBundle(bundle, {
  packageName: "@example/math",
  packageVersion: "1.2.3",
  fileName,
  source,
  program,
})

const installed = await loadContractSummaryBundle("uneffect-contract.json")
const binding = bindContractSummaryBundleToProgram(installed, consumerProgram)
```

The bundle binds:

- package name and exact version;
- TypeScript version and canonical compiler-options digest;
- producer file and full source SHA-256;
- direct export name and function identity;
- declaration span and SHA-256;
- TypeChecker-rendered signature and SHA-256;
- parameter names, `requires`, and `ensures` clauses;
- every solver artifact ID supporting the export.
- optional verified Effect atoms and declaration-order parameter names;
- direct callback timing, cardinality, completion mode, and optional Effect
  upper bound.

Changing any covered value invalidates the bundle content digest. Validation
also recomputes compiler, source, declaration, and signature evidence instead
of trusting the stored digest.

## Assurance boundary

The consumer binder follows TypeChecker-resolved calls through named-import
aliases, namespace imports, and source re-exports. It accepts a contract only when the resolved
declaration belongs to an installed package with the exact summarized name and
version, exact root-package export identity, and its TypeChecker signature matches the producer signature. Evidence
records the resolved declaration file, span, and SHA-256. The CLI exposes the
same path:

```sh
npx uneffect check --project tsconfig.json \
  --contract-summary ./uneffect-contract.json \
  --assurance no-unknown
```

Repeat `--contract-summary` to compose packages. A content, TypeScript,
installed-version, or signature mismatch is a blocking `unknown`; an unused
summary is `not-applicable` rather than a proof.

Effect-only exports are supported. Scoped capabilities, `Throw<E>`, and
parameter-rooted `Mutate<typeof parameter.member>` use the same parser and
call-site substitution as same-workspace summaries. The binding is supplied to
the ordinary Effect analyzer rather than interpreted by a package-specific
walker.

Direct callback parameters are also composed. For a callback passed as an
inline function or immutable TypeChecker-resolved function identifier, its
effects propagate into the caller using the persisted timing. A producer
`effect_parameter` upper bound is checked against the inferred callback
effects; a violation downgrades the caller to `unknown`. `promise-reaction`
timing and `convert-throw-to-rejection` completion lower to the shared
host-neutral microtask/rejection transition, while the Effect call graph
discharges the callback's synchronous `Throw`. Cardinality is preserved on
that transition. When the returned Promise is assigned to a direct identifier,
the callback and a conservative fulfilled/rejected settlement transition share
the same source-stable binding identity and the settlement records the Promise
ownership status (`floating`, `transferred`, or `observed`). Host-task queue
selection still requires a reviewed Web or Node scheduling profile. A
throw-to-rejection contract on a call whose actual TypeChecker return type is
not Promise-like is rejected as `unknown`; Uneffect does not invent a hidden
returned Promise.

`generateHostTransitionModel` projects this external Promise reaction into the
same executable Web/Node Quint Promise-chain state machine. Because external
implementation progress is opaque, the generated model keeps separate
settled, pending, and synchronous-divergence choices instead of assuming that
the callback eventually runs.

This does not yet prove that the installed declaration bytes were emitted from
the summarized producer source, or that bundled/runtime JavaScript corresponds
to that declaration. Export-map selection is inherited from TypeScript module
resolution; Uneffect does not independently authenticate an installed tarball.

The content SHA-256 provides integrity, not publisher authenticity. There is no
signature, transparency log, or trusted publishing identity in v1. A
successfully bound scalar call carries `trusted` relational evidence: the
declaration binding is checked, while the persisted producer authority is not
silently upgraded to an authenticated proof.

Exported `const` callables are joined by the root package export symbol and the
resolved call signature, not by a guessed variable name. Mutable `let`/`var`,
multi-declaration export statements, reassigned aliases, and non-callable
exports are not published.

Finite object/tuple callback paths are supported for an inline literal or a
single-use `const` literal container whose TypeChecker symbol appears only at
its declaration and the external call. The selected leaf may be an inline
function or immutable symbol-resolved function identifier. A repeated use
without the borrow evidence described below, mutation, alias, capture, spread,
computed/dynamic selection, or unresolved leaf fails closed. Returned
callables, reentrancy/concurrency, external settlement internals, and resource ownership
remain outside this first consumer fragment.

A literal wrapped by the exact standard-library `Object.freeze` symbol may be
reused across calls. This is a shallow rule: the selected callback property is
stable, but Uneffect does not infer deep immutability for nested mutable values.
A same-spelled local `Object.freeze` receives no authority.

This is compatibility recognition for code that already freezes the container,
not a recommendation to introduce `Object.freeze`. Freezing has runtime cost,
while Uneffect's preferred inline-literal and exclusive single-use `const`
paths are static-only.

A persisted callback entry may additionally carry
`containerAccess: "borrow-readonly"`. The producer emits this only for a
TypeChecker-resolved destructured parameter whose callback does not escape.
The consumer may then reuse a plain `const` literal container with zero runtime
work, but only when every reference is the same verified callee's same argument
position. Mutation, aliasing, capture, returning, unrelated calls, or missing
borrow evidence fail closed.

The Effect payload also persists direct Promise rejection types separately as
`rejects`. After exact package/declaration/signature binding, synchronous
`Throw<E>` and a directly awaited rejection become authenticated exceptional
edges in the shared resource CFG. Package semantic authority remains `trusted`;
declaration linkage does not upgrade it to a proof. A floating rejection stays
in Promise ownership and is never rewritten into a synchronous throw edge.

Callback cardinality is path-joined for one closed mutually exclusive control
node. An `if/else` with one unconditional call in each arm is exactly-once; if
the whole conditional is itself optional or repeated, that outer multiplicity
is preserved. A `switch` receives the same treatment only with an explicit
default, one unconditional callback call per clause, and no fallthrough.
Independent conditions, fallthrough, or nested conditional calls remain
`unknown` rather than being added as if they were exclusive.
The same join applies when every arm forwards the callback to a reviewed
builtin. Outer branch multiplicity is composed with the builtin's own
cardinality—for example, either of two `Promise.then` registrations remains
`0..1`. Timing and completion must agree across all arms; mixing an inline call
with a Promise reaction or host task stays `unknown`.

One direct returned callable is persisted as `returnCallable` when the producer
has exactly one return expression resolving to an inline function or immutable
local callable with non-unknown evidence. A consumer may invoke it through a
direct `const result = factory()` binding and an acyclic immutable identifier
alias chain. TypeChecker-resolved imports and re-exports of that binding retain
identity. Its Effect, synchronous `Throw`, and directly awaited rejection then
compose like an ordinary authenticated package call. `let`, reassignment,
conditional or multiple returns, cyclic aliases, property storage, and dynamic
selection remain unknown. This is not yet a general higher-order or fluent-API
model.
