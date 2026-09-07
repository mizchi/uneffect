# Corsa/Oxc migration

The target is to remove the JavaScript TypeScript compiler from production
analysis. Oxc owns syntax; Corsa owns authenticated symbols and types. The
implementation remains TypeScript. The native TypeScript compiler used by
Corsa and the development compiler are separate from the JavaScript
`@typescript/typescript6` dependency being removed.

See the [TypeScript 7 / Corsa migration plan](./typescript7-migration-plan.md)
for the current inventory, implementation order, API compatibility decisions,
and full-migration acceptance gates. This document records available APIs.

## Available without the JavaScript compiler

| Entry or command | Implementation |
| --- | --- |
| `/cfg`, `/workflow`, `/impact` | Language-independent graph contracts and solvers. |
| `/corsa/api` | Native Corsa semantic queries. |
| `/experimental/corsa/callables` | Native overload selection, generic substitution, constructor results, inferred declaration returns, complete overload sets, assignability, shorthand value symbols, exact expression types, intrinsic never/boolean-literal facts, and snapshot diagnostics. |
| `/experimental/lint` | Source-independent prerequisite analysis. |
| `/experimental/lint/corsa`, `cfg-lint` | Oxc CFG extraction and Corsa symbol/type queries, with native diagnostics. |
| `/experimental/module-order/corsa`, `module-order` | Oxc module facts and Corsa import/boolean identities, native diagnostics, shared v1 ordering and v2 conditional-await CFG proof. |
| `/spec` | Definition helpers, separated from DSL parsing and linking. |
| `/experimental/spec` | Oxc specification and temporal-expression parsing, scalar contract expressions, SMT/Quint generation, temporal composition, specification lint, four DSL source parsers, native contract/refinement callable linking, property-test generation/execution, and structural/native-refined contract completion analysis. |
| `/experimental/build/corsa` | Bounded native JS/d.ts re-emission comparison for single projects and reference workspaces in dependency order; compiler/input digests, explicit outDir, no writes to consumer outputs. |
| `/experimental/workspace/corsa` | Bind supplied summaries to authenticated direct import calls using native declarations and build-output checks. Claims remain trusted; body and caller-precondition proofs are not performed. |
| `/experimental/instrument`, `instrument` (without ownership options) | Oxc parameter assertion insertion with restricted Valibot schema expressions. |
| `spec ir`, `spec lint`, `spec z3`, `spec quint`, `spec compose` | Specification analysis through the Oxc path. Z3-backed lint still needs its solver. |

The default `check` command already uses the bounded Corsa/Oxc frontend.
Explicit Program/parity options, contract/resource summaries, declaration
transforms, module-entry/build assurance options, and project references select
the compatibility Program implementation. Source annotations alone do not select
it. Native check now proves the [bounded Boolean/constant-return body fragment](./corsa-contract-bodies.md)
and reports other contract candidates as unsupported; ownership, typed-array, and
resource outputs remain empty. `spec temporal` also retains the compatibility implementation
for JavaScript async/resource observations.

```ts
import { parseSpec, generateQuint } from "@mizchi/uneffect/experimental/spec"

const specification = parseSpec("protocol.ts", source)
const quint = generateQuint("protocol", specification.temporal)
```

These parsing and generation APIs do not certify implementation bodies or
add checker evidence. Existing declared temporal summaries remain trusted
contracts with the existing composition limits. Generating SMT is distinct
from discharging an obligation.

## Boundaries established by this migration

- `frontends/oxc/source.ts` owns validated syntax, declaration-leading comments,
  export spans, child traversal, and UTF-16 positions, including CRLF and Unicode.
- `frontends/oxc/dsl.ts` owns static property/import parsing and restricted DSL
  callbacks. All four DSL source modules have no Program imports;
  the existing adapters retain their optional checker authentication.
- `frontends/oxc/expression.ts` accepts exactly one expression and rejects source
  that escapes the synthetic parser wrapper.
