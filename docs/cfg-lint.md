# CFG prerequisite lint prototype

This prototype detects operations whose prerequisites are not guaranteed on
every incoming CFG path. The first rule is `initialization-before-use`:
`initialize(x)` provides `initialized`, `use(x)` requires it, and `reset(x)`
revokes it. Ordinary TypeScript type checking does not encode this protocol.

```sh
just cfg-lint examples/dogfood/cfg-lint-initialization.ts ready
just cfg-lint examples/dogfood/cfg-lint-initialization.ts branchMissing
just cfg-lint examples/dogfood/cfg-lint-initialization.ts loopReset --reset reset
just cfg-lint-evaluate
```

The equivalent package command is `uneffect cfg-lint <file.ts> <function>`.
It uses Oxc syntax and Corsa symbol/type queries, with the packaged native
compiler and `@corsa-bind/napi`. It does not load `typescript` or
`@typescript/typescript6`. `--initialize` and `--use` select
source-local function declarations; their defaults are `initialize` and `use`.
`--reset` optionally registers an invalidation operation. The CLI binds argument
zero as the subject. The programmatic adapter accepts an explicit argument index.

CLI output is prototype JSON with the selected rule, file, function, registered
operation assumptions, and one of these outcomes:

| Outcome | Exit | Meaning |
| --- | --- | --- |
| `clean` | 0 | Every reachable modeled use has its prerequisites, under the operation contracts. |
| `findings` | 1 | At least one use lacks a guarantee; diagnostics include rule ID, subject identity, missing facts, and source offsets. |
| `unknown` | 2 | Source/configuration is unsupported, a compiler error exists, or analysis did not complete. No partial diagnostic list is emitted. |

Malformed arguments also exit 2, with usage diagnostics on stderr.
`--budget` is a positive safe integer counting processed analysis steps, including
revisits; the default is 100,000. CFG blocks and individual events are separate
analysis steps. Exhaustion is `unknown`, never `clean`.

## Contracts and responsibilities

`src/lint/contracts.ts` owns the prototype contracts. `input.ts` validates them,
`oxc.ts` extracts source operations and control flow through a narrow semantic
query contract, `corsa.ts` owns the native project and diagnostics lifecycle, and `prerequisites.ts`
maps events into the existing workflow prerequisite checker. That checker uses
the shared CFG fixed-point engine. `tsconfig.cfg-lint.json` verifies that the rule
contracts and execution layer need no compiler or Node ambient types.

The independent `@mizchi/uneffect/experimental/lint` entry exposes the pure rule
engine; `/experimental/lint/corsa` exposes the asynchronous native source adapter.
Neither entry imports the JavaScript TypeScript compiler. These signatures and
the CLI report shape remain experimental:

```ts
import {
  initializationRule, lintPrerequisites,
} from "@mizchi/uneffect/experimental/lint"
import { lowerCorsaRuleCfg } from "@mizchi/uneffect/experimental/lint/corsa"

const lowered = await lowerCorsaRuleCfg({
  fileName: "src/client.ts",
  functionName: "run",
  bindings: [
    { functionName: "prepare", operation: "initialize", argumentIndex: 0 },
    { functionName: "send", operation: "use", argumentIndex: 0 },
  ],
})
const result = lowered.status === "lowered"
  ? lintPrerequisites(lowered.cfg, initializationRule)
  : lowered
```

A `RuleCfg` contains ordered events inside blocks and successor references.
Subjects are stable declaration/region identities, and facts are namespaced by
subject. Every subject starts with no guaranteed facts. Each event checks
`requires` before applying `revokes`, then `provides`. Joins retain only facts
guaranteed on all incoming paths. Diagnostics are collected after convergence;
unreachable operations do not generate findings.

Another rule can use the same engine without compiler changes:

```ts
const publishRule = {
  id: "publish-after-check",
  operations: {
    compile: { provides: ["compiled"] },
    check: { provides: ["checked"] },
    change: { revokes: ["compiled", "checked"] },
    publish: { requires: ["compiled", "checked"] },
  },
}
// Supply events with these operation names via RuleCfg or SourceRuleBinding.
```

Invalid graph/rule shapes, references, and unregistered events produce
`invalid-input` unknown results. Malformed analysis options throw
`TypeError`/`RangeError`. Source extraction also reports invalid bindings and
compiler errors as unknown.

## Registry own-entry policy

`--registry` selects the opt-in `own-property-before-read` rule instead of
initialization operations. It accepts a plain parameter or module `const` name and optional static
property path; operation flags cannot be combined with it.

