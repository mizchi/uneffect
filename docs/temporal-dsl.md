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
Collection descriptors, module composition, and TypeChecker symbol-identity
validation of authoring helpers are not implemented yet. Linked liveness
properties are generated into Quint, but project verification currently runs
only the linked safety invariants automatically. Keep `.uneffect.ts` files
outside the production bundle.
