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