- `contracts/logic-contracts.ts` owns scalar and obligation types without AST or
  checker objects. `logic.ts` parses restricted scalar expressions through Oxc;
  `obligations.ts` constructs stable obligation identities and emits SMT.
- `contracts/control-flow-contracts.ts` defines AST-independent statement/expression
  views and structural endpoint results. `control-flow-core.ts` composes the shared
  CFG completion algebra; Oxc and Program adapters only read syntax. The Program
  adapter preserves original node identity for checker callbacks.
- `modules/module-order-core.ts` owns dependency ordering and cycle evidence;
  `module-order-control-flow.ts` owns the bounded conditional-await proof. Both
  accept neutral source facts shared by the legacy and native adapters.
- `evidence/status.ts` owns the shared evidence-status contract without importing
  an effect analyzer.
- `contracts/verification-contracts.ts` owns neutral artifact and diagnostic types;
  `contract-solver.ts` discharges obligations for both Program and native lowerers.
- `invariant-ir.ts` retains the Program-specific lowering and compatibility
  re-exports. Existing public declarations and obligation IDs remain unchanged.

Parser recovery is an error. Temporal optional chaining, async/default/rest
lambda parameters, prototype setters, and extra declarations in expression or
type inputs are rejected because their semantics are absent from the IR. Some
of these were silently accepted by the former parser; they are deliberate
corrections rather than expanded proof support.

## Remaining migration

At `97c50e4c`, 64 source files refer directly to `@typescript/typescript6`:
63 have runtime imports or lazy requires, and one contains catalog metadata.
There are no files with only type imports. These are direct-reference counts,
not per-entry load counts. The aggregate root and `/experimental` APIs still
load legacy analyzers, so importing a new independent entry is necessary when
the JavaScript compiler is absent.

The next domains are:

1. Freeze feature acceptance and define the replacement for public Program APIs.
2. Close known TSX, exhaustive-switch, and arbitrary-awaited-type gaps; expose
   the neutral native facts required by existing analyzers.
3. Move contract body lowering and effect/call-graph propagation, followed by
   ownership/resources, async, typed arrays, refinement, and proof consumers.
4. Integrate native proof producers and consumers with workspace module
   composition, build assurance, summaries, and transformation evidence.
   Native build inspection and trusted summary binding already exist.
5. Switch the aggregate APIs and all supported CLI modes, isolate compatibility
   tooling, then remove the TypeScript 6 peer and remaining production imports.

Do not replace missing semantic evidence with name matching, silently fall back
to the JavaScript compiler, or remove an existing checker before its supported
fragment and negative controls have migrated.

## Verification

`just spec-frontend-check` covers the frozen pre-migration specification,
expression, type, scalar-contract, obligation-ID, SMT, and Quint outputs, plus
unsupported-input regressions. The frozen data is in
`test/fixtures/oxc-spec-parity.json`; do not regenerate it from the new parser.

The CLI regression blocks both JavaScript TypeScript package imports and runs
`ir`, `quint`, `compose`, and `z3`. Installed-package smoke tests repeat that
check for the published `/experimental/spec` entry. Existing contract/Z3 and
temporal/Quint tests validate solver results separately from generation parity.

`just module-order-check` compares native and Program artifacts for imports,
cycles, top-level await, Promise launches, and conditional CFG proofs. The CLI
and new async entry use Corsa/Oxc; `/module-order` retains its synchronous
`ts.Program` contract. Native compiler version and option digest are recorded
as native metadata, so those fields intentionally differ from Program output.
`--project` selects consumer compiler options; without it, `module-order` uses
ES2024/NodeNext and no ambient package types. Native errors retain
`typescript-error` evidence, with point spans because native diagnostics do not
provide token lengths. Missing tools, invalid syntax rejected by Oxc, and files
outside the project fail the command rather than produce a positive artifact.

## Typed DSL source and identity APIs

