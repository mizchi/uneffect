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

Every analysis records the schema, exact TypeScript version, SHA-256 source
digest, compiler options, function span and diagnostic codes, both endpoint
results, and whether they agree or TypeScript refines the neutral result. An
unrelated semantic error inside the function makes its endpoint `unknown`.

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
resolves to a source callable. Project lowering relocates the contract to that
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
