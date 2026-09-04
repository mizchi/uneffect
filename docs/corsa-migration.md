# Corsa migration decision and roadmap

## Decision

A staged migration to `@corsa-bind/napi` is realistic and worth continuing.
A complete replacement of the TypeScript Compiler API is not realistic with
the current Corsa 1.13.1 API for Hoare, ownership, resource CFGs, or temporal
extraction. The admitted Effect catalog slice no longer needs a JavaScript
TypeScript 6 `Program`.

Default `uneffect check` — both `--project <tsconfig.json>` and
file-specified `uneffect check file.ts` — uses Corsa for checker identity
and Oxc for syntax. It does not construct a JS TypeScript 6 `Program` and
does not load the `typescript` package for checker facts. File-specified
checks write an ephemeral tsconfig so Corsa can open the files.
`--typescript-program`, `--corsa-parity`, workspace project references,
contract summaries, and build-artifact gates still load the TypeScript 6
path. Uneffect must not make Corsa authoritative for a construct merely
because both frontends happen to return the same type text in a fixture.

## Evidence from the current prototype

Upstream status checked on 2026-09-03:

- npm `latest`: `@corsa-bind/napi@1.13.1` and `corsa-oxlint@1.12.4`;
- npm `latest`: `typescript@7.0.2`;
- npm `latest`: `typescript@7.0.2` native platform packages (`@typescript/typescript-*`);
- [`corsa-bind` #475](https://github.com/ubugeeei-prod/corsa-bind/pull/475) merged
  named N-API wrappers for batched symbols, alias traversal, and module
  exports. `@corsa-bind/napi@1.13.1` publishes those names in `dist/index.d.mts`
  along with `getTypesAtPositions`, `getPropertyOfType`, and `isTypeAssignableTo`.

The Corsa worker is pinned to TypeScript 7 native platform binaries
(`@typescript/typescript-<platform>-<arch>/lib/tsc`). The JavaScript TypeScript 6
peer remains for the TypeScript Program path (`--typescript-program`,
workspace composition, contracts, `--corsa-parity`) and for analyzers that
still walk TypeScript AST. Default check is TypeScript-7-only: one native
Corsa compiler plus Oxc, no JS `typescript` Program alongside it.
Dual TS6+Corsa memory is a migration tax on the remaining Program path, not
the default.

- `@corsa-bind/napi` opens a real project through a prebuilt `tsgo` worker and
  returns checker-owned symbol and type facts without constructing a JavaScript
  TypeScript `Program`.
- A package-only smoke test opens that frontend with no consumer `typescript`
  installation. Uneffect resolves its optional TypeScript 7 native `lib/tsc`
  instead of a PATH or project compiler.
- Global `fetch` and members of the checker-resolved global `console` object can
  be distinguished from same-spelled local parameters. This is the first
  admitted Effect-resolution slice.
- The published 1.13.1 binary exposes named `getSymbolsAtPositions`,
  `getImmediateAliasedSymbol`, `getAliasedSymbol`, `getExportsOfModule`,
  `getTypesAtPositions`, `getPropertyOfType`, and `isTypeAssignableTo`.
  Uneffect calls those methods directly. `getSignaturesOfType` stays on
  `callJson` because that path fills `parameterTypeTexts`.
- A re-exported `node:fs/promises` alias reaches its immediate re-export symbol,
  but full canonicalization returns Corsa's `unknown` symbol for the exercised
  two-hop fixture. A separate Red probe found that a direct named import from
  this ambient Node module also returns `unknown`, with no immediate target.
  Both remain unclassified rather than being guessed as `FsRead`.
- The earlier local benchmark measured about 76 ms for frontend startup plus a
  symbol/type query, versus 757–1,031 ms for the temporary-project Oxlint export
  path. The workloads differ, so this establishes feasibility, not a general
  10x speedup.

## Benefits

1. **Compiler isolation.** A fixed prebuilt compiler does not participate in the
   application's TypeScript dependency resolution. Different projects can keep
   their own compiler versions while Uneffect records the compiler used for
   evidence.
2. **A Rust-oriented execution path.** Compact semantic facts can flow directly
   into the existing Rust normalization and lattice code. This avoids moving a
   growing analyzer entirely through JavaScript object graphs.
3. **Startup and memory potential.** The direct worker is already materially
   cheaper than the current temporary-project bridge in a small benchmark.
   Warm batched call-site measurements are still required.
4. **A clearer trust boundary.** Compiler revision, executable, project, source
   positions, and returned identities can be recorded independently from the
   user's build compiler.
5. **Incremental adoption.** Each semantic family can retain TypeScript as an
   oracle until positive, negative, alias, and shadowing parity is demonstrated.

## Current blockers

Corsa's underlying project-scoped API exposes batched symbols/types, alias
relations, resolved signatures, property lookup, assignability, exports, and
many other checker relations. In `@corsa-bind/napi@1.13.1`, batched symbols,
types, alias traversal, module exports, property lookup, and assignability
have named N-API methods. `getSignaturesOfType` stays on `callJson` because
that path fills `parameterTypeTexts`.
Direct and two-hop Node ambient-module aliases still resolve to `unknown`, and
source-position or node handles are required by several relation endpoints. CFG and a complete
whole-project AST traversal suitable for Uneffect's analyzers remain missing.
The typed facade exposes `overlayChanges`, but TypeScript 7.0.2 and 7.1
nightlies still ignore in-memory overlays (`describeCapabilities` is missing
and a typed upsert does not change checker results). Incremental watch-mode
measurement therefore remains blocked on the compiler runtime rather than
being approximated with destructive on-disk fixture edits.

`workspace/symbol` exists on tsgo's LSP surface, but it is a name-search API. It
does not replace call-site identity queries and is not used as Effect evidence.

Consequently, full Effect propagation, Hoare/refinement analysis, Promise
ownership, resource CFGs, and temporal extraction cannot be switched wholesale.
The current main analyzer still needs TypeScript 6 when imported through
`checkFiles` or `--typescript-program`. Default `check`, file-specified
`check`, and `checkCorsaProject` avoid that runtime dependency. A
`@mizchi/uneffect/corsa/api`-only installation also avoids it.

## Roadmap

### Phase 0 — packaging and fail-closed probe (complete)

- Ship Corsa N-API and a fixed native compiler as optional platform prebuilds.
- Keep the JavaScript TypeScript peer optional at install time. It is required
  for `--typescript-program`, workspace composition, and `--corsa-parity`, not
  for default `check` or file-specified `check`.
- Verify Corsa-only and TypeScript-main package consumers independently.
- Admit `Fetch` and `Console`; reject shadowed names and unsupported FS aliases.

### Phase 1 — semantic sidecar in the main analyzer

- Collect call-expression positions during the existing TypeScript AST walk.
- Batch semantic requests once per source file and attach Corsa facts to a
  compiler-neutral sidecar. (Implemented for the initial slice.)
- Default `check --project` classifies admitted `Fetch`/`Console`, lib.dom
  methods such as `Document#createElement`, properties such as
  `Document#cookie`, and DOM constructors such as `new WebSocket` through
  Corsa identity collected from Oxc call/property/construct sites. Same-spelled
  locals stay unclassified. Two-hop `node:fs/promises` aliases stay
  fail-closed (not `FsRead`).
- When a TypeScript Program sidecar is attached, admitted catalog lookup uses
  `overlayCorsaBuiltinCatalog`. Other builtins still go through
  `TypeScriptFrontendAdapter`. The TypeScript adapter remains the parity oracle.
- Run TypeScript and Corsa resolution together for `Fetch` and `Console` in CI;
  expose mismatches from `check --corsa-parity` as assurance blockers.
- Report parity mismatch as unknown; do not silently fall back in proof-grade
  mode.
- Benchmark cold open, warm 100/1,000-call batches, memory, and incremental
  snapshot updates. Cold open and warm batches are measured; memory and
  incremental snapshot updates remain open.

Exit criterion: all positive, shadowing, nested-scope, and rename fixtures agree,
and Corsa is no slower than the existing checker path for the selected slice.

The 2026-09-03 warm benchmark authenticated alternating global `fetch` and
`console.log` call sites before timing. One `getSymbolsAtPositions` request
classified 100 sites in 0.839 ms mean versus 4.433 ms for sequential requests,
and 1,000 sites in 7.427 ms versus 46.607 ms. This is a roughly 5.3–6.3x
same-workload improvement for Corsa RPC batching. It does not yet compare the
complete TypeScript adapter workload or include AST traversal, memory, or
snapshot-update cost.

### Phase 2 — stable identity API upstream

- Prefer named, typed Corsa facade methods for the existing batch-symbol,
  alias, resolved-signature, property, export, and awaited-type relations;
  retain versioned `callJson` adapters only where the facade has not surfaced
  them yet.
- Migrate named and re-exported Node/Deno/DOM builtin catalog entries one family
  at a time, beginning with `node:fs/promises`.
- Record API/compiler revisions in evidence and reject revision drift.

Exit criterion: catalog lookup no longer depends on type-text or source-name
heuristics, and negative controls cover local modules, mutable aliases,
namespace imports, overloads, and re-exports.

### Phase 3 — neutral syntax and control-flow export

- Export a versioned neutral AST/CFG containing only facts required by Effect,
  exception, Promise, resource, and refinement analyses.
- Compare it against TypeScript-backed evidence on the dogfood corpus.
- Move TypeScript-dependent analyzers to the neutral IR by domain, preserving an
  explicit unsupported/unknown result for missing nodes or edges.

Exit criterion: the public CLI can analyze the selected stable domains without
loading the JavaScript `typescript` package, with matching diagnostics and
source spans.

### Phase 4 — default switch and cleanup

- Make Corsa the default only after real-application dogfood and CI parity.
- Retain the TypeScript frontend as a compatibility oracle for at least one
  release line.
- Remove duplicated frontend code only after artifact-schema and diagnostic
  compatibility tests pass.

## Stop or defer conditions

Pause migration if stable identity endpoints cannot be provided, if compiler
updates repeatedly change opaque handles without source-bound evidence, or if
the neutral IR must reproduce most of TypeScript's checker inside Uneffect.
Under those conditions Corsa remains useful as an optional fast lint/export
backend, while TypeScript stays the proof frontend.

## Recommendation

Proceed through Phase 1, and coordinate Phase 2 with `corsa-bind` upstream.
Do not schedule the complete frontend rewrite yet. The next decision point is
after dual-fronted `Fetch`/`Console` dogfood and warm-batch benchmarks, not after
adding more handwritten builtin cases.