`/experimental/spec` also exports `parseTemporalDsl`, `parseContractDsl`,
`resolveTemporalDslSourceLink`, and `prepareContractDslSources`. These interpret
trusted declarative source; source linking alone does not authenticate helper
imports or prove that an implementation matches a contract. Clause text, order,
and UTF-16 provenance are covered by the frozen pre-migration
`test/fixtures/oxc-dsl-parity.json` fixture.

`validateCorsaDslHelperIdentities(frontend, fileName, source, kind)` authenticates
`"temporal"` or `"contract"` value-import helpers using Corsa alias targets and
this package's actual authoring declaration paths. Matching a helper name or
file basename is insufficient. The caller supplies an open Corsa snapshot and
matching source text. This narrow check does not run compiler diagnostics or
validate contract implementation signatures; those remain a separate boundary.

`prepareCorsaContractDslLinks({ configFile, files, ...frontendOptions })` performs
that boundary through `/experimental/spec`. It checks exact source text against
one Corsa snapshot, authenticates helpers and numeric brands, and matches the
implementation's parameter names and numeric/boolean domains to the DSL. Native
intrinsic type identity after literal widening identifies number/boolean;
`Nat`/`Float` require this package's runtime declaration or its verifier's owned
package contract. Same-named types in unrelated modules are rejected. All
project diagnostics are checked on the same snapshot, and `noCheck` projects
are rejected. The result retains generated clauses and source provenance; this
does not prove that the implementation satisfies those clauses.

The native and Program adapters share Oxc function attachment/parameter checks
and domain comparison. Program consumers in the main verifier still perform
body analysis through the legacy compiler. `just corsa-contract-check` tests
native linking, type/identity failures, source drift, and compiler-free loading;
the package smoke repeats linking against installed declarations.

DSL parsing rejects async callbacks, default/rest/renamed destructuring,
optional helper calls, type-only helpers used as values, duplicate/static-key
violations, prototype setters, and unknown contract sections. Text that can escape a generated
annotation comment is rejected. Exported type declarations remain supported.
The legacy Program API consumes the same Oxc parser and retains its signature
and helper checks. `just spec-frontend-check` covers the new paths and an
installed-package probe exercises them with JavaScript compiler imports blocked.

Capability and refinement source APIs now use the same Oxc boundary:
`parseCapabilityDsl`, `parseCapabilityDslWithSchemas`,
`prepareCapabilityDslSources`, `parseRefinementDsl`, and
`resolveRefinementDslSourceLink`. Local Effect schemas and their generated
annotations remain project-local; refinement callable names, projections, runtime
identities, and v1 binding manifests retain their shapes. Binding manifest types
live in `refinement/binding-contracts.ts`, without importing body analyzers.

Corsa helper authentication also accepts `"capability"` and `"refinement"`.
It authenticates authoring helpers, not the user callables referenced by a
refinement definition. Source APIs alone make no callable or body proof claim.
`test/fixtures/oxc-capability-refinement-parity.json` freezes the former parser's
outputs, including schema maps serialized as entry arrays. Optional helpers,
recovered syntax, duplicate bindings, unknown schema fields, and annotation
escapes are rejected. Builtin literal atoms containing ` | ` remain whole.

`resolveCorsaRefinementDslLink({ configFile, implementationFile, files })` checks
refinement callables in one native snapshot and returns the existing v1 binding
manifest. It requires exactly one signature per callable and a runtime parameter;
`create` input/result, `observe`, actions, and invariants must agree through
bidirectional native assignability. Invariant results must be boolean. Helpers
must belong to this package, and callable alias targets must be declared in the
attached implementation. Barrel imports are followed; re-exporting a foreign
declaration from the implementation does not establish that origin.

Oxc callable locations and Runtime compatibility rules are shared with the
Program adapter. For shorthand properties, `getShorthandAssignmentValueSymbol`
uses the native property node identity to distinguish the referenced function
from its object property. Assignability rejects type facts from another snapshot.
Both source files must match the native snapshot; native project diagnostics are
checked and `noCheck` is rejected. These checks preserve structural compatibility,
not action/invariant body proofs, projection correctness, or runtime validation.
Those main verifier consumers still retain their Program implementations.
`just corsa-refinement-check` covers parity, mismatched Runtime shapes, overloads,
foreign origins, aliases, helper impostors, and JavaScript-compiler-blocked use.

