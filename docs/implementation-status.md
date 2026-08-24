# Implementation status

This document is the concise, user-facing summary of the completed entries in
`TODO.md`. The checklist remains a historical implementation ledger; open work
is tracked in GitHub Issues and summarized in `roadmap.md`. For a compact view
that puts tested fragments next to their unsupported boundaries, see
`feature-matrix.md`.

The project is an experimental prototype. "Implemented" below means that the
documented fragment has executable regression tests. It does not mean that the
same property is proved for arbitrary TypeScript.

## Annotation and contract surface

- Existing TypeScript remains valid: Uneffect reads only `/* uneffect: ... */`
  block comments and reports malformed or unsupported directives.
- The typed annotation AST separates capability effects, Hoare-style
  preconditions/postconditions/invariants, and temporal specifications.
- Contracts can remain zero-runtime metadata or be emitted as optional runtime
  assertions. Escape hatches are explicit and recorded as assumptions.
- Helper types and values cover `Int`, `Nat`, bounded machine numbers, integer
  casts such as known `Math.floor` cases, and `u8`/`f32` runtime refinements.

## Capability effects

- Effect declarations are checked as upper bounds, propagated through resolved
  call graphs, and diagnosed when declared but unused.
- Builtins are identified by TypeScript symbol identity, including supported
  aliases and namespace imports, rather than by source spelling.
- Structured effects include `Console`, `Fetch`, `Throw`, DOM operations,
  mutation regions, transfer ownership, and Deno-compatible permission
  categories (`FsRead`, `FsWrite`, `Net`, `Env`, `Run`, `Sys`, `Ffi`, and
  `Import`). User-defined, qualified, parameterized effects are supported by a
  versioned schema registry.
- Fetch authority combines method sets, restricted URL patterns, and a separate
  Deno-compatible network-host requirement.
- Filesystem scopes support explicit `$WORKSPACE_ROOT`, `$PACKAGE_ROOT`,
  `$SOURCE_DIR`, `$CWD`, and target-profile `$TEMP` anchors. Separator, dot
  segment, case-policy, and containment normalization are implemented.
- DOM contracts distinguish attribute, node-topology, text, Web IDL property,
  and layout operations from creation, listeners, dispatch, and parsing.
  Authority is based on receiver identity regions; selectors are refinements
  rather than security boundaries. The executable overlay infers a reviewed
  call subset including reviewed attribute/tree/text methods and compound
  clone/normalize/adjacent-content operations, plus reviewed
  attribute-collection and tree-topology reads,
  direct/immutable-alias `NamedNodeMap` origin projection,
  markup serialization/parsing, layout metrics, `Node.textContent`,
  `Node.nodeValue`, `CharacterData.data`, and
  `HTMLInputElement.value` reads and writes. Other ordinary Web IDL properties
  remain open.
- Transferable values are modeled as ownership transitions with invalidation
  and use-after-transfer diagnostics.

## Contracts and formal backends

- A shared typed specification IR generates reviewable SMT-LIB obligations for
  Z3 and reviewable Quint models for temporal checking and simulation.
- The supported Hoare fragment checks integer and machine-number expressions,
  assignments, selected control flow, preconditions, postconditions, and loop
  invariants. Runtime assertion generation is optional.
- Temporal declarations compose calls between modeled functions, preserve
  source locations, and support runtime execution, replay, Z3 lowering, Quint
  generation, and normalized counterexample traces for the documented subset.
- The linter detects syntactic and solver-level constant properties,
  contradictory initial constraints, globally impossible guards, duplicate or
  subsumed properties, bounded unreachability, and several inductively proved
  unreachability cases.
- Bounded invariant synthesis covers boolean polarity, integer sign/order,
  affine relations and conservation laws, and selected record/Set/Map
  equality/subset views. Candidate budgets are explicit.
