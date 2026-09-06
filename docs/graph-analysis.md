# Supported workflow and dependency-impact APIs

`@mizchi/uneffect/workflow` and `@mizchi/uneffect/impact` are public supported
entrypoints. Their exported functions and types follow the same pre-1.0
compatibility policy as the other public facades. They do not require an
experimental import or feature flag. Support covers the finite graph models
defined here, not arbitrary workflow engines or complete build-system behavior.

Both implementations use the reusable CFG core and standard ECMAScript only.
They have no compiler, native binding, Node builtin or solver-backend imports.
Installing Uneffect still installs the package's other declared dependencies.

## Workflow preflight

```ts
import { verifyWorkflow, type Workflow } from "@mizchi/uneffect/workflow";

const release: Workflow = {
  entry: "prepare",
  steps: [
    { id: "prepare", kind: "fork", join: "ready", next: ["build", "review"] },
    { id: "build", provides: ["artifact"], next: ["ready"] },
    { id: "review", provides: ["approved"], next: ["ready"] },
    { id: "ready", kind: "join", fork: "prepare",
      requires: ["artifact", "approved"], next: ["publish"] },
    { id: "publish", requires: ["artifact", "approved"], next: [] },
  ],
};

const result = verifyWorkflow(release);
if (result.status === "unknown") {
  console.error(result.reason, result.detail);
} else {
  console.log(result.status, result.diagnostics);
}
```

An ordinary action (`kind: "action"`, or no kind) chooses one alternative in
`next`. A fork starts all of its distinct `next` branches. Its paired join waits
for an arrival from every branch before executing once. Nested forks restore
their parent branch; repeated completed activations do not reuse old arrivals.
Only one activation of a static fork ID can be live at a time. Cross-scope joins
and overlapping activation of that same fork are rejected as `invalid-input`.

Facts are Boolean names. Requirements are checked before a step executes; the
step then removes `revokes` and adds `provides`, so a fact listed in both is
provided. A missing requirement is a diagnostic, not a guard that disables a
transition. Action effects are atomic and shared between parallel branches.
Every possible ordering of enabled steps is considered. Outputs provided on
successful execution and failure alternatives must be modeled explicitly.

For sequential graphs, guaranteed facts are intersected across alternative
paths. Parallel graphs retain complete fact/token configurations to preserve
correlation between alternatives and activations. A `valid` result establishes
requirements at all enabled steps, and that each active barrier remains reachable
from every reachable configuration. It does not guarantee eventual scheduling,
termination, fairness, timeouts, cancellation, or truth of declared facts.

### Results and diagnostics

- `valid` / `invalid`: the analysis completed. `guaranteed` is a `ReadonlyMap`
  from step ID to sorted guaranteed facts at enabled step entry. `unreachable`
  lists steps that cannot execute (including joins that only receive some arrivals).
- `unknown`: malformed input, unsupported activation scope, or a work/state limit
  prevented a verdict. `reason`, `detail`, and `iterations` are available; no
  diagnostics or partial guarantees are exposed as a completed result.
- `kind: "missing-prerequisite"`: `step` and sorted `missing` facts.
- `kind: "blocked-join"`: `step`, owning `fork`, and `waitingFor` branch entry IDs
  in one reachable configuration from which that join is no longer reachable.
  Dead ends and closed cycles are included. A later failed barrier does not
  invalidate an earlier barrier that can execute.

Blocked diagnostics choose one representative per fork, maximizing arrivals and
breaking ties lexically; they are not a union of incompatible execution paths.
Diagnostic discriminants and field meanings are the contract; explanatory
`detail` strings and iteration counts are not stable text/performance APIs.

### Input and resource limits

`parseWorkflow(input: unknown)` validates JSON-compatible input shape and returns
an independent, normalized copy. Unknown fields, unsupported kinds, invalid or
empty names, wrong types, sparse arrays, null optional fields, and duplicate
successors throw `TypeError`. Graph references and scope are checked by
`verifyWorkflow`, which also performs shape validation when called directly and
returns `unknown` / `invalid-input` for bad models. It never silently ignores
misspellings such as `require` instead of `requires`.

The optional fields are `initial` and each step's `kind`, `requires`, `provides`,
and `revokes`. A fork must additionally declare `join`; a join must declare
`fork`. Those fields are rejected on other kinds. Fact lists are deduplicated;
node IDs must be unique. Input order has no semantic significance and is
normalized before analysis. Caller data is not mutated.

`verifyWorkflow(workflow, options?)` accepts:

| Option | Default | Meaning |
| --- | ---: | --- |
| `budget` | 100,000 | Processed CFG blocks; for parallel models, includes expanded configurations and reverse reachability work. |
| `maxConfigurations` | 10,000 | Maximum parallel configurations retained. |
| `maxTransitions` | 100,000 | Maximum parallel execution transitions explored, including transitions to already-known configurations. |

All explicitly supplied limits must be positive safe integers, even on
sequential-only models. Invalid numeric limits throw `RangeError`; unknown
option names or a malformed options object throw `TypeError`. Configuration
and transition limits apply to parallel exploration. Exceeding either yields
`unknown` / `state-space-exhausted`; work exhaustion yields
`unknown` / `proof-budget-exhausted`. None is a wall-clock guarantee. The state
space grows exponentially with parallelism and facts.

## Dependency impact

```ts
import { analyzeImpact } from "@mizchi/uneffect/impact";

const result = analyzeImpact([
  { id: "schema", dependencies: [] },
  { id: "client", dependencies: ["schema"] },
  { id: "app", dependencies: ["client"] },
  { id: "docs", dependencies: [] },
], ["schema"]);
// analyzed: schema, client and app carry cause "schema"; docs is unaffected.
```

Dependencies point from a consumer to its inputs; impact propagates towards
consumers. The result includes the changed nodes themselves, sorted affected
nodes with individual change origins, and sorted unaffected IDs. Cycles and
multiple changes are supported. Duplicate dependencies and change seeds are
deduplicated. Unknown changed nodes, missing dependencies, duplicate/empty IDs,
or malformed input produce `unknown` / `invalid-input`.

`parseDependencyGraph(input: unknown)` is the strict shape parser; it returns an
independent copy and throws `TypeError` on malformed shapes. `analyzeImpact`
also validates its input, returning `unknown` rather than an empty impact plan
on invalid models. Its sole option is `budget`, with the same limit/error rules
as above. Empty graphs with no changes are valid.

Impact is potential reachability in the supplied dependency graph, not a promise
that output bytes change, a rebuild order, or permission to skip real CI checks.
Extraction of build inputs, package resolution, environment/configuration edges,
and deleted-file handling belongs to the caller. The repository import scanner
under `bench/graph-analysis` is an evaluation adapter, not a supported build resolver.

## Qualification and maintenance

The API inventory is snapshotted alongside the existing public entrypoints.
An installed tarball consumer typechecks both facades, executes a parallel
release and its missing-arrival mutation, checks input and resource failures,
and executes impact analysis while its loader rejects imports outside the
graph-analysis/CFG directories. Compiler peers and native bindings are absent.

The regression suite retains malformed-input controls and independent
comparisons: 128 dependency graphs, 128 finite sequential models, and 128 parallel
models spanning 2,752 schedules. Nested scopes, repeated activations, stale
arrivals, revocation races, and blocked loops have focused controls. This
qualifies the documented model; it does not promote the package's separate
research/experimental language semantics.

```sh
just graph-check
just graph-evaluate > /tmp/uneffect-graph-evaluation.json
just package-check
```

See the [evaluation history](./cfg-prototype-evaluation.md) for the initial
application results and comparison with ordinary graph traversal.