## Runtime parameter assertions

`/experimental/instrument` exports `instrumentRuntimeAssertions` and its result
and diagnostic types. The default `instrument` CLI loads this Oxc transform;
ownership flags explicitly load the existing semantic analyzer and solver.
The compatibility aggregate API re-exports the same implementation.

The transform preserves original source slices, handles exported/anonymous and
ambient declarations, and places inserted code after directive prologues and
the hashbang. It selects an unused namespace identifier and rewrites only AST
references to `v`, leaving schema string literals unchanged. Recovered syntax,
expression-wrapper escapes, optional/computed schema calls, prototype access,
callbacks, and spreads are rejected. It does not certify function bodies or
resolve the authoring namespace by checker identity: these are explicitly
declared runtime schemas. Generated source requires Valibot when executed.

`just instrument-check` compares `test/fixtures/oxc-instrument-parity.json`
(frozen TypeScript 6 output), checks unsupported cases, executes generated
checks on accepted/rejected values, and verifies legacy ownership proof/cache
behavior. Import-blocked child processes and installed-package smoke tests
exercise the independent API and default CLI.

## Native callable signatures

The earlier inventory identified missing **named binding methods**, not missing
native compiler functionality. TypeScript 7.0.2 already serves signature
queries, and Corsa 1.13.1 can carry them through `callJson`.
`/experimental/corsa/callables` isolates these requests behind typed methods:

```ts
import { openCorsaCallableFrontend } from "@mizchi/uneffect/experimental/corsa/callables"

const frontend = await openCorsaCallableFrontend({ configFile: "tsconfig.json" })
try {
  const signature = frontend.getResolvedSignature(fileName, callSpan, source)
  // signature?.declaration, .parameters, .returnType
} finally {
  frontend.close()
}
```

`getResolvedSignature` accepts the full Oxc call/new range and matching snapshot
source. It returns the native-selected overload with instantiated parameter and
return types. `getSignatureFromDeclaration` accepts function declarations
(including export modifiers), function expressions, and arrows; inferred
results are supported. `getSignaturesOfTypeAtPosition` returns all signatures
for a call or construct type; it does not select an overload by array order.

The native numeric handles stay scoped to the owning snapshot. Parameter
sub-property queries register the instantiated symbol handles before type
lookup. A small protocol-5 decoder indexes native node IDs and declaration
locations; Oxc still interprets syntax. It checks section bounds, node kinds,
paths, and UTF-16 spans, and rejects unsupported protocol versions and stale
source. It reads UTF-8 source strictly; unsupported WTF-8 lone-surrogate bytes
fail rather than changing source coordinates. No JavaScript compiler, AST enum
import, display-string overload inference, or name-based declaration matching
is involved.

These are resolution facts, **not well-typedness or body proofs**. Call
`getProjectDiagnostics()` before relying on them: it obtains configuration,
program, global, syntax, and semantic diagnostics from the owning snapshot and
rejects `noCheck`. `getPrimitiveTypeKind`, `getTypeAliasSymbol`, and symbol queries
let consumers check intrinsic and declaration identity without printed-type
inference. Type and symbol query inputs must belong to the same frontend. Native
recovery/`any` signatures with no declaration return `null`. Existing main
analyzers have not yet been switched to this API, and `/corsa/api`'s v1
descriptor remains unchanged.

`just corsa-callable-check` compares native facts against TypeScript 6 for
overloads, generic substitution, async functions, constructors, arrows, and
shadowing, then tests imported declarations, malformed binary data, source
drift, invalid ranges, and compiler-import-blocked execution. Installed-package
smoke tests repeat overloaded resolution through the new entrypoint.

