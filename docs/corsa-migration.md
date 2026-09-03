# Corsa migration decision and roadmap

## Decision

A staged migration to `@corsa-bind/napi` is realistic and worth continuing.
A complete replacement of the TypeScript Compiler API is not realistic with
the current Corsa 1.12.4 API. Corsa should remain an optional semantic sidecar
until it reaches measured parity for each admitted slice.

This distinction is important: the migration can remove checker queries from
the JavaScript TypeScript `Program` before it can remove TypeScript AST
traversal. Uneffect must not make Corsa authoritative for a construct merely
because both frontends happen to return the same type text in a fixture.

## Evidence from the current prototype

Upstream status checked on 2026-09-03:

- npm `latest`: `@corsa-bind/napi@1.12.4` and `corsa-oxlint@1.12.4`;
- npm `latest`: `typescript@7.0.2`;
- npm `latest`: `@typescript/native-preview@7.0.0-dev.20260707.2`;
- [`corsa-bind` main](https://github.com/ubugeeei-prod/corsa-bind) is ahead of
  the 1.12.4 tag and contains unreleased fixes, so released and main behavior
  are recorded separately.

The current Uneffect Corsa path deliberately pins the preview package under a
different npm name. This lets the main analyzer continue using its TypeScript 6
peer while the Corsa worker uses a native TypeScript 7-line compiler without
forcing the application to resolve both through the same `typescript` package.

- `@corsa-bind/napi` opens a real project through a prebuilt `tsgo` worker and
  returns checker-owned symbol and type facts without constructing a JavaScript
  TypeScript `Program`.
- A package-only smoke test opens that frontend with no consumer `typescript`
  installation. Uneffect resolves its exact optional
  `@typescript/native-preview` compiler instead of a PATH or project compiler.
- Global `fetch` and members of the checker-resolved global `console` object can
  be distinguished from same-spelled local parameters. This is the first
  admitted Effect-resolution slice.
- The published 1.12.4 binary accepts `getSymbolsAtPositions`,
  `getImmediateAliasedSymbol`, and `getAliasedSymbol` through `callJson`. The
  sidecar now performs one symbol batch per source file.
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
many other checker relations. In `@corsa-bind/napi@1.12.4`, several are reached
through the generic `callJson` method rather than named, generated N-API methods.
Direct and two-hop Node ambient-module aliases still resolve to `unknown`, and
source-position or node handles are required by several relation endpoints. CFG and a complete
whole-project AST traversal suitable for Uneffect's analyzers remain missing.
The typed facade exposes `overlayChanges`, but the pinned native-preview runtime
reports that capability as unsupported. Incremental in-memory watch-mode
measurement therefore remains blocked on the compiler runtime rather than
being approximated with destructive on-disk fixture edits.

`workspace/symbol` exists on tsgo's LSP surface, but it is a name-search API. It
does not replace call-site identity queries and is not used as Effect evidence.

Consequently, full Effect propagation, Hoare/refinement analysis, Promise
ownership, resource CFGs, and temporal extraction cannot be switched wholesale.
The current main analyzer still needs TypeScript 6 when imported or run; only a
`@mizchi/uneffect/corsa/api`-only installation avoids that runtime dependency.

## Roadmap

### Phase 0 — packaging and fail-closed probe (complete)

- Ship Corsa N-API and a fixed native compiler as optional platform prebuilds.
- Keep the JavaScript TypeScript peer optional at install time but required and
  documented for the main CLI/API.
- Verify Corsa-only and TypeScript-main package consumers independently.
- Admit `Fetch` and `Console`; reject shadowed names and unsupported FS aliases.

### Phase 1 — semantic sidecar in the main analyzer

- Collect call-expression positions during the existing TypeScript AST walk.
- Batch semantic requests once per source file and attach Corsa facts to a
  compiler-neutral sidecar. (Implemented for the initial slice.)
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
