# Native ドッグフード評価

この評価では、実コードの診断をレビューし、再現可能な不具合と解析の未対応を分ける。
Console の意図的な挿入テストや、未対応構文数の減少は実バグの発見件数に含めない。

## 対象と判定

対象ソースは `b77d95d0` の以下の 3 ファイル。診断には、その後の native 構文収集と
直接呼出の既知 effect 伝播を適用した。今回の修正前後で診断数は変わらない。

| ファイル | 関数 summary | 未対応構文 | unknown summary |
| --- | ---: | ---: | ---: |
| `src/support/diagnostic-quality.ts` | 24 | 1 | 5 |
| `src/support/environment.ts` | 20 | 2 | 11 |
| `src/evidence/model-replay.ts` | 67 | 13 | 48 |
| 合計 | 111 | 16 | 64 |

16 件はいずれも動的 property access の未対応報告で、バグの診断ではない。
64 件は呼出解析が不完全という evidence であり、64 個の不具合を意味しない。
unknown の個々の呼出先について、実装の正しさまでレビューし終えたとは扱わない。

| 評価項目 | 結果 |
| --- | --- |
| 初回評価で検査器が未知のバグとして自動特定した件数 | 0 |
| 診断箇所と関連処理のレビューで再現した既存バグ | 2 |
| 今回修正した既存バグ | 2 |
| 追加ルールで修正前ソースから自動再検出した既知バグ | 1（DF-001） |
| バグ診断の誤検知率 | 未算出。既知バグと境界ケースの回帰検証のみ |
| 外部アプリでの実バグ発見 | 今回の評価対象外 |

## 未対応構文 16 件の確認

行番号はレビュー時点。重複する同一行のアクセスは個別に数える。
「未対応」は解析の分類であり、その周辺コードが正しいという証明ではない。

| ファイル・行 | アクセス | 件数 | レビュー結果 |
| --- | --- | ---: | --- |
| `diagnostic-quality.ts:24` | 診断行番号による文字列配列の参照 | 1 | 未対応。範囲外には空文字の fallback がある |
| `environment.ts:208,212` | status をキーに表示ラベルを参照 | 2 | 未対応。入力型は有限の status union |
| `model-replay.ts:80` | trace の step 配列 | 1 | 未対応。配列長を上限にしたループ |
| `model-replay.ts:159` | ITF の一つ前の state | 1 | 未対応。元配列と `slice(1)` の対応 |
| `model-replay.ts:168,184` | temporal state / record field | 2 | 未対応。欠損値の判定を含む経路 |
| `model-replay.ts:281` | TLC 文字列の走査 | 1 | 未対応。文字列長を上限にしたループ |
| `model-replay.ts:307` | record field の型表 | 1 | 未対応。動的な型表の参照 |
| `model-replay.ts:357,358` | action 復元時の前後 state | 2 | 未対応。関連する条件評価で DF-002 を発見 |
| `model-replay.ts:374` | 次の TLC state header | 1 | 未対応。最後はテキスト末尾へ fallback |
| `model-replay.ts:384` | 一つ前の TLC state | 2 | 未対応。元配列と `slice(1)` の対応 |
| `model-replay.ts:409` | リプレイ対象 step | 1 | 未対応。配列長を上限にしたループ |
| `model-replay.ts:412` | action 名による実装選択 | 1 | 未対応。この箇所のレビューで DF-001 を発見 |

## DF-001: 未登録の action が再生成功になる

`replayModelCounterexample` は `adapter.actions[step.action]` の存在だけを確認していた。
空の action table に `toString` または `constructor` を指定すると Object.prototype の
関数が選ばれ、観測 state が変わらない step は `replayed / matchedSteps: 1` になった。
仕様上は未登録なので `missing-action / matchedSteps: 0` が必要である。

own property に限定して解決するよう修正した。明示的に登録された `toString`、
`constructor`、`__proto__` は引き続き使える。これは名前の禁止リストではない。

## DF-002: collection の等価条件から逆の action を復元する

TLC の action 復元に使う evaluator が `===` / `!==` に JavaScript の参照比較を
使っていた。例えば同じ値を持つ state の Set と `Set(1)` は別の配列になる。
等価・非等価を guard にする二つの action が同じ遷移を持つと、本来の `equal` ではなく
`different` を復元した。Map と record でも再現した。

正規化した値を、state の一致判定と共通の内容比較で比べるよう修正した。
Set / Map の順序や record のフィールド順に依存しない等価ケースと、値が異なる
非等価ケースを公開 parser API の回帰テストにした。

