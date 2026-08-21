# Custom validators and cardinality specialization

Uneffect should allow a project to register a validator for a domain-specific
failure mode, such as accidentally sending the same class of event to Datadog
more than once. A validator is not merely a diagnostic callback. When its proof
succeeds, it may attach a versioned specialization to the function summary;
callers and optimizers can consume that specialization without knowing the
validator's implementation.

The initial acceptance contract is sketched in
`test/acceptance-roadmap.test.ts` as `DatadogOnce`:

```ts
defineUneffectValidator({
  name: "DatadogOnce",
  rule: "at-most-once",
  sink: {
    module: "@datadog/browser-rum",
    export: "datadogRum.addAction",
  },
  specialization: { kind: "call-cardinality", maximum: 1 },
})
```

Source opts in with a normal block comment:

```ts
/* uneffect: validate DatadogOnce */
function report(enabled: boolean) {
  if (enabled) datadogRum.addAction("loaded")
}
```

## Cardinality algebra

The neutral summary uses the finite domain `0 | 1 | many | unknown`.

- sequential composition adds cardinalities, saturating at `many`;
- mutually exclusive branches take their maximum;
- loops become `many` when a non-zero body can repeat;
- direct calls substitute the callee summary;
- recursion and unresolved callback invocation become `unknown` unless a
  stronger invocation contract proves a bound;
- concurrent branches such as `Promise.all` compose all started branches and
  therefore add rather than choose;
- `unknown` cannot satisfy an at-most-once validator.

The first implemented slice covers intraprocedural sequencing, alternatives,
loops, concurrently started call arguments, direct recursion, and callback
parameters without an invocation bound. Aliased, method, and cross-module
calls are the next composition boundary.

Resolved local callees now compose transitively. For generators, ordinary
calls contribute zero because they only construct an iterator; `yield*` and
`for (await) ... of` consume the per-iterator summary. The selected entrypoint
records both its sink upper bound and whether it consumes zero, one, or many
generator instances. Alias, method, re-export, and cross-module parity remains
future work.

A verified `0 | 1` result becomes a proof-grade `call-cardinality`
specialization. Modified source, builtin contracts, validator code/version, or
frontend schema invalidates that evidence.

## Generator semantics

Generator construction does not execute the body. Calls occur as the iterator
is resumed. `yield` retains the yielded operation's summary, and `yield*`
composes the delegated iterator summary. Async generators use the same
cardinality domain with suspension events in the ordered IR.

The bound is first computed per complete consumption of one iterator instance.
Partial consumption can only reduce an upper bound. Consuming two fresh
instances adds their summaries, so two loops over a generator that calls the
sink once produce `many` at the caller. An application-wide claim additionally
needs an explicit entrypoint and a proof that its relevant iterator is consumed
at most once; merely declaring a generator does not establish process-wide
uniqueness.

This preserves the original “main is a composite function” intent: `main`
collects transitive effects and their cardinalities, while Generator syntax is
a compositional source construct rather than a required runtime effect handler.
