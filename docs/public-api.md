# Public API and compatibility

This document defines the intended package surface as of Uneffect 0.3.0. The
project is still pre-1.0: pin the exact version in verification workflows and
read emitted exclusions together with every result.

The default 0.3 check frontend uses the pinned TypeScript 7 native compiler
through Corsa plus Oxc. The explicit `--typescript-program` compatibility path
uses the separately pinned TypeScript 6 compiler API package for proof domains
that have not moved to the native frontend yet.

## Package entrypoints

| Import path | Status | Intended use |
| --- | --- | --- |
| `@mizchi/uneffect` | Public | Small, durable helper and high-level verification facades listed below. It intentionally excludes backend and lowering internals. |
| `@mizchi/uneffect/corsa` | Public integration boundary | Versioned Corsa/tsgo fact export. Pin the package and frontend versions. |
| `@mizchi/uneffect/corsa/api` | Public integration boundary | Versioned direct Corsa semantic queries without constructing a JavaScript TypeScript `Program`. The `uneffect-corsa-api-frontend/v1` descriptor lists the active capabilities and limitations; syntax/CFG parity is not claimed. |
| `@mizchi/uneffect/experimental` | Experimental | The complete research API, including low-level IR, solver, CFG, async, Promise, event-loop, resource, and Quint operations. Names, options, and generated text may change without notice. |
| `@mizchi/uneffect/spec` | Initial public authoring fragment | Type-checked, declarative `*.uneffect.ts` temporal, capability, and Hoare-contract specifications. Uneffect parses these modules but does not execute them. |
| `@mizchi/uneffect/schemas/*` | Versioned data contract | Published JSON schemas. Compatibility follows the schema identifier, not an unversioned TypeScript implementation detail. |
| `@mizchi/uneffect/package.json` | Public metadata | Exact package version and package metadata. |

Do not import unpublished paths such as `dist/src/async-patterns.js`. Package
exports intentionally block those implementation paths.

The release package probe runs the real `prepack` lifecycle, installs the
resulting tarball into a fresh Node 24 project, type-checks the public root,
Corsa, Corsa API, spec, and versioned-schema imports with TypeScript 6, and
executes their supported runtime slices. It also confirms that low-level CFG,
Promise/resource lowering, solver, and direct Quint helpers are present only on
the experimental subpath. The exact tarball contents and SHA-256 digest are
retained as `uneffect.package-evidence/v1` CI evidence.

## Why the root API is deliberately small

The roadmap replaces several current internal representations: the
backend-neutral specification AST, TypeScript CFG lowering, Corsa facts,
resource/Promise composition, and Quint projections. Exporting those pieces
from the package root would make the implementation harder to correct without
breaking consumers. Version 0.3 therefore exposes contracts that can remain as
facades while those representations change:

| Root API family | Public contract |
| --- | --- |
| Numeric and bounded-container helpers | Branded `Int`, `Nat`, `Float`, `U8`, `U32`, `I32`, `F32`, bounded buffer/view/Set/Map types, their parsers, schemas, constants, and explicit machine coercions. |
| Effect tracking and primary checking | `analyzeEffects`, `analyzeEffectsInProgram`, `analyzeProgramEffects`, Effect-set parse/format/containment operations, `checkFiles`, `verifyUneffectProject`, `verifyContracts`, typed-array verification facades, and the versioned inferred-effect baseline helpers. Effect tracking is a first-class public capability, not an experimental backend detail. |
| Temporal checking | `generateTemporalModel` and `parseTemporalModelResult`; the versioned result and its explicit exclusions are the contract, not generated Quint text. |
| Test generation | `checkUneffectProperty`, `generateUneffectPropertyTests`, and `generateUneffectPropertyTestsWithZ3` for the documented bounded fragment. |
| Gradual extension | custom validators, effect-schema registration, module manifests, builtin registry configuration, and versioned contract-summary bundles. |
| Runtime boundary | contract predicate instrumentation and `isContractRuntimeError`. Runtime instrumentation remains opt-in. |
| Security analysis | `analyzeTrustedScriptSinks` for the documented Trusted Types fragment. |

Types associated with these functions are exported from the same root. The CLI
is the preferred integration surface when no in-process API is required.

The package root no longer exports raw SMT conversion, direct Z3 execution,
fixed-point lattices, backend-specific Quint generators, optimizer experiments,
or individual async/resource lowerings. Existing experiments can import those
from `@mizchi/uneffect/experimental`, with no compatibility promise. This is an
intentional pre-1.0 break in 0.3.0 and avoids freezing the very layers targeted
by the roadmap.

## Annotation dialect inventory

`uneffectDialects` is the machine-readable public inventory of recognized
comment headers. Its current values are `unified`, `trust`,
`react-component`, `react-hook`, and `react-resource`. The ordinary form
`/* uneffect:effect ... */` belongs to `unified`. React roles also have
namespaced plugin directives `react.component`, `react.hook`,
`react.acquire`, and `react.release`, registered with the same collision and
provenance rules as third-party plugins. The remaining dialect values are
explicit hyphenated markers. Removed `capability`, `contract`, `temporal`,
`refinement`, `runtime`, `async`, and `resource` headers are not compatibility
aliases and fail closed as unknown dialects. Typed refinement metadata belongs
in an attached `.uneffect.ts` module.

