# Persisted contract summaries

`uneffect-contract-summary/v1` is the shared package envelope for publishing
verified scalar Hoare contracts, Effect summaries, and trusted resource
lifecycle declarations. A direct named/default function export, a static
default-exported arrow/function expression, or a single immutable exported `const` initialized by an arrow/function
expression, is included when at least one of those domains is explicitly declared and
verified. Hoare entries require every local obligation and transitive
relational dependency to be `verified`; Effect entries require the declared
upper bound to match the analyzed implementation.

A same-file local function or immutable callable `const` may instead be exposed
by a later static export list, including rename and `as default`:

```ts
/* uneffect:effect none */
function implementation(value: number): number { return value + 1 }
export { implementation as increment, implementation as default }
```

The producer resolves each `ExportSpecifier` to its declaration through the
TypeChecker and retains the implementation function name for Hoare evidence.
This includes a static relative re-export such as
`export { value } from "./implementation.js"` when the implementation source is
in the same Program. Each cross-file export records the implementation file and
full source digest in addition to the public entry source. Validation resolves
the barrel again and checks both identities and bytes. Mutable bindings and
external-package re-exports remain unsupported.

Static relative `export *` barrels use the entry module's final TypeChecker
export set. Callable members may pass through multiple relative barrel layers;
each summary still points at the final implementation source. Default exports
and non-callable values are not introduced by `export *`. An explicit local
export overrides the star member, while ambiguous stars are TypeScript errors
and prevent publication.

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
  // Optional: publish one package subpath rather than the root import.
  moduleSpecifier: "@example/math/scalar",
  fileName,
  source,
  program,
  artifacts,
  runtimeArtifacts: [
    { packagePath: "dist/index.js", fileName: emittedJavaScriptFile },
  ],
  // Stronger option for an untransformed TypeScript distribution:
  typescriptEmit: { packageRoot },
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

The equivalent package-facing CLI is:

```sh
npx uneffect contract-summary --project tsconfig.build.json --entry src/index.ts \
  --package-name @example/math --package-version 1.2.3 \
  --module-specifier @example/math/scalar \
  --typescript-emit-root . --out uneffect-contract.json
```

The bundle binds:

- package name and exact version;
- TypeScript version and canonical compiler-options digest;
- producer file and full source SHA-256;
- direct export name and function identity;
- declaration span and SHA-256;
- TypeChecker-rendered signature and SHA-256;
- ordered public overload signatures and individual SHA-256 digests when the
  export is overloaded;
- parameter names, `requires`, and `ensures` clauses;
- every solver artifact ID supporting the export.
- optional verified Effect atoms and declaration-order parameter names;
- direct callback timing, cardinality, completion mode, and optional Effect
  upper bound.
- optional parameter/return resource operations (`acquire`, `use`/`borrow`,
  `consume`, `release`, `transfer`, and `escape`) retained as trusted evidence.
- optional package-relative runtime artifact paths and SHA-256 digests.

Changing any covered value invalidates the bundle content digest. Validation
also recomputes compiler, source, declaration, and signature evidence instead
of trusting the stored digest.

## Assurance boundary

The consumer binder follows TypeChecker-resolved calls through named-import
aliases, namespace imports, source re-exports, and immutable aliases of a
supported callable member. It accepts a contract only when the resolved
declaration belongs to an installed package with the exact summarized name and
version, exact root-package export identity, and its TypeChecker signature matches the producer signature. Evidence
records the resolved declaration file, span, and SHA-256. The CLI exposes the
same path. The identities are checked separately:

The root package identity (`package.name`) is distinct from the callable import
identity (`symbol.module`). A summary may target the root or a normalized
subpath such as `@example/math/scalar`; the latter must remain beneath the same
package name. Binder keys include both module specifier and export name, so a
root `connect` and `@example/math/client`'s `connect` cannot authorize each
other. Absolute, empty, backslash, `.`/`..`, and unrelated package specifiers
are rejected.

Consume the summary with:

```sh
npx uneffect check --project tsconfig.json \
  --contract-summary ./uneffect-contract.json \
  --assurance no-unknown
```

Repeat `--contract-summary` to compose packages. A content, TypeScript,
installed-version, or signature mismatch is a blocking `unknown`; an unused
summary is `not-applicable` rather than a proof.

Overloaded exports retain the TypeChecker's ordered public call signatures;
the implementation signature is not published as a callable overload. Consumer
binding requires every resolved call signature to be present and also requires
the installed declaration's complete ordered overload set to match. Added,
removed, reordered, or changed overloads therefore fail closed even when the
consumer happens to call only an unchanged overload.

Generic exports retain their public type-parameter arity together with the
complete TypeChecker-rendered declaration signature. Consumer calls may use
different inferred instantiations only after the installed declaration's full
signature set has matched exactly; changing a constraint, default, overload,
or type-parameter list blocks the binding. This authenticates the declaration
that TypeScript instantiated. A call site overlapping a TypeScript semantic
error is rejected even when the compiler exposes a recovery signature. It does not prove TypeScript's type system or
infer a contract for an opaque dynamically selected callable.

