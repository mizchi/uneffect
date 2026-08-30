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
/* uneffect:temporal from "./upload.uneffect.ts#default" */
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
/* uneffect:capability from "./policy.uneffect.ts#LoadConfiguration" */
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
/* uneffect:contract from "./counter.uneffect.ts#Increment" */
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
`float()` results receive matching Valibot validation. This initial runtime
fragment requires a synchronous function whose discovered exits return values.
Multiple branch returns are instrumented independently, while returns belonging
to nested functions are excluded. Calls, property access, async functions, bare
returns, and other unsupported expressions fail closed with diagnostics.
The supported return/throw/block/if-else fragment must also be shown unable to
fall through; richer CFG exit analysis remains outside this runtime claim. The
`.uneffect.ts` module is parsed but never evaluated.
