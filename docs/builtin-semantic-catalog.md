# Builtin semantic catalog

Uneffect keeps reviewed JavaScript, Node.js, and DOM behavior in the versioned
`uneffect-builtin-semantics/v1` catalog. Definitions compile to trusted
symbol-identity contracts; they do not patch or wrap runtime implementations.

A definition can record capability authority, receiver or argument mutation,
fresh/path-refined results, callback timing, DOM operations, resource
transitions, and clone/transfer behavior.

The initial catalog contains representative definitions for all three
platforms: Array/Object copying behavior, Node module/path/process helpers, and
DOM Storage reads and writes. Existing handwritten definitions migrate in
bounded groups with positive, negative, and symbol-shadowing tests.

The JavaScript catalog also owns Array callback/copy helpers, Promise
combinators, `Math.random`, and `structuredClone`. Semantic axes are orthogonal:
`Array#sort` has an inline-callback operation plus `receiverMutation: true`, so
neither comparator timing nor destructive receiver behavior is discarded.
Future result, throw, resource, and argument-mutation projections should follow
this pattern instead of creating duplicate symbol contracts.

The Node catalog owns both `node:fs` callback/synchronous APIs and
`node:fs/promises`. Each definition records independent read/write authority,
source and destination path arguments, poll-queue callback completion, repeated
watch callbacks, and buffer mutation for descriptor-based reads. Compound APIs
such as `copyFile` therefore retain both `FsRead` and `FsWrite`.

Node OS, crypto-randomness, and child-process definitions also live in the
catalog. OS queries retain their scoped `Sys` atoms, `tmpdir()` refines to
`$TEMP`, callback crypto APIs retain poll-queue completion plus `Random`, and
child-process APIs distinguish scoped program execution from broad `Run`.

`reviewed` means the overlay is a trusted analyzer input, not that an engine or
host implementation was proved. Unsupported callback composition remains
visible. For example, `toSorted` records its synchronous comparator and fresh
result, but arbitrary comparator-effect propagation through an enclosing
function is not yet a supported claim.

Each expansion must preserve exact TypeChecker symbol identity, reject duplicate
`(module, export)` definitions, record trust provenance, retain separate JS,
Node, and DOM ownership, and include a negative test showing that the semantic
field affects analysis.
