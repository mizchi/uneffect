# Corsa/Oxc 全機能移行の実現性確認

確認日: 2026-09-07。対象コミット: `7589ca03`。
実測環境: Node 24.12.0、`@corsa-bind/napi` 1.13.1、native TypeScript 7.0.2、
比較用 JS TypeScript 6.0.3、Oxc parser 0.148.0。

## 結論

利用者向けの解析・検証機能について、JS TypeScript 実装を恒久的に必要とする
原理的な障害は、今回の調査では見つからなかった。ただし、全機能の移植可能性を
実証した状態ではない。現在の Corsa/Oxc 経路だけでは既存機能を置き換えられず、
追加の native API、解析処理の移植、公開コントラクトの変更が必要。

とくに `ts.Program` / `ts.CompilerHost` を受け渡す API の完全互換、TS6 の出力との
バイト一致、TS6 自体との比較を残したまま JS TS6 を完全削除する、という条件は
そのままでは成立しない。解析機能を維持することと、旧バックエンドのオブジェクト・
観測値・生成物を維持することを分けて移行する必要がある。

調査範囲は package.json の全 18 exports 定義（実行コードの入口 16、静的配布 2）、
root / experimental の再 export、CLI の 10 commands、src の直接依存 64 ファイル。
以下は機能群単位の静的調査と限定した実測であり、全入力・全 solver tier の比較ではない。

## 機能別の判定

「経路あり」は独立した入口で利用できることを意味し、root からの import 独立性や
旧 API の全対応範囲との同等性を意味しない。「見込み」は構成上の判断であり、実証済みではない。

| 提供機能 | 現状と移行の見込み | 残る作業・確認 |
| --- | --- | --- |
| CFG、固定点、completion、workflow の並列待ち合わせ、impact | 言語非依存の経路あり | 既存のグラフ契約を維持する |
| 数値 schema、capability の集合演算、注釈、設定・module manifest、診断整形、doctor | 中核は独立済み／移植可能な見込み | root の依存グラフ、AST を使う周辺の読み取りを分離する |
| spec DSL、SMT/Quint 生成、lint、temporal composition、property test | Oxc の独立経路あり | 全体の package facade を整理。モデル生成と実装の証明を混同しない |
| CFG linter、単独 project の module-order v1/v2 | Corsa/Oxc の独立経路あり | 既存の対象範囲・除外条件を維持。Program 入口は別途置き換え |
| effects、call graph、callback、region alias、typed Throw、builtin semantics | native check は限定範囲。全面移植は可能な見込みだが大きい | 型・宣言の同一性、callback の実行回数・時点、可変 alias、getter/Proxy 等の反例を維持 |
| requires / ensures / loop invariant、機械数、Z3 による本体証明 | DSL・式・obligation・callable linking は移行済み、本体 lowering は未移行 | invariant-ir の状態遷移・合流・ループ・例外・呼び出し条件を Oxc/中立 IR に移す |
| 契約の到達性と runtime 計装 | 構造解析と native never/boolean refinement はあるが、まだ機能差あり | 網羅的 switch、method/arrow/getter 等、契約配置・return 書換えの挙動を維持 |
| refinement の projection / action / invariant / recurrence 証明 | native linking はある。本体解析は未移行で大きい | 対応済みの有限集合、状態写像、handler join、再帰・漸化式の証明を全 corpus で比較 |
| TypedArray / ArrayBuffer / DataView の範囲・window 安全性 | 移植可能な見込み、未実証 | 数値 brand、メモリ view の同一性・alias、境界条件・証明 obligation を維持 |
| Promise ownership、using/dispose、async iterator、resource protocol | モデル評価の中核は独立、抽出は未移行 | awaited 型、well-known symbol、例外時の解放・transfer の native 認証が必要 |
| timer / Promise combinator / abort / host-aware temporal model | モデル生成の中核を再利用できる見込み | async event の順序、再開・reject・callback の抽出を移す。`spec temporal` / `resource-model` / `async-model` は未移行 |
| React functional component、Trusted Types | 未移行。Oxc と native symbol/type で移せる見込み | TSX mode、React/DOM 宣言の所有者認証、hook/ref/callback・sink の反例維持 |
| 証明に基づく assertion 除去、stable read 再利用、project optimizer | 変換の一部は Oxc。証明・全体 orchestration は未移行 | 証拠と変換対象の対応、出力の実行結果、反例時に最適化しないことを維持 |
| workspace、project references、生成宣言の認証、build freshness / exact outputs | native CLI の小規模実測は成功。全体移行は条件付き | native build/emit adapter、隔離再出力、入力→出力対応、config と compiler provenance の再設計 |
| contract/resource summary 配布、assumptions、evidence、baseline、assurance | データ処理は再利用可能。Program binding・version 認証は未移行 | native 宣言と公開 export の認証、compiler version/digest の更新、旧証拠の再生成 |
| custom validator、verifyUneffectProject、checkFiles | 下位機能移行後に再構成する見込み | 現在の集約結果を欠落させない。virtual source/host、計装・transpile、エラーの受け渡しを定義 |
| TypeScriptFrontendAdapter、`*InProgram`、createCheckHost/Program | 現在の API 契約のまま完全独立化は不可 | 中立 project/snapshot API に置換するか、TS6 互換アダプタを別 package に残す |
| frontend/Corsa parity、TS6 internalFlow 観測 | TS6 を観測・比較する機能は TS6 が必要 | 本体から分離して開発用 oracle にする。新しい evidence を旧観測値として偽装しない |

