# Native workspace summary binding

`@mizchi/uneffect/experimental/workspace/corsa` の `composeCorsaWorkspaceSummaries` は、
提供された requires / ensures / effect summary を指定した cross-project call に結び付ける。
JS TypeScript compiler を使わず、Corsa の宣言同一性と native build-output 検査を利用する。
summary の生成・本体証明・呼出側の事前条件の証明は、この API の役割に含まない。

```ts
import {
  composeCorsaWorkspaceSummaries,
  type CorsaWorkspaceSummary,
} from "@mizchi/uneffect/experimental/workspace/corsa";

const summaries: CorsaWorkspaceSummary[] = await loadReviewedSummaries();
const result = await composeCorsaWorkspaceSummaries({
  configFile: "tsconfig.json",
  summaries,
  calls: [{
    projectFile: "app/tsconfig.json",
    fileName: "app/index.ts",
    span: { start: 120, end: 132 }, // 完全な CallExpression の UTF-16 範囲
  }],
});
```

`loadReviewedSummaries` は利用側で用意する読み込み処理。summary には次を記録する。

- 一意の `id` と producer の `projectFile`。
- producer の検証時点の native compiler `version` / バイナリ `digest`。
- [workspace build-output API](./corsa-build-outputs.md) が返す producer の `inputDigest`。
- 元ソースの `fileName` / SHA-256 `digest` / 宣言全体の `span`（export 修飾子を含む）。
- producer の `evidence` と `claims`。claims の requires / ensures / effects は文字列配列。
  空の effects は効果なしの主張、effects の省略はその主張がないことを表す。

メタデータは summary を作った時点のものを保持する。古い summary に現在の digest を
付け直しても、本体の証明を更新したことにはならない。hash は入力への結び付けであり、
署名や producer の権限・主張の正しさを認証するものではない。

## 検証内容

1. 到達可能な全 project の native 出力を検証する。欠落・改変・古い出力では結び付けない。
2. call が consumer project の入力に含まれ、完全な Oxc span と native snapshot が一致することを確認する。
3. direct import の symbol 自体の宣言を照合し、shadowing や callable alias を除外する。
   可変な export alias は差し替え後も元の関数の型を持ち得るため、シグネチャ一致だけでは採用しない。
4. native resolved signature の元ソース・宣言範囲から参照先 producer を一意に特定する。
   producer 自身の native snapshot でも同じ宣言を確認する。ファイル名の stem や関数名では補完しない。
5. compiler・project 入力・元ソース・宣言範囲が一致する summary を一つだけ採用する。
   `unknown` / `inferred` の summary は採用しない。producer / consumer 内の明示的な
   callable 代入や、その module namespace への書き込みも除外する。
6. 全 binding の収集後に workspace を再検査する。入力・出力・compiler が変わった場合は
   bindings 全体を破棄する。API 呼出中の入力と生成物は静止させること。

結果は `bound` / `unknown` / `not-applicable`。個別の失敗は blockers に返し、独立した binding は
保持する。workspace の観測自体が無効になった場合は全 binding を破棄する。
`calls` に渡していない呼出の coverage は主張しない。

## 証拠の意味と対応範囲

binding の `linkage: "verified"` は native 宣言と生成物の結び付けを表す。
内容の `evidence` は常に `trusted` とし、入力の証拠区分は `producerEvidence` に別途保持する。
`verified` と記録された producer の主張も、この API 自体が証明し直すわけではない。
claims の式・効果はこの段階では解釈しない。後続の解析・証明処理で検証する。
ソース上の代入検査は、実行時の値の不変性を証明するものではない。間接的な書き換えや
他の module の初期化を含む実行時の振る舞いは、後続の whole-program 解析で扱う。

`arguments` は native の仮引数名と呼出元の実引数 span を対応付ける。
式の文字列置換や効果の単純加算を行わず、呼出側の式を後続の解析へ渡せる形にする。

現在は単純な名前付き引数を持つ top-level function の直接 import 呼出に限定する。
native が元ソースまで解決する re-export と import alias は対応する。
method、namespace call、ローカル callable alias、overload、省略・default・rest・spread 引数、
宣言出力だけに解決される呼出は対応範囲外。module 初期化、callback、mutation region、
resource / refinement summary、TS6 の証拠互換、既存 checker / CLI の全面置換も未移行。

検証: `just corsa-migration-gates`。配布 package smoke では JS compiler の読み込みを禁止して実行する。
