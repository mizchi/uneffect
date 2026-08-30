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
`Throw`. Dynamic descriptors and computed scopes fail closed. User-defined
effects, remaining builtins, package composition, and TypeChecker identity
checks for capability helpers remain future work.
