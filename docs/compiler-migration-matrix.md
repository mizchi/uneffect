# Compiler 移行の入口・回帰検証対応表

基準: `97c50e4c` に native contract body の最初の slice を追加した状態。
この表の「native」は入口が利用可能という意味で、旧機能全体との同等性ではない。
工程と完了条件は [移行計画](./typescript7-migration-plan.md) を参照。
未リリースのため旧 Program / host API の互換維持は不要。
2026-09-09 の実装依存一覧は [TS6 残作業](./ts6-runtime-remaining.md) を参照。

## Package exports

19 exports 定義を、17 runtime 入口と 2 静的配布に分けて記録する。
表中のテスト名は `test/` 配下。全入口の配布形態は `ci/smoke-package.mjs`、
安定版 API の宣言は `api/public-api-v0.3.json` でも検査する。

| Export | 現在の backend / 境界 | 主な回帰テスト | 残る工程 |
| --- | --- | --- | --- |
| `.` | 集約入口は Program 依存 | `public-surface.test.ts`, `contracts.test.ts` | M2〜M5 |
| `./corsa` | native check。直接呼出・凍結表の静的呼出の既知 effect 伝播、分岐・有限安全整数の限定本体証明 | `corsa-check.test.ts`, `corsa-effect-propagation.test.ts`, `corsa-contract-check.test.ts` | M2〜M5 |
| `./corsa/api` | native semantic facts | `corsa-api-frontend.test.ts` | M1、既存型契約維持 |
| `./experimental` | 集約入口は Program 依存 | `public-surface.test.ts`, `release-readiness.test.ts` | M2〜M5 |
| `./experimental/corsa` | checker exporter と Oxc/Corsa builtin 分類 | `corsa-checker-exporter.test.ts`, `corsa-builtin-calls.test.ts` | TS6 なしの import / CLI テスト済み |
| `./spec` | compiler 非依存の authoring helpers | `public-surface.test.ts` | M5 の package 検査 |
| `./cfg` | 言語非依存 | `cfg-public.test.ts` | 既存契約維持 |
| `./workflow` | 言語非依存 | `graph-api.test.ts`, `workflow-parallel.test.ts` | 既存契約維持 |
| `./impact` | 言語非依存 | `graph-api.test.ts`, `graph-analysis.test.ts` | 既存契約維持 |
| `./module-order` | 非同期 Oxc/Corsa API。設定診断を含む v1/v2 解析 | `module-order-api.test.ts`, `module-order-corsa.test.ts` | workspace checker への統合 |
| `./experimental/lint` | 中立 CFG 上の prerequisite 解析 | `cfg-lint.test.ts` | 既存契約維持 |
| `./experimental/lint/corsa` | Oxc / native 型・symbol | `cfg-lint-corsa.test.ts`, `registry-read-rule.test.ts`, `registry-dogfood.test.ts` | M1、登録表の式内/文間ガードを検査。例外・別名・helper の証明は対象外 |
| `./experimental/spec` | Oxc 解析・生成、native DSL linking / completion | `oxc-spec-migration.test.ts`, `corsa-contract-dsl.test.ts`, `corsa-contract-control-flow.test.ts` | M1 / M2、生成と本体証明を区別 |
| `./experimental/instrument` | Oxc の限定 assertion 挿入 | `oxc-instrument.test.ts` | M3 の証拠消費 |
| `./experimental/corsa/callables` | native signature / type facts | `corsa-callable-frontend.test.ts`, `corsa-awaited-types.test.ts` | M1 の不足 facts |
| `./experimental/build/corsa` | native 再出力比較、references の依存順検査 | `corsa-build-output.test.ts`, `corsa-workspace-build-output.test.ts` | M4 の assurance 統合 |
| `./experimental/workspace/corsa` | trusted summary の宣言・出力・呼出照合 | `corsa-workspace-summaries.test.ts` | M2 / M4 の生成・証明・合成 |
| `./schemas/*` | 静的配布 | `release-readiness.test.ts` | M5 の schema 互換検査 |
| `./package.json` | 静的配布 | `release-readiness.test.ts` | M5 の peer / exports 整理 |

## CLI commands / modes

全 10 commands。`check` の bare-file 呼出も同じ切替条件を持つ。

