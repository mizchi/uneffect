# TypeScript 7 / Corsa 完全移行の実装計画

確認日: 2026-09-07。実装の基準: `97c50e4c`。
対象は native TypeScript 7.0.2、`@corsa-bind/napi` 1.13.1、Oxc parser 0.148.0。

構文・型情報・ビルド検査の土台はある。残る中心は **関数本体の証明、effect の伝播、
各解析ドメイン、公開 API / CLI への統合**。独立した native API が動くことと、
提供機能全体の移行完了は分けて判定する。

この文書は既存機能を維持するための順序と完了条件を定義する。
実測の詳細は [実現性確認](./compiler-migration-feasibility.md)、移行済み API の詳細は
[実装記録](./compiler-migration.md) を参照。未実装機能の管理元は GitHub Issues とし、
下記の工程は [#8](https://github.com/mizchi/uneffect/issues/8) の更新・分割案として扱う。

続行時の進捗: [入口・回帰検証対応表](./compiler-migration-matrix.md) を追加し、
[Boolean / 定数 return の限定本体証明](./corsa-contract-bodies.md) を default check に接続した。
以下の「現在地」の空 artifacts は基準 commit 時点の棚卸し。M0 の API 互換方針、
M1 の既知の差、本体解析の拡張・call summary 生成と呼出側の証明は引き続き未完了。

## 完全移行の定義

1. 本体 package の実行コードと公開 `.d.ts` が JS Compiler API
   `@typescript/typescript6` を必要としない。root、subpath、CLI の対応モードを含む。
2. 現在対応している解析について、診断・証拠区分・coverage・obligation・反例を維持する。
   解析を省略した空配列や `unknown` の増加を、同等性の達成として数えない。
3. Oxc が構文を読み、Corsa が symbol / type identity を供給し、中立 IR と解析器が
   状態遷移・証明を担当する。名前や型の表示文字列で認証を代用しない。
4. TypeScript で書いたソースと開発用の native TypeScript 7 compiler は残す。
   `ts.Program` / `ts.CompilerHost` のオブジェクト互換は、解析結果の互換と別に扱う。

**互換方針の提案:** 本体の入口を project / snapshot / source facts に置き換え、
旧 Program API を維持する場合は別の互換 package に隔離する。
同期 API の非同期化、virtual source、host の寿命、診断の返し方を先に定義し、
破壊的変更として移行ガイド・version 方針を確定してから切り替える。

移行中は TS6 を開発用 oracle として残せる。ただし **リポジトリ全体からの削除** は別の最終工程で、
比較結果を固定 fixture に保存するか oracle を外に移し、CI・bench・smoke の依存も消す。
TS6 の live parity 機能を同じ package に残したまま依存ゼロとはしない。

TS7.0 の公式発表では新しい programmatic API を 7.1 に向けた別 API として説明している。
その予定を旧 API 互換や不足機能の解消の根拠にはせず、この計画は固定版での実測に基づく。
[TypeScript 7.0 公式発表](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)

## 現在地

| 領域 | 使える経路 | 残る境界 |
| --- | --- | --- |
| CFG / workflow / impact | 言語非依存 API | 集約入口の依存整理 |
| spec / DSL / SMT・Quint / property test | Oxc の独立入口、native contract / refinement linking | DSL と実装本体の適合性証明は別 |
| CFG lint / module-order | native CLI と v1/v2 解析 | 安定版 `/module-order` の Program API、workspace checker への統合 |
| callable / type / 到達性 | native signature・型同一性・実在する await 式の型・never/boolean refinement | 任意型の awaited 化、網羅的 switch 等の機能差 |
| build outputs | 単一 project と references の依存順 JS/d.ts 照合 | freshness、map、対応する emit 設定、既存 assurance flags への統合 |
| workspace summary | native 宣言・入力・出力と直接 import 呼出の結び付け | 主張は `trusted`。本体証明、呼出側の事前条件、効果の合成は未実装 |
| default check | 限定された builtin / callable facts | 本体の proof artifacts、ownership、typed arrays、resource 等は未移行 |

`checkCorsaProject` の結果型は `artifacts` / `ownership` / `asyncIterators` /
`resourceProtocols` を空配列に限定し、typed-array obligation も生成しない。
ソースに未移行の注釈を書くだけで旧経路へ自動切替されるわけではない。

`check` が現時点で旧経路を選ぶ条件は次のとおり。

- `--typescript-program` または `--corsa-parity`。
- `--contract-summary`、`--resource-contract`、`--declaration-transforms`、`--module-entry` の指定。
- `--require-build-artifacts` または `--require-exact-build-artifacts`。
- `--project` の設定に project references がある場合。

詳細: [CLI 分岐](../src/cli/check-command.ts)、[native 結果型](../src/frontends/corsa/corsa-check.ts)、
[build-output 境界](./corsa-build-outputs.md)、[summary binding 境界](./corsa-workspace-summaries.md)。

### 直接依存の棚卸し

`src/**/*.ts` の `@typescript/typescript6` 文字列参照は **64 ファイル**。
うち静的 import または遅延 `typescriptRequire` を持つものは **63 ファイル**、
残る 1 ファイルは builtin catalog のメタデータ。type-only のみのファイルはない。
これは直接参照の棚卸しであり、各入口から実際にロードされる数ではない。

| ディレクトリ | import / require を持つファイル数 |
| --- | ---: |
| frontends | 14 |
| effects | 8 |
| project | 7 |
| analysis / async | 6 / 6 |
| contracts | 5 |
| resources | 4 |
| refinement | 3 |
| cli / evidence / modules | 各 2 |
| lint / optimizer / spec / support | 各 1 |

`package.json` は 20 exports 定義（実行入口 18、静的配布 2）を持つ。
root と `/experimental` は旧解析器を再 export し、公開型にも Program が残る。
開発側では `ci/check-public-api.mjs`、`ci/smoke-package.mjs` の旧 consumer 検査、
一部 bench、比較テストも対象。禁止 import 検査の文字列や歴史資料は実行依存と区別する。

## 実装順序と完了条件

### M0: 機能対応表と API 契約を固定する

最初に全 exports / CLI modes を、提供機能・現在の backend・テスト・移行先へ対応付ける。
各行には成功例と隣接する反例、期待する診断・evidence・coverage・artifact を記録する。
旧経路の結果を削除前に固定し、新実装から期待値を再生成しない。

project / snapshot と symbol / type / source span の中立コントラクトを定義する。
UTF-16 座標、compiler と library の revision、異なる snapshot の fact 混入、close 後の利用、
virtual source の扱いを明示する。state とクエリ・解析ロジックを分離する。

**完了条件:** 現在提供する機能に移行先の未割当行がなく、Program 互換方針を確定し、
既存成功例が native 経路で欠ける場合に失敗するテストを用意できる。

### M1: 型・構文・到達性の既知の差を埋める

- 自己検証で見つかった object method / 関数値 property と、文字列・数値 literal の
  member access は Oxc の syntax facts に接続済み。`just dogfood-native` で実コード
  3 ファイルの未対応構文を 50 → 16 件に削減し、意図的な Console 挿入も検出する。
  残る動的キー、object accessor は未移行。
- 共通 `parseOxcSource` の TSX mode を揃える。Oxc 自体は TSX を解析できる。
- 網羅的 union switch の終端判定を移す。現状の安全側の `mayFallThrough` だけでは
  旧経路で成立した契約を証明できない。非網羅・fallthrough・default も比較する。
- 任意型に対する awaited 型取得を実証する。実在する `AwaitExpression` の取得は実装済み。
  `getAwaitedType(type)` RPC は固定版で未提供であり、先頭型引数で代用しない。
- properties、index signature、constraint、well-known symbol の facts を解析器の必要量で
  中立 API にする。`getIndexInfosOfType` 等は native RPC が既にあり、全て upstream 待ちではない。

**完了条件:** 各差分が独立した成功・反例 corpus で解消され、利用する解析器へ接続できる。
実在しない型クエリが必要なら、この段階で upstream 対応または同等な代替クエリを実証する。
native `emit` RPC を待つ必要はなく、既存の隔離 CLI 再出力を再利用する。

### M2: 本体証明と effect の伝播を移す（主な作業量）

**契約:** `contracts/invariant-ir.ts` の Program 依存 lowering を Oxc → 中立 IR に移し、
既存の obligation / solver を再利用する。代入、分岐・合流、loop invariant、例外・finally、
呼出先の requires / ensures、数値の意味を保持する。

**Effects:** call graph、builtin semantic interpreter、region alias、callback、typed Throw、
Promise の伝播を native symbol / signature facts へ接続する。効果の上界、scope、
callback の回数・実行時点、可変 alias、shadowing、getter / Proxy の反例を保持する。

直接呼出の最初の接続は実装済み。選択ファイル内の同期 top-level 宣言を native symbol で
照合し、既存 CFG 固定点エンジンで既知 effect を caller へ伝播する。別名 import、再 export、
再帰を扱い、再代入・隠蔽・未選択の本体は除外する。実コードの `minimumMajor` に挿入した
Console が `nodeCheck` と `runEnvironmentChecks` に届くことを `just dogfood-native` で確認する。
呼出全体の上界は未証明なので、local call の unknown は維持する。callback / object dispatch、
async / generator、builtin の完全性、注釈の検証は引き続き M2 の残作業。

最初の縦断実装は、数値引数と `requires / ensures` を持つ直接呼出の関数を対象にする。
**本体を証明 → producer summary を生成 → 呼出先を照合 → 引数を IR 上で対応付け →
caller の事前条件を証明 → check 結果に返す**、までを通す。
式の文字列置換は行わず、builtin や外部契約の trusted 仮定は証拠に残す。
既存 summary binder の linkage 検証だけで主張を `verified` に昇格させない。

**完了条件:** 対応済み本体解析・効果伝播の corpus が同じ証拠強度で通る。
契約違反・未知の呼出先・入力改変では失敗または明示した未検証となり、空 artifacts で成功しない。
最初の縦断実装の成功だけで M2 全体を完了にしない。

### M3: 残る解析ドメインを移す

| ドメイン | 移すもの | 主な依存 |
| --- | --- | --- |
| ownership / resources / async | disposal symbol、transfer / escape、例外時 cleanup、async iterator、Promise / timer / abort のイベント抽出 | M1 の型 facts、M2 の call / effect facts |
| refinement | projection / action / invariant、handler flow、対応済み recurrence と状態写像 | M2 の本体 IR と証明 |
| typed arrays / machine numbers | view / region identity、window、境界 obligation、数値 brand | M1 の型 facts、M2 の数値・alias 解析 |
| React / Trusted Types | TSX、宣言所有者、hook / ref / callback / sink の既存解析 | M1 の TSX、M2 の effect / identity |
| instrumentation / optimizer / custom validators | 対応済みの証拠消費、source 対応、変換後の挙動 | 上記ドメインの native 証拠 |

**完了条件:** 現在対応する成功例と反例を各ドメインで維持し、既存の CLI / API に返す
データを生成できる。Issue にある将来の解析範囲拡張までは移行の必須条件にしない。

### M4: workspace の証拠を生成・合成する

既存 native build 検査と summary binder を使い、M2 / M3 の証拠を producer / consumer に通す。
effect、module 初期化、callback、mutation region、resource / refinement summary の合成を移す。
overload、method、default / rest / spread、宣言出力へ解決される呼出などは旧対応範囲と照合する。

source → d.ts → runtime の対応、非同一変換の意味対応、build freshness と exact-output flags の
契約を native compiler 基準で定義する。現在の JS/d.ts バイト比較は map や tsbuildinfo、
タイムスタンプ上の freshness の証明ではない。既存の対応設定を単に拒否して移行済みとはしない。
TS6 compiler/version に結び付いた既存 summary は native 証拠から再生成する。

**完了条件:** project references を持つ実例と、古い・欠落・改変出力、producer の変更、
別 compiler、宣言の差し替え、可変 alias の反例が通る。独立 API の検査だけでなく、
workspace の high-level checker / assurance に結果が反映される。

### M5: 公開入口を切り替え、依存を削除する

- root、`/experimental`、`/module-order`、`checkFiles`、project verification を統合する。
  M0 の API 方針に沿って旧 Program 入口を移す。
- 上記 `check` 分岐条件と、`spec temporal` / `resource-model` / `async-model`、
  contract-summary / evidence / ownership 計装など、残る CLI を移す。
- packed package で JS compiler の読み込みを禁止し、全 runtime exports と全対応 CLI mode を実行する。
  公開 `.d.ts` の型依存も検査し、TS6 peer と本体依存を削除する。
- API snapshot 検査、旧 consumer smoke、bench を更新する。TS6 oracle を隔離した後、
  repo 全削除の段階では dev dependency と live parity も外す。

**完了条件:** ドメイン別比較、solver / integration / dogfood、`just ci-fast`、
`just package-check`、リリースに必要な `just release-check` と対象 commit の CI が通る。
native worker の終了・エラー処理、対応 OS / arch、cold / warm の時間・メモリも確認する。
テスト件数だけでは機能同等性を判定しない。

## 次に着手する単位

1. **M0 の対応表と縦断テストの Red**。native の「空の結果で通る」を防ぐ。
2. **M1 の TSX / switch 回帰と必要な型 facts**。任意型の awaited 化は独立して実証する。
3. **M2 の最小本体証明を check 結果まで接続**。追加の binding API より、証拠の生成を優先する。
4. **M2 の call graph / effect propagation**。その後 M3 をドメイン単位で進める。
5. **M4 の workspace 統合 → M5 の切替・削除**。互換 API の設計は M0 から進め、削除は最後に行う。

各単位で探索 → Red → Green → Refactoring を回す。
TSX と switch の修正、契約 lowering と effect propagation は一部並行可能だが、
公開入口の全面切替は下位機能の同等性を確認した後に行う。

## Issues との対応

| Issue | 移行計画での扱い |
| --- | --- |
| [#8 native parity](https://github.com/mizchi/uneffect/issues/8) | 主 epic。旧 Rust bridge / Workhub corpus 中心の本文を現状に更新し、M0〜M5 を実装単位で分割する案。既存の 3〜8 週という見積りを全面移行へ転用しない |
| [#18 module initialization](https://github.com/mizchi/uneffect/issues/18) | 単独 native v1/v2 は実装済み。M4 の workspace 合成と既存の証拠境界を照合する |
| [#70 CLI v2](https://github.com/mizchi/uneffect/issues/70)、[#71 actual await resumption](https://github.com/mizchi/uneffect/issues/71) | open だが該当実装とテストは既にある。新規移植作業として再計上せず、CI・受入条件と Issue 状態を照合する |
| [#64 DSL](https://github.com/mizchi/uneffect/issues/64)、[#25 CFG](https://github.com/mizchi/uneffect/issues/25)、[#24 alias](https://github.com/mizchi/uneffect/issues/24) | 既存部分の移行は必要。追加の言語設計・解析範囲拡張の全完成は前提にしない |
| [#6 typed arrays](https://github.com/mizchi/uneffect/issues/6)、[#10 event loop](https://github.com/mizchi/uneffect/issues/10)、[#16 React](https://github.com/mizchi/uneffect/issues/16)、[#13 optimizer](https://github.com/mizchi/uneffect/issues/13) | 同様に既存実装の移行と将来拡張を分離する |
| [#2 synthesis](https://github.com/mizchi/uneffect/issues/2)、[#4 property tests](https://github.com/mizchi/uneffect/issues/4)、[#5 temporal](https://github.com/mizchi/uneffect/issues/5)、[#7 proof evidence](https://github.com/mizchi/uneffect/issues/7) | 未実装の拡張・研究は移行後も独立して進められる |

Issue の状態は確認日時点。この整理では GitHub の本文・ラベル・open/closed は変更していない。