## 再実行と限界

```sh
just dogfood-native
pnpm vitest run test/model-replay.test.ts
```

`test/model-replay.test.ts` は本体へのバグ挿入を行わず、公開 API に入力を渡す。
修正前には 2 件の原因に対応する 5 ケースが失敗した。修正後は既存テストに加えて、
未登録 action、明示的な登録、collection の等価・非等価の回帰が通る。
TLC の状態列は形式を固定した fixture で検証した。この環境には Java がなく、
今回 TLC 本体を起動した往復検証は行っていない。

現段階で示せた有用性は「未対応箇所をレビュー対象に絞り、リプレイ機能の実バグを
再現して修正できた」こと。未知の呼出先を個別の source site とともに報告し、
登録表の参照と存在確認の関係については、下記の追加評価で自動再検出まで進めた。
collection の比較を生成する runtime assertion 経路は、下記 DF-003 で横断検証した。

## 追加評価: DF-001 の自動再検出

`own-property-before-read` を追加し、指定した登録表の直接参照に、同じ式内の
`Object.hasOwn` が先行するかを共有 CFG の prerequisite 解析で検査した。
元の `b77d95d0` の `model-replay.ts` は fixture として保存し、比較先には現在の
実ファイルを使う。テスト中の変更は一時コピーの型 import パスの付け替えのみ。

| 対象 | 自動検査の結果 |
| --- | --- |
| 修正前 `replayModelCounterexample` / `adapter.actions` | `findings`。`adapter.actions[step.action]` の1件 |
| 現在の同関数・同登録表 | `clean`。同じ式の own property guard を認識 |

JavaScript TypeScript の import を禁止した子プロセスで両方を検査している。
CLI から現在のコードを検査するには次を実行する。

```sh
just cfg-lint src/evidence/model-replay.ts replayModelCounterexample --registry adapter.actions --project tsconfig.json
```

