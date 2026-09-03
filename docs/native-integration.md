# Native frontend integration

Uneffect's implementation layer is replaceable; its frontend and proof contracts are versioned.

## Corsa interchange

The Rust crate exposes `consume_corsa_json` and `CORSA_FRONTEND_SCHEMA_VERSION`. Schema v8 consumes:

- mandatory fact provenance (`typescript-reference` or `corsa-checker`) and a
  consistent `checkerBacked` flag,

- stable symbol IDs and declaration kinds (`function`, `method`, `arrow`, callback, overload),
- TypeScript type text and selected overload signatures,
- checker-inferred builtin effects with builtin key, opaque checker symbol ID,
  declaration provenance, and operation span,
- resolved caller/callee IDs and overload indices,
- callback invocation timing (`inline`, `deferred`, `unknown`),
- raw leading trivia with UTF-8 byte spans and file IDs.
- Promise observations and rejection-ownership records,
- resource scopes and reverse-order synchronous/asynchronous disposal records,
- exact nested resource failure payloads corresponding to `SuppressedError` chains.
- conditional-execution flags plus ordered control-condition IDs and polarity,
  including validated OR-of-conjunction `controlPaths` on Promise observations
  and resource acquisitions (`controlConditions` mirrors the primary path),
- disposal protocol symbols as stable IDs with a `sync`/`async` role, and
  resource-to-protocol edges validated for existence and matching role.

Rust attaches `uneffect:` trivia to the resolved owner, parses its structured effect set, and rejects unsupported schema versions, duplicate/dangling symbols, invalid overload indices, and malformed effects. This is the semantic-fact boundary that a Corsa integration must supply; Rust does not rediscover source spellings.

`compareUneffectFrontends` exercises that boundary end to end. The TypeScript
reference side emits schema-v8 mapper records, the Rust
`uneffect-corsa-normalize` binary consumes them, and both sides are compared as
the same normalized functions, transitive inferred effect sets, resolved local
call edges, source-ordered call events, Promise ownership records, resource
scopes, disposal order, and nested resource failure payloads. UTF-16 offsets
are converted to UTF-8 byte spans before crossing the schema. Frontend-specific
evidence provenance is carried through this semantic projection. The result
separates `checkerMetadataEquivalent`, `semanticEquivalent`, and overall
`equivalent`, and reports its producer. The metadata flag compares exact
checker-backed overload/effect atoms independently of neutral-IR domains that
the Corsa exporter has not implemented. It must not be read as full frontend
parity. With `requireCorsaCheckerFacts: true`, reference facts fail closed
even when Rust normalization is semantically equal. The mapper records are
currently produced by the TypeScript reference adapter, not by a linked
typescript-go/Corsa build. The reference adapter proves that aliases of
the standard symbols resolve through TypeChecker identity while same-spelled
user properties do not become protocols.

### Checker-backed exporter prototype

The optional `@mizchi/uneffect/corsa` entry point now runs an Oxlint JS plugin
through `corsa-oxlint`. The visitor refuses parser services without full type
information, reads Corsa symbol identity and type text, emits schema-v8 facts
with `producer: corsa-checker`, and compares them through the Rust consumer:

```ts
import { compareUneffectFrontends } from "@mizchi/uneffect";
import { exportCorsaCheckerFacts } from "@mizchi/uneffect/corsa";

const files = { "example.ts": "export function run(): number { return 1 }" };
const corsaFacts = await exportCorsaCheckerFacts({
  files,
  corsaExecutable: "node_modules/.bin/tsgo",
});
const result = await compareUneffectFrontends({
  files,
  corsaFacts,
  requireCorsaCheckerFacts: true,
});
```

