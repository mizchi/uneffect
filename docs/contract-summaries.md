# Persisted contract summaries

`uneffect-contract-summary/v1` is the initial producer envelope for publishing
verified scalar Hoare contracts with a package. It is generated only for direct
named exported function declarations whose local obligations and transitive
relational dependencies are all `verified`.

```ts
import {
  createContractSummaryBundle,
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

Changing any covered value invalidates the bundle content digest. Validation
also recomputes compiler, source, declaration, and signature evidence instead
of trusting the stored digest.

## Assurance boundary

This v1 API produces and validates a bundle against the original producer
source Program. It does not yet authorize a consumer call through an installed
package. In particular, Uneffect does not yet prove that an emitted `.d.ts`,
package export map, bundled JavaScript, or installed tarball corresponds to the
producer source in this envelope.

The content SHA-256 provides integrity, not publisher authenticity. There is no
signature, transparency log, or trusted publishing identity in v1. Until the
consumer linker is implemented, package contracts remain `trusted` declarations
at call sites rather than `verified` imported evidence.