これは、レビューで先に見つけたバグをルール化して再検出した結果であり、未知の
バグを新たに自動発見した件数には加えない。DF-002 の collection 等価性はこの
ルールの対象外。登録表・キーが getter/Proxy を持たない安定したデータであること、
キーが文字列/数値であること、組み込み `Object.hasOwn` が変更されないことを仮定する。
別文のガードや関数全体の到達可能性・別名参照は証明しない。
詳細な範囲は [CFG linter](./cfg-lint.md#registry-own-entry-policy) を参照。

## 次の評価: 生成コードと別の実コード

### DF-003: runtime assertion の collection 比較

生成された JavaScript でも `===` / `!==` を使っていたため、同じ内容の Set・Map・record
が等しくならなかった。これは DF-002 の関連処理を調べた手動発見で、linter の自動発見には
数えない。生成式・生成 assertion 文を実行する9ケースを追加し、修正前は7ケースが失敗した。

有限で非循環の temporal 値を比較する単独実行可能な関数式を生成するよう修正した。
Set は順序と同値要素の重複、Map は scalar key と再帰的な value、record はフィールド順に
依存せず比較する。ネストした collection、異なる値、両辺を一度ずつ評価することも確認する。
scalar literal と比較する既存の短い式は維持する。一般の循環オブジェクトや別 realm の値は
対象外であり、Set の他の演算すべての内容比較対応を今回の成果には含めない。

### 別の登録表6箇所への適用

候補は replay 以外のヒント表・DSLファイル表・schema 表・設定表から選んだ。
モジュールの `const` 表も native symbol で選択できるようにし、同名の別 binding と区別する。
修正前の出力は [registry-evaluation-before.json](../dogfood/registry-evaluation-before.json)、
修正後は [registry-evaluation-after.json](../dogfood/registry-evaluation-after.json) に保存した。
各記録にはファイル全体の SHA-256、関数・登録表・解析モード、指摘の行・元の式を含む。

| 実コード / 表 | 修正前 → 修正後 | レビュー・実行確認 |
| --- | --- | --- |
| `diagnosticHint` / `hints` | findings → clean（statement） | DF-004。未登録コードで関数やオブジェクトを返す |
| `prepareCapabilityDslSourceLinks` / `files` | findings → clean（expression） | DF-005。選択外の継承ファイルを受け入れる |
| `schemaCode` / `namedSchemas` | clean → clean | 既存の式内 own property guard を認識 |
| `resolvePath` / `options.anchors` | findings → findings | ポリシー上の指摘。継承した設定の許否は未確定で、バグ件数に含めない |
| `resolveTargetTemp` / `target.environment` | unknown → unknown | 表のローカル別名が未対応 |
| `emit` / `flags` | unknown → unknown | 表参照を含むテンプレート式が未対応。Object.keys の列挙保証も未モデル化 |

初回の指摘は3件。そのうち2件を実行で再現して修正し、1件は判定保留。
この小規模な選択標本から一般的な誤検知率・再現率は算出しない。
unknown 2件を安全とは扱わない。外部リポジトリへの適用は今回も対象外。

**DF-004:** `diagnosticHint("toString")` / `"constructor"` は関数、`"__proto__"` は
オブジェクトを返し、`string | undefined` の契約に反した。未知のコードでは `undefined` に
なるよう own property を確認して早期 return する。既存コードのヒントは維持する。

**DF-005:** `files` のプロトタイプに `src/policy.uneffect.ts` を持たせ、own entry の
`src/run.ts` から参照すると、選択したプロジェクトに含まれない DSL を展開できた。
own entry のみを解決し、継承したファイルは既存の「選択プロジェクトに存在しない」エラーに
する。明示的に選択した同じファイルは引き続き展開する。

`test/registry-source-bugs.test.ts` の5ケースは修正前に4ケース失敗した。
`test/registry-dogfood.test.ts` は現在の実ファイル6箇所を、JS TypeScript import を
禁止した CLI で毎回検査する。DF-004 では別文のガードを新しい statement モードで検証する。
`try/catch/finally` などの未対応構文は unknown のままにし、式モードへ自動退避しない。

```sh
just dogfood-native
just cfg-lint-check
just registry-dogfood
```

この追加評価では既存バグを3件修正した。内訳は関連処理の手動確認1件（DF-003）と、
linter の指摘から新たに再現した2件（DF-004/005）。前段の DF-001 の既知バグ再検出とは
別に集計する。

## 続行評価: 設定と evidence の一致、残る unknown

### DF-006: 権限引数が変わっても bindingDigest が変わらない

前段で判定保留とした `resolvePath` の指摘を、既存の Deno 権限仕様と照合した。
仕様は「anchor の値が変われば digest も変わる」としているが、参照では継承した値を
使い、digest の生成では object spread によって落としていた。`b77d95d0` の実装を
一時ファイルで実行し、次の結果を記録した。

| WORKSPACE_ROOT | 権限引数 | digest |
| --- | --- | --- |
| 継承した `/repo-a` | `--allow-read=/repo-a/data` | `f4883edd…b718` |
| 継承した `/repo-b` | `--allow-read=/repo-b/data` | `f4883edd…b718` |

非列挙の own property でも同じ不整合を再現した。完全な digest と元ソースの SHA-256 は
[anchor-digest-before.json](../dogfood/anchor-digest-before.json) に保存している。
このため、保留していた指摘を実バグ1件として確定した。

anchor と target environment は明示的な own entry と定義した。継承した値は使わず、
projection 開始時に own entry を一度だけ読み、権限引数と digest の両方に使う。
非列挙の own entry も含め、getter が値を変えても lookup と digest の間で値がずれない。
cross-anchor 比較も同じ own-entry 方針に揃えた。`resolveTargetTemp` の直接呼出では
既存の優先順位と短絡評価を維持する。これはホスト環境の自動読み込みを追加する変更ではない。

### 別名とテンプレート式の解析

`resolveTargetTemp` の `const env = target.environment` を選択した登録表の capture として
追跡するようにした。元の参照と capture を区別するため、元のオブジェクトを差し替えた後の
guard を古い capture に流用しない。環境値は own property guard 付きで読むようにした。

`emit` のテンプレート式は、各補間の評価と文字列化を順にモデル化する。未知の文字列化は
副作用として保証を破棄する。フラグ表は `Object.freeze` した静的な表とし、組み込みの
`Object.keys` から得た const ループ変数は、その表の own entry を指すと認識する。
mutable な表・キー、別の表の列挙、偽の `Object.keys` / `Object.freeze` は保証に使わない。
実行時の組み込み関数と配列 iterator が変更されないという前提は CLI / API の契約に記載する。

追加標本6箇所は現在すべて `clean`。結果とソースハッシュは
[registry-evaluation-bindings.json](../dogfood/registry-evaluation-bindings.json) に保存した。
元の3件の指摘はすべて不具合として再現・修正できたが、この小さな標本で一般的な精度を
主張しない。unknown の解消には解析の拡張とソース側の own guard / freeze の追加の両方が
寄与している。任意の alias、動的テーブル、例外、一般の for-of まで解析できる意味ではない。

## 追加評価: アノテーションの登録表

### DF-007: 継承プロパティによる診断・抽出の不整合

`src/support/annotations.ts` の登録表を読み、既存の CFG ルールを関数と表の組合せ4箇所に
適用した。すべて own-entry の保証不足を報告した。指摘箇所と関連処理を公開APIで確認し、
同じ参照方式に起因する以下の3症状を再現した。4診断を4バグとは数えない。

| 入力・操作 | 修正前 | 修正後 |
| --- | --- | --- |
| `/* uneffect:constructor payload */` を検証 | `accepted.has is not a function` で例外 | `unknown-dialect` 診断 |
| `/* uneffect:temporal_contract constructor payload */` を検証 | 診断なしで受理 | `unknown-directive` 診断 |
| `constructor` を追加directiveとして登録し、統一形式のブロックから抽出 | 検証は成功するが抽出結果が空 | 指定したpayloadを抽出 |

`toString` と `__proto__` でも同じ症状になる。payloadなしの場合や診断のソース範囲も
含めて `test/annotation-registry.test.ts` の9テストにした。修正前は9件とも失敗した。
修正前の実行結果・ソースハッシュは [annotation-registry-before.json](../dogfood/annotation-registry-before.json)、
CFGによる診断は [registry-evaluation-annotations-before.json](../dogfood/registry-evaluation-annotations-before.json)
に保存した。未知のtemporal句の受理は、選択した4箇所に加えて関連するvalidatorを
レビューして確認したもので、linter単独のバグ確定とは区別する。

dialect・alias・temporal句の表を own property に限定した。追加directiveとして明示的に
許可した名前は維持する。aliasの内側の表にもown guardを付け、既存のtemporalやReactの
構文テストを合わせて検証した。この段階では解析器の対応構文を拡張していない。

現在の評価は計10選択で9 `clean`、1 `unknown`。
`extractLocatedAnnotations / dialectDirectives` は値の参照を `Object.hasOwn` の存在検査に
置き換えたため、選択対象のreadがなくなった。空の抽出を成功としないAPI契約に従い、
この1選択は `unknown` の理由も含めて固定する。残った解析失敗が実バグを示すわけではない。
[registry-evaluation-annotations-after.json](../dogfood/registry-evaluation-annotations-after.json)
には修正後の結果とソースハッシュを保存した。9件の回帰テストと10選択の実コード評価は
`just dogfood-native` および通常のfast CIで継続実行する。

## Effect解析から契約本体証明への続行

### 凍結した表を経由する既知effectの伝播

診断品質の `criterionChecks` を変更不能な表とし、nativeのreceiver identityと静的な
member名から同期inline関数へ呼出を結び付けた。実際の `location` 評価関数へConsoleを
挿入した場合、修正前はその関数だけがConsoleを持ち、呼出元へ伝播しなかった。
現在は `criterionSatisfied` → `scoreDiagnostic` → `evaluateQuality` まで到達する。
この変化は `test/corsa-syntax-dogfood.test.ts` の実ソース変異テストで固定した。

mutableな表、shadowされたfreeze、spread、async/generatorは結び付けない。
別名importはnative identityで認証し、同名のparameterや未選択のファイルの本体から
effectを借りない。組み込み `Object.freeze` の契約を信頼する範囲であり、任意の
object dispatchやcallbackを解決したわけではない。既知effectを伝えるだけで
呼出全体の上界を証明しないため、callerのunknownを維持する。

実コード3ファイルの再実行結果は111 summaries・64 unknown・構文未対応16件で、
`no-unknown` は引き続き失敗する。結果とソースハッシュは
[native-dispatch-evaluation.json](../dogfood/native-dispatch-evaluation.json) に保存した。
意図的なConsole挿入の検出改善なので、実バグの発見件数には加えない。
旧Program版の診断処理pureチェックも通ることを確認した。

### Boolean分岐・早期returnの契約証明

旧Program版でif/else・早期return・ネスト・分岐違反の4ケースを実行し、status・evidence・
return span・契約本文を `corsa-contract-body-parity.json` に固定した。
native実装前はこの4ケースの比較が失敗し、実装後は成功する。

共有CFG固定点エンジンでreturnまでの経路条件を保持し、既存solverでpostconditionを証明する。
誤った分岐では反例とBoolean入力値を返す。同じreturnへ入る別の経路も維持し、
未対応構文・fallthrough・経路予算超過は部分的な証明成功を返さない。
単一returnのcoverageを維持し、文を含む本体は `boolean-branching` と区別する。

配布packageのAPI/CLIにも、JS TypeScript importを禁止した状態で、凍結表のeffect伝播と
分岐違反・別経路の成功を確かめる検査を追加した。
数値引数・算術・代入・loop・呼出先のrequires/ensures合成はまだ未対応である。

### 有限の安全整数型と演算

次の段階で、安全整数literal型と最大16値のunionをnative signatureから認証するようにした。
型の表示文字列を変えても取得結果は変わらず、foreign/fabricatedな型factやclose済みsnapshotは
使えない。返した値一覧は凍結し、通常のnumber、小数、unsafe integer、mixed union、
branded intersection、17値以上のunionは採用しない。

型の値域から、加算・減算・乗算・符号反転の中間値域をBigIntで求める。本体とrequires/ensuresは
同じsort・値域検査を使う。数値比較と分岐も扱い、例えば `value: -2 | 0 | 3` に対する
`return value + 2` の非負性を証明できる。`value: 0 | 1 | 2` に対する
`return value + 1` が常に2以上という誤った契約では `value = 0` を反例として返す。

通常のnumberを範囲条件だけで整数とは見なさない。最大安全整数に対する `(value + 2) - 2` は
JavaScriptでは丸めによって元の値と異なるため、数学的整数の恒等式として通してはいけない。
途中の値域が安全整数を超えれば関数全体をunsupportedとし、clause側のoverflowも拒否する。
値域は分岐やrequiresでまだ絞り込まないため、実際には安全でも拒否する式は残る。

旧Program版にProgramを渡して生成した数値の加算・分岐・反例3ケースを、既存の固定corpusに
追加した。数値を使う証拠には `safe-integer-arithmetic` を付ける。定数数値returnも同じ検査を
通るため新coverageになる。型の取得と証明の回帰検証、配布packageのJS compiler禁止API/CLIで
成功・反例・unsafe intermediateの拒否を確認する。この段階も移行範囲の拡張であり、
意図的な反例を既存の実バグ発見件数へ加算しない。

出力artifactと公開JSON Schemaの照合では、分岐のcoverageがSchemaに未登録だった不整合も
検出した。分岐・安全整数の両coverageをSchemaへ追加し、実際の証明結果が公開定義に含まれる
ことを回帰検証する。

### 経路条件を使った安全整数の値域

有限unionの区間を、検査済みrequiresと各CFG地点に到達した条件で絞り込むようにした。
`value: 0 | 9007199254740991` に対して最大値なら早期returnする関数は、残る経路の
`value + 1` を検証できる。旧実装ではこの安全な形もunsupportedだった。
数値式の構文・sort検査と、各実行経路での中間値域検査を分離した。

成立したAND・不成立のOR、比較の否定や左右反転を扱う。別経路への条件の流出、
条件式自体のoverflow、まだ成立していないensuresの流用は拒否する。
requiresは他のrequiresを含めた絞込みの前に検査するため、循環した安全性の根拠を作らない。
小さな整数範囲ではJavaScriptで条件を評価し、成立する全状態が絞込み後の区間内に残ることと、
元の状態が変更されないことも検査する。

これは移行範囲の拡張と誤拒否の改善であり、注入した反例を実バグ発見件数には加算しない。
通常のnumber、式内部の短絡評価による絞込み、変数間の関係、呼出契約の合成は残る。

### 式内部の短絡評価

本体・requires・ensuresの `&&` / `||` にも、左辺から右辺への値域の伝播を接続した。
`value: 0 | 9007199254740991` の `value < MAX && value + 1 > value` は、安全に評価できる
Boolean式として扱える。常にtrueという契約には最大値を反例として返す。
`value === MAX || value + 1 > value` は全入力でtrueを証明できる。

左辺そのもののoverflowや、成立したOR・不成立のANDから片側だけの条件を借りる誤りは拒否する。
左辺がliteralの `false && ...` / `true || ...` は、右辺の構文とsortだけを検査する。
呼出・除算・非Boolean値など、未対応fragmentを短絡で隠すことは許可しない。
この段階も誤拒否の改善であり、意図的な契約違反は実バグ発見件数へ加算しない。

### 数値変数同士の比較

検査済みの `value < limit` などを両辺の区間に反映するようにした。
上限を除外してからの加算、下限を除外してからの減算、requires・短絡評価・ensuresを
通した比較を扱う。等値は区間の交差、不等値は相手が1値の場合だけ端点を除外する。
`value <= limit` だけで上限の加算を許す、複数値の相手との不等値から端点を除外する、
別経路の比較を流用する、といった誤った絞込みは拒否する。

最大16走査で比較の連鎖を伝播し、通常の短い連鎖は記述順を入れ替えても同じ検証結果になる。
巨大な区間で `x < y && y < x` を与えても有限の処理で終了する。途中の区間も過大近似なので、
上限時に完全な固定点だとは扱わず、元の比較を残したまま安全性を検査できる範囲を使う。
小さな整数範囲では、否定・等値・不等値・自己比較・循環を含め、成立する全状態が
絞込み後も区間内に残ることをJavaScriptの条件評価と比較した。

この段階も安全な式の誤拒否の改善であり、意図的な反例は実バグ発見件数へ加算しない。

有限unionの具体的な値集合を補助情報として保持し、`value + 1 < limit` のような比較で
実際に成立する値だけを残すようにした。区間の境界だけでは残っていたunionの穴を除外するが、
SMTのOR前提は変更せず、値集合が空の経路を静的に削除もしない。

### 定数の加減算を含む比較

検査済みの比較式を `±変数 + 定数` に整理し、定数の加減算・符号反転を変数の区間へ
逆算できるようにした。例えば、先行する `value < limit` で `value + 1` を安全に評価できる
状態にした後、`value + 1 < limit` を満たす経路では `value + 2` も検証できる。
両辺の式、比較の否定、短絡評価、requires/ensuresを通した適用を確認した。

整理は演算の安全性を証明する処理から分離している。`(value + 2) - 1` の途中が安全整数を
超える場合は、式を整理すれば小さく見えても拒否する。小さな整数範囲の全列挙では、
定数の左右入替え、ネストした符号反転、等値・不等値、未対応の複数変数出現も含めて、
条件を満たす実際の値が絞込みで失われないことを検査する。
`value + 1 !== MAX` で `value + 2` の加算が安全になっても、`result <= limit` までは
保証されない。`value=1, limit=2, result=3` を反例として返す検査も残し、
演算の安全性とpostconditionの成立を区別する。
通常のnumber、複数の変数出現を含む式や乗除算からの絞込み、呼出契約の合成は残る。

単一引数・単一return・`ensures`付きcalleeの1段展開を追加した。引数式を置換してcallerの
安全整数値域で再検査する。callee側requires、複数段・再帰・動的dispatchはunsupportedである。

### 最小の直接呼出合成

native signature identityを認証できる同一snapshot内の、引数なし・単一return・`ensures`付き
calleeをcallerの式へ1段だけ展開するsliceを追加した。未契約関数、arrow/const、再帰は
unsupportedのまま保持する。引数付き呼出、動的dispatch、callee側requiresの代入、複数段の
合成は次の境界として残る。

### 機能開発への復帰: 別ファイルの契約付き関数

全面的なTS6移行は保留し、native契約本体証明の名前付きimportに対応した。
import時の改名と複数ファイルの同名関数を、Corsaのsymbol宣言とresolved signatureの
file/spanで識別する。0〜8引数・単一returnの1段展開で、calleeの全requiresが
引数代入後に定数として成立することも検査する。

機能追加前の回帰標本15ケース中14ケースが期待と異なった。改名importの未対応に加え、
同名の別実装・未契約関数の取り違え、calleeの自由変数をcaller引数として扱う誤り、
2件目以降および引数なしのrequiresの脱落、未使用引数の危険な演算の脱落を再現した。
書換えの標本は意図的な `@ts-expect-error` によりコンパイラ診断を抑制しており、
解析器自身の書換え検査を確認する。直接evalも合成を拒否する。

修正後は全15ケースが期待どおりとなった。これは解析器の回帰標本で見つけた不具合であり、
実アプリケーションで新たに検出したバグ件数には加算しない。
配布パッケージではretry回数の計算を2ファイルに分けた標本を使い、改名importを通した
成功と反例の両方を、JS TypeScriptパッケージ未インストールで確認する。
calleeの本体を再検査する機能であり、一般的な契約summaryの合成ではない。

### 呼出側の経路条件でrequiresを証明する

nativeの呼出合成に、呼出位置ごとの `call-precondition` obligationを追加した。
callerの型・requires・成立済みの分岐条件からcalleeのrequiresをZ3で証明する。
単純なguard、早期return、引数同士の大小関係、短絡式を扱い、未成立の条件や別経路の
条件を流用しない。定数として真のrequiresは従来どおり省略するが、定数falseは
unsupportedではなく明示的なrequiresの反例を返す。

最初の12標本は変更前にすべて失敗し、変更後は証明・反例が期待どおりになった。
さらに関係式、ifの判定前、合流した両経路、未使用の初期化式を加えて16標本とした。
初期化式と代入右辺の呼出は宣言・代入時点の値で検査するため、後続のguardや代入で
過去の呼出を正当化しない。returnの証明だけが成功しても、requiresの違反がcheckを失敗させる。

配布パッケージのretry標本では、試行回数が上限なら早期returnする版の事前条件を証明し、
guardのない版で上限値を反例として返す。TS6未インストールの公開APIで検証する。
この標本は境界を検査するための制御例であり、実アプリケーションの新規バグ発見数には含めない。

### 単一returnのwrapperを挟む2段合成

`caller -> wrapper -> leaf` の最大2呼出を、各段のnative宣言identityを確認して展開する。
wrapperは無条件の直接呼出を1個returnする形に限定した。全段のrequiresと引数評価を
callerの変数へ代入し、内側の未使用引数や書換えも検査対象に残す。
最初の9標本中8標本が変更前に期待と異なり、対応後は改名import、引数の入替え、
内側の事前条件、外側の短絡条件、再帰・3段目の明示的な拒否が期待どおりになった。

入力構文と展開したscalar式の上限を4,096ノードに設定した。繰り返し参照される引数式も
使用回数で数える。追加標本ではcallerのconst置換後に上限を超える経路を再現したため、
置換後にも検査を入れた。条件付きwrapper・内側の書換え・外部変数のcaptureと合わせ、
この段階の回帰標本は15ケースとなる。

配布パッケージのretry標本は3ファイルに分けた。wrapperとleafの両方のrequiresについて、
guard付きcallerでの証明と、guardなしcallerでの反例をJS TypeScript未インストールで確認する。
これらは解析機能の境界を検査する制御例であり、実アプリケーションの新規バグ数には含めない。

### Wrapper内の短絡と呼出結果の演算

2段合成のwrapperで、return式中の `&&` / `||` と複数の呼出結果へのscalar演算を扱う。
内側の引数評価とrequiresごとに到達条件を保持し、callerの条件と合わせて検査する。
wrapper自身のrequiresを内側のguardで正当化せず、別の呼出のrequiresも前提に加えない。

最初の8標本中7標本が変更前に期待と異なった。追加した4標本では、隣の呼出との
前提の分離、32呼出の予算境界、calleeとcallerの引数名が衝突する場合の同時代入を確認する。
2段・4,096ノードの上限も維持する。計12ケースは解析器の回帰標本であり、
実アプリケーションの新規バグ発見数には含めない。

配布パッケージのretry標本でもwrapper内の短絡と加算を使い、正しいguardでの証明と、
呼出より後にguardを置いた場合のrequiresの反例をJS TypeScript未インストールで検査する。

### 引数内の契約付き呼出

`consume(normalize(value))` のような引数内の呼出を展開する。未使用引数でも、
その計算と事前条件を検査する。callee本体のguardや後続引数の条件を、先に評価する
呼出の正当化に使わない。引数式内の短絡条件は保持する。

最初の14標本では変更前に13標本が期待と異なった。追加した2標本と合わせ、
改名import、同名引数の置換、未使用引数の危険な演算、短絡の順序、再帰と32呼出の
予算境界を確認する。有限の `f(f(value))` と関数本体からの再帰を区別する。
これらは解析器の回帰標本であり、実アプリケーションの新規バグ数には含めない。

配布パッケージでもretry関数の引数を別の関数で計算する標本と、retryの結果を
使わない標本を追加した。後者はreturnの契約が成立しても、引数の事前条件違反を返す。

### Return位置の三項演算子

`return condition ? a : b` を既存のnative CFGで分岐させ、各枝の返り値と呼出前提を検証する。
数値とBoolean、括弧・枝のネスト、if文との組合せ、直前のconst・代入を扱う。
条件式の評価前や初期化時点へ、後から成立する条件を持ち込まない。

最初の16標本中15標本が変更前に期待と異なった。追加の3標本で、512 blocksの予算超過が
部分的な証明を残さないことと、演算に埋め込まれた三項・到達しない枝の未対応構文を
明示的に拒否することを確認する。Booleanの三項はbranching coverageとして報告する。
これらは解析器の回帰標本であり、実アプリケーションの新規バグ発見数には加算しない。

配布パッケージのretry標本にも三項returnを追加した。正しい枝から呼ぶ版はrequiresを証明し、
枝を逆にした版は返り値の契約が成立してもrequiresの反例を返す。
一般の式中の三項と、三項を返すcalleeの展開は未対応として残す。

### 三項を返すcalleeと式内の条件付き値

中立なLogicExpressionにconditionalを追加し、Oxcの三項をSMTのiteとして出力する。
三項を返すcallee、演算・引数・初期化式に含む三項を検証できるようにした。
各枝の到達条件を呼出の引数評価とrequiresに保持し、条件式自身やwrapper自身のrequiresに
枝の条件を流用しない。有限の結果集合は16値まで保持し、厳密な整数除算にも使う。

最初の14標本中11標本が変更前に失敗した。追加の7標本と合わせ、枝を逆にした場合の
反例、Booleanと数値、ネスト・引数名の置換、guardによる安全整数の検査、型不一致、
再帰・自由変数・4,096ノード制限を確認する。式の表示とモデル評価も同じ選択結果を返し、
モデル評価では選ばれない枝のゼロ除算を実行しない。
これは解析器の回帰標本であり、実アプリケーションの新規バグ発見数には加算しない。

配布パッケージでは三項wrapperの結果へ加算するcallerを追加し、正常版のrequiresの証明と、
条件を逆にした版のrequiresの反例をTS6未インストールで確認する。
if文を含むcalleeの展開と、requires / ensures注釈自体の三項は未対応として残す。

### If文・早期returnを含むcalleeの合成

関数単独の検証に使うCFG経路列挙を呼出合成でも共有し、各returnの値をconditional IRへまとめる。
返り値だけでなく、空のif文を含む各条件式の評価を保持する。合流先では両方の経路を検査し、
返り値へ影響しない呼出のrequiresや危険な演算も脱落させない。

最初の14標本中13標本が変更前に失敗した。追加確認では、到達しない条件式の型検査が
抜けるケースを再現したため、構文・型の検査記録と実行経路の評価記録を分けて保持した。
到達しない未使用引数の演算、Boolean、3経路の早期return、合流先の前提と合わせ、
この段階の回帰標本は19ケース。実アプリケーションの新規バグ発見数には加算しない。

配布パッケージでは、早期returnでretry上限を避けるwrapperの合成を証明する。
条件を逆にした版と、retryの呼出結果を空のif条件に使う版は、返り値の契約が成立しても
requiresの反例を返す。calleeの局所宣言・代入と、契約注釈自体の三項は未対応として残す。

### Callee冒頭のconstと初期化時点の検査

冒頭に連続するconst宣言を左から順に展開し、残りのreturn・分岐へbindingを渡す。
最初の13標本中12標本が変更前に失敗した。対応後は、複数宣言・alias連鎖、短絡を含む
初期化式、unused initializerの事前条件と危険な演算、引数名の衝突、自由変数の拒否、
32呼出と4,096ノードの予算が期待どおりとなった。

追加標本では、後のconstによる先行参照の解決と、分岐内部の同名constの混同を拒否することを
確認した。計15標本に加え、既存の展開量の境界テストで内側の返り値の二重カウントを検出し、
返り値を式へ埋め込んだ分と、独立に保持すべき引数評価・requiresを区別して数えるよう修正した。

配布パッケージのretry wrapperでもconst aliasを経由したguardを証明する。
retry関数をconst初期化時に呼び、後からguardする版では、返り値の契約が成立しても
requiresの反例を返す。これらは解析器の回帰標本であり、実アプリケーションの
新規バグ発見数には加算しない。分岐内部の宣言と代入は未対応として残す。

### Callee冒頭のlet・代入と評価時点の保持

callee冒頭の初期化済みletと、local letへの単純代入・数値の複合代入を展開する。
各値は元の引数だけを参照する式として保存するため、後から元の変数を書き換えても、
保存済みalias・呼出引数・短絡条件は変化しない。上書きされた未使用の代入結果も検査する。

回帰標本では、Booleanと数値の書換え、複合代入、保存済み値と現在値の区別、
呼出前後の代入、後続guardで救済できないrequires、上書きされる危険な演算、
32呼出・4,096ノードの上限を確認する。分岐内部の代入と引数・constへの書換えは拒否する。
配布パッケージのretry例では、呼出前に値を補正する版の証明と、呼出後にリセットする版・
保存済みの元の値を呼出へ渡す版の反例を、TS6未インストールで確認する。
これらは解析器の回帰標本であり、実アプリケーションの新規バグ発見数には加算しない。

分岐内部の状態更新・合流、関数単独の検証でのlet/代入prefixとif文の組合せは残る。
