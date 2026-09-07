# Native build-output verification

`@mizchi/uneffect/experimental/build/corsa` は native TypeScript 7.0.2 が再出力する
JS・宣言ファイルと、既存の生成物のバイト列を比較する。JavaScript の TypeScript compiler は不要。
型・API は実装と分離した `corsa-build-output-contracts.ts` で定義する。

```ts
import {
  inspectCorsaBuildOutputs,
  inspectCorsaWorkspaceBuildOutputs,
} from "@mizchi/uneffect/experimental/build/corsa";

// references を持たない単一 project。
const project = inspectCorsaBuildOutputs({ configFile: "lib/tsconfig.json" });

// solution config または references を持つ project から到達できる全 project。
const workspace = inspectCorsaWorkspaceBuildOutputs({ configFile: "tsconfig.json" });
for (const project of workspace.projects) {
  console.log(project.configFile, project.status, project.blockedBy);
}
```

どちらも同期 API。`cwd` と `corsaExecutable` を指定でき、compiler のパス・version・
バイナリ digest を返す。呼出前に同じ native compiler でビルドしておく。
検査時の出力と tsbuildinfo は一時ディレクトリに隔離し、既存の生成物を修復・更新しない。

## Workspace の結果

- schema は `uneffect-native-workspace-build-outputs/v1`、coverage は
  `project-reference-js-and-declarations`。
- `projects` は依存先を先に並べ、各 config を一度だけ含める。
  directory と config file の reference を解決し、循環・欠落した config はエラーにする。
- `kind: "solution"` は source を持たず references をまとめる config。
  その `verified` は依存グラフの検査を表し、自身の生成物の検証ではない。
  source を持つ project が一つもない workspace は拒否する。
- producer が `missing` / `mismatch` / `error` の場合、consumer は `not-checked`。
  `blockedBy` に直接の依存先を返し、未検証を後続へ伝播する。独立した project は検査を続ける。
- 全体の status は `error`、`mismatch`、`missing` の順に優先する。
  `verified` は全 emitting project の JS・宣言が一致した場合だけ返す。
- 全 project の出力検査後に入力・compiler・生成物・設定を再確認する。
  途中の変更や project 間の出力先重複を検出した場合、全体を `error` とし、
  先行結果も `not-checked` にして outputs を空にする。

## 現在の境界

各 emitting project には明示的な `outDir` と runtime JS の出力が必要。
`noCheck`、`noEmit`、`emitDeclarationOnly`、`inlineSourceMap`、`outFile`、`mapRoot` は拒否する。
元の root files・型探索先・references を保って再出力し、compiler が選択した入力ファイル集合が
変わる設定は拒否する。通常の source/declaration map は許可するが、map 自体の内容は検証しない。
同一 config の異なる symlink alias は対応範囲外。

この結果は tsbuildinfo の正当性・タイムスタンプ上の freshness・実行時の依存解決・
契約や effect summary の合成を証明しない。TS6 の成果物との互換証拠でもない。
旧 workspace checker / CLI の切替条件は変更していない。

検査中は入力と生成物を変更しないこと。前後比較は atomic snapshot ではなく、
変更と復元を挟む競合まで検出できる保証はない。

検証コマンド: `just corsa-migration-gates`。
