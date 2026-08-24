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
    UNEFFECT_CI_TIER=fast pnpm vitest run
    cargo fmt --all --check
    cargo test --workspace

formal:
    pnpm vitest run test/formal-models.test.ts

formal-z3:
    pnpm tsx ci/run-test-tiers.ts z3

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
    cargo package --workspace --allow-dirty --no-verify

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

spec-async-quint file:
    pnpm tsx src/cli.ts spec async-quint {{ file }}

spec-promise-quint file:
    pnpm tsx src/cli.ts spec promise-quint {{ file }}

spec-resource-quint file:
    pnpm tsx src/cli.ts resource-model {{ file }}

spec-unified-async file function:
    pnpm tsx src/cli.ts async-model {{ file }} {{ function }}

spec-web-event-loop file:
    pnpm tsx src/cli.ts spec web-loop-quint {{ file }}

spec-node-event-loop file:
    pnpm tsx src/cli.ts spec node-loop-quint {{ file }}

spec-node-esm-event-loop file:
    pnpm tsx src/cli.ts spec node-loop-quint {{ file }} --node-top-level=esm

build:
    pnpm build

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
    pnpm tsx src/cli.ts check --infer src/*.ts
    pnpm vitest run test/dogfood.test.ts
