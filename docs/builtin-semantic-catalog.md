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

The JavaScript catalog also owns non-mutating Array callback/copy helpers,
Promise combinators, `Math.random`, and `structuredClone`. `Array#sort` remains
handwritten for now: it simultaneously invokes a comparator and mutates its
receiver, while the v1 contract currently stores only one `operation`.
Migrating it requires ordered/multiple semantic projections rather than
discarding either fact.

`reviewed` means the overlay is a trusted analyzer input, not that an engine or
host implementation was proved. Unsupported callback composition remains
visible. For example, `toSorted` records its synchronous comparator and fresh
result, but arbitrary comparator-effect propagation through an enclosing
function is not yet a supported claim.

Each expansion must preserve exact TypeChecker symbol identity, reject duplicate
`(module, export)` definitions, record trust provenance, retain separate JS,
Node, and DOM ownership, and include a negative test showing that the semantic
field affects analysis.