## 実測で確認した障害と代替経路

### 1. Native RPC の不足

固定された native 7.0.2 に Corsa の `callJson` から問い合わせた。

| RPC | 結果 |
| --- | --- |
| `getAwaitedType` | `unknown API method` |
| `emit` | `unknown API method` |
| `getIndexInfosOfType` | string index と値型を取得できた |
| `getBaseConstraintOfType` | 呼出可能。制約のない Promise 型では null |
| `getTypeArguments` | Promise の number 型引数を取得できた |
| `getPropertiesOfType` | then / catch / finally / Symbol.toStringTag の宣言情報を取得できた |

`getAwaitedType` は [invariant-ir](../src/contracts/invariant-ir.ts) の async call と
[disposal-symbols](../src/resources/disposal-symbols.ts) が利用している。
単に Promise の先頭型引数を読む代替では、thenable・union・入れ子の意味を保存できない。
実在する AwaitExpression の型は現在の完全範囲クエリで取得できるが、任意の返り値型を
awaited 型へ変換する用途は別。native endpoint の追加か、同等な型クエリの実証が必要。

名前が一致する RPC も同じ意味とは限らない。旧 checker の
`getIndexTypeOfType(type, IndexKind.String/Number)` に対して、native の同名メソッドは
IndexedAccessType の index 側を取り出すもの。index signature の取得には
`getIndexInfosOfType` を使って key/value 型を対応させる必要がある。

### 2. 新しい到達性解析には既存機能との差がある

次のソースを同じ設定で比較した。

```ts
type Kind = "left" | "right";
export function checked(kind: Kind): number {
  switch (kind) {
    case "left": return 1;
    case "right": return 2;
  }
}
```

- 既存 `analyzeTypeScriptControlFlow`: `endpoint: "unreachable"`。
- 新規 `analyzeCorsaContractControlFlow`: `mayFallThrough: true`。

新規 API は安全側に倒れているが、既存の証明成功を保持できていない。
「never/boolean の移行完了」を「契約の到達性解析全体の同等性」とは扱えない。
また旧実装の endpoint は public diagnostics を主に使う。
`flowNode` の観測数は付随 evidence であり、解析全体が内部 CFG に依存しているわけではない。

### 3. TSX の共通 helper は未対応

`export function View() { return <div />; }` を `view.tsx` として比較した。
Oxc 自体の `{ lang: "tsx" }` は成功したが、共有 `parseOxcSource` は `lang: "ts"` 固定のため拒否した。
`oxc-syntax.ts` はすでに TSX mode を切り替えている。parser 能力の欠如ではなく、
共有 frontend の適用範囲の問題。React 対応を移行済みとする前に統一と回帰検証が必要。

### 4. Build/emit は CLI なら可能だが、証拠の互換性は未実証

native CLI 7.0.2 で以下を確認した。

- 小さな TS project を `--project ... --listEmittedFiles` で JS と d.ts に出力できた。
- この 1 fixture では TS6 の `Program.emit` と両ファイルがバイト一致した。
- 2 project の references を `--build` でビルドできた。
- `--build --dry --verbose` でビルド前の out-of-date、ビルド後の up-to-date を観測できた。

