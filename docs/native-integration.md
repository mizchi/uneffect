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
The completed direct-await slice additionally emits source-ordered Promise records
when a resolved call is the direct operand of an `await` in the exported owner.
Each record binds the numeric owner, exact source text, UTF-8 call span, and
`observation: "await"`. Unconditional calls have an explicit empty control
path. The active application-backed extension admits exactly one enclosing
`if` then/else branch and binds its owner-local file-offset condition ID
and branch polarity into one singleton control path. The Workhub-shaped corpora
reach full semantic parity for these exact families. Nested conditionals and
awaits under loop/catch ownership remain omitted, which makes checker Promise
evidence differ instead of flattening path semantics.
Nested function and callback awaits are not attributed to the outer owner, and
source/span/owner tampering fails metadata parity.
Calls outside the exported project symbol set are not emitted. Traversal stops
at unsupported nested function and callback boundaries, so their work is not
misreported as an immediate call by the outer function; comparison with a
reference edge then fails rather than claiming parity. Other Console methods
and filesystem/fetch forms outside that exact slice, path/URL/method scope
inference, return/catch/conditional Promise observations, rejection ownership,
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

The contract layers — CLI surface, evidence schema, builtin registry, Corsa JSON schema, optimizer obligations, and Rust crate — are versioned at `0.1.0`, which is what an evidence artifact records as `uneffectVersion`. The npm package itself is published separately (`uneffect --version` reports it) and is still on a `0.0.0-alpha` line. `just package-check` executes npm and Cargo package dry-runs. Runtime implementations may be regenerated, but these contract layers require a version bump when changed incompatibly.

## CI tiers

The workflow separates unit/build/package checks, Z3 obligations, Quint safety simulations with negative controls, and exhaustive Apalache verification. The exhaustive tier installs Java explicitly; local environments without Java still run every other tier. Hoare, ownership, temporal semantic/reachability/counterexample, property-generation, and typed-array SMT-LIB checks can use an optional native Z3 process and otherwise fall back to `z3-solver` WASM. CI forces WASM in the dedicated Z3 tier and forces an installed native Z3 in the solver-heavy integration tier, retaining fallback coverage without sending large telemetry proofs into the WASM 2 GiB ceiling. The JVM appears only in the deliberately redundant Apalache and TLC checks described in [formal models](./formal-models.md).