```sh
just cfg-lint examples/dogfood/cfg-lint-registry.ts unsafe --registry table
just cfg-lint src/evidence/model-replay.ts replayModelCounterexample --registry adapter.actions --project tsconfig.json
just cfg-lint src/support/diagnostics.ts diagnosticHint --registry hints --flow statement --project tsconfig.json
just registry-dogfood
```

The API is `lowerCorsaRegistryReadCfg({ fileName, functionName, registry, flow?, configFile? })`
from `/experimental/lint/corsa`, followed by `lintPrerequisites(cfg, ownPropertyReadRule)`
from `/experimental/lint`. The native diagnostics lifecycle and the shared CFG
prerequisite engine are reused; `registry-reads.ts` authenticates identities and extracts
events, `registry-control-flow.ts` connects statements without owning abstract state,
and `registry-enumeration.ts` authenticates keys from frozen table enumeration.

By default (`--flow expression`), each direct read in the function body requires
an authenticated `Object.hasOwn(table, key)` on the same key in the **same expression**,
unless frozen-table enumeration establishes permanent membership as described below.
It handles ternaries, `&&`, `||`, and negation, using native symbols to distinguish
shadowed identifiers and reject a locally supplied `Object.hasOwn` as a guard.
String/number literals and static key paths such as `step.action` are supported.
For example, `Object.hasOwn(table, key) ? table[key] : undefined` passes, while
`const action = table[key]; if (action) action()` reports the read. This is an
own-before-read policy; it does not prove that a later call is unsafe.

In expression mode, each expression starts without facts. Calls, assignments, awaits, spreads,
coercions, and unrelated property reads conservatively invalidate facts. The
analysis assumes stable data properties for registry/key paths and entries,
primitive string/number keys, unmodified `Object.hasOwn` / `Object.keys` /
`Object.freeze`, and standard array iteration.
It does not establish these runtime assumptions or model getters/proxies. The
CLI records them in `assumptions` with `analysisScope: "expression-local-registry-reads"`.

With `--flow statement`, facts carry through blocks, `if/else`, early `return` /
`throw`, `while`, `do/while`, and unlabeled `break/continue`. For example,
`if (!Object.hasOwn(table, key)) return; return table[key];` passes. Both incoming
paths must guarantee the same binding/key, and mutations or unknown calls revoke
the guarantee. Local variable initializers conservatively revoke facts after
evaluation, because they can rebind an existing `var`. Await also revokes facts.
The CLI reports `analysisScope: "statement-registry-reads"`. Try/catch/finally,
for/for-of/for-in, switch, destructuring declarations, and disposal remain unknown;
destructuring assignments containing selected reads/guards are also unknown because
their interleaved writes and reads require a separate evaluation-order model.
There is no fallback to expression mode when statement lowering fails.

Function-body `const` aliases of the selected table are supported. A capture is a
separate region from the original binding/property path; guards on a replacement
object do not establish facts about the captured object. Chained const captures
share the captured region. Guards should refer to that alias; cross-region facts
are conservatively not transferred even if no reassignment is visible. Mutable
or block-local aliases and selected references in nested functions remain unknown.

Untagged template substitutions are evaluated and coerced left to right. Each
nonliteral substitution conservatively invalidates facts before the next one,
because string conversion can call user code. RegExp literals also invalidate;
literal primitives do not. This can flag a safe string-typed substitution until
primitive type evidence is connected. Tagged templates remain unsupported.

For a module `const` initialized with authenticated `Object.freeze` on a plain
literal table, a `const` key in `for (... of Object.keys(table))` identifies a
permanent own entry. The rule can admit these reads even inside templates and
after unrelated calls. This is a lexical key-provenance fact, available in
expression mode; general for-of statement lowering is still unsupported. Mutable
tables, mutable loop keys, enumeration of another object, and shadowed Object
builtins do not establish that guarantee. It proves property membership only.

Statement-level guards return `unknown` in expression mode.
Class/tagged-template/JSX expressions and computed object property definitions in a
selected expression are also unsupported because implicit execution is not modeled.
No selected direct reads also returns `unknown`, so an empty extraction cannot
claim success. Reads in helpers, parameter defaults, and arbitrary escaping aliases
are not covered. Statement mode excludes paths terminated by return/throw; it does
not correlate separate predicates, and keeps both branches of constant conditions.
Expression mode does not model statement reachability. Findings describe missing
abstract guarantees and can include safe alternative idioms.

