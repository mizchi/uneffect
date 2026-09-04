# TypeScript control-flow bridge

Uneffect connects contract-runtime exit analysis to the installed TypeScript
compiler without treating an undocumented compiler object as a stable proof
API.

## Decision path

`analyzeTypeScriptControlFlow(fileName, source)` creates a strict TypeScript
program with `noImplicitReturns: true` and records function-local semantic
diagnostics. Diagnostic 2366 or 7030 is positive evidence that the endpoint is
reachable. When a function has value returns, has no fallthrough diagnostic,
and has no other function-local semantic error, the endpoint is classified as
unreachable according to TypeScript's public diagnostic behavior.

This can refine Uneffect's structural CFG. For example, TypeScript recognizes a
switch covering every member of a literal union even when no `default` clause
exists. Widening that discriminant to `string` produces diagnostic 2366 and
keeps the contract runtime fail-closed.

Every analysis records the schema, exact TypeScript version, aggregate and
per-source SHA-256 identities, compiler options, source-qualified function
span and diagnostic codes, both endpoint results, and whether they agree or
TypeScript refines the neutral result. `coverage` counts observed, supported,
and unknown endpoints. Every unknown endpoint has a source-qualified
`exclusions` entry such as `mutable-binding`, `typescript-diagnostic`, or
`endpoint-not-established`. An unrelated semantic error inside the function
makes its endpoint `unknown`.

Stored artifacts can be checked with `parseTypeScriptControlFlowAnalysis` or
`@mizchi/uneffect/schemas/uneffect-typescript-control-flow-v1.schema.json`.
The runtime parser additionally checks aggregate source identity, span bounds,
coverage counts, parity, compiler-compatibility and fallthrough evidence, and
one exclusion for every unknown endpoint.

`analyzeTypeScriptProgramControlFlow(program, sources?)` instead reuses an
existing checked project snapshot. The correspondence is keyed by the actual
declaration nodes owned by that `Program`, never by function names or adjusted
text offsets. The tested fragment includes function declarations,
static-named class methods/accessors, and arrows/function expressions bound
directly to `const`, including expression-bodied arrows. A function value bound with `let`/`var` is
`unknown`, because its runtime identity may be replaced.

Program-backed evidence is compatible only when `noImplicitReturns` is enabled.
Otherwise every endpoint is `unknown` with
`uneffect-incompatible-compiler-options`. Project runtime-assertion generation
creates one compatible Program for all transformed files and reuses it across
the per-file lowering pass.

## Internal CFG observation

TypeScript 6.0.3 exposes `canHaveFlowNode` at runtime and attaches internal
`flowNode` objects after semantic checking, but these are absent from the public
`typescript.d.ts` contract. Uneffect records only whether this internal hook was
available and how many nodes were observed. It does not use internal flags,
IDs, graph formatting, or reachability helpers to authorize instrumentation.

## Remaining boundary

The contract runtime lowers annotations attached to function declarations,
static-named methods/accessors, and directly `const`-bound functions, including
lexically nested declarations and expression-bodied arrows. Getter results and
setter preconditions are supported; setter postconditions are rejected. A
literal computed name is static, while a dynamic computed name is unknown.
Immutable callable alias chains resolve through nested lexical scopes and
TypeChecker symbol identity across imports and re-exports. Direct properties of
a builtin-`Object.freeze` static object literal are also stable when their value
resolves to a source callable. A `const` object destructuring binding preserves
that identity through immutable aliases of the frozen container.
TypeChecker-authenticated module namespace members and their `const` object
destructuring bindings are also stable, covering patterns such as
`import * as fs from "node:fs"`. Project lowering relocates the contract to that
source declaration instead of introducing an identity- or `this`-changing
wrapper. Mutable aliases, unfrozen objects, getters, dynamic properties, and
targets outside the selected source project remain unsupported. Linked
`.uneffect.ts` predicates retain their original source file,
line, column, expression, and AST span through a sidecar provenance map.
Endpoint evidence establishes reachability, not a Hoare postcondition.

The stable-callable resolver is shared by contract CFG lookup, capability and
exception summary lookup, and resource lifecycle lookup. It authenticates both
the standard-library `Object` and `freeze` symbols; a user-defined same-spelled
function is not evidence of immutability. Interface/class method declarations
remain declaration-identified callable boundaries, while arbitrary data
properties require the frozen-literal rule above.

The public compiler behavior is documented by TypeScript's
[`noImplicitReturns`](https://www.typescriptlang.org/tsconfig/noImplicitReturns.html)
and
[`allowUnreachableCode`](https://www.typescriptlang.org/tsconfig/allowUnreachableCode.html)
options. TypeScript does not publish a supported API for retrieving its complete
internal flow graph.

## Oxc syntax observation

The Corsa check path obtains traversal positions from the versioned
`uneffect-syntax-facts/v1` artifact. It binds the file, SHA-256 digest, language,
and installed Oxc parser version. Function boundaries and call, construction,
and property sites each have explicit `complete`, `partial`, or `invalid`
coverage. Computed or otherwise non-static call/construct targets, tagged
templates, dynamic imports, and function boundaries that are not represented
by the normalized contract are emitted as source spans with reason codes rather
than silently disappearing. Anonymous declarations and inline callback
boundaries are retained so their calls are not attributed to an enclosing
named function.

The normalized function fragment is differential-tested against this
TypeScript bridge for declarations with bodies, static class methods/accessors,
directly bound arrows, and function expressions. Corsa check treats a syntax
coverage exclusion as an error because otherwise a hidden call could be
misreported as an empty effect set. Class method calls now retain their class
and method owner. Constructors, object-member functions, computed names, and
non-static effect-bearing sites remain explicit exclusions.
