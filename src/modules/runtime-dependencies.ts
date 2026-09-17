import type { Node } from "oxc-parser";

/** Leading trivia between `import` and its specifier, so a clause-less import is told from a named one. */
const COMMENTS = /\/\*[\s\S]*?\*\/|\/\/[^\r\n\u2028\u2029]*/gu;

/** A static import or export-from whose evaluation runs the module it names. */
export interface RuntimeModuleDependency {
  /** The specifier text as written, before any resolution. */
  readonly specifier: string;
  /** Offset of the specifier's string literal, which is where a checker resolves the target module. */
  readonly position: number;
  readonly span: { readonly start: number; readonly end: number };
  /** `import "./x.js"` with no clause at all, as distinct from `import {} from "./x.js"`. */
  readonly sideEffectOnly: boolean;
}

/**
 * The static imports and export-froms a module evaluates when it is imported. A type-only statement, and a
 * named list whose every element is type-only, are elided under the default emit and do not evaluate their
 * target; an empty import clause (`import {} from`) is elided for the same reason, while a clause-less
 * `import "./x.js"` is not. Under `verbatimModuleSyntax` the elision rules differ and this list is an
 * under-approximation — a known limitation it shares with the module-initialization analysis.
 */
export function runtimeModuleDependencies(program: { body: readonly Node[] }, text: string): RuntimeModuleDependency[] {
  const dependencies: RuntimeModuleDependency[] = [];
  for (const item of program.body) {
    const node = item as unknown as {
      type: string;
      start: number;
      source?: { start: number; end: number; value: string } | null;
      importKind?: string;
      exportKind?: string;
      specifiers?: readonly { type: string; importKind?: string; exportKind?: string }[];
    };
    if (node.type !== "ImportDeclaration" && node.type !== "ExportNamedDeclaration" && node.type !== "ExportAllDeclaration") continue;
    if (!node.source) continue;
    const specifiers = node.specifiers ?? [];
    const runtime = node.type === "ImportDeclaration"
      ? node.importKind !== "type" && (specifiers.length === 0 || specifiers.some(item => item.type !== "ImportSpecifier" || item.importKind !== "type"))
      : node.exportKind !== "type" && (node.type === "ExportAllDeclaration" || specifiers.some(item => item.exportKind !== "type"));
    const sideEffectOnly = node.type === "ImportDeclaration" && specifiers.length === 0
      && text.slice(node.start, node.source.start).replace(COMMENTS, "").trim() === "import";
    const emptyImportClause = node.type === "ImportDeclaration" && specifiers.length === 0 && !sideEffectOnly;
    if (!runtime || emptyImportClause) continue;
    dependencies.push({
      specifier: node.source.value,
      position: node.source.start,
      span: { start: node.source.start, end: node.source.end },
      sideEffectOnly,
    });
  }
  return dependencies;
}
