# TS6 実行時依存の残作業（2026-09-09）

全面移行は保留。今後の新規機能は Oxc/Corsa で開発する。
方針は [AGENTS.md](../AGENTS.md) を参照。

パッケージ名の直接参照数は移行率ではない。互換モジュールへの import 集約は
Compiler API 呼出しの置換ではなく、旧実装には引き続き TS6 が必要。

未リリースのため旧 Program API の互換維持は不要。ただし、各解析機能の削除と
Oxc/Corsa への置換は別であり、機能の対応範囲は回帰テストで確認する。

## 今回完了した経路

- 旧 Program parity API を削除。Oxc/Corsa の `analyzeCorsaBuiltinCalls(sources, frontend)` に置換。
- `--corsa-parity` を削除し、`--corsa-builtins` を native CLI に接続。
- `Map` の誤変換で入力が空になる退行を修正。
- `agree` / `mismatch` の疑似比較を廃止。分類・未分類・構文除外・構文エラーを明示する。
- builtin registry 本体から Program によるパッケージ解決を分離。データの読込みは JS compiler を必要としない。
- package smoke は両 JS compiler の未インストールを確認し、公開エントリポイントから実解析する。
- 公開 `/module-order` を非同期 Oxc/Corsa API に変更。旧 v2 は比較テスト専用 oracle に移し、配布対象から削除。
- native module-order が設定ファイルのエラーを捨てて `verified` と判定する不具合を修正。継承した設定のエラーも保持する。

## 次の置換単位

1. root / experimental の未移行 Program API を native 入力へ変更。公開 `/module-order` は完了済み。
2. 型・binding・CFG を消費する effect / resource / async / contract の各解析を frontend 中立契約へ移す。
3. workspace、出力検査、evidence の Program 依存を native query / build API に接続する。
4. 旧実装と型宣言を削除した後に、互換モジュール・TS6 peer / dev dependency・CI の TS6 oracle を除去する。

検証: `just corsa-builtins-check`、`just corsa-package-check`。分類結果単独は純粋性や検証成功の証拠にはならない。

## 依存が残る実装

| Directory | Count | Files |
| --- | ---: | --- |
| `src/analysis` | 6 | `number-semantics.ts`, `ownership.ts`, `react-semantics.ts`, `trusted-types.ts`, `typed-array-safety.ts`, `typed-array-windows.ts` |
| `src/async` | 6 | `abortable-fetch-product.ts`, `async-iterator-cleanup.ts`, `async-patterns.ts`, `async-safety.ts`, `host-neutral-transitions.ts`, `promise-chains.ts` |
| `src/cli` | 2 | `contract-summary-command.ts`, `evidence-command.ts` |
| `src/contracts` | 5 | `contract-dsl.ts`, `contract-runtime.ts`, `contract-summary.ts`, `contracts.ts`, `invariant-ir.ts` |
| `src/effects` | 7 | `builtin-semantic-interpreter.ts`, `call-graph.ts`, `callable-summary.ts`, `capability-dsl.ts`, `effects.ts`, `iterator-check.ts`, `region-alias.ts` |
| `src/evidence` | 2 | `assumptions.ts`, `evidence.ts` |
| `src/frontends/corsa` | 1 | `corsa-builtin-catalog.ts` |
| `src/frontends` | 2 | `frontend-adapter.ts`, `frontend-parity.ts` |
| `src/frontends/typescript` | 11 | `binding-identity.ts`, `builtin-runtime-binding.ts`, `callable-annotation-owner.ts`, `contract-control-flow.ts`, `declaration-transforms.ts`, `lexical-execution.ts`, `stable-callable.ts`, `static-evaluation.ts`, `typescript-control-flow.ts`, `typescript-project.ts`, `typescript-semantic-query.ts` |
| `src/lint` | 1 | `typescript.ts` |
| `src/modules` | 1 | `module-initialization.ts` |
| `src/optimizer` | 1 | `project-optimizer.ts` |
| `src/project` | 7 | `build-output-integrity.ts`, `check.ts`, `custom-validators.ts`, `project-verification.ts`, `workspace-effects.ts`, `workspace-module-initialization.ts`, `workspace-refinements.ts` |
| `src/refinement` | 3 | `refinement-bindings.ts`, `refinement-dsl.ts`, `refinement-handler-flow.ts` |
| `src/resources` | 4 | `disposal-symbols.ts`, `resource-callable-artifact.ts`, `resource-callable-typescript.ts`, `resource-protocol-typescript.ts` |
| `src/spec` | 1 | `temporal-dsl.ts` |
| `src/support` | 1 | `adoption.ts` |