`test/registry-read-rule.test.ts` checks the original replay implementation from
`b77d95d0` (frozen as a fixture) and the current actual implementation with
JavaScript TypeScript imports prohibited. It automatically detects the one
historical unguarded registry read and accepts the own-entry fix. This is
rediscovery of a known bug, not a new automatic bug discovery; see
[the dogfood evaluation](./dogfood-evaluation.md).
`test/registry-dogfood.test.ts` additionally checks ten actual function/table selections
with compiler imports blocked. Nine are clean after reviewed source fixes. One
lookup was replaced by a membership check, so no selected reads remain and the
adapter returns `unknown`; this is retained as an empty-extraction control.
Inputs and before/after reports are in `dogfood/registry-*.json`; findings are
reviewed separately from bugs, including the annotation parser regressions.

## Initialization source fragment and trust

The adapter analyzes one top-level synchronous function using Oxc's AST and
Corsa's checker-backed symbol identities. UTF-16 source offsets are preserved. It supports blocks, `if/else`, `while`, `do/while`,
unlabeled loop `break/continue`, bare `return`, and explicit `throw` with a pure
expression. Predicates allow local identifiers, literals, truthiness negation,
strict equality/inequality, and `&&`/`||` of pure operands. Both CFG branches are
kept even for constant conditions.

Direct calls must resolve to the configured source-local function declaration
and return `void`. Their operation semantics are **trusted caller contracts**:
calls are synchronous and affect protocol facts as configured. This prototype
does not establish those facts from operation bodies. Unexpected synchronous
throws terminate the function; catch/finally and asynchronous continuations are
unsupported. The graph proves neither call success nor function termination.

Subjects may be a single used parameter identity, immutable local aliases of it,
or fresh empty-object locals outside loops. Symbol identity distinguishes
shadowed names. Multiple parameter subjects are rejected because callers could
alias them; fresh loop allocations need generation tracking and are rejected.
Parameter reassignment, mutable locals, destructuring, property/getter access,
unregistered calls, callable aliases, reassigned operation bindings in the source,
nested functions, return values/escapes, `for`, `switch`, `try`, `using`/`await using`, async, and
generators remain `unknown`. A registered function's unrelated direct calls in
other functions do not contribute facts to the selected function.

Without `--project`, the CLI checks the file in an isolated ES2024/NodeNext
project with no automatically included ambient `types`. Pass `--project
path/to/tsconfig.json` (API: `configFile`) for project settings such as Node
types, path mappings, and strictness. All project errors block extraction.
`--corsa-executable path` (API: `corsaExecutable`) overrides the packaged native
compiler. Missing native tools produce `frontend-error`; there is no JavaScript
compiler fallback. Temporary projects and semantic snapshots are closed after
each request, and edits to the source during analysis cause `unknown`. Keep the
whole project stable while checking it; concurrent dependency/config edits are
not an atomic snapshot across the diagnostics and semantic processes.

Registered shorthand destructuring writes conservatively produce `unknown` even
when a same-spelled local might shadow the operation: the Corsa position query
cannot authenticate the assignment's value symbol in that syntax.

The optional `lowerTypeScriptRuleCfg(program, options)` adapter remains on the
aggregate `/experimental` entry for compatibility and migration comparison.
That aggregate still loads the TypeScript 6 compiler through other analyzers;
use the independent lint entries when avoiding that dependency.
There is no ESLint/Oxlint adapter or automatic source fix yet.

## Prototype evaluation

`just cfg-lint-evaluate` uses Corsa/Oxc to check ten source fixtures and independently enumerates
concrete states for 256 generated branching/cyclic graphs. The reference
enumerator uses two Boolean initialization flags and no CFG/workflow solver.

| Curated source cases | Result |
| --- | --- |
| Missing branch initialization, zero-iteration loop, reset across loop iterations, shadowed identity | All 4 violations detected. |
| Both-branch initialization, early return, do/while initialization, immutable alias | All 4 accepted. |
| Initialization through a callback | `unknown`. |
| Two correlated checks of the same immutable condition | One known false positive. |

For example, `if (flag) initialize(x); if (flag) use(x)` is safe for a stable
flag, but this must-analysis forgets the relation between the conditions.
`findings` means a missing abstract guarantee, not a demonstrated concrete
execution. These curated counts are not an estimate of general precision or
recall. The generated graph comparison has zero mismatches; it validates the
rule engine's abstraction, not complete TypeScript lowering.

The prototype is useful for custom operation-order checks with explicit
contracts. Next improvements should target correlated predicates, authenticated
imported operation contracts, and source-mapped explanation paths before adding
broader syntax. Run `just cfg-lint-check` for type checks, the shared TypeScript/
Corsa source corpus, native failure cases, and a CLI test that prohibits imports
of both JavaScript TypeScript packages. The packed-package smoke test repeats
the import prohibition and executes the pure engine with optional tools absent.