The wire contract is pinned to the upstream
[7.0.2 signature endpoints](https://github.com/microsoft/typescript-go/blob/typescript/v7.0.2/internal/api/proto.go),
[binary layout](https://github.com/microsoft/typescript-go/blob/typescript/v7.0.2/_packages/native-preview/src/api/node/protocol.ts),
and [native node kinds](https://github.com/microsoft/typescript-go/blob/typescript/v7.0.2/internal/ast/kind_generated.go).
The remaining work is migrating the Program consumers onto these facts while
retaining their diagnostic, call-effect, and proof boundaries.

## Property tests and diagnostic rendering

`generateUneffectPropertyTests`, `generateUneffectPropertyTestsWithZ3`, and
`checkUneffectProperty` retain their existing signatures and are also exported
from `/experimental/spec`. Generator domains, source annotations, structured
expressions, and the SMT conversion now use Oxc. Integer/literal-union, nested
record, optional-field, bounded array/set/map, hint, shrinking, and replay
behavior is preserved. These are generated runtime tests and finite input
models, not a proof of the implementation or checker authentication of a
spelled generator-domain type.

Source-local predicates remain explicit exported unary declarations. Directly
imported predicates use Corsa symbols and native declaration spans, with original
source text checked against the snapshot. A private temporary project represents
the supplied file map; caller files are never overwritten. Only selected source
declarations are admitted. Barrel/default/namespace/type-only imports, dynamic
aliases, and ambiguous overloads remain unsupported. This synchronous identity
query opens Corsa lazily and closes it on success or failure; ordinary generators
and property execution need no native compiler. It checks identity, not compiler
diagnostics or predicate-body correctness: the generated test invokes the real
predicate and rejects a specialization with no valid candidates.

`just property-frontend-check` checks frozen pre-migration generated text and
metadata in `test/fixtures/oxc-property-parity.json`, rejects recovered syntax,
expression-wrapper escapes and optional chaining, and blocks JavaScript compiler
imports. The existing property-test/Z3 suite covers execution, shrinking, replay
and solver tuples; the installed-package smoke repeats generation with compiler
imports blocked. Diagnostics now render structural compiler data without an AST
method or compiler import, preserving nested message indentation and UTF-16 line
attribution, including offsets inside CRLF.

## Contract completion analysis

`analyzeOxcContractControlFlow(fileName, text)` in `/experimental/spec` reports
exits and possible fallthrough for named, body-bearing top-level function
declarations. Spans include export modifiers and use UTF-16 offsets. Parsing
errors are rejected. Each result explicitly carries `evidence: "structural"`;
this API does not infer `never`, authenticate literal types, certify return
values, or enumerate methods, closures, and anonymous declarations.

The shared completion engine preserves loop transfer ownership, switch
fallthrough, conservative catch reachability, and finally precedence. Unsupported
expression effects and uncertain loop conditions remain conservative; source-only
results do not substitute for Corsa semantic facts or contract body proofs.
Optional calls and logical assignments cannot make skipped `never` calls into
mandatory exits. Parentheses ending an optional chain preserve eager argument
and computed-key evaluation.

`just contract-flow-check` compares both adapters with 71 frozen pre-migration
cases, checks conditional-call regressions and original Program node identity,
and runs the source facade with JavaScript compiler loading forbidden.
`just package-check` exercises the packed API under the same import restriction.
The legacy contract instrumenter and checker bridge still use Program semantic
callbacks; moving their syntax views does not remove that remaining dependency.


`analyzeCorsaContractControlFlow({ configFile, files })` refines the same rules
with resolved native call signatures and boolean literal types. `files` must
contain the exact text present in the configured project. It checks all project
diagnostics (including imported files), rejects `noCheck`, parser recovery and
source mismatch, then reports both structural and refined exits for each named
top-level function. Any project type error prevents endpoint results, including
return-coverage diagnostics when enabled in that project's configuration.

Results carry `evidence: "structural-with-corsa-types"`, the compiler revision,
and a source SHA-256 digest. This is checker-assisted structural analysis, not
native internal-CFG evidence or proof of contract predicates. Existing contract
instrumentation and full body verification still retain their Program path.

The callable frontend's `getExpressionType` matches complete Oxc ranges to
native protocol-5 nodes before querying `getTypeAtLocation`; querying the first
identifier would conflate `enabled` with `enabled && widened`. Unsupported
expression kinds yield no fact. `isNeverType` uses native intrinsic identity,
and `getBooleanLiteralValue` reads the native literal payload. Display strings,
cloned facts, foreign snapshots, and closed frontends cannot supply semantic
facts. Parsed Oxc sources are reused within a snapshot.

`just contract-flow-check` includes native/checker parity for direct, overloaded,
generic, shadowed and optional calls; literal, member, computed, compound and
narrowed boolean expressions; imported aliases; diagnostics and snapshot rejection.
The installed-package smoke runs native refinement with JS compiler imports
forbidden as well as the source-only analysis.


## Awaited types and native emission gates

`just corsa-migration-gates` exercises actual awaited-expression types, malformed
and recursive thenables, isolated native emission, stale/missing/modified outputs,
NodeNext package metadata, and a referenced producer's declaration tampering.
`getAwaitedExpressionType` on `/experimental/corsa/callables` accepts a complete
AwaitExpression range. It compares with the old checker's `getAwaitedType` for
plain values, Promise/PromiseLike, nested promises, unions, any/unknown/never,
non-callable then members, disposable resources, and generic/constrained inputs.
A missing await range returns no fact. Project diagnostics must be checked before
using a returned type: invalid thenables may otherwise produce recovery types.
This does not add the unavailable native `getAwaitedType(type)` RPC.

`inspectCorsaBuildOutputs({ configFile })` in `/experimental/build/corsa` compares
native re-emission with the configured JS and d.ts files. It emits into a private
temporary directory, redirects incremental build state there, and leaves consumer
outputs intact. The staged config fixes the original root-file list, preserves
relative config paths and default type roots, and checks resolved input membership
before emitting; redirected outDir cannot pull old dist declarations into analysis.
It records the executable digest/version and a digest of effective
config, selected input bytes, and ancestor package.json files (including absence).
Detected compiler/input changes fail closed; quiescent inputs are required because
this is not an atomic filesystem snapshot.

The gate is pinned to native 7.0.2; other compiler versions are rejected until
the emission corpus is checked against them. The admitted domain requires an explicit outDir and runtime JS emission. Separate
declarationDir and ordinary source/declaration maps are accepted, but map files are
not compared. References, noCheck, noEmit, declaration-only emission, outFile,
inlineSourceMap and mapRoot are rejected. `verified` means the selected JS/d.ts
bytes match this native compiler; it does not establish producer identity, map
integrity, build freshness, workspace composition, or equality to every TS6 emit.
It is not wired into the high-level workspace assurance flags yet.

The separate `inspectCorsaWorkspaceBuildOutputs` API handles references in
dependency order, invalidates consumers of failed producers, and rechecks inputs
and outputs after inspecting all projects. The standalone API above still rejects
references. See [native build outputs](./corsa-build-outputs.md) for the shared
emit restrictions and evidence boundary.

`composeCorsaWorkspaceSummaries` uses that workspace check and native declaration
identity to bind supplied claims to selected direct import calls. It does not
generate or prove those claims, discharge caller preconditions, or replace the
high-level workspace checker. See [workspace summary binding](./corsa-workspace-summaries.md).

## First native contract body proofs

Default check now lowers synchronous, single-return top-level functions with
Boolean parameters or safe integer constants into neutral obligations. Native
signature identity and project diagnostics precede solver execution. The result
contains solver artifacts, counterexamples, or explicit unsupported diagnostics;
the CLI JSON and exit status include them. Effect summaries remain independent.

`just corsa-body-check` compares the frozen Program outputs and negative controls.
See [native contract bodies](./corsa-contract-bodies.md) for the exact syntax and
evidence boundary, and the [migration matrix](./compiler-migration-matrix.md) for
all package exports and CLI modes. Call summary generation/composition, numeric
parameter semantics, and full body lowering remain subsequent work.