| Command / mode | 現在の backend | 主な回帰テスト | 残る工程 |
| --- | --- | --- | --- |
| `check` 通常 / files / 単独 project | native。限定本体を検証、直接呼出の既知 effect を伝播。未移行の契約は unsupported | `corsa-check.test.ts`, `corsa-effect-propagation.test.ts`, `corsa-syntax-dogfood.test.ts`, `corsa-contract-check.test.ts` | M2 / M3 |
| `check --corsa-builtins` | Oxc/Corsa builtin 分類 | `corsa-builtin-calls.test.ts` | M0 / M5 |
| `check --contract-summary`, `--resource-contract` | Program | `contract-summary.test.ts`, `resource-callable-artifact.test.ts` | M2 / M3 / M4 |
| `check --declaration-transforms`, `--module-entry` | Program | `workspace-module-initialization.test.ts`, `release-readiness.test.ts` | M4 |
| `check --require-build-artifacts`, `--require-exact-build-artifacts`, project references | Program | `corsa-workspace-build-output.test.ts` と既存 workspace 検査 | M4 / M5、native 単独検査は切替済みを意味しない |
| `doctor` | 環境検査 | `release-readiness.test.ts` | M5 の runtime 要件更新 |
| `spec ir / lint / z3 / quint / compose` | Oxc / solver | `oxc-spec-migration.test.ts`, `temporal-compose.test.ts` | 対応範囲維持 |
| `spec temporal` | 実装イベント抽出は Program | `temporal-dsl.test.ts`, `temporal-async-integration.test.ts` | M3 |
| `instrument` 通常 / ownership | 通常 Oxc、ownership は Program | `oxc-instrument.test.ts`, `instrument.test.ts` | M3 |
| `evidence` | Program | `evidence-optimizer.test.ts` | M2〜M5 |
| `contract-summary` | Program の producer 証明 | `contract-summary.test.ts` | M2 / M4 |
| `module-order --schema-version 1 / 2` | native | `module-order-corsa.test.ts` | M4、境界維持 |
| `cfg-lint` | native | `cfg-lint-cli.test.ts`, `cfg-lint-corsa.test.ts`, `registry-read-rule.test.ts`, `registry-dogfood.test.ts` | `--registry` / `--flow statement`。既知バグの再検出と、別の実コードで新たに2件のバグを再現。前提を JSON に表示 |
| `resource-model` | Program のイベント抽出 | `resource-protocol-typescript.test.ts` | M3 |
| `async-model` | Program のイベント抽出 | `resource-temporal-product.test.ts` | M3 |

## 最初の実行可能な本体比較

`test/fixtures/corsa-contract-body-parity.json` は Program verifier から取得した成功・反例を固定する。
native 側の結果から期待値を再生成しない。比較項目は status、evidence、return span、
関数名・clause・契約本文。compiler や backend 固有の obligation ID の一致は主張しない。

`test/corsa-contract-check.test.ts` では、この比較に加えて未対応構文、誤った型、別 snapshot、
solver 障害、注釈の誤認・空 payload、JS compiler 禁止の CLI を検証する。
この小さな corpus は M2 の本体証明開始の証拠であり、call summary や全ドメインの同等性ではない。

分岐・早期return・ネスト・分岐違反も旧Program版の固定結果に追加した。
新しい `boolean-branching` coverageでは共有CFGが各returnへの経路条件を保持し、
solverがそれぞれの事後条件を検証する。経路予算超過・fallthrough・未対応構文で
空の成功を返さないことも検証する。数値literal型・最大16値のunionには加減算・乗算・符号反転・
大小比較を接続し、`safe-integer-arithmetic` coverageで記録する。本体と契約式の中間値域を検査し、
IEEE 754の丸めが関係する式を無制限の整数算術へ置換しない。
通常のnumber・数値brand・範囲を持つ除算・剰余、分岐内のmutable local、loop本体のnative化は残る。安全な定数除算・剰余、直線形assignment、複数引数の直接呼出契約、連続const束縛は対応済み。
検査済みrequiresと分岐の引数/literal比較は経路別の値域に反映する。
条件の安全性を先に検査し、合流点でも別経路の条件を流用しない。
式内の短絡評価も、検査済み左辺の真偽を右辺の値域へ反映する。変数同士の比較も両辺に反映し、
比較の連鎖を最大16走査で伝播する。1変数への定数加減算・符号反転の比較も、
元の演算を検査してから変数の区間へ逆算する。複数変数の式や有限unionの穴を使った絞込みは残る。

検証: `just corsa-body-check`。全 feature corpus の固定と API 方針の確定は継続する。
