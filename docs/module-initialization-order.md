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
Program-visible static module graph. It represents:

- a `start` and normal `complete` event for each module;
- static dependency normal completion before importer body start;
- straight-line top-level `await` as `suspend`, followed by an explicit
  `resume` or `reject` choice;
- an unconditional top-level `throw` as terminal, with no normal completion;
- `blockedBy` on importers whose dependency has no normal-completion event;
- TypeScript syntax and semantic errors as non-proof-grade input.

This is not a total schedule. It proves only the constraints named in
`claims`. `complete` denotes the normal-completion path; it is not a proof that
arbitrary JavaScript expressions cannot throw. Host timing is excluded.
Sibling dependency start order is currently over-approximated rather than
claimed exactly.

The artifact remains `unknown` when it encounters a static cycle, an external
module body, a dynamic import, control-dependent top-level await or throw,
class/decorator initialization, or TypeScript errors. These boundaries remain
in `unknowns` with source spans and do not get
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

Still unimplemented:

- exact synchronous and top-level-await evaluation inside cycles;
- exact sibling-dependency initiation order while another dependency is
  suspended;
- conditional/dynamic import branches and external package bodies;
- decorator application ordering in the same event IR;
- Quint lowering and bounded schedule checking for this artifact;
- liveness, host scheduling time, and promise settlement guarantees.
