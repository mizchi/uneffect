# Public API and compatibility

This document defines the intended package surface as of Uneffect 0.2.1. The
project is still pre-1.0: pin the exact version in verification workflows and
read emitted exclusions together with every result.

## Package entrypoints

| Import path | Status | Intended use |
| --- | --- | --- |
| `@mizchi/uneffect` | Public | TypeScript helpers, analyzers, evidence APIs, project verification, and stable high-level model facades. |
| `@mizchi/uneffect/corsa` | Public integration boundary | Versioned Corsa/tsgo fact export. Pin the package and frontend versions. |
| `@mizchi/uneffect/experimental` | Experimental | Low-level async, Promise, event-loop, and resource Quint generators. Names, options, and generated text may change without notice. |
| `@mizchi/uneffect/schemas/*` | Versioned data contract | Published JSON schemas. Compatibility follows the schema identifier, not an unversioned TypeScript implementation detail. |
| `@mizchi/uneffect/package.json` | Public metadata | Exact package version and package metadata. |

Do not import unpublished paths such as `dist/src/async-patterns.js`. Package
exports intentionally block those implementation paths.

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

`TemporalModelResult` is tagged with
`schema: "uneffect-temporal-model/v1"`. Its fields are:

| Field | Meaning |
| --- | --- |
| `runtime` | Selected host profile. |
| `includedDomains` | Analyses that contributed to this result. This is not a whole-program coverage claim. |
| `exclusions` | Relevant semantics that the generated projections do not prove. Never discard this field. |
| `models` | Authoritative list of independently checked Quint projections, including module, owner, properties, kind, and source text. |
| `properties` | Display names for the host and owner-qualified projection properties. |
| `quint` | All generated modules concatenated for inspection or storage. Project verification checks each `models` entry with its own module selection. |

Current model kinds are `web-event-loop`, `node-event-loop`,
`resource-lifecycle`, and `resource-host-lifecycle`. Current exclusions include
`async-ownership`, `resource-lifecycle`, `resource-host-scheduling`, and
`resource-host-callback-interleavings`. New exclusions may be added in a patch
release because making an unproved boundary visible is a safety correction.

The CLI equivalent is:

```sh
npx uneffect spec temporal src/main.ts main --runtime web > main.qnt
```

Project verification uses the same facade when `temporalRuntime` is `web` or
`node`.

## Async and resource API placement

`/* uneffect:async ... */`, async diagnostics, and the high-level analyzers are
public inputs and evidence APIs. They feed the temporal pipeline; async is not
a fourth independent formal-specification domain.

Direct backend generators such as `generateAsyncPatternsQuint`,
`generatePromiseChainsQuint`, `generateWebEventLoopQuint`,
`generateNodeEventLoopQuint`, `generateResourceSafetyQuint`,
`generateUnifiedAsyncQuint`, and `generateResourceHostTemporalQuint` are
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
