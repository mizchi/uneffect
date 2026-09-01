# Semantics modules

Uneffect semantics modules are a declarative extension boundary for application and ecosystem-specific effects. They bundle effect schemas and reviewed builtin contracts without executing third-party analyzer code.

This feature is experimental. A loaded module contributes **trusted assumptions**, never independently verified facts. A green result remains conditional on the module review recorded by `trustOwner`, `trustReason`, version, and SHA-256 digest. The evidence artifact records this ledger and becomes stale when the manifest changes.

## Manifest

```json
{
  "$schema": "./node_modules/@mizchi/uneffect/schemas/uneffect-module-v1.schema.json",
  "schema": "uneffect-module/v1",
  "name": "@acme/audit-semantics",
  "version": "1.2.0",
  "namespace": "Acme.Audit",
  "evidence": "trusted",
  "trustOwner": "security-platform",
  "trustReason": "reviewed against @acme/audit 4.1.0",
  "effectSchemas": [
    { "name": "Acme.Audit.Emit", "version": 1, "arguments": ["literal"] }
  ],
  "registry": {
    "schema": "uneffect-registry/v1",
    "builtinRegistryVersion": 2,
    "contracts": [{
      "symbol": { "module": "@acme/audit", "export": "emit" },
      "runtime": { "kind": "package", "version": "4.1.0" },
      "evidence": "trusted",
      "trustOwner": "security-platform",
      "trustReason": "reviewed emit boundary",
      "semantics": {
        "schema": "uneffect-semantic-primitives/v1",
        "primitives": [{
          "kind": "effect",
          "capability": "Acme.Audit.Emit",
          "scope": { "kind": "value", "target": { "kind": "argument", "index": 0 } }
        }]
      }
    }]
  }
}
```

Use it from the CLI:

```sh
uneffect check --semantics-module ./audit.uneffect.json src/main.ts
uneffect evidence --semantics-module ./audit.uneffect.json src/main.ts
```

The option may be repeated. Module identities and effect names must not conflict. Effect names must be under the declared namespace. Invalid manifests are rejected atomically; their effect schemas do not remain registered.

The programmatic API is `loadUneffectModules()` or `installUneffectModules()`.

## Annotating external package APIs

Use a semantics module when the library cannot or should not contain Uneffect
comments. A contract is attached to the TypeChecker-resolved package export,
not to the local variable spelling. Package contracts require an exact runtime
version; an upgrade without a matching reviewed contract becomes `unknown`.

An API returning a newly allocated, caller-owned object can declare a fresh
result. This allows later in-place operations on that result without claiming a
mutation of library or caller state:

```json
{
  "symbol": { "module": "reviewed-values", "export": "keys" },
  "runtime": { "kind": "package", "version": "1.0.0" },
  "evidence": "trusted",
  "trustOwner": "platform-runtime",
  "trustReason": "reviewed implementation always allocates a new Array",
  "semantics": {
    "schema": "uneffect-semantic-primitives/v1",
    "primitives": [{ "kind": "result", "refinement": { "kind": "fresh" } }]
  }
}
```

`fresh` is an aliasing/ownership claim only. It does not imply that calling the
API is pure; compose `effect`, `callback`, `throw`, or other primitives in the
same ordered `primitives` array when applicable. It also does not prove the external implementation. The result remains
conditional on the reviewed manifest, exact package version, TypeChecker symbol
resolution, and module-initialization assumptions. Do not use `fresh` for a
cache, singleton, pooled object, input alias, view into input memory, or an
object that the library retains and mutates later.

## Current boundary

Version 1 intentionally supports only data understood and validated by Uneffect core:

- namespaced capability schemas using the existing finite-set atom domains;
- reviewed builtin function contracts;
- the complete validated `uneffect-semantic-primitives/v1` data model,
  including callbacks, ownership, directional properties, and named protocols;
- reviewed package/module initialization effects;
- declaration fingerprints inherited from the registry format;
- a trusted-module ledger in effect evidence.

It does not yet load JavaScript, native, or Wasm analyzer plugins. It also cannot add arbitrary AST rules, Z3 encodings, Quint transition systems, runtime assertions, or proof certificates. Those require a versioned neutral obligation IR and a proof-producing protocol; accepting an executable plugin's boolean answer would create false assurance.

The intended later tiers are:

1. declarative, distributable package-summary modules (implemented here);
2. proof-producing modules that emit core-validated obligations and source mappings;
3. isolated executable adapters whose output remains `trusted` unless checked by a supported verifier.
