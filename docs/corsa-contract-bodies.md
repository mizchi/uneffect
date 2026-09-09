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
関数本体の postcondition を検証する。対応する関数呼出には別途 `requires` obligationを作る。
実行時の引数検査は挿入しない。

## 現在の対応範囲

- 名前付き top-level function declaration。同期・非 generator・非 generic、overload なし。
- 必須の単純なBoolean引数と、安全整数の数値literal型・最大16値の有限union。
  nativeが認証したliteral値はimportやalias経由でも前提に残す。
  名前は ASCII 英数字と `_`、先頭は英字または `_`。
  `result` は返り値を表す予約名。
- 本体はreturn、block、Boolean条件の `if/else`、空文。ネストと早期returnを扱う。
  三項演算子も使える（括弧・ネスト、演算・引数・初期化式・条件式への埋込みを含む）。
  式は引数、Booleanと安全整数literal、括弧、Booleanの `!` / `&&` / `||`、
  同じ種類のscalarの `===` / `!==`、数値の `+` / `-` / `*`・符号反転・大小比較を扱う。
- requiresとensuresにも同じsort・演算範囲の検査を適用する。
- 分岐の前に宣言したconstを展開する。初期化式は宣言時点で検査し、後続の分岐条件を借りない。
  初期化済みの変数宣言から始まる直線的な本体では単純代入と対応する複合代入も扱う。
  分岐内部の局所宣言・代入による状態の合流は未対応。
- 同一snapshot内の `ensures`付きcalleeを、0〜8個の必須引数で最大2段展開する。
  calleeの本体はreturn、block、if/else、空文から構成でき、ネストと早期returnを扱う。
  callee冒頭に並ぶ、単純な識別子の初期化済みconst/let宣言と、local letへの代入も展開する。
  wrapperのreturn式では、呼出結果へのscalar演算、複数の呼出、`&&` / `||` による短絡、三項を扱う。
  引数内の呼出も先に評価して展開する。未使用引数の検査は省略しない。
  直接呼出と名前付きimport（import時の改名を含む）をCorsaの宣言identityで照合する。
  詳細は下の「別ファイルの関数呼出」を参照。

通常の `number`、小数、branded数値型、一般の除算・剰余、分岐内部の代入・loop・switch・例外、
一般の呼出・property access、async、method / arrow、
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

`return condition ? a : b` も同じCFGで経路を分け、条件が真の枝と偽の枝を独立に検証する。
条件はBooleanに限り、条件式自体はその成立を仮定する前に検査する。
各枝では成立済みの条件から安全整数の値域を絞り、呼出のrequiresを検証する。
return前のconst初期化や直線的な代入は、その実行時点で検査してから分岐する。
初期化式の呼出に、後の三項演算子の条件を流用しない。
Boolean literalで選ばれない枝も構文・sort検査は行い、到達しない演算や呼出の証明は作らない。
各経路のartifactは元のreturn文のspanとcompletionのIDを共有し、経路条件とobligation IDで区別する。
ネストした三項にも既存のCFG予算を適用する。

式に埋め込まれた三項と、三項を返すcalleeの呼出合成は、中立IRの
`{ kind: "conditional", test, consequent, alternate }` として保持し、SMTの `ite` へ出力する。
条件はBoolean、両枝は同じscalar種別に限る。条件式を先に検査し、各枝の成立条件で
中間演算の安全性を確認する。数値の結果範囲は両枝の区間を合わせて過大近似する。
両枝の有限値集合が得られ、合計16値以内なら、後続の厳密な整数除算にも利用できる。
反例の表示・評価も同じIRを扱い、モデルが選んだ枝だけを評価する。
requires / ensures注釈そのものの三項構文は、引き続き未対応である。

native の project 全体の診断と `noCheck`、Oxc と snapshot の source 一致を検査してから証明する。
project 診断・snapshot 不一致は API エラーとなり、肯定的な結果を返さない。
Oxc が読んだ return の UTF-16 span、source SHA-256、compiler executable SHA-256、binding revision、
数値を含む証拠は `native.coverage: "safe-integer-arithmetic"` として記録する。
Booleanのみの単一return式は従来の `"boolean-and-constant-return"`、return位置の三項や文を
CFGで扱う本体は `"boolean-branching"` を維持する。従来の定数数値returnも、数値の検査を通るため新coverageになる。
solverのversion / attemptsもartifactに保持する。
`compilerRevision` は Corsa binding の revision であり、native compiler の意味的 version と同一ではない。
検証対象の snapshot の証拠であり、実行時までの source の不変性は主張しない。

