# Contract-derived property testing

Uneffect can generate standalone Vitest properties from supported `requires`
and `ensures` comments. Generated tests are development artifacts: they do not
change TypeScript emit and add no production runtime dependency.

## Explicit user-predicate specialization

Arbitrary TypeScript predicates cannot be inverted into constructive generators
in general. For one bounded fragment, callers can provide a finite, versioned
candidate universe for an exported source-local unary predicate:

```ts
// metrics.ts
export function isMetricName(value: string): boolean {
  return /^[a-z][a-z0-9_.]{0,31}$/.test(value)
}

/* uneffect: requires isMetricName(name) */
/* uneffect: ensures result === name */
export function metricKey(name: string): string {
  return name
}
```

```ts
generateUneffectPropertyTests({
  files: { "metrics.ts": source },
  predicateSpecializations: {
    "metrics.ts:isMetricName": {
      version: "uneffect-property-predicate/v1",
      values: ["bad space", "requests.total", "a"],
    },
  },
})
```

The registry is a candidate source, not proof that every value is valid. The
generated test imports and calls the real `isMetricName` function, excludes
invalid candidates, and fails if no candidate satisfies the precondition. A
failing value shrinks only toward smaller registered candidates for which the
real precondition still holds and the property still fails.

This fragment requires all of the following:

- the key is the exact `<source file>:<predicate name>` pair;
- the schema is exactly `uneffect-property-predicate/v1`;
- the predicate is an exported function declaration in the same source file;
- it has exactly one identifier parameter;
- the contract is exactly `requires predicate(parameter)`;
- candidates are non-empty primitive values matching the parameter's ordinary
  `string`, `number`, or `boolean` annotation.

Missing registrations, empty universes, non-exported or multi-argument
predicates, nested predicate expressions, cross-file predicates, recursion,
higher-order predicates, and inferred candidate generation remain unsupported.
The Z3 generator does not translate the predicate body; it preserves the
ordinary finite generated-test path instead.

The checked-in Datadog-shaped fixture is
`examples/dogfood/datadog-metric-name.ts`. It demonstrates the integration
shape only; it is not a claim about Datadog's complete naming rules.
