# uneffect (feasibility prototype)

既存の TypeScript を Effect ランタイムへ書き換えず、コメントを契約層として副作用と Hoare Triple を静的検査する PoC です。

```ts
/* uneffect: effect Console */
function log() { console.log("hello") }

/* uneffect: requires x >= 0 */
/* uneffect: ensures result > x */
/* uneffect: effect Console */
function inc(x: number) {
  log()
  return x + 1
}
```

`/* uneffect: effect Console | Fetch */` は関数が持つ effect の上限を宣言します。`FsRead`, `FsWrite`, `Console`, `Fetch`, `Dom`, `Mutate<typeof ref>`, `Throw<ErrorType>` と、ローカル関数呼び出しを解析します。推移的に必要な effect の不足は error、宣言したが使われていない effect は warning です。effect が少ない実装は型として許容されるため、unused warning は CLI の終了コードを失敗にしません。`yield` やランタイムラッパーは不要です。

補助情報はすべて通常の `/* ... */` コメントに置き、既存のTypeScript構文とemitを変えません。文法、数値helper、任意のValibot assertionは[段階導入ガイド](./docs/gradual-annotations.md)、Effect TSとの比較は[比較メモ](./docs/effect-ts-comparison.md)を参照してください。

effect の漸進性、Verse を参考にした semantic footprint、Rust/corsa-bind への配置、optimizer が利用できる証明条件は [設計メモ](./docs/effect-system.md) にまとめています。
async phase と inline invalidate の扱い、および Quint と Rust の中立 IR の対応は [形式モデル](./docs/formal-models.md) にまとめています。
英語版の設計文書一覧は [docs](./docs/README.md) を参照してください。

## fixtures

`fixtures/` には入力のソースと、その検査結果 `.diag` を同じ名前で併置しています。1 ファイルが 1 つの機能または 1 つの失敗モードに対応し、先頭の `//` 行がその意図を述べます。

```
fixtures/contracts/postcondition-off-by-one.ts   # 入力
fixtures/contracts/postcondition-off-by-one.diag # `uneffect --evidence <file>` の出力
```

診断は sat/unsat を返すだけではなく、反例を IR 上で評価して意味を説明します。

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

`.diag` は生成物です。検査に成功した場合も、証明した obligation と推論した effect を `evidence:` 節に出力します。`just fixtures` で最新かを検査し、`just fixtures-update` で再生成します。メッセージ自体の質は `fixtures/quality.md` の rubric スコアで評価ループに載せています。詳細は [診断とフィクスチャ](./docs/diagnostics.md) を参照してください。

`requires` / `ensures` / `invariant` は整数論理式です。Z3 で反例が存在しないことを確認します。現状の契約検査は整数、四則演算、比較、論理演算、単純な変数宣言・代入・return、および単純代入だけの while に限定されています。

```sh
just install
just check
just demo
```

## 実現性の判断

コメントを構文拡張せず trivia として読む方式は、既存 TypeScript と互換なまま導入でき、effect の関数間伝播にも十分です。まず TypeScript Compiler API でルールと意味論を固め、その後 AST/シンボル解決アダプタを Corsa/tsgo 側へ移す構成が現実的です。

tsgo 本体の公開 API はまだ未準備です。tsgolint は高速な type-aware lint の実証ですが、独自ルールを npm パッケージとして差し込む安定 API ではありません。corsa-bind は Node/Rust の拡張点を提供しますが 0.x です。このため PoC で直接依存せず、解析結果と検査器を分離しています。

## PoC の限界

- effect source は `console.*`, `fetch`, DOM, Storage, Random, Timer, `throw` の既知パターンのみ。throw型の継承制約はまだ構文推論
- 同一ファイルの function declaration のみ。メソッド、関数値、動的 dispatch、外部モジュールは未対応
- Hoare 検査は整数のみ。分岐、配列、オブジェクト、関数呼び出し、例外、浮動小数点は未対応
- ループは不変条件から終了後状態を導く partial correctness。停止性は証明しない
- コメントは型システムから見えないため、CI lint として強制する想定

次段階は Compiler API を `ProgramAdapter` に隔離し、TypeChecker の symbol identity でモジュール間 call graph を構築することです。その後、同じ検査コアを corsa-bind または tsgolint の native rule frontend に接続できます。
