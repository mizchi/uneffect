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

## CLI

公開しているバイナリは `uneffect` 1 本で、機能はサブコマンドです。`uneffect --help` と `uneffect <command> --help` が入口になります。

```sh
npm install --save-dev @mizchi/uneffect typescript
npx uneffect check src/*.ts
```

TypeScript は peer dependency です（解析対象と同じコンパイラを使うため、バージョンは利用側が決めます）。Node.js 24 以降が必要です。

| コマンド | 用途 |
| --- | --- |
| `check <file.ts> [...]` | effect / 契約 / async safety の診断。既定コマンドなので `uneffect <file.ts>` でも走ります |
| `doctor` | 実行前提（Node、peer の TypeScript、`@types/node`、Z3 の WASM、任意の `z3` / `quint` / `java`）の確認 |
| `spec <backend> <file.ts> [function]` | 仕様 IR と各バックエンド向けプログラム（`ir` `lint` `z3` `quint` `compose` `async-quint` `web-loop-quint` `node-loop-quint` `promise-quint`） |
| `instrument <file.ts>` | 契約・所有権のランタイムアサーションを挿入したソース |
| `evidence <file.ts>` | effect の evidence artifact（JSON） |
| `resource-model <file.ts>` | resource safety の Quint モデル |
| `async-model <file.ts> <function>` | Promise / 例外 / リソースを統合した Quint モデル |

前提が多いので、動かす前に `uneffect doctor` で環境を確認できます。各項目が「何に必要か」と「どう直すか」を出し、必須が欠けていれば終了コード 1、任意ツールが無いだけなら警告扱いで 0 です（`--json` で機械可読、`--skip-solver-probe` で遅い Z3 WASM の起動確認を省略）。

生成物は stdout、診断は stderr に出ます。終了コードは 0 =問題なし、1 =検査対象に問題あり、2 =コマンドラインが不正です。オプションは厳密に検査するので、`--stict` のような打ち間違いは黙って無視されず usage エラーになります。詳細は [CLI ドキュメント](./docs/cli.md) を参照してください。

開発時は just を使います。

```sh
just install
just check
just demo
```

## 実現性の判断

コメントを構文拡張せず trivia として読む方式は、既存 TypeScript と互換なまま導入でき、effect の関数間伝播にも十分です。まず TypeScript Compiler API でルールと意味論を固め、その後 AST/シンボル解決アダプタを Corsa/tsgo 側へ移す構成が現実的です。

tsgo 本体の公開 API はまだ未準備です。tsgolint は高速な type-aware lint の実証ですが、独自ルールを npm パッケージとして差し込む安定 API ではありません。corsa-bind は Node/Rust の拡張点を提供しますが 0.x です。このため PoC で直接依存せず、解析結果と検査器を分離しています。

## PoC の限界

Uneffect は広い TypeScript/JavaScript 全体を証明するものではありません。
現在の実装は、各ドキュメントで明示した構文・型・制御フローの断片に対してのみ
回帰テストを持つ実現性プロトタイプです。動的 dispatch、Proxy/Reflection、未知の
alias、一般の例外付きCFG、完全なホストイベントループ、停止性、SharedArrayBufferの
メモリモデルは保守的な `unknown` または診断になります。Z3/Quintの実行結果は
再現可能な evidence ですが、独立検証可能な proof certificate ではありません。

実装済み範囲と明示的な非保証は[Implementation status](./docs/implementation-status.md)、
未実装項目と優先順位は[Roadmap and known gaps](./docs/roadmap.md)、詳細な履歴は
[TODO.md](./TODO.md)を参照してください。今後の作業はGitHub Issuesを正本とします。

## License

MIT
