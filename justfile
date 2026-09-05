set shell := ["bash", "-cu"]

install:
    pnpm install

test:
    pnpm test
    cargo test --workspace

bench:
    pnpm bench

check:
    pnpm check
    cargo fmt --all --check
    cargo test --workspace

ci-fast:
    pnpm exec tsc -p tsconfig.json --noEmit
    just examples-check
    just skills-check
    UNEFFECT_CI_TIER=fast pnpm vitest run
    cargo fmt --all --check
    cargo test --workspace

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
    cargo package --workspace --allow-dirty --no-verify

# Full local gate before creating a release tag. Native Z3 permits solver-dense
# suites to use one fresh process per file; CI keeps per-test WASM isolation.
release-check:
    UNEFFECT_Z3_BACKEND=native UNEFFECT_TEST_ISOLATION=file pnpm check
    just examples-check
    just skills-check
    cargo fmt --all --check
    cargo test --workspace
    just build
    just package-check
    git diff --check

spec-ir file:
    pnpm tsx src/cli.ts spec ir {{ file }}

spec-lint file:
    pnpm tsx src/cli.ts spec lint {{ file }}

spec-z3 file function="":
    pnpm tsx src/cli.ts spec z3 {{ file }} {{ function }}

spec-quint file:
    pnpm tsx src/cli.ts spec quint {{ file }}

spec-compose file function:
    pnpm tsx src/cli.ts spec compose {{ file }} {{ function }}

# Canonical host-aware async model.
spec-temporal file runtime="web" root="main":
    pnpm tsx src/cli.ts spec temporal {{ file }} {{ root }} --runtime {{ runtime }}

spec-resource-quint file:
    pnpm tsx src/cli.ts resource-model {{ file }}

spec-unified-async file function:
    pnpm tsx src/cli.ts async-model {{ file }} {{ function }}

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
    pnpm tsx src/cli.ts doctor

demo:
    pnpm tsx src/cli.ts check examples/demo.ts

effect-demo:
    pnpm tsx -e 'import { runEffectExample } from "./examples/effect-ts.ts"; runEffectExample(1).then(console.log)'

instrument-demo:
    pnpm tsx src/cli.ts instrument examples/gradual.ts

instrument-ownership file:
    pnpm tsx src/cli.ts instrument --ownership {{ file }}

verified-ownership file:
    pnpm tsx src/cli.ts instrument --verify-ownership --ownership-evidence .uneffect/ownership-evidence.json {{ file }}

evidence file:
    pnpm tsx src/cli.ts evidence {{ file }}

dogfood:
    pnpm tsx ci/run-test-tiers.ts integration test/dogfood.test.ts

# First constraint-bearing self-check: one leaf utility with explicit pure
# function and module boundaries. Expand this list only after each file has a
# load-bearing negative control in test/dogfood.test.ts.
dogfood-leaf:
    pnpm tsx src/cli.ts check --infer --effect-baseline dogfood/effect-baseline.json src/static-evaluation.ts src/ownership-evidence-cache.ts
    pnpm tsx src/cli.ts check --typescript-program --infer --assurance no-unknown src/static-evaluation.ts src/project-coordinates.ts src/disposal-symbols.ts src/diagnostics.ts src/diagnostic-quality.ts src/cli-support.ts src/cli-runner.ts src/environment.ts src/doctor-command.ts src/todo-consistency.ts src/fixtures.ts src/ownership-evidence-cache.ts src/model-replay.ts src/project-optimizer.ts src/refinement-flow.ts
    pnpm vitest run test/dogfood.test.ts -t "classifies every unknown summary|explicit pure boundary|pure construction|disposal traversal|pure diagnostic|pure CLI helpers|environment report|CLI help formatting|CLI dispatch|doctor environment inspection|TODO hierarchy|fixture discovery|ownership cache keys|model trace loading|persisted optimizer evidence|fixed-point engine"
