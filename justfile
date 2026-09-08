set shell := ["bash", "-cu"]

install:
    pnpm install

test:
    pnpm test

cfg-check:
    pnpm exec tsc -p tsconfig.cfg.json
    pnpm vitest run test/cfg-public.test.ts test/refinement-flow.test.ts test/completion-flow.test.ts

graph-check:
    pnpm exec tsc -p tsconfig.graph-analysis.json
    pnpm exec tsc -p bench/graph-analysis/tsconfig.json
    pnpm vitest run test/graph-api.test.ts test/graph-analysis.test.ts test/workflow-parallel.test.ts

module-order-check:
    pnpm exec tsc -p tsconfig.json --noEmit
    pnpm vitest run test/module-order-corsa.test.ts test/module-order-api.test.ts test/module-initialization.test.ts test/module-initialization-v2.test.ts test/module-initialization-domain.test.ts test/workspace-module-initialization.test.ts

graph-evaluate:
    pnpm tsx bench/graph-analysis/evaluate.ts

# Corsa/Oxc migration: syntax parity and compiler-independent specification commands.
spec-frontend-check:
    pnpm exec tsc -p tsconfig.json --noEmit
    pnpm vitest run test/oxc-spec-migration.test.ts test/oxc-dsl-migration.test.ts test/oxc-capability-refinement.test.ts test/corsa-dsl-identities.test.ts test/temporal-expressions.test.ts

instrument-check:
    pnpm exec tsc -p tsconfig.json --noEmit
    pnpm vitest run test/oxc-instrument.test.ts test/instrument.test.ts

corsa-migration-gates:
    pnpm exec tsc -p tsconfig.json --noEmit
    pnpm vitest run test/corsa-awaited-types.test.ts test/corsa-build-output.test.ts test/corsa-workspace-build-output.test.ts test/corsa-workspace-summaries.test.ts test/corsa-callable-frontend.test.ts test/corsa-contract-control-flow.test.ts

corsa-callable-check:
    pnpm exec tsc -p tsconfig.json --noEmit
    pnpm vitest run test/corsa-callable-frontend.test.ts

corsa-contract-check:
    pnpm exec tsc -p tsconfig.json --noEmit
    pnpm vitest run test/corsa-contract-dsl.test.ts test/corsa-callable-frontend.test.ts test/corsa-dsl-identities.test.ts test/oxc-dsl-migration.test.ts

corsa-body-check:
    pnpm exec tsc -p tsconfig.json --noEmit
    pnpm vitest run test/corsa-contract-check.test.ts test/corsa-contract-composition.test.ts

corsa-refinement-check:
    pnpm exec tsc -p tsconfig.json --noEmit
    pnpm vitest run test/corsa-refinement-dsl.test.ts test/refinement-dsl.test.ts test/corsa-callable-frontend.test.ts test/corsa-dsl-identities.test.ts test/oxc-capability-refinement.test.ts

contract-flow-check:
    pnpm exec tsc -p tsconfig.json --noEmit
    pnpm vitest run test/oxc-contract-control-flow.test.ts test/corsa-contract-control-flow.test.ts test/corsa-callable-frontend.test.ts test/contract-control-flow.test.ts test/typescript-control-flow-contract.test.ts

property-frontend-check:
    pnpm exec tsc -p tsconfig.json --noEmit
    pnpm vitest run test/oxc-property-tests.test.ts

cfg-lint-check:
    pnpm exec tsc -p tsconfig.json --noEmit
    pnpm exec tsc -p tsconfig.cfg-lint.json
    pnpm exec tsc -p bench/cfg-lint/tsconfig.json
    pnpm vitest run test/cfg-lint.test.ts test/cfg-lint-typescript.test.ts test/cfg-lint-cli.test.ts test/cfg-lint-corsa.test.ts test/registry-read-rule.test.ts

cfg-lint file function *args:
    pnpm tsx src/cli/index.ts cfg-lint {{quote(file)}} {{quote(function)}} {{args}}

cfg-lint-evaluate:
    pnpm tsx bench/cfg-lint/evaluate.ts

registry-dogfood:
    node --import ./test/hooks/install-reject-js-typescript.mjs --import tsx bench/cfg-lint/registry-dogfood.ts

bench:
    pnpm bench

check:
    pnpm check

ci-fast:
    pnpm exec tsc -p tsconfig.json --noEmit
    pnpm exec tsc -p tsconfig.cfg.json
    pnpm exec tsc -p tsconfig.graph-analysis.json
    pnpm exec tsc -p bench/graph-analysis/tsconfig.json
    pnpm exec tsc -p tsconfig.cfg-lint.json
    pnpm exec tsc -p bench/cfg-lint/tsconfig.json
    just examples-check
    just skills-check
    UNEFFECT_CI_TIER=fast pnpm vitest run

formal:
    pnpm vitest run test/formal-models.test.ts

formal-z3:
    pnpm tsx ci/run-test-tiers.ts z3

formal-z3-stress:
    pnpm tsx ci/run-solver-stress.ts

formal-quint:
    pnpm tsx ci/run-test-tiers.ts quint

formal-integration:
    pnpm tsx ci/run-test-tiers.ts integration

