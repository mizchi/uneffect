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
    pnpm tsx src/spec-cli.ts ir {{ file }}

spec-lint file:
    pnpm tsx src/spec-cli.ts lint {{ file }}

spec-z3 file function="":
    pnpm tsx src/spec-cli.ts z3 {{ file }} {{ function }}

spec-quint file:
    pnpm tsx src/spec-cli.ts quint {{ file }}

spec-compose file function:
    pnpm tsx src/spec-cli.ts compose {{ file }} {{ function }}

spec-async-quint file:
    pnpm tsx src/spec-cli.ts async-quint {{ file }}

spec-promise-quint file:
    pnpm tsx src/spec-cli.ts promise-quint {{ file }}

spec-resource-quint file:
    pnpm tsx src/resource-cli.ts {{ file }}

spec-unified-async file function:
    pnpm tsx src/unified-async-cli.ts {{ file }} {{ function }}

spec-web-event-loop file:
    pnpm tsx src/spec-cli.ts web-loop-quint {{ file }}

spec-node-event-loop file:
    pnpm tsx src/spec-cli.ts node-loop-quint {{ file }}

build:
    pnpm build

demo:
    pnpm tsx src/cli.ts examples/demo.ts

effect-demo:
    pnpm tsx -e 'import { runEffectExample } from "./examples/effect-ts.ts"; runEffectExample(1).then(console.log)'

instrument-demo:
    pnpm tsx src/instrument-cli.ts examples/gradual.ts

instrument-ownership file:
    pnpm tsx src/instrument-cli.ts --ownership {{ file }}

verified-ownership file:
    pnpm tsx src/instrument-cli.ts --verify-ownership --ownership-evidence .uneffect/ownership-evidence.json {{ file }}

evidence file:
    pnpm tsx src/evidence-cli.ts {{ file }}

dogfood:
    pnpm tsx src/cli.ts --infer src/*.ts
    pnpm vitest run test/dogfood.test.ts