See [TypeScript temporal specification modules](./temporal-dsl.md) for the
initial `@mizchi/uneffect/spec` syntax and its explicit unsupported boundary.

## Stable temporal facade

Use:

```ts
import { generateTemporalModel } from "@mizchi/uneffect"

const result = generateTemporalModel({
  fileName: "src/main.ts",
  source,
  runtime: "web", // or "node"
  root: "main",
})
```

`GenerateTemporalModelOptions` has the following contract:

| Field | Meaning |
| --- | --- |
| `fileName` | Source identity used for diagnostics and generated module names. |
| `source` | TypeScript source text to analyze. |
| `runtime` | Required host profile: `web` or `node`. |
| `root` | Temporal and resource root; defaults to `main`. |
| `nodeTopLevelMode` | Node top-level scheduling profile; defaults to `commonjs`. |
| `linkedTemporal` | A resolved `.uneffect.ts` link. Project verification resolves `uneffect: from` comments automatically. |

`TemporalModelResult` is tagged with
`schema: "uneffect-temporal-model/v1"`. Its fields are:

| Field | Meaning |
| --- | --- |
| `runtime` | Selected host profile. |
| `includedDomains` | Analyses that contributed to this result. This is not a whole-program coverage claim. |
| `exclusions` | Relevant semantics that the generated projections do not prove. Never discard this field. |
| `synchronizations` | Exact cross-projection identity links proved by the frontend. An absent link must not be inferred from matching display names. |
| `coverage` | One entry for every public temporal/Promise/resource domain, classified as `modeled`, `not-applicable`, or `excluded`, with contributing model kinds and exact exclusion codes. |
| `scheduling` | Machine-readable scheduling boundary. The current facade records `fairness: "none"`; resource/callback interleavings are `excluded` or `not-applicable`. |
| `models` | Authoritative list of independently checked Quint projections, including module, owner, properties, kind, and source text. |
| `properties` | Display names for the host and owner-qualified projection properties. |
| `quint` | All generated modules concatenated for inspection or storage. Project verification checks each `models` entry with its own module selection. |

Current model kinds are `web-event-loop`, `node-event-loop`,
`promise-ownership`, `abortable-fetch`, `resource-lifecycle`, and
`resource-host-lifecycle`.
`async-ownership` is included only when the selected root has supported tracked
Promise bindings; otherwise it remains an explicit not-projected exclusion.
Current exclusions include `async-ownership`, `promise-host-synchronization`,
`abortable-fetch-synchronization`,
`resource-lifecycle`, `resource-host-scheduling`, and
`resource-host-callback-interleavings`. New exclusions may be added in a patch
release because making an unproved boundary visible is a safety correction.
`modeled` means that a projection was emitted under the documented fragment; it
does not mean the backend verified its properties. Use project verification and
inspect each property result for that claim.

The CLI equivalent is:

```sh
npx uneffect spec temporal src/main.ts main --runtime web > main.qnt
```

Project verification uses the same facade when `temporalRuntime` is `web` or
`node`. In that mode, `verifyUneffectProject` also aggregates the shared
`AsyncSafetyDiagnostic` results into its public `diagnostics` list and assurance
decision. A floating Promise is an ownership violation; invalid or stale
resource use is a resource violation; an unsupported control transfer is an
unknown rather than a successful temporal result. `generateTemporalModel`
remains a model artifact API, so callers that need an acceptance decision
should use project verification instead of inferring success from the presence
of generated models.

Stored or transported results can be checked with
`parseTemporalModelResult`. It rejects unknown fields, unsupported enum values,
malformed projections, and incomplete or duplicate coverage inventories. The
same contract is published as
`@mizchi/uneffect/schemas/uneffect-temporal-model-v1.schema.json`.

## Stable Corsa semantic-query boundary

`openCorsaApiFrontend` from `@mizchi/uneffect/corsa/api` opens an explicitly
selected project using Uneffect's pinned native TypeScript compiler unless an
executable is supplied. Its immutable Corsa semantic-query API descriptor binds
the Corsa revision, compiler executable, project/config identity, root files,
supported query capabilities, and current limitations. The descriptor schema
is published as
`@mizchi/uneffect/schemas/uneffect-corsa-api-frontend-v1.schema.json`.

The stable contract covers position/batch symbol and type queries, bounded alias
resolution, module exports, type properties and symbols, assignability, and the
documented bounded builtin classifier. Syntax traversal remains out of band and
the builtin classifier is not a complete JavaScript or host-API catalog.