formal-realtime:
    pnpm vitest run test/spec-backends.test.ts -t "guarded real-time"

formal-exhaustive:
    pnpm exec quint verify specs/invalidate.qnt --invariant=cacheIsSound --max-steps=8 --verbosity=1

package-check:
    npm pack --dry-run
    node ci/check-public-api.mjs
    node ci/smoke-package.mjs

# Full local gate before creating a release tag. Native Z3 permits solver-dense
# suites to use one fresh process per file; CI keeps per-test WASM isolation.
release-check:
    UNEFFECT_Z3_BACKEND=native UNEFFECT_TEST_ISOLATION=file pnpm check
    just examples-check
    just skills-check
    just build
    just package-check
    git diff --check

spec-ir file:
    pnpm tsx src/cli/index.ts spec ir {{ file }}

spec-lint file:
    pnpm tsx src/cli/index.ts spec lint {{ file }}

spec-z3 file function="":
    pnpm tsx src/cli/index.ts spec z3 {{ file }} {{ function }}

spec-quint file:
    pnpm tsx src/cli/index.ts spec quint {{ file }}

spec-compose file function:
    pnpm tsx src/cli/index.ts spec compose {{ file }} {{ function }}

# Canonical host-aware async model.
spec-temporal file runtime="web" root="main":
    pnpm tsx src/cli/index.ts spec temporal {{ file }} {{ root }} --runtime {{ runtime }}

spec-resource-quint file:
    pnpm tsx src/cli/index.ts resource-model {{ file }}

spec-unified-async file function:
    pnpm tsx src/cli/index.ts async-model {{ file }} {{ function }}

build:
    pnpm build

examples-check:
    node ci/check-examples.mjs

skills-check:
    node ci/check-skills.mjs

fixtures:
    pnpm tsx ci/fixtures.ts check

fixtures-update:
    pnpm tsx ci/fixtures.ts update

doctor:
    pnpm tsx src/cli/index.ts doctor

demo:
    pnpm tsx src/cli/index.ts check examples/demo.ts

effect-demo:
    pnpm tsx -e 'import { runEffectExample } from "./examples/effect-ts.ts"; runEffectExample(1).then(console.log)'

instrument-demo:
    pnpm tsx src/cli/index.ts instrument examples/gradual.ts

instrument-ownership file:
    pnpm tsx src/cli/index.ts instrument --ownership {{ file }}

verified-ownership file:
    pnpm tsx src/cli/index.ts instrument --verify-ownership --ownership-evidence .uneffect/ownership-evidence.json {{ file }}

evidence file:
    pnpm tsx src/cli/index.ts evidence {{ file }}

dogfood:
    pnpm tsx ci/run-test-tiers.ts integration test/dogfood.test.ts

# Native coverage on real source, mutation controls, and reviewed replay regressions.
dogfood-native:
    pnpm exec tsc -p tsconfig.json --noEmit
    pnpm vitest run test/syntax-facts.test.ts test/corsa-check.test.ts test/corsa-syntax-dogfood.test.ts test/corsa-effect-propagation.test.ts test/corsa-contract-check.test.ts test/model-replay.test.ts test/registry-read-rule.test.ts test/registry-dogfood.test.ts test/registry-source-bugs.test.ts test/temporal-expressions.test.ts test/deno-permissions.test.ts test/annotation-registry.test.ts

# First constraint-bearing self-check: one leaf utility with explicit pure
# function and module boundaries. Expand this list only after each file has a
# load-bearing negative control in test/dogfood.test.ts.
dogfood-leaf:
    pnpm tsx src/cli/index.ts check --infer --effect-baseline dogfood/effect-baseline.json src/frontends/typescript/static-evaluation.ts src/optimizer/ownership-evidence-cache.ts
    pnpm tsx src/cli/index.ts check --typescript-program --infer --assurance no-unknown src/frontends/typescript/static-evaluation.ts src/frontends/typescript/project-coordinates.ts src/resources/disposal-symbols.ts src/support/diagnostics.ts src/support/diagnostic-quality.ts src/cli/cli-support.ts src/cli/cli-runner.ts src/support/environment.ts src/cli/doctor-command.ts src/support/todo-consistency.ts src/support/fixtures.ts src/optimizer/ownership-evidence-cache.ts src/evidence/model-replay.ts src/optimizer/project-optimizer.ts src/cfg/fixed-point.ts src/modules/corsa-module-order.ts
    pnpm vitest run test/dogfood.test.ts -t "classifies every unknown summary|explicit pure boundary|pure construction|disposal traversal|pure diagnostic|pure CLI helpers|environment report|CLI help formatting|CLI dispatch|doctor environment inspection|TODO hierarchy|fixture discovery|ownership cache keys|model trace loading|persisted optimizer evidence|fixed-point engine|conditional TLA dogfood"

# Builtin discovery and classification must run without the JS TypeScript compiler.
corsa-builtins-check:
    pnpm exec tsc -p tsconfig.json --noEmit
    pnpm vitest run test/corsa-builtin-calls.test.ts test/corsa-builtin-catalog.test.ts test/builtin-contracts.test.ts test/release-readiness.test.ts

corsa-package-check:
    node ci/smoke-corsa-no-typescript.mjs
