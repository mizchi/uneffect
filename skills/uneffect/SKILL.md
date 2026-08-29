---
name: uneffect
description: Add, review, or operate Uneffect annotations and checks for TypeScript. Use for gradual capability effects, Hoare-style contracts, async ownership, temporal models, React semantics, Trusted Types, and bounded numeric or typed-array checks; do not present Uneffect as a whole-program verifier or runtime security boundary.
---

# Uneffect

Use Uneffect to add a zero- or low-runtime-cost specification layer to existing
TypeScript. Preserve ordinary TypeScript syntax: specifications belong in
canonical block comments such as `/* uneffect:capability ... */`.

## Choose the smallest useful check

1. Identify a narrow boundary and the concrete failure to prevent.
2. Run inference before adding declarations when working in existing code.
3. Add only the domain needed for that failure: capability, contract, async,
   temporal, React, Trusted Types, or numeric/typed-array safety.
4. Check the exact consumer TypeScript project and inspect diagnostics,
   `unknown` evidence, assumptions, and exclusions.
5. Ratchet assurance only after the selected fragment is supported.

Do not rewrite an application around an effect runtime. Prefer annotations at
real I/O, mutation, validation, ownership, and state-machine boundaries over
annotations on mechanically added wrappers.

## Read the relevant guide

- For installation, canonical syntax, commands, and first adoption, read
  [references/basics.md](references/basics.md).
- For choosing what to model and copyable examples, read
  [references/patterns.md](references/patterns.md).
- Before making a result release-blocking or describing a guarantee, read
  [references/assurance.md](references/assurance.md).

Read only the guides needed for the current task. The repository's `docs/`
directory is authoritative for detailed and fast-changing semantics; use the
links in each reference instead of guessing unsupported behavior.

## Working rules

- Treat effect declarations as upper bounds. Missing transitive effects are
  errors; unused declared effects are warnings.
- Use `effect none` only for an explicit checked empty bound. An unannotated
  function is not declared pure.
- Keep dialect hints explicit: `uneffect:capability`, `uneffect:contract`,
  `uneffect:temporal`, `uneffect:async`, and `uneffect:react-component`.
- Use TypeChecker-resolved identities and scoped capabilities. Do not infer
  safety from matching names or structural casts.
- Keep runtime validation at untrusted inputs. Branded helper types and static
  evidence do not validate arbitrary runtime values.
- Preserve `unknown` and trusted/assumed evidence. Never turn an escape hatch,
  external contract, or backend success into a stronger claim than it records.
- When modifying Uneffect itself, follow repository TDD: exploration, a failing
  test, the smallest passing implementation, then refactoring.

## Completion criteria

Report which files and domains were checked, the selected assurance profile,
and whether the result is `verified`, `assumed`, `unknown`, or `violated`.
State important unsupported constructs explicitly. Exit code 0 without an
assurance profile means the enabled lint/check pass succeeded; it is not a
whole-program proof.
