# Diagnostics and the fixture corpus

A verifier that answers only "verified" or "counterexample" is hard to adopt: the
reader still has to reconstruct which input breaks the contract, which call
introduced an effect, and what to change. This document describes the diagnostic
format, the `fixtures/` corpus that demonstrates it, and the rubric that keeps
message quality from regressing.

## Diagnostic format

Every checker — effects, contracts, async safety — produces the same reportable
shape (`src/diagnostics.ts`): a code, a severity, a location, the function under
check, one message, and explanation notes. The CLI renders it as:

```
error contract/ensures fixtures/contracts/postcondition-off-by-one.ts:5 in decrement
  message: `ensures result > x` can fail on this return
  5 |   return x - 1;
    |   ^
  rule: every input allowed by requires must leave this return with ensures true
  counterexample: x = 0
  state: result = x - 1 = -1
  still holds: x >= 0 (0 >= 0)
  fails: ensures result > x evaluates to -1 > 0, which is false
  hint: weaken the postcondition, strengthen the precondition, or change the returned expression so the counterexample above cannot occur
```

The note labels are stable and each answers one question:

| label | question it answers |
| --- | --- |
| `rule` | which proof obligation is this, in words |
| `counterexample` | which concrete inputs refute it |
| `state` | what every source-level name (`result`, locals, loop snapshots) becomes under those inputs |
| `still holds` | which assumptions remain true, so the counterexample is reachable |
| `fails` | which sub-clause evaluates false, with the arithmetic already done |
| `because` | which operation or call produced the reported fact |
| `declared` / `inferred` | the declared effect bound and the inferred one |
| `out of authority` | the declared effect shares the constructor but its arguments do not cover the required one |
| `construct` / `binding` | the exact source construct the checker could not verify or is tracking |
| `hint` | what to change next |

Counterexamples are read back from the Z3 model and evaluated over the same
invariant IR that produced the query (`src/contract-explanations.ts`), with exact
rational arithmetic. Loop snapshot variables are displayed as `i@loop` rather
than their generated names. Nothing in a report is SMT-LIB; the raw model stays
available on the diagnostic's `model` field and verification artifact.

Constructs outside the verified subset are located at the offending statement,
not at the first function in the file, and carry the edit that brings them back
into the subset.

## The fixture corpus

`fixtures/` holds one small TypeScript file per capability and per failure mode,
each next to the checker output it produces:

```
fixtures/contracts/postcondition-off-by-one.ts   # the input
fixtures/contracts/postcondition-off-by-one.diag # the output of `uneffect --evidence <file>`
```

Every fixture starts with a `//` line stating what it demonstrates, and that
line is repeated in the report header. Each report ends with the evidence the
run produced — the obligations Z3 proved and the inferred effect summary of every
function with its evidence state — so a fixture that reports no diagnostics still
shows what was checked:

```
$ uneffect --evidence fixtures/contracts/verified-increment.ts
# A Hoare triple Z3 proves: for every x >= 0 the returned value is greater than x.

no diagnostics
0 error(s), 0 warning(s)

evidence:
  proved increment: ensures result > x
  effects increment: no effect (inferred)
```

Reading a pair top to bottom is the fastest way to see what this repository does
and does not check.

`.diag` files are generated, never hand-edited:

```sh
just fixtures         # verify every .diag and the quality report are current
just fixtures-update  # regenerate them after a checker or message change
```

`test/fixtures.test.ts` runs the same check in CI, so a message change that is
not reflected in the corpus fails the integration tier.

## The message-quality loop

`src/diagnostic-quality.ts` scores every diagnostic the corpus produces against
six criteria: `location`, `subject`, `cause`, `evidence`, `action`, and
`plain-language`. Four are marked required and may never regress; all six move
the score. `fixtures/quality.md` is the generated report and is committed, so a
pull request shows what a message change did to the metric.

The threshold is a ratchet at 1.0: every diagnostic in the corpus satisfies every
criterion today. The loop is therefore:

1. add a fixture for a diagnostic that reads poorly, or add a criterion to the
   rubric;
2. run `just fixtures-update` and read `fixtures/quality.md` — the new gap is
   listed per diagnostic;
3. improve the message or its notes until the gap closes;
4. commit the fixtures, the reports, and the regenerated score together.

Because the rubric runs over rendered diagnostics rather than over checker
internals, a new checker inherits it for free: it only has to produce notes that
explain, evidence, and act.
