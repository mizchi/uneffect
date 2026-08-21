import { spawnSync } from "node:child_process";
import ts from "typescript";
import { extractAnnotations } from "./annotations.js";
import { formatEffect, parseEffectExpression, splitTopLevel } from "./capabilities.js";

export interface CompareUneffectFrontendsOptions { files: Record<string, string>; corsaSchemaVersion?: number }
export interface NormalizedFrontendIr {
  schemaVersion: 1;
  functions: Array<{ name: string; effects: string[] }>;
  calls: Array<{ caller: string; callee: string; callbackTiming: "none" }>;
  orderedEvents: Array<{ kind: "call"; caller: string; callee: string; start: number; end: number }>;
}
export interface FrontendSchemaDrift { frontend: "corsa"; message: string }
export interface CompareUneffectFrontendsResult {
  equivalent: boolean;
  schemaDrift: FrontendSchemaDrift[];
  typescriptIr: NormalizedFrontendIr;
  corsaIr: NormalizedFrontendIr | null;
}

function programOf(files: Record<string, string>): ts.Program {
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true };
  const host = ts.createCompilerHost(options), original = host.getSourceFile.bind(host);
  host.getSourceFile = (name, version, onError, fresh) => Object.hasOwn(files, name) ? ts.createSourceFile(name, files[name]!, version, true, ts.ScriptKind.TS) : original(name, version, onError, fresh);
  return ts.createProgram(Object.keys(files), options, host);
}

function byteOffset(text: string, utf16Offset: number): number { return Buffer.byteLength(text.slice(0, utf16Offset)); }

function corsaInput(program: ts.Program, files: Record<string, string>, schemaVersion: number) {
  let nextId = 1;
  const symbols: any[] = [], trivia: unknown[] = [], calls: any[] = [];
  const ids = new Map<ts.Symbol, number>(), declarations: Array<{ source: ts.SourceFile; node: ts.FunctionDeclaration; id: number }> = [];
  const checker = program.getTypeChecker();
  for (const source of program.getSourceFiles()) {
    if (!Object.hasOwn(files, source.fileName)) continue;
    for (const node of source.statements) {
      if (!ts.isFunctionDeclaration(node) || !node.name || !node.body) continue;
      const id = nextId++, leading = source.text.slice(node.getFullStart(), node.getStart(source));
      const symbol = checker.getSymbolAtLocation(node.name);
      if (symbol) ids.set(symbol, id);
      declarations.push({ source, node, id });
      symbols.push({ id, name: node.name.text, kind: "function", typeRepr: node.getText(source).slice(0, node.getText(source).indexOf("{")).trim(), overloads: [], effectParameters: [], span: { start: byteOffset(source.text, node.getStart(source)), end: byteOffset(source.text, node.getEnd()) } });
      if (extractAnnotations(leading, "effect").length) trivia.push({ owner: id, text: leading, span: { start: byteOffset(source.text, node.getFullStart()), end: byteOffset(source.text, node.getStart(source)) } });
    }
  }
  for (const { source, node, id: caller } of declarations) {
    const visit = (child: ts.Node): void => {
      if (ts.isCallExpression(child)) {
        const lookup = ts.isPropertyAccessExpression(child.expression) ? child.expression.name : child.expression;
        let symbol = checker.getSymbolAtLocation(lookup);
        if (symbol && (symbol.flags & ts.SymbolFlags.Alias)) symbol = checker.getAliasedSymbol(symbol);
        const callee = symbol ? ids.get(symbol) : undefined;
        if (callee) calls.push({ caller, callee, overloadIndex: null, callbackTiming: "none", span: { start: byteOffset(source.text, child.getStart(source)), end: byteOffset(source.text, child.getEnd()) } });
      }
      ts.forEachChild(child, visit);
    };
    ts.forEachChild(node.body!, visit);
  }
  return { schemaVersion, fileId: 1, compilerRevision: `typescript-reference@${ts.version}`, symbols, calls, trivia };
}

export async function compareUneffectFrontends(options: CompareUneffectFrontendsOptions): Promise<CompareUneffectFrontendsResult> {
  const program = programOf(options.files), functions: NormalizedFrontendIr["functions"] = [];
  for (const source of program.getSourceFiles()) if (Object.hasOwn(options.files, source.fileName)) for (const node of source.statements) {
    if (!ts.isFunctionDeclaration(node) || !node.name || !node.body) continue;
    const leading = source.text.slice(node.getFullStart(), node.getStart(source));
    const effects = extractAnnotations(leading, "effect").flatMap((union) => splitTopLevel(union, "|").map(parseEffectExpression)).map(formatEffect).sort();
    functions.push({ name: node.name.text, effects });
  }
  functions.sort((left, right) => left.name.localeCompare(right.name));
  const input = corsaInput(program, options.files, options.corsaSchemaVersion ?? 1);
  const names = new Map(input.symbols.map((symbol) => [symbol.id as number, symbol.name as string]));
  const calls = input.calls.map((call) => ({ caller: names.get(call.caller)!, callee: names.get(call.callee)!, callbackTiming: "none" as const }));
  let changed = true;
  while (changed) {
    changed = false;
    for (const call of calls) {
      const caller = functions.find((item) => item.name === call.caller)!, callee = functions.find((item) => item.name === call.callee)!;
      const next = [...new Set([...caller.effects, ...callee.effects])].sort();
      if (next.join("\0") !== caller.effects.join("\0")) { caller.effects = next; changed = true; }
    }
  }
  const orderedEvents = input.calls.map((call) => ({ kind: "call" as const, caller: names.get(call.caller)!, callee: names.get(call.callee)!, start: call.span.start, end: call.span.end }))
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const typescriptIr: NormalizedFrontendIr = { schemaVersion: 1, functions, calls, orderedEvents };
  const execution = spawnSync("cargo", ["run", "--quiet", "--package", "uneffect-core", "--bin", "uneffect-corsa-normalize"], { input: JSON.stringify(input), encoding: "utf8", timeout: 30_000 });
  if (execution.error || execution.status !== 0) return { equivalent: false, schemaDrift: [{ frontend: "corsa", message: `${execution.stderr}${execution.error?.message ?? ""}`.trim() }], typescriptIr, corsaIr: null };
  try {
    const corsaIr = JSON.parse(execution.stdout) as NormalizedFrontendIr;
    corsaIr.functions.sort((left, right) => left.name.localeCompare(right.name));
    return { equivalent: JSON.stringify(typescriptIr) === JSON.stringify(corsaIr), schemaDrift: [], typescriptIr, corsaIr };
  } catch (error) {
    return { equivalent: false, schemaDrift: [{ frontend: "corsa", message: error instanceof Error ? error.message : String(error) }], typescriptIr, corsaIr: null };
  }
}