This executable slice supports multiple project files, top-level named function
declarations and single-declarator immutable arrow/function-expression
bindings, identifier-named methods of top-level classes, direct local and
cross-file calls between those callables, function type text, and leading
`uneffect:` trivia. Named-function overload candidates are source ordered, and
call-site selection uses Corsa signature identity supplied with literal, base,
and union argument type alternatives. Corsa symbol IDs are
collected before numeric schema IDs are assigned, so imported calls retain
declaration identity. A local function name is kept when unique and rendered as
`path/to/file.ts::name` when duplicated elsewhere in the project; call edges
use the same identity and cannot collapse solely because spellings match.
For the first inferred-effect seed, `console.log` is recognized only when both
the receiver and member resolve through the active Corsa checker to the pinned
standard `lib.dom.d.ts` declarations. The exporter emits `Console` with the
operation's project-wide UTF-8 span, checker symbol ID, builtin registry key,
declaration file identity, and compiler revision. A local object named
`console` with a method named `log` has different declaration identities and
remains effect-free. The TypeScript reference adapter independently emits the
same effect/builtin/span tuple; metadata drift fails parity even when the
normalized effect set would otherwise match.
The next application-backed builtin slice recognizes named `readFile` and
`writeFile` imports only from the exact `node:fs/promises` module and recognizes
global `fetch` only through a standard DOM/Worker declaration. It emits
`FsRead`, `FsWrite`, and `Fetch` with ordered operation spans and builtin keys.
For the Node imports, the current Corsa API does not expose an aliased target
declaration node, so evidence binds the checker symbol to the exact source
import specifier and module/export pair; it does not claim identity with the
underlying `@types/node` declaration. Same-spelled local declarations and
local-module imports remain effect-free. Tampering with the module/export atom
sets `checkerMetadataEquivalent` to false.
The Workhub directory/archive extension uses the same exact named-import
identity rule for `access` and `readdir` as `FsRead`, and for `appendFile` and
`mkdir` as `FsWrite`. Ordered evidence retains all four operations even though
the normalized function effect set contains only two atoms. Same-spelled local
bindings and local-module imports remain effect-free, and builtin-key tampering
fails metadata parity. Sync `node:fs`, namespace/default/CommonJS forms,
`copyFile`'s compound read/write semantics, other operations, and path-scope
inference remain outside this slice.
The dynamic-import extension recognizes exactly one function-local immutable
shorthand object-destructuring binding from direct
`await import("node:fs/promises")`. Both frontends bind `readFile` to `FsRead`;
Corsa also emits the import expression itself as an `await` observation with
its exact source and project UTF-8 span. Renamed, namespace, non-literal,
mutable, multi-binding, and other-module forms remain unsupported. This is not
a model of ESM initialization, host resolution, or a dynamic module graph.
The completed direct-await slice additionally emits source-ordered Promise records
when a resolved call is the direct operand of an `await` in the exported owner.
Each record binds the numeric owner, exact source text, UTF-8 call span, and
`observation: "await"`. Unconditional calls have an explicit empty control
path. The completed application-backed extension admits exactly one enclosing
`if` then/else branch and binds its owner-local file-offset condition ID
and branch polarity into one singleton control path. The Workhub-shaped corpora
reach full semantic parity for these exact families. Nested conditionals and
awaits under loop ownership remain omitted, which makes checker Promise
evidence differ instead of flattening path semantics.
The direct caught-await extension additionally marks `catchesRejection: true`
when the awaited call is lexically inside the protected block of exactly one
`try` with a `catch`. One optional enclosing `if` retains its existing control
path. Awaits in catch/finally, nested try regions, and nested functions remain
omitted rather than receiving invented rejection ownership.
Nested function and callback awaits are not attributed to the outer owner, and
source/span/owner tampering fails metadata parity.
The direct-return extension emits `observation: "return"` only when an
unconditional returned expression is a checker-resolved call whose selected
signature returns explicit `Promise<T>`/`PromiseLike<T>`, or when that call has
one `as Promise<T>` wrapper. Its source and project UTF-8 span cover the full
returned expression, including the assertion. Conditional returns, bare
Promise identifiers, and nested assertions remain omitted and therefore fail
Promise-evidence parity. Promise comparison now includes every observation
kind instead of filtering to `await`, so omitted return evidence cannot hide
behind semantic projection.
Calls outside the exported project symbol set are not emitted. Traversal stops
at unsupported nested function and callback boundaries, so their work is not
misreported as an immediate call by the outer function; comparison with a
reference edge then fails rather than claiming parity. Other Console methods
and filesystem/fetch or dynamic-import forms outside those exact slices, path/URL/method scope
inference, broader catch/conditional Promise observations, rejection-binding ownership,
Promise chains/combinators, resource records, computed or polymorphically
dispatched methods, nested callbacks, method/generic overload edge cases, and
callback timing are not
checker-exported yet. An explicitly
annotated computed method produces a coverage failure even if both projections
would otherwise be empty. Using those constructs therefore cannot establish
full frontend parity. Install compatible
`corsa-oxlint`, `oxlint`, and `@oxlint/plugins` peers and supply a real Corsa or
`tsgo` executable. The package does not silently fall back to TypeScript facts.
`requireCorsaCheckerFacts` accepts only the object returned by the in-process
exporter. A cloned, deserialized, or hand-written object carrying the same
provenance strings is rejected as unauthenticated. Persisted checker facts do
not yet have a signed evidence format and cannot satisfy this gate.

### Direct Corsa API migration probe

The same optional entry point exposes `openCorsaApiFrontend`. It loads the
prebuilt `@corsa-bind/napi` binding and opens a pinned Corsa/tsgo worker, without
constructing a JavaScript TypeScript `Program`:

```ts
import { openCorsaApiFrontend } from "@mizchi/uneffect/corsa/api";

const frontend = await openCorsaApiFrontend({
  configFile: "/workspace/tsconfig.json",
});
try {
  const symbol = frontend.getSymbolAtPosition("/workspace/src/index.ts", 120);
  const type = frontend.getTypeAtPosition("/workspace/src/index.ts", 120);
} finally {
  frontend.close();
}
```

`corsaExecutable` is optional. By default it resolves the fixed
`@typescript/native-preview` prebuilt owned by Uneffect, rather than a
consumer-local `typescript` package or a PATH-global compiler. Pass an explicit
path when the application must select compiler provenance. The regular
Uneffect CLI still requires the JavaScript TypeScript 6 peer; that peer is
optional at package-install time so a `/corsa/api`-only consumer does not have
to install it.