`@corsa-bind/napi` and the platform compiler are optional dependencies. When
the binding is absent, opening the frontend rejects with an explicit
installation diagnostic; when the compiler cannot be resolved, the resolver
reports that no Corsa compiler was supplied. Importing `/corsa/api` alone does
not crash or silently succeed in either case. Other binding initialization or
ABI failures retain their original error instead of being mislabeled as a
missing package. The broader `/corsa` exporter additionally requires the
compatible `corsa-oxlint`, `oxlint`, and `@oxlint/plugins` peers declared by the
package.

## Contract runtime failures

When `runtimeAssertions: "fallback"` is enabled, generated contract checks throw
a `RangeError` with structured `uneffect` metadata. Catch boundaries can narrow
it without depending on the message text:

```ts
import { isContractRuntimeError } from "@mizchi/uneffect"

try {
  await operation()
} catch (error) {
  if (isContractRuntimeError(error)) {
    console.error(error.uneffect.fileName, error.uneffect.line,
      error.uneffect.kind, error.uneffect.expression)
  }
}
```

`ContractRuntimeError` and `ContractRuntimeFailureMetadata` are exported types.
Metadata includes the directive's one-based `line` and `column` plus its
zero-based `{ start, end }` source span. For a linked `.uneffect.ts` contract,
these coordinates and `fileName` identify the original predicate body in the
specification AST, carried through materialization as sidecar provenance.
Instrumented code does not import Uneffect at runtime; the type guard is
optional consumer code.

The experimental API `analyzeTypeScriptControlFlow(fileName, source)` exposes the versioned
`uneffect-typescript-control-flow/v1` artifact used by runtime-contract exit
analysis. It binds the TypeScript version, aggregate and per-source digests,
compiler options, source-qualified function diagnostics, endpoint coverage,
explicit exclusions, neutral-CFG comparison, and internal-hook observation.
Persisted artifacts can be checked with
`parseTypeScriptControlFlowAnalysis` and the published JSON Schema.
See [TypeScript control-flow bridge](./typescript-control-flow.md). An
`unreachable` endpoint is endpoint evidence, not a Hoare proof.

`analyzeTypeScriptProgramControlFlow(program, sources?)`, also experimental, reuses an existing
project snapshot and additionally covers static-named methods/accessors and
directly `const`-bound functions. The Program must enable `noImplicitReturns`;
otherwise its endpoints fail closed as `unknown`. Mutable function bindings
are also `unknown`. Stable callable aliases compose through nested scopes,
imports/re-exports, and direct properties of builtin-frozen static object
literals. Runtime project lowering moves an alias contract to the resolved
source callable rather than wrapping it.

The experimental `collectSyntaxFacts` boundary emits
`uneffect-syntax-facts/v1` with source/parser identity and coverage for function
boundaries and call/construct/property sites. `parseSyntaxFacts` rejects
malformed or internally inconsistent artifacts. Syntax exclusions are
fail-closed errors in the Corsa project checker, not evidence of an empty
effect set. Anonymous callback boundaries remain source-scoped; computed or
otherwise non-static calls/constructions, tagged templates, and dynamic imports
are explicit exclusions. The artifact schema is published, but the traversal
API remains on the experimental subpath while Corsa syntax traversal is out of
band.

Builtin `Object.freeze` recognition is compatibility support for existing
code, not an optimization or usage recommendation. Prefer the zero-runtime
inline, immutable-alias, and statically screened local-container forms when
they are sufficient.

## Temporal ownership and resource API placement

`/* uneffect: ... */`, async diagnostics, and the high-level analyzers are
public inputs and evidence APIs. Promise ownership and resource directives now
use the same `temporal` dialect; the former `async` and `resource` dialects are
not compatibility aliases.

Direct backend generators such as `generateAsyncPatternsQuint`,
`generatePromiseChainsQuint`, `generateWebEventLoopQuint`,
`generateNodeEventLoopQuint`, `generateResourceSafetyQuint`,
`generateUnifiedAsyncQuint`, and `generateResourceTemporalProductQuint` are
experimental. Import them only from:

```ts
import { generateResourceSafetyQuint } from "@mizchi/uneffect/experimental"
```

Generated Quint text is not a stable textual ABI. Prefer the stable facade and
inspect the versioned result metadata.

## Compatibility policy before 1.0

- Patch releases preserve the documented high-level entrypoints and option
  meanings. They may add diagnostics, exclusions, result fields, or reject an
  unsound previously accepted shape.
- Minor releases may change unversioned TypeScript APIs or annotation syntax,
  with migration notes in the changelog.
- The `experimental` subpath has no source or semantic compatibility promise.
- Versioned JSON schemas and evidence records retain their declared schema
  compatibility independently of TypeScript APIs.
- A change that broadens a verified claim requires new positive and
  load-bearing negative tests; documentation alone cannot promote a fragment.

This policy does not turn Uneffect into a complete JavaScript verifier. See
[Stability and safe adoption](./stability.md), [Assurance
boundaries](./assurance-boundaries.md), and the [Feature
matrix](./feature-matrix.md) before relying on a result.
