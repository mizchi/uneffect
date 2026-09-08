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

/* uneffect:ensures result === enabled */
export function choose(enabled: boolean): boolean {
  if (enabled) return true;
  return false;
}

/* uneffect:ensures result >= 0 */
export function shifted(value: -2 | 0 | 3): number {
  return value + 2;
}

/* uneffect:ensures result >= 0 */
export function guarded(value: 0 | 9007199254740991): number {
  if (value === 9007199254740991) return 0;
  return value + 1;
}
```

`uneffect check input.ts --json` の `contracts` に、成功時の `verified`、違反時の
`counterexample`、solver 障害時の `unknown` を返す。契約違反・未検証があれば終了コードは 1。
`--evidence` にも契約の status を表示する。証明は引数の型と requires を前提とする
関数本体の postcondition であり、実行時の引数検査や呼出側の事前条件証明ではない。

## 現在の対応範囲

- 名前付き top-level function declaration。同期・非 generator・非 generic、overload なし。
- 必須の単純なBoolean引数と、安全整数の数値literal型・最大16値の有限union。
  nativeが認証したliteral値はimportやalias経由でも前提に残す。
  名前は ASCII 英数字と `_`、先頭は英字または `_`。
  `result` は返り値を表す予約名。
- 本体はreturn、block、Boolean条件の `if/else`、空文。ネストと早期returnを扱う。
  式は引数、Booleanと安全整数literal、括弧、Booleanの `!` / `&&` / `||`、
  同じ種類のscalarの `===` / `!==`、数値の `+` / `-` / `*`・符号反転・大小比較を扱う。
- requiresとensuresにも同じsort・演算範囲の検査を適用する。
- 同一snapshot内の認証済みcalleeを、引数なし・単一return・`ensures`付きの場合に限り
  return式へ1段だけ展開する。

通常の `number`、小数、branded数値型、除算・剰余、代入・loop・switch・例外、
呼出・property access、async、method / arrow、
default / optional / rest 引数、`contract_from` の本体証明はまだ対応しない。
対応範囲外の契約注釈は `unsupported` artifact と診断を返す。
別の関数の独立した証明は保持する。文字列中の注釈風テキストは契約として扱わない。

数値はnativeのliteral payloadと型の構成要素から取得し、表示文字列や型名で推測しない。
本体・requires・ensuresの各演算について、BigIntで計算した値域が安全整数範囲内にあることを
確認してからSMTのIntへ落とす。中間結果が範囲を超える式は、後で小さな値に戻っても
`unsupported` とする。例えば最大安全整数に対する `(value + 2) - 2` はJavaScriptでは
元の値と一致せず、数学的な整数の恒等式として証明してはいけない。

値域検査には、検査済みのrequiresと、その地点までに成立した分岐条件を使う。
引数と整数literalの等値・不等値・大小比較、否定、成立したAND、不成立のORから区間を絞る。
数値変数同士の比較も両辺に反映する。`value < limit` ならvalueの上限をlimitの上限-1へ、
limitの下限をvalueの下限+1へ絞る。等値では区間を交差させ、不等値で値を除外するのは
相手側が1値まで絞られた場合だけである。複数値の相手との不等値から特定の値は除外しない。
比較する両辺には、1回だけ現れる数値変数への定数の加減算と符号反転も使える。
`value + 1 < limit` や `1 - value > 2 - limit` は、検査済みの式を `±変数 + 定数` に
整理して変数の区間へ逆算する。整理と逆算にはBigIntを使い、元の式の中間演算を
省略して安全性を判定しない。先行条件なしに危険な `value + 1` を比較に書いても拒否する。
整数literalが左側にある比較も扱う。成立したORや不成立のANDから片側の条件を仮定せず、
合流点でも経路ごとに検査する。返り値とensuresの値域にもその経路の条件を適用する。

requiresはそれぞれ宣言型の値域から検査を始め、他のrequiresや式全体の成立を根拠に安全とは判断しない。
ifの条件式も、その条件全体が成立することを仮定する前に検査する。
本体・requires・ensures内の `&&` / `||` は左から順に検査する。右辺には `&&` の左辺が真、
`||` の左辺が偽という条件だけを渡す。例えば `value < MAX && value + 1 > value` は
右辺の加算を安全にできるが、左右を入れ替えると左辺の加算を正当化できない。
左辺がBoolean literalで右辺を短絡する場合は、右辺の中間値域検査を省く。
その場合もBoolean同士というsort制約、呼出や除算などの未対応構文の拒否は維持する。
数式や型から必ず短絡すると推論する機能はない。
比較の連鎖を反映するため、条件を最大16回走査し、変化がなくなれば終了する。
有限unionの具体的な値集合も保持し、affine比較を満たす値だけを補助情報として残す。
区間は引き続き過大近似であり、値集合が空になる経路を削除したり、unionの穴から
別の値を生成したりはしない。SMTには元の全union前提を渡す。
矛盾した循環でもこの上限で停止する。上限時の区間も過大近似として利用できるが、
絞込みが不十分で安全な式を拒否する場合はある。SMTには元の比較をそのまま渡す。
複数の変数出現を含む式や乗除算からの絞込み、有限unionの穴を使った区間分割は
未対応なので、安全な式を拒否する場合は残る。矛盾した区間から経路を削除せず、SMTには
元の型と条件を保持する。未到達の式も構文とsortを検査し、中間値域は到達した経路で検査する。
`number` に `0 <= value && value <= 3` を付けても小数を排除できないので、整数とは見なさない。
入力型とrequiresは証明の前提であり、入力を実行時に検査する機能ではない。
0と-0は許可した演算と比較で同じ整数として扱える範囲に限る。符号を観測する
`Object.is` や除算はこのfragmentの対象外である。

分岐は共有CFG固定点エンジンを使って経路条件を合流・伝播し、各returnと各経路について
postcondition obligationを作る。return後の経路とBoolean literalで到達不能な分岐は
証明対象から外す。ただし未対応構文の検査は到達性にかかわらず行う。
returnなしで末尾へ進める場合は `unsupported` とする。requiresや型の制約によって
その経路が実行不能でも、現段階ではfallthroughを許可しない。

上限は512 CFG blocks、1 blockあたり256経路、固定点処理4,096 steps。
予算超過は関数全体を `unsupported / unknown evidence` とし、部分的な成功を返さない。
同じpredicateの繰返しによる矛盾は経路列挙中に除去せず、solverで判定する。
上限の意味は実行時ループの回数制限ではない。

native の project 全体の診断と `noCheck`、Oxc と snapshot の source 一致を検査してから証明する。
project 診断・snapshot 不一致は API エラーとなり、肯定的な結果を返さない。
Oxc が読んだ return の UTF-16 span、source SHA-256、compiler executable SHA-256、binding revision、
数値を含む証拠は `native.coverage: "safe-integer-arithmetic"` として記録する。
Booleanのみの単一returnは従来の `"boolean-and-constant-return"`、文を含む本体は
`"boolean-branching"` を維持する。従来の定数数値returnも、数値の検査を通るため新coverageになる。
solverのversion / attemptsもartifactに保持する。
`compilerRevision` は Corsa binding の revision であり、native compiler の意味的 version と同一ではない。
検証対象の snapshot の証拠であり、実行時までの source の不変性は主張しない。

effect summary の証拠区分は独立している。本体証明だけで effect を `verified` に上げない。
この artifact を workspace の trusted summary binding に渡す機能、producer summary の生成、
caller の requires 証明・ensures 合成も未実装。

## 実装と検証

同一snapshot内でnative signature identityを認証した、単一return・`ensures`付きのcalleeは
引数なしまたは単一引数の場合に1段だけcallerへ展開する。callee側requires、複数段・再帰・
動的dispatchはunsupportedとして扱う。

- `contracts/verification-contracts.ts`: Program を含まない artifact / 診断の型。
- `contracts/contract-solver.ts`: 中立 obligation の solver 実行と証拠・反例の生成。旧 verifier も共有する。
- `contracts/corsa-contracts.ts`: Oxc の限定 lowering、native signature 認証、snapshot 診断。
- `contracts/corsa-contract-flow.ts`: scalar CFGの構築、経路条件の合流と予算、return経路の抽出。
- `contracts/native-scalars.ts`: 本体と契約式に共通のsort・安全整数値域の検査。
- `contracts/native-ranges.ts`: 検査済み条件による区間の絞込み。入力の状態は変更しない。
- `contracts/native-affine.ts`: 検査済みの定数加減算・符号反転の整理。演算自体の安全性は判定しない。
- `contracts/contract-annotations.ts`: 契約候補と空 payload の検出。実際の注釈位置は Oxc comments で確認する。

`just corsa-body-check` で固定した Program 結果と native 結果を比較し、成功・違反・未対応・
solver 障害・snapshot 不一致・compiler-free CLI を検証する。
配布 package の API / CLI でも JS compiler を禁止して実行する。
分岐・早期return・ネスト・分岐違反の4ケースも、旧Program版で生成した固定結果と比較する。
数値unionの加算・分岐・反例の3ケースも、旧Program版に実際のProgramを渡した固定結果と比較する。