effect summary の証拠区分は独立している。本体証明だけで effect を `verified` に上げない。
この artifact を workspace の trusted summary binding に渡す機能、producer summary の生成、
一般的なensures summary 合成も未実装。

## 別ファイルの関数呼出

```ts
// retry-policy.mts
/* uneffect:ensures result === 2 - attempts */
export function remaining(attempts: 0 | 1 | 2): number { return 2 - attempts; }

// retry-client.mts
import { remaining as retriesLeft } from "./retry-policy.mjs";
/* uneffect:ensures result === 1 */
export function budget(): number { return retriesLeft(1); }
```

両方のファイルを検証projectに含めると、`budget` の契約を検証できる。
`retriesLeft(2)` に対して `result > 0` を要求すれば反例を返す。
関数名や構造的な関数型だけでは合成せず、呼出先symbolの宣言とresolved signatureの宣言を、
解析した実装のfile/spanと照合する。同名の別ファイル、未契約関数、関数型だけを合わせた
別の値は根拠にしない。calleeの本体を展開して再検査する処理であり、ensuresを未検証の公理として使わない。

書換え・分割代入・直接evalがある対象、外部変数のcapture、overload、generic、async、
method・関数値の変数alias、再帰・関数本体を3段以上辿る展開は対象外。
calleeの全requiresを引数へ代入し、定数として真のもの以外は呼出位置に独立した
`call-precondition` obligationを作る。引数なしのrequiresも省略しない。
callerの引数型・検査済みrequires・その呼出までに成立した経路条件を使ってZ3で証明する。
例えば `if (attempts === 2) return 0; return retriesLeft(attempts);` なら、
calleeの `requires attempts < 2` を有限型 `0 | 1 | 2` と早期returnから証明できる。
guardを外すと `attempts = 2` を反例として返す。

`&&` の右辺には左辺が真、`||` の右辺には左辺が偽という条件を渡す。
ifの条件式中の呼出には、まだ判定していない条件の成立を仮定しない。
calleeのrequires・ensures、callerのensuresを呼出の正当化に利用しない。
宣言初期化や代入右辺はその時点の値で検証し、未使用の初期化式や引数の検査も省略しない。

結果の `obligation.clause` は `requires`、`controlFlow.completion` は `call` で、
呼出式のfile/span、経路条件、solverの証拠・反例を保持する。
postconditionとcall-preconditionは独立した結果であり、postconditionだけが成功しても
呼出の事前条件が違反・不明ならcheckは失敗する。solverが証明できない場合はunknownのままとする。
calleeの本体は最大2段展開し、callerの型と成立済み条件から安全な演算範囲を確認する。
callerのrequiresだけで通常のnumber引数を整数として扱うことはできない。

### Wrapperを挟む2段の呼出

`caller -> wrapper -> leaf` を、各段のCorsa symbol・resolved signatureと実装の照合を
通して展開する。wrapperとleafの全requires、および未使用引数を含む各段の引数評価を
callerの変数へ順に代入する。引数の改名・入替えも同時代入として扱い、名前の衝突による
取り違えを防ぐ。wrapperのrequiresをleafのrequiresの証明に無条件で使うことはない。

引き継いだrequiresは外側の呼出位置にobligationを作る。これはその呼出を許可するための
条件であり、内側のcall spanをcallerのファイル位置として表示するものではない。
引数内の呼出から引き継ぐrequiresも、同じ外側の呼出位置に表示する。
wrapper自身を検証した結果には、wrapper内の実際の呼出位置でのobligationも含まれる。
各関数の検証結果は独立しているため、あるcallerから安全に呼べても、wrapperのより広い
入力領域で事前条件違反があればproject全体のcheckは失敗する。

wrapper内の各引数評価とrequiresには、その呼出に到達するまでの短絡・三項の条件を保持する。
callerの経路条件と合わせて検査するため、`count === 2 || remaining(count) > 0` では
右辺に到達したときの `count !== 2` を使える。呼出より後の条件は使わない。
wrapper自身のrequiresに内側のguardを流用せず、隣の呼出のrequiresも仮定しない。

関数本体を辿る深さはcallerから最大2段。1回の展開は引数内と外側を含めて最大32呼出とし、
再帰は宣言identityの再訪で拒否する。
各展開の入力構文、および展開後の返り値・全引数・全requiresとその到達条件の式は、それぞれ合計4,096
ノードまでとする。共有された引数式も使用回数だけ数え、展開やSMT出力の増大を制限する。
callerのconst・代入結果を置換した後にも同じ上限を検査する。
上限超過は理由付きのunsupportedとなり、打切りまでの部分結果を証明として返さない。
三項の条件と両枝もノード数・自由変数検査・再帰検査の対象に含める。

### If文と早期returnを含むcallee