Callable members of an exported builtin `Object.freeze({ ... })` literal can
be published as an export plus a static symbol path, for example
`telemetry.track` or `api.users.get`. Every object traversed below the root
must have its own builtin freeze; a shallowly frozen root gives no authority to
a nested mutable object. Direct calls, immutable local
aliases, and statically named `const` object destructuring must retain the root exported receiver identity, resolve to the
installed member declaration, and then use the ordinary
external Effect/resource IR. A scalar Hoare contract on an identifier-named
member is verified against that method's own source span and can be instantiated
at a synchronous scalar call or after a direct `await` at the consumer;
callee preconditions become call-site obligations rather than assumptions, and
the synchronous result may flow through an initialized scalar binding before
the caller returns. Promise-producing calls remain in the ownership/completion
path; direct await, stored await, direct async return, and return of a supported
stored immutable Promise preserve their distinct observation timing. Same-named
sibling methods cannot lend evidence. Hoare lowering accepts only the
call-site spans authenticated by the root-provenance binder, so a structural
lookalike or `as typeof exportedRoot` cast cannot recover the member contract.
An ordinary or nested mutable object, computed key, getter,
spread-built object, or a same-named user implementation of `Object.freeze`
is rejected. A structurally compatible value with the same imported member
type is not the exported receiver: its call remains explicit `unknown` rather
than inheriting the package authority. Uneffect does not insert or recommend `Object.freeze`; this rule
only consumes an immutability decision already present in the package. As with
function exports, the producer claim remains trusted unless the optional exact
emit/runtime evidence is supplied.

The bound contract carries the exact accepted consumer call-site spans into
Effect analysis. This is intentional: a declaration-compatible receiver that
did not pass root-provenance checking cannot regain authority merely because
TypeScript reports the same structural member declaration.

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

When `runtimeArtifacts` is supplied, production hashes the selected emitted
files and includes their package-relative paths and digests in the signed
content envelope. Consumer binding resolves the installed package root from the
TypeChecker-selected declaration and requires those installed bytes to match.
Paths must be normalized forward-slash package paths; absolute paths, `.`/`..`
segments, backslashes, duplicate paths, missing files, and digest drift fail
closed. This opt-in proves byte identity only for the listed files. It does not
prove that the declaration or JavaScript was emitted from the summarized source,
that every runtime/export-map branch was listed, or that the tarball publisher
is authentic.

Export-map selection is inherited from TypeScript module resolution; Uneffect
does not independently choose or authenticate all conditional runtime targets.

For packages that execute the exact TypeScript output, `typescriptEmit` is the
stronger producer option. Uneffect invokes the existing exact-output checker:
the supplied Program is re-emitted in memory by the recorded TypeScript
version, and every emitted declaration/runtime file on disk must match those
bytes. All outputs must be inside `packageRoot`; their kind, relative path, and
digest enter the package envelope. Validation repeats the emit comparison, and
consumer binding checks every listed installed output before exposing any
contract. This establishes source/Program-to-plain-TypeScript-emit integrity
conditional on the TypeScript compiler. It intentionally rejects `noEmit`,
`emitDeclarationOnly`, missing output, and post-emit or bundler-transformed
files; those need a separate authenticated transformation pipeline.

The content SHA-256 provides integrity, not publisher authenticity. There is no
signature, transparency log, or trusted publishing identity in v1. A
successfully bound scalar call carries `trusted` relational evidence: the
declaration binding is checked, while the persisted producer authority is not
silently upgraded to an authenticated proof.

Exported `const` callables are joined by the root package export symbol and the
resolved call signature, not by a guessed variable name. Mutable `let`/`var`,
multi-declaration variable exports, reassigned aliases, and non-callable
exports are not published.

Default imports and namespace `.default` calls bind through the TypeChecker's
root-package `default` export symbol. A named default function retains its local
function name for Hoare obligation matching; the package identity remains
`default`. A directly authored default arrow/function expression uses the
export assignment as its annotation owner. Indirect forms such as
`export default someCallable`, mutable bindings, calls, and conditional
expressions are rejected rather than followed speculatively.

Finite object/tuple callback paths are supported for an inline literal or a
single-use `const` literal container whose TypeChecker symbol appears only at
its declaration and the external call. The selected leaf may be an inline
function or immutable symbol-resolved function identifier. A repeated use
without the borrow evidence described below, mutation, alias, capture, spread,
computed/dynamic selection, or unresolved leaf fails closed. Returned
callables, reentrancy/concurrency, and external settlement internals remain
outside this first callback fragment. Direct exported resource lifecycle
contracts are composed separately through the shared resource CFG.