The first checker-backed effect-resolution slice is deliberately small.
`classifyBuiltinCall` authenticates global `fetch` as `Fetch`, and a member of
the checker-resolved global `console` object as `Console`. Same-spelled local
parameters fail closed. A re-exported `node:fs/promises` alias currently also
fails closed: Corsa 1.12.4 exposes immediate/full alias relations through its
generic JSON endpoint, but the exercised two-hop re-export reaches the
immediate bridge symbol and then Corsa's `unknown` symbol. This is covered by a
negative test and is not reported as `FsRead`.

This probe supports project-root membership checks, symbol identity, normalized
type text, batched symbol/type queries, and bounded alias traversal. Both the Corsa implementation and a
TypeScript reference implementation satisfy the small `SemanticQueryFrontend`
contract, and parity tests compare position queries without comparing
compiler-private handle values. It is a realistic partial replacement for
the TypeScript 6 checker calls used by Uneffect's resolver. It is not yet a
replacement for syntax enumeration, parent/child traversal, TypeScript CFG,
node-kind guards, or source transforms: Corsa's public Node API accepts source
positions but does not expose a whole-project AST iterator. During migration,
syntax can therefore remain on a parser-compatible layer while semantic queries
move behind this adapter. The N-API package and compiler are exact optional
dependencies with platform prebuilds; the default compiler executable does not
load or mutate the consuming application's TypeScript installation.
The isolated `/corsa/api` subpath does not statically load the Oxlint exporter
or the JavaScript TypeScript compiler package.

On the 2026-09-03 local migration benchmark, opening the direct API frontend
and querying one symbol and type took 75.98 ms mean (7 samples). The existing
temporary-project Oxlint exporter took 757–1,031 ms for its one-sample fixtures,
so the probe was roughly 10–14x faster. These figures measure different amounts
of work and establish startup feasibility, not complete semantic parity.

The result supports a staged architecture, not a complete frontend switch:
keep TypeScript AST syntax enumeration, move authenticated position-based
checker queries behind the semantic frontend, validate the existing
alias/signature/property relations against real code, and replace syntax traversal separately.
The prebuilt compiler isolates compiler installation and startup; it does not
by itself remove the TypeScript AST dependency from the main analyzer.

Schema v8 has one `fileId`, so both adapters use a deterministic virtual-project
coordinate instead of mixing file-local offsets: source files are ordered by
file name, encoded as UTF-8, and separated by one byte. Every symbol, trivia,
call, Promise, and resource offset is projected into that coordinate. This
makes spans unique and ordered across files without pretending that unrelated
file-local offsets share a source buffer.

TypeScript Go's Content Mapper facility is deliberately not treated as this
frontend API. Content Mappers run an external process for otherwise unsupported
file extensions, return generated TypeScript plus source-span mappings, and do
not expose the checker graph for ordinary `.ts` input. The intended native path
is instead the `corsa-bind` type-aware Oxlint bridge: it collects compact node,
type-text, property-name, and symbol facts from a pinned Corsa checker and sends
them to Rust native rules. Expanding the implemented schema-v8 exporter from
the restricted slice above to the whole neutral IR remains the P6 production
integration task. Content Mappers may later project an Uneffect
foreign file format, but are neither required nor sufficient for TypeScript
semantic parity.

## TypeScript reference frontend

`buildProgramCallGraph` is the executable reference adapter. It resolves multi-file aliases and re-exports through `ts.Symbol`, maps methods, variable arrows, function expressions, overload selections, and callbacks to stable source IDs, and records callback timing. `analyzeProgramEffects` propagates effects across these edges. The CLI uses this program-wide path.

Function-typed parameters are effect parameters. Direct invocation is inline; known array combinators are inline; timers/microtasks are deferred; unsupported consumers are `unknown`. Instantiation substitutes the callback's effects and reports whether suspension is introduced. Unknown timing keeps lint information but produces unknown evidence and cannot authorize optimization.

## Published surfaces

The contract layers — CLI surface, evidence schema, builtin registry, Corsa JSON schema, optimizer obligations, and Rust crate — are versioned at `0.3.0`, which is what an evidence artifact records as `uneffectVersion`. The npm package and Rust crate use the same release version. `just package-check` executes npm and Cargo package dry-runs. Runtime implementations may be regenerated, but these contract layers require a version bump when changed incompatibly.

## CI tiers

The workflow separates unit/build/package checks, Z3 obligations, Quint safety simulations with negative controls, and exhaustive Apalache verification. The exhaustive tier installs Java explicitly; local environments without Java still run every other tier. Hoare, ownership, temporal semantic/reachability/counterexample, property-generation, and typed-array SMT-LIB checks can use an optional native Z3 process and otherwise fall back to `z3-solver` WASM. CI forces WASM in the dedicated Z3 tier and forces an installed native Z3 in the solver-heavy integration tier, retaining fallback coverage without sending large telemetry proofs into the WASM 2 GiB ceiling. The JVM appears only in the deliberately redundant Apalache and TLC checks described in [formal models](./formal-models.md).
