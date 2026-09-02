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
effects; a violation downgrades the caller to `unknown`. Cardinality is
persisted as auditable metadata but is not yet projected into the temporal
model. A nested callback path or completion mode other than synchronous
`propagate-throw` blocks consumer binding instead of being approximated.

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

Finite object/tuple callback paths are supported when the consumer supplies an
inline object/array literal whose selected leaf is an inline function or an
immutable symbol-resolved function identifier. A spread, computed/dynamic
selection, mutable container alias, or unresolved leaf fails closed. Returned
callables, reentrancy/concurrency, temporal cardinality, and resource ownership
remain outside this first consumer fragment.