calleeの分岐は、関数単独の検証と同じCFG固定点エンジンで経路を列挙する。
すべての到達経路がreturnすることを確認した後、経路条件と返り値をconditional IRへまとめる。
途中でreturnせず末尾へ到達するcalleeは、callerの型やrequiresにかかわらずunsupportedとする。
callee内の冒頭prefix以外の局所宣言・代入、loop・switch・例外は、この呼出合成では未対応。

返り値とは別に、各条件式とreturn式の評価地点・到達条件を保持する。
`if (check(value)) {} return 0` のように条件が返り値に影響しなくても、checkのrequiresと
条件式の演算を検査する。合流先の呼出はすべての到達経路で検査し、一方のguardを流用しない。
各式の構文・型は到達性にかかわらず検査し、実行時の演算範囲とrequiresの証明は
到達した経路に限る。条件式はBooleanに限り、捨てられた条件も同じ制約を受ける。

CFGの再訪で呼出解決を繰り返さないよう、構文ごとに式と呼出先を保持し、各到達条件を
別々に付ける。CFGの512 blocks・256経路/block・4,096 stepsに加え、呼出合成の
2段・32呼出・4,096ノードの上限も維持する。構文検査用の式、各経路の評価記録と
引数置換後の式も予算検査に含め、超過時は部分的な証明を返さない。

### 引数内の呼出

`consume(normalize(value))` では、`normalize` の結果と全引数評価・requiresを保持してから、
`consume` の引数へ結果を代入する。呼出先でその引数を使わなくても検査する。
引数は左から順に扱い、後の引数の条件やcalleeのrequires・本体のguardは、先に評価する
引数内の呼出の前提に使わない。引数式自身の `&&` / `||` の到達条件は引き継ぐ。

引数の呼出はcallee本体に入る前のcaller側の評価なので、`f(f(value))` は再帰ではない。
一方、`f` の本体から引数式を通して `f` を呼べば再帰として拒否する。
引数を解析するときも本体の深さ・32呼出・4,096ノードの予算は共有する。

### Callee冒頭の局所変数と代入

最初に並ぶconst/let宣言と代入を左から順に評価してから、残りの本体を展開する。
`const current = input, next = current + 1` のような複数宣言・alias連鎖を扱う。
各初期化式はその時点で成立しているbindingだけで置換し、その結果を後続の式へ渡す。
内側のcalleeの引数名やcallerの変数名との衝突による二重置換を避ける。

初期化式の値域検査と全呼出のrequiresは、変数の使用有無にかかわらず保持する。
`const value = positive(input); if (input === 0) return 0; return value` では、
後のguardで最初の呼出を正当化しない。一方、引数のaliasをconstに保存してから
guardする場合や、初期化式自体の短絡条件は検証に使える。
全初期化式・代入結果を自由変数・32呼出・4,096ノードの検査対象に含め、繰り返し使うaliasも
使用回数に応じて数える。calleeのrequiresは引数のみを参照でき、局所変数は前提に使わない。

local letへの `=` / `+=` / `-=` / `*=` / `/=` / `%=` を扱う。
除算・剰余の値域制約は通常の式と同じで、一般の小数演算には広げない。
右辺と複合代入の左辺は書換え前のbindingで評価し、結果を保存してから次の文へ進む。
`let current = input; const saved = current; current = 0` のsavedは元のinputを保持する。
上書きされる未使用の値にも演算の検査と呼出のrequiresを残し、後の書換えやguardで
過去の呼出を正当化しない。分岐にはprefixの実行後の値を渡す。

分割代入による宣言、var、未初期化宣言、引数・const・外部変数への代入、update式、
分岐内部や分岐以降の宣言・代入は、この合成では未対応。
関数単独の検証では、let/代入を含むprefixにif文が続く本体は引き続き未対応であり、
呼出合成の結果とは別にunsupportedを返す。

## 実装と検証

- `contracts/verification-contracts.ts`: Program を含まない artifact / 診断の型。
- `contracts/logic-contracts.ts`: conditionalを含む中立な式・obligationの型。
- `contracts/obligations.ts`: 中立IRからSMTへの出力。conditionalはiteへ変換する。
- `contracts/contract-explanations.ts`: 同じIRからの式表示とモデル評価。
- `contracts/contract-solver.ts`: 中立 obligation の solver 実行と証拠・反例の生成。旧 verifier も共有する。
- `contracts/corsa-contracts.ts`: Oxc の限定 lowering、native signature 認証、snapshot 診断。
- `contracts/native-contract-calls.ts`: 呼出先の宣言照合、書換え検査、最大2段の式・引数・requires展開と予算管理。
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
