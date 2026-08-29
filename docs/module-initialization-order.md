# Module initialization order

Effect summaries and ESM evaluation order are separate claims. A `<module>`
summary answers which capabilities may occur in a static import closure. The
module-order analyzer answers which represented initialization events must
happen before others.

```sh
npx uneffect module-order src/main.mts > module-order.json
npx uneffect module-order --require src/main.mts > module-order.json
```

The command emits a `ModuleInitializationOrder` artifact identified by
`schema: "uneffect-module-order/v1"` (and `schemaVersion: 1`). Without
`--require`, an `unknown` artifact is still emitted for inspection and the
command exits 0. `--require` exits 1 unless extraction is proof-grade. Missing
files and malformed CLI arguments exit 2.

The current verified fragment is a source-mapped partial order for an acyclic,
Program-visible static module graph plus one deliberately narrow synchronous
cycle family. It represents:

- a `start` and normal `complete` event for each module;
- static dependency normal completion before importer body start;
- straight-line top-level `await` as `suspend`, followed by an explicit
  `resume` or `reject` choice;
- an unconditional top-level `throw` as terminal, with no normal completion;
- one top-level `main().catch(handler)` expression where `main` resolves by
  TypeChecker identity to a source-local top-level async function, takes no
  arguments, and `catch` resolves to the standard `Promise` member. This emits
  `promise-launch` followed by `rejection-handler-attach` before module
  completion, without emitting a TLA suspension for awaits inside `main`;
- `blockedBy` on importers whose dependency has no normal-completion event;
- a simple ring of two or more modules when every runtime edge inside the ring
  is a side-effect-only import, every member has exactly one runtime dependency,
  and the component has no top-level await, direct/conditional throw,
  class/decorator initialization, dynamic import, or external body;
- the ring's synchronous body execution in DFS postorder, following ECMA-262
  `InnerModuleEvaluation`: dependency requests are traversed in source order,
  a request to an already-evaluating ancestor is a no-op, and synchronous
  `ExecuteModule` occurs while recursion unwinds;
- TypeScript syntax and semantic errors as non-proof-grade input.

Every constraint records its source file/span, semantic rule, and SHA-256 of
the exact Program source. The artifact records the TypeScript version and a
compiler-options digest. A `cycleComponents` entry records the SCC root,
members, execution order, and every internal request/revisit edge. The strict
published schema is `schemas/uneffect-module-order-v1.schema.json`.

This is not a total schedule. It proves only the constraints named in
`claims`. `complete` denotes the normal-completion path; it is not a proof that
arbitrary JavaScript expressions cannot throw. Host timing is excluded.
Sibling dependency start order is currently over-approximated rather than
claimed exactly.

For the supported Promise-launch form, only launch and synchronous handler
attachment are represented. Execution or completion of `main`, effects after
its first suspension, handler execution, process exit, and event-loop queue
selection are explicitly excluded. A bare source-local async `main()` launch
is `unhandled-top-level-promise-launch`. Member, renamed, reassigned,
non-standard-catch, multiple-launch, or mixed TLA/launch shapes remain
proof-grade `unknown` rather than being accepted by spelling.

The artifact remains `unknown` for named/default/namespace/re-export cycles,
self-cycles, branching or multi-edge SCCs, every asynchronous cycle, an
external module body, a dynamic import, control-dependent top-level await or
throw, class/decorator initialization, or TypeScript errors. Runtime-binding
cycles are rejected because TDZ observation is outside the current model.
These boundaries remain in `unknowns` with source spans and do not get
erased by a module effect declaration or a reviewed capability contract.
External initialization contracts can justify may-effects, but cannot justify
evaluation order for code that was not analyzed.

Programmatic project verification opts into the same domain explicitly:

```ts
const result = await verifyUneffectProject({
  files,
  moduleInitializationEntry: entryFile,
})
```

When selected, unknown ordering entries become project assurance blockers in
the `module-initialization` domain. When not selected, project assurance lists
module ordering as an exclusion. This preserves gradual adoption and prevents
ordinary effect checking from silently claiming temporal order.

For a TypeScript solution, the same option may select an entry in a parent
project:

```ts
const result = await verifyUneffectProject({
  projectFile: rootTsconfig,
  moduleInitializationEntry: parentEntry,
  buildArtifacts: "require-exact",
})
```

The initial workspace fragment emits
`uneffect-workspace-module-order/v1`. It accepts exactly one direct
child-project runtime dependency when the consumed declaration is reproduced
byte-for-byte by the child Program, maps uniquely back to one child source,
and that child is one acyclic module with exactly one straight-line top-level
await and normal completion. The importer must be one synchronous acyclic
module with normal completion. The composition retains both raw per-domain
orders, explicitly lists the parent `external-static-import` unknown discharged
by the exact declaration link, and adds only the child `complete` to importer
`start` edge. The child order already contains the `resume | reject` choice, so
rejection has no path to that completion edge.

Conditional/looping await, await followed by unconditional throw, multiple or
transitive child dependencies, transformed declarations, and asynchronous or
multi-module importers remain `unknown`. The strict published composition
schema is `schemas/uneffect-workspace-module-order-v1.schema.json`. This is a
source-semantics claim; exact runtime emit bytes are checked only when the
caller separately requests `buildArtifacts: "require-exact"`.

Still unimplemented:

- synchronous cycles beyond side-effect-import simple rings and every
  top-level-await cycle;
- exact sibling-dependency initiation order while another dependency is
  suspended;
- cross-project TLA beyond one direct child source/declaration link;
- conditional/dynamic import branches and external package bodies;
- decorator application ordering in the same event IR;
- Promise execution after a supported top-level launch and its host-queue
  relationship;
- Quint lowering and bounded schedule checking for this artifact;
- liveness, host scheduling time, and promise settlement guarantees.

The cycle rule follows the current ECMA-262 algorithms for
[`Evaluate` and `InnerModuleEvaluation`](https://tc39.es/ecma262/multipage/ecmascript-language-scripts-and-modules.html#sec-cyclic-module-records-execute-module).
This documentation link is normative provenance; Uneffect does not claim that
its bounded ring fragment implements the full algorithm.
