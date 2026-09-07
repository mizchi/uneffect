# Native check の限定契約本体証明

`checkCorsaProject` と通常の `uneffect check` は、対応範囲内の関数本体から obligation を作り、
共有 Z3 backend で `requires / ensures` を検証する。JS TypeScript Compiler API は読み込まない。

```ts
/* uneffect:requires enabled */
/* uneffect:ensures result === false */
export function invert(enabled: boolean): boolean {
  return !enabled;
}

/* uneffect:ensures result > 0 */
export function positive(): number {
  return 7;
}
```

`uneffect check input.ts --json` の `contracts` に、成功時の `verified`、違反時の
`counterexample`、solver 障害時の `unknown` を返す。契約違反・未検証があれば終了コードは 1。
`--evidence` にも契約の status を表示する。証明は引数の型と requires を前提とする
関数本体の postcondition であり、実行時の引数検査や呼出側の事前条件証明ではない。

## 現在の対応範囲

- 名前付き top-level function declaration。同期・非 generator・非 generic、overload なし。
- 必須の単純な Boolean 引数。native が認証した `true` / `false` のリテラル型は、
  alias 経由でもその値を前提に残す。名前は ASCII 英数字と `_`、先頭は英字または `_`。
  `result` は返り値を表す予約名。
- 本体は一つの return のみ。Boolean 引数、Boolean literal、非負の safe-integer literal、
  括弧、Boolean の `!` / `&&` / `||`、同じ種類の scalar の `===` / `!==` を扱う。
- 契約式は上記の変数・literal、同種の比較、Boolean 演算。数値比較は定数と定数の返り値に限定する。

数値引数・算術、分岐・代入・loop、呼出・property access、async、method / arrow、
default / optional / rest 引数、`contract_from` の本体証明はまだ対応しない。
対応範囲外の契約注釈は `unsupported` artifact と診断を返す。
別の関数の独立した証明は保持する。文字列中の注釈風テキストは契約として扱わない。

native の project 全体の診断と `noCheck`、Oxc と snapshot の source 一致を検査してから証明する。
project 診断・snapshot 不一致は API エラーとなり、肯定的な結果を返さない。
Oxc が読んだ return の UTF-16 span、source SHA-256、compiler executable SHA-256、binding revision、
`native.coverage: "boolean-and-constant-return"`、solver の version / attempts を artifact に記録する。
`compilerRevision` は Corsa binding の revision であり、native compiler の意味的 version と同一ではない。
検証対象の snapshot の証拠であり、実行時までの source の不変性は主張しない。

effect summary の証拠区分は独立している。本体証明だけで effect を `verified` に上げない。
この artifact を workspace の trusted summary binding に渡す機能、producer summary の生成、
caller の requires 証明・ensures 合成も未実装。

## 実装と検証

- `contracts/verification-contracts.ts`: Program を含まない artifact / 診断の型。
- `contracts/contract-solver.ts`: 中立 obligation の solver 実行と証拠・反例の生成。旧 verifier も共有する。
- `contracts/corsa-contracts.ts`: Oxc の限定 lowering、native signature 認証、snapshot 診断。
- `contracts/contract-annotations.ts`: 契約候補と空 payload の検出。実際の注釈位置は Oxc comments で確認する。

`just corsa-body-check` で固定した Program 結果と native 結果を比較し、成功・違反・未対応・
solver 障害・snapshot 不一致・compiler-free CLI を検証する。
配布 package の API / CLI でも JS compiler を禁止して実行する。
