# TypeScript temporal specification modules

Uneffect accepts declarative temporal specifications in `*.uneffect.ts` files.
They are ordinary TypeScript modules, so editors and `tsc` check their state,
initial values, action updates, and predicates. Uneffect reads the TypeScript
AST; it does not import or execute the module.

```ts
import { bool, defineTemporal, int } from "@mizchi/uneffect/spec";

export default defineTemporal({
  state: { attempts: int(), done: bool() },
  init: { attempts: 0, done: false },
  actions: {
    retry: ({ attempts }) => ({ attempts: attempts + 1 }),
    finish: ({ attempts }) => ({ done: attempts >= 1 }),
  },
  guards: { retry: ({ done }) => !done },
  fairness: { retry: "weak" },
  invariants: { nonnegative: ({ attempts }) => attempts >= 0 },
  eventually: { completes: ({ done }) => done },
  responses: {
    retryCompletes: {
      trigger: ({ attempts, done }) => attempts > 0 && !done,
      response: ({ done }) => done,
    },
  },
});
```

The frontend lowers this syntax to Uneffect's backend-neutral `TemporalSpec`.
Quint is one backend; it is not the source language or public semantic
contract. Z3 linting, bounded counterexamples, replay, and future runtime or
property-test backends can consume the same IR.

Connect implementation code to the default export of a nearby specification:

```ts
/* uneffect:temporal_from "./upload.uneffect.ts#default" */
export async function upload() {
  // ordinary TypeScript implementation
}
```

Project verification resolves the path relative to the implementation file,
type-checks the selected project, parses the specification without executing
it, emits a `user-temporal` model, and verifies its safety invariants with the
same Quint pipeline. The first fragment supports exactly one relative
`.uneffect.ts#default` link per implementation file. Missing files, other
exports, malformed references, and duplicate links are errors.

## Supported initial fragment

- scalar `int()`, `bool()`, and `text()` state;
- literal initial state;
- single-expression actions returning a partial state update;
- optional action guards and weak/strong fairness;
- invariants, eventuality, recurrence, stabilization, and response properties;
- expressions already supported by the neutral temporal expression IR.

The parser fails closed on executable top-level statements, computed keys,
block-bodied callbacks, unsupported helper calls, and unknown sections.
Project verification validates `defineTemporal`, `int`, `bool`, and `text`
through TypeChecker symbol identity; same-spelled user helpers are rejected.
The standalone `parseTemporalDsl` text frontend performs only structural import
validation and therefore carries lower assurance.

Collection descriptors and module composition are not implemented yet. Linked liveness
properties are generated into Quint, but project verification currently runs
only the linked safety invariants automatically. Keep `.uneffect.ts` files
outside the production bundle.

## Capability specifications

The same entrypoint supports an initial capability fragment:

```ts
import { Console, Fetch, FsRead, Throw, defineCapability } from "@mizchi/uneffect/spec";

export const LoadConfiguration = defineCapability({
  effects: [
    Console(),
    Fetch({ methods: ["GET"], urls: ["https://api.example.com/**"] }),
    FsRead({ paths: ["$WORKSPACE_ROOT/config/**"] }),
    Throw(TypeError),
  ],
});
```

```ts
/* uneffect:capability_from "./policy.uneffect.ts#LoadConfiguration" */
export async function loadConfiguration() {
  // ordinary TypeScript implementation
}
```

Project verification lowers the selected export to the existing effect IR and
analyzes a derived TypeScript Program containing the equivalent `effect`
annotation. Original source and emitted JavaScript remain unchanged, while the
normal missing-effect and unused-effect diagnostics continue to apply.

The initial fragment supports `Console`, `Fetch`, `FsRead`, `FsWrite`, and
`Throw`. Any registered builtin schema is also available through `Builtin`:

```ts
Builtin("Net", { arguments: [["api.example.com:443"]] })
Builtin("Dom", { arguments: [["AttributeWrite"], ["root"]] })
Builtin("CookieRead")
```

The argument-set count and atom domains come from the existing versioned
`EffectSchema`; URL, path, host, environment, system, token, and region values
therefore retain their normal capability-lattice semantics. `"All"` may replace
one argument set. Project verification checks capability helper identity with
the TypeChecker.

User-defined schemas remain local to one verification invocation:

```ts
const Audit = defineEffectSchema({
  name: "Audit",
  arguments: ["literal", "url"],
});

export const WriteAudit = defineCapability({
  effects: [
    Custom(Audit, {
      arguments: [["metric.write"], ["https://audit.example.com/**"]],
    }),
  ],
});
```

Supported atom domains are `token`, `literal`, `url`, `path`, `host`, `env`,
`sys`, and `region`. The parser passes these schemas explicitly to the effect
checker and never mutates the process-global registry. Conflicting local schema
definitions fail closed. Dynamic descriptors and computed scopes still fail
closed. Cross-package schema evidence and composition remain future work.

## Hoare-style contracts

```ts
import { defineContract, int } from "@mizchi/uneffect/spec";

export const Increment = defineContract({
  parameters: { value: int() },
  returns: int(),
  requires: ({ value }) => value >= 0,
  ensures: ({ value, result }) => result === value + 1,
});
```

```ts
/* uneffect:contract_from "./counter.uneffect.ts#Increment" */
export function increment(value: number): number {
  return value + 1;
}
```

Project verification lowers these predicates to the existing contract IR and
Z3 obligations. A broken implementation produces a source-mapped
counterexample. The initial fragment supports scalar `int()`, `nat()`,
`float()`, and `bool()` parameters/results and non-empty arrays of preconditions
and postconditions.
Project verification checks helper symbol identity and requires parameter names,
scalar domains, arity, and result domain to match the implementation's exact
TypeChecker signature. A linked `nat()` or `float()` parameter additionally
lowers to the existing Valibot `Nat`/`Float` assertion when
`runtimeAssertions: "fallback"` is enabled. In that profile, pure scalar
preconditions and postconditions are also emitted as checks, and `nat()` or
`float()` results receive matching Valibot validation. Multiple branch returns
are instrumented independently, while returns belonging to nested functions are
excluded. In an async function, Uneffect returns a Promise reaction that checks
the fulfilled value. This avoids making a returned rejection catchable by a
surrounding synchronous try/catch; an original rejection propagates without
being reported as a postcondition failure. Calls and property access in
predicates, bare returns, and other unsupported expressions fail closed with
diagnostics.

The structured exit analysis composes return/throw/block/if-else, switch entry
and fallthrough paths, try/catch/finally override, finite and literal-infinite
loops, labels, and targeted break/continue. It remains conservative about
implicit exceptions. TypeChecker-resolved direct calls returning `never` and
conditions with literal `true`/`false` types refine fallthrough; names alone are
never trusted. Generator and AsyncGenerator postconditions apply to the final
return value, not yielded values. Broader semantic reachability remains outside
this runtime claim. TypeScript's public `noImplicitReturns` diagnostics can
additionally refine a structurally open endpoint, including an exhaustive
literal-union switch. Evidence is bound to compiler version, source digest, and
options; any other function-local semantic error makes the result unknown.
Internal `flowNode` data is observed for parity only and never authorizes a
check. A generated failure is a `RangeError` carrying an
`uneffect` object with `fileName`, exact local directive `line`, `column`,
`span`, `kind`, and `expression`. A linked contract currently reports the
materialized implementation-side directive span rather than the originating
`.uneffect.ts` span. Generated async checks necessarily add a Promise reaction
and can affect microtask timing; exact schedule identity is therefore not a
realizable runtime-validation guarantee. The `.uneffect.ts` module is parsed
but never evaluated.
