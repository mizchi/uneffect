# Fixtures

Each fixture is a small TypeScript file next to the checker output it produces:
`<name>.ts` is the input, `<name>.diag` is the result of `uneffect check --evidence <name>.ts`.
The first `//` line of every source states what the pair demonstrates, and the
report repeats it, so the two files can be read side by side without running
anything.

| directory | what it demonstrates |
| --- | --- |
| `effects/` | declared vs. inferred effects, transitive propagation through calls, scoped authorities, property-level mutation regions, unused and misspelled declarations |
| `contracts/` | Hoare triples Z3 proves, postcondition and loop-invariant counterexamples, and the limits of the verified subset |
| `async/` | floating Promises and `using` disposal errors |

`quality.md` is the generated score of every diagnostic in this corpus against
the rubric in `src/diagnostic-quality.ts`.

Reports are generated, not hand-edited:

```sh
just fixtures         # fail if any .diag or quality.md is out of date
just fixtures-update  # regenerate them
```

See [docs/diagnostics.md](../docs/diagnostics.md) for the diagnostic format and
the message-quality loop.
