# Local Rust prototype retirement

Uneffect now uses TypeScript for its own semantic-fact validation and
normalization. `@corsa-bind/napi` remains the external native compiler binding;
it never depended on `crates/uneffect-core`. The local crate, Cargo manifests,
Rust build cache, Cargo tasks, CI toolchain setup, and release-version coupling
have been removed. Quint's separately distributed evaluator is unchanged.

## Preserved boundaries

- `compareUneffectFrontends` and the schema-v8 fact representation remain
  available. The internal schema and consumer are separate modules.
- The consumer rejects unsupported schemas, malformed records/spans/effects,
  duplicate identities, dangling calls/owners, invalid overload selections,
  inconsistent producer provenance, mismatched disposal protocols, and
  empty/duplicate/contradictory or mismatched branch conditions.
- Effect propagation is a finite monotone worklist over input symbols and effect
  atoms. Cycles terminate without inventing effects.
- Reference projection and Corsa fact consumption remain separate paths.
  Authenticated checker facts still come from the real exporter; serialized
  producer labels cannot authenticate them. `requireCorsaCheckerFacts` still
  rejects reference or tampered facts.
- Comparison runs inside Node, including from an installed npm tarball without
  a Cargo workspace or toolchain. `corsaTimeoutMs` remains a deprecated no-op for
  source compatibility; exporter process timeouts remain in effect.

This retires cross-language differential checking. Reference-only equality is
an adapter consistency check, not independent compiler evidence. Shared
TypeScript effect parsing is not an independent parser oracle. Real-checker
metadata controls, literal expectations, and frozen outputs carry the retained
regression evidence.

## Migration evidence

Before removal, the existing frontend parity and real checker-exporter suites
passed 47 tests at base commit `c8a2315`. A temporary capture wrapper called the
actual `uneffect-corsa-normalize` binary and retained its inputs and outputs;
it did not generate expected outputs using the replacement implementation.
The new consumer matched all 55 captured successful normalizations locally.

`test/fixtures/corsa-normalization-v8.json` retains 15 representative cases:
all captured reference projections (including empty effects, UTF-8 spans,
Promise ownership, resource protocols, disposal and suppression, and control
paths), plus checker facts for dynamic imports, cross-file identities,
filesystem effects, methods, and overloads. These are frozen historical outputs,
not a claim that arbitrary persisted facts are authenticated. Do not regenerate
expectations from the consumer being tested.

The new consumer suite carries literal call/effect expectations and malformed
input mutations. Existing checker-exporter tests independently detect builtin,
overload, span, Promise-observation, and provenance drift. Existing TypeScript
capability/containment, ownership, and formal invalidation tests remain the
maintained checks for semantics formerly duplicated in Rust's `effect_model`
tests; Rust-only API details such as `LocatedEffectSet` are retired.

Earlier benchmark and completed-issue records that mention Rust describe their
original measured implementation, not a current runtime dependency.
