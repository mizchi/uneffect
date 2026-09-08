# 開発方針

- ユーザーには日本語で答える。
- TDD（探索 → Red → Green → Refactoring）で開発する。
- 関心の分離、状態とロジックの分離を保つ。公開 API・型のコントラクトと実装を分ける。
- タスク実行は `justfile`、Node.js は v24 以降と pnpm、E2E は Playwright を使う。

## 新規機能の frontend

- 新規の解析機能は、構文解析に Oxc、型・シンボルの意味解析に Corsa を使う。
- 新規実装から `typescript` / `@typescript/typescript6` の JS Compiler API、
  `src/support/typescript-compiler.ts`、既存の TS6 依存解析器への依存を追加しない。
- 型情報が不足する場合は Corsa の query と中立な解析コントラクトを拡張する。
  型やシンボルの同一性を名前・表示文字列だけで代用しない。
- 新規の公開入口は、JS TypeScript パッケージを読み込まずに実行できることを検証する。

## 既存 TS6 実装の扱い

全面移行はいったん保留する。既存実装と比較用 oracle は残し、通常の機能開発に
全面移行を自動的に含めない。移行を再開する場合は
[残作業一覧](docs/ts6-runtime-remaining.md) を参照する。