全 compiler option、declaration map、変換済みソースの出力対応、古い生成物の検出まで
確認したわけではない。[build-output-integrity](../src/project/build-output-integrity.ts) と
[workspace-effects](../src/project/workspace-effects.ts) は元の Program と同じ compiler/config
で再出力した内容を期待値としている。native の出力を TS6 の期待値として扱ってはいけない。
compiler provenance を更新し、対応する compiler で成果物・summary を再生成する必要がある。

## 完全移行を判定するゲート

1. awaited 型、型・symbol queries、TSX、網羅的 switch を小さな parity corpus で先に実証する。
2. effects / 本体証明 / resources / refinement ごとに、対応済みの成功例と反例を旧経路と比較する。
   diagnostics だけでなく unknown、evidence、coverage、obligation、counterexample を比較し、
   unknown を増やすだけで移行済みとしない。
3. native build の freshness・再出力・source mapping を、stale/missing/tampered output と
   project references の反例を含めて検証する。
4. Program API、TS6 parity、compiler-version 付き summary の互換方針を確定する。
5. root と CLI の全対応モードを JS compiler 不在の package smoke に通す。
   `checkCorsaProject` は現時点で artifacts / ownership / typedArrays / resourceProtocols 等を
   空で返す限定経路なので、その成功を全 checker の移行証拠にしない。

機能ごとのテスト移植を進める前に、1 と 3 を優先すると「最後に移せない領域が残る」
リスクを早く評価できる。現時点の判断は「全面移行を目指せる構成だが、機能同等性は未確認」。

## 確認元

- [公開 exports](../package.json)、[root API](../src/api/public.ts)、[experimental API](../src/api/all.ts)
- [CLI の切替条件](../src/cli/check-command.ts)、[限定 native check の結果型](../src/frontends/corsa/corsa-check.ts)
- [native callable frontend](../src/frontends/corsa/corsa-callable-frontend.ts)、[Oxc source helper](../src/frontends/oxc/source.ts)
- [旧到達性解析](../src/frontends/typescript/typescript-control-flow.ts)、[既存の網羅性テスト](../test/contract-dsl.test.ts)
- [summary の compiler version 認証](../src/contracts/contract-summary.ts)
- [TypeScript 7.0 公式発表](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/):
  7.0 の stable programmatic API と TS6 API の互換性は保証されていない。
  このプロジェクトは固定版 native の内部 protocol を Corsa から利用している。


## 続行時のゲート実証

`just corsa-migration-gates` として再実行できるテストを追加した。

- 実在する AwaitExpression の native 型は、Promise/thenable/union/ジェネリック等の
  12 ケースで旧 `getAwaitedType` と一致した。不正・再帰・optional then は診断で除外する。
  新しい `getAwaitedExpressionType` はこの範囲を明示し、任意の型を unwrap する API とはしない。
- `/experimental/build/corsa` の限定された単一 project 検査では、欠落・JS/d.ts 改変・
  ビルド後の source 変更を検出した。再出力は consumer の生成物・tsbuildinfo を変更しない。
- NodeNext の package.json 変更を入力 digest に含める。compiler と入力の前後比較も行うが、
  atomic snapshot ではないため検査中に入力を変更しないことが前提。
- 同じ入口の `inspectCorsaWorkspaceBuildOutputs` は references を依存順に検証する。
  solution config と菱形の依存を扱い、producer の欠落・改変・古い出力・診断エラーで
  consumer を `not-checked` にする。単一 project API は references を引き続き拒否する。
- workspace の全 consumer 検査後に producer の入力・生成物・compiler と全 project 設定を
  再確認し、検査途中の変更を検出した場合は先行 project の検証結果も無効にする。
  生成物・tsbuildinfo は変更せず、JS compiler 禁止の package smoke でも動作を確認する。
  詳細と対応範囲は [native build-output API](./corsa-build-outputs.md) を参照。
- `/experimental/workspace/corsa` で、指定された直接 import 呼出に対する contract/effect summary の
  結び付けを追加した。native の元ソース・宣言範囲と producer の input digest を照合し、
  同名関数・古い summary・別 compiler・可変 alias を拒否する。実引数の span も保持する。
  persisted な主張の authority は `trusted` に保ち、本体の証明成功に昇格させない。
  対応範囲は [native workspace summary binding](./corsa-workspace-summaries.md) を参照。

任意の型に対する awaited 変換、全 emit 設定、workspace の本体証明・module/callback/mutation を含む
契約・effect summary の完全な合成証拠は引き続き未解決。
本体コードの旧経路を外す前に、この限定ゲートを対応範囲へ広げる必要がある。
