# Builtin semantic catalog

Uneffect keeps reviewed JavaScript, Node.js, and DOM behavior in the versioned
`uneffect-builtin-semantics/v1` catalog. Definitions compile to trusted
symbol-identity contracts; they do not patch or wrap runtime implementations.

A definition can record capability authority, receiver or argument mutation,
fresh/path-refined results, callback timing, DOM operations, resource
transitions, and clone/transfer behavior.

The catalog contains reviewed definitions for JavaScript, Node.js, DOM, and
selected package APIs. All definitions use the same generic semantic primitives
and are covered in bounded groups with positive, negative, and symbol-shadowing
tests.

The JavaScript catalog also owns Array callback/copy helpers, Promise
combinators, `Math.random`, and `structuredClone`. Semantic axes are orthogonal:
`Array#sort` has a generic synchronous `callback` plus `mutate(receiver)`, so
neither comparator timing nor destructive receiver behavior is discarded.
Result, throw, resource, and argument-mutation projections follow this pattern
instead of creating duplicate symbol contracts.

The Node catalog owns both `node:fs` callback/synchronous APIs and
`node:fs/promises`. The Promise catalog has its own API surface rather than
inheriting nonexistent sync names; it includes Promise-specific `opendir`,
`statfs`, `mkdtemp`, `mkdtempDisposable`, `watch`, and `glob`. Each definition records independent read/write authority,
source and destination path arguments, poll-queue callback completion, repeated
watch callbacks, and buffer mutation for descriptor-based reads. Compound APIs
such as `copyFile` therefore retain both `FsRead` and `FsWrite`.
These definitions now use generic effect, filesystem-path, mutate, callback,
result, and acquire primitives exclusively; the legacy filesystem operation is
no longer present. Promise APIs share permission projection but do not claim
callback scheduling. Direct path parameters remain parameterized in summaries
and are substituted at call sites. Literal callers recover exact path
authority; other resolved expressions conservatively require broad filesystem
authority, while an invalid projector remains unknown.

Node DNS, socket, HTTP, and server lifecycle definitions use generic network
scope, callback, result, acquire, release, and protocol primitives. Host,
connect-options, and HTTP URL/options projections are selected by typed catalog
data rather than by symbol-name branches in the analyzers.

Node OS, crypto-randomness, and child-process definitions also live in the
catalog. OS queries retain their scoped `Sys` atoms, `tmpdir()` refines to
`$TEMP`, callback crypto APIs retain poll-queue completion plus `Random`, and
child-process APIs distinguish scoped program execution from broad `Run`.
Executable parameters use the same summary and call-site substitution rules as
filesystem paths.

Node network and event-loop definitions retain connect/request host scopes,
HTTP default ports, DNS poll completion, repeating server callbacks, server
handle acquisition/close, watcher close, `nextTick`, and the check-phase
`setImmediate`/`clearImmediate` pair. Timer and watcher cancellation are generic
protocol transitions consumed by the async model through projected handle identity.

The Web host slice owns `fetch`, console effects, timers and animation frames,
AbortSignal constructors, Scheduler tasks, Web Crypto randomness, and
structured-clone transfer at Worker and MessagePort boundaries. These entries
preserve queue, cancellation-family, capability, and transfer metadata; they do
not claim to verify browser implementations.

DOM method definitions are catalog-owned as a separate slice. Node, attribute,
text, layout, creation, parsing, listener, and dispatch operations retain their
receiver/argument mutation regions, selector scopes, and possible user-code
invocation. DOM property reads and writes remain a separate projection because
their semantics depend on access direction. The directional property slice is
also catalog-owned: tree/text/markup/layout/script properties retain distinct
read and write operations, mutation regions, and possible user-code invocation.
Cookie and Storage properties retain separate read/write capability effects.

`reviewed` means the overlay is a trusted analyzer input, not that an engine or
host implementation was proved. Unsupported callback composition remains
visible. For example, `toSorted` records its synchronous comparator and fresh
result, but arbitrary comparator-effect propagation through an enclosing
function is not yet a supported claim.

Each expansion must preserve exact TypeChecker symbol identity, reject duplicate
`(module, export)` definitions, record trust provenance, retain separate JS,
Node, and DOM ownership, and include a negative test showing that the semantic
field affects analysis.

API-family-specific operation kinds have been replaced by composable generic
primitives. The completed migration, acceptance gates, and the remaining
bounded protocol limitations are documented in `generic-builtin-semantics.md`.