- Refinement checks connect selected adjacent TypeScript implementations to
  their temporal actions and invariant predicates. Supported forms include
  scalar and nested-record updates, selected native Set/Map operations,
  conditionals, scalar switch fallthrough and direct return/throw entries,
  bounded literal loops, and acyclic symbol-resolved helpers. The
  action-control subset keeps return and throw completion predicates distinct,
  lets catch discharge only the throw paths, and runs a common finally block at
  their shared boundary. Post-try statements run only on the remaining normal
  paths before joining with retained abrupt paths. Catch-local conditional void
  returns and supported pure rethrows are composed through the same predicates.
  Conditional returns and supported pure throws from finally override prior
  completion on exactly their paths. A value-bearing non-call return is
  accepted only when its expression normalizes in the pure refinement fragment;
  its result is not compared with the temporal action. Scalar `int`/`bool`
  throw payloads are retained through direct, conditional `if`, and scalar
  `switch` completion and can bind immutable catch-local predicates. Normalized
  integer and boolean literals are tracked, including switch fallthrough and
  default paths. Switch joins require every selected throwing path to carry a
  tracked payload. Direct and conditionally joined normalized object-literal
  throws may expose fields present on every joined branch through catch-local
  property reads. Missing/dynamic object fields, effectful or unresolved return
  calls, string/null payloads, other
  abrupt finally forms, labels, and arbitrary exception-aware CFGs remain
  unsupported. The opt-in Z3 validator proves equivalent boolean guards and
  integer updates when their normalized syntax differs.
- Evidence artifacts bind source/model inputs, configuration, tool versions,
  and outcomes. They deliberately do not claim to be independently checkable
  proof terms.

## Async, resources, and event loops

- Promise executors, reactions, `await`, `try`/`catch`, floating rejection
  diagnostics, and the major Promise combinators have executable models for
  the documented fragments. The ownership fixed point routes explicit `throw`
  completions and a structured expression fragment proven both `never` and
  `Throw<E>` into the nearest `catch`, including `return fail()` without
  misclassifying it as a completed return. Literal/immutable-const truthiness
  selects supported `&&`, `||`, and ternary paths. Statically nullish literals,
  `void`, global `undefined`, and immutable aliases select a supported `??`
  right side; nullable unions and shadowed identifiers remain unknown.
  Arbitrary expressions still retain a conservative possible-throw catch entry.
- `using` and `await using` track reverse-order disposal, exceptional exits,
  and selected exactly-once lifetime obligations.
- Web and Node event-loop models cover the implemented ordering fragments for
  timers, intervals, microtasks, animation frames, Promise jobs, cancellation,
  and selected Node phases. Host-specific gaps remain explicit.
- Real-time annotations use logical clocks, guards, deadlines, and bounded
  exploration. They are opt-in and are not assumed for ordinary programs.

## Validators, generators, and numeric memory safety

- Registered custom validators can attach proof-backed specializations. The
  call-cardinality lattice tracks `0 | 1 | many | unknown` through supported
  local, cross-module, Generator, and AsyncGenerator call paths.
- Contract-derived property tests support primitive and machine-number
  boundaries, literal unions, records, nested optional presence, and bounded
  arrays, with deterministic counterexamples for the supported subset.
- Typed-array analysis checks supported allocation bounds, index bounds,
  element ranges, bitwise/shift semantics, and optional runtime refinements.
  SHA-256 building blocks are covered, but the complete interprocedural proof
  is not yet available.

## Native integration, CI, and performance

- The analyzer core is separated from frontend adapters. A Rust neutral IR and
  Corsa bridge cover structured declarations and source spans; semantic parity
  with the TypeScript reference frontend is incomplete.
- CI separates unit, Z3, Quint simulation, exhaustive Quint, and integration
  jobs. Dependencies and solver/tool inputs are pinned, and solver-bearing test
  files are process-isolated.
- Diagnostics from every checker share one reportable shape with explanation
  notes: a counterexample is replayed over the invariant IR as concrete values,
  an effect is traced back to the operation that produces it, and a construct
  outside the verified subset is located where it appears. The `fixtures/`
  corpus commits each input next to its `.diag` output, and
  `fixtures/quality.md` scores every diagnostic against a rubric that CI holds
  at its current level.
- The published surface is one `uneffect` binary with subcommands, strict option
  parsing, and uniform exit codes. `uneffect doctor` checks the toolchain a run
  depends on before it is depended on.
- Performance-sensitive paths have Vitest Bench baselines. Benchmarks are
  regression signals, not proof that arbitrary applications will meet a fixed
  latency target.

## Explicit non-claims

- Uneffect does not prove arbitrary TypeScript, termination, arbitrary dynamic
  dispatch, or full JavaScript host behavior.
- A bounded model check or simulation is not reported as an unbounded proof.
- Unsupported syntax, unresolved calls, solver timeouts, and abstraction gaps
  must remain `unknown` or diagnostics; they must not be silently accepted.
- Optimizer transformations require verified evidence for the exact supported
  schema. Only narrow authorization and ownership-assertion-elision prototypes
  exist; a general proof-driven compressor or mangler is not implemented.