A resource-only export can be published without inventing an Effect or Hoare
contract. The producer validates its annotation syntax, but records the payload
as `trusted`, because the declaration is not an implementation proof. At the
consumer, package/version/compiler/signature binding must succeed before the
resource operations are rebound to installed declaration identities. The
ordinary `checkFiles` and project verifier then detect leaks, duplicate release,
and post-release use and expose the result in `resourceProtocols`. A static
object-literal factory may also persist resource operations for named callable
`returnMembers`. The consumer accepts calls through a direct factory result and
acyclic immutable receiver aliases; dynamic member selection, receiver escape,
and mutable aliases fail closed.

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
`rejects`. Direct standard `Promise.reject(...)` and an uncaught `throw` inside
an `async` callable contribute rejection types; a locally caught throw does not,
while a catch rethrow contributes its new error type. After exact package/declaration/signature binding, synchronous
`Throw<E>` and a directly awaited rejection become authenticated exceptional
edges in the shared resource CFG. A root-provenance-authorized persisted
`Throw<E>` call statement also enters the Hoare exception CFG as a may-throw
completion: `catch` discharges it, `finally` preserves or overrides it, and an
unhandled edge remains in `exceptionFlow.escapes`. Structural lookalikes do not
inherit that completion. A scalar call that both returns a contract value and
may synchronously throw composes both paths when it is the direct return
expression, the direct initializer of one scalar binding, or the complete
right-hand side of an identifier assignment. An escaping path
still requires the caller's declared `Throw<E>` upper bound. A call nested in
supported scalar arithmetic/comparison, prefix negation, ternary branches and
conditions, Boolean short circuit, and reviewed `Math` scalar arguments uses the
same value/abrupt evaluator. Binary operands and call arguments are evaluated
left-to-right; an abrupt path skips the remaining expression. Unsupported
property/coercion/dynamic expressions remain fail-closed. Throwing Boolean
contracts also drive `if`, finite literal `switch`, and invariant-backed
`while`/`for`/`do...while` conditions; the loop claim remains the existing
invariant abstraction, not termination or invocation-cardinality proof.
Package semantic authority remains `trusted`;
declaration linkage does not upgrade it to a proof. A floating rejection stays
in Promise ownership and is never rewritten into a synchronous throw edge.
Persisted rejection sets are expanded into authenticated `Reject<E>` await
completions; catch may discharge them, and receiver lookalikes cannot inherit
them.

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

A source-local `const` object literal may store returned callables without a
runtime freeze. Uneffect scans every reference to the container symbol and
requires each use to be a direct call through a static dot or string/numeric
literal property. Multiple explicit property assignments are supported.
Mutation, passing or returning the container, computed keys, spreads,
accessors, methods, and duplicate keys invalidate the proof and produce
unknown external evidence.

A factory may instead return one static object literal. Its explicit method and
function-valued property bodies are persisted independently as
`returnMembers`; non-callable data properties are allowed. A consumer's direct
`const client = factory()` and its acyclic `const` receiver aliases may call
those members through static dot or literal keys when every reference in the
complete alias family is such a call or an immutable alias edge. Each member retains its own
Effect, synchronous `Throw`, and awaited rejection. Producer spreads,
accessors, computed or duplicate keys, and consumer mutation, escape, or
dynamic selection fail closed. Stateful method effects are tracked, but
general `this`-dependent relational contracts are not yet modeled.
Direct callable parameters of each member also retain their Effect bounds,
invocation cardinality, timing, and throw-completion lane. At the consumer the
authenticated member contract is projected onto the TypeChecker-resolved
method declaration before the ordinary callback call graph is built. This
supports `client.run(callback)` through immutable receiver aliases without a
wrapper or runtime marker. Reentrant/concurrent callback protocols and callbacks
stored for later opaque invocation remain outside this fragment.
Every callback-parameter reference and immutable alias must be consumed by a
direct invocation, immutable alias declaration, or reviewed builtin forwarding
site. Unknown calls, storage, return, capture, comparison, and other uses are
`callback-escape`; cardinality becomes unknown and package publication fails.
One direct TypeChecker-resolved same-Program wrapper may forward its callback
parameter to another summarized callable. A fixed point composes acyclic
wrapper chains independent of declaration order, including enclosing `0..1`
conditionality, completion, and scheduling provenance. Cycles, multiple or
mixed forwarding sites, and unresolved callees stay unknown. Type-only
references such as `typeof callback` do not count as runtime escape.
The same authenticated member callback is visible to the host-neutral temporal
collector. `inline` and Promise-reaction lanes retain their defined projection.
A direct reviewed forwarding to `setTimeout`, `setInterval`,
`requestAnimationFrame`, or EventTarget persists scheduling provenance.
Literal timer delays additionally permit executable Web/Node timer projection.
A generic `deferred` member callback remains an unknown queue; Uneffect does
not infer a timer merely from deferred execution.
One narrow fluent form is receiver-preserving: an explicit object-literal
method whose only return is a final direct `return this`. A call such as
`client.chain().report()` retains the original factory receiver, composes both
member effects/exceptions, and keeps `this`-rooted mutation attached to that
receiver. Conditional or multiple returns, replacement objects, arrow lexical
`this`, computed selection, and general fluent result types fail closed.
Member mutation effects rooted at `this` are instantiated against the concrete
static receiver, so `Mutate<typeof this.value>` becomes
`Mutate<typeof client.value>`. If the receiver has no stable addressable region,
the mutation contract cannot be instantiated and evidence becomes unknown.
