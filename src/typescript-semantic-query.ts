import { resolve } from "node:path";
import ts from "typescript";
import type { SemanticPositionFact, SemanticQueryFrontend, SemanticSymbolFact } from "./semantic-query.js";

export interface TypeScriptSemanticQueryOptions {
  readonly configFile: string;
}

export interface TypeScriptSemanticQueryFrontend extends SemanticQueryFrontend {
  getExportsAtPosition(file: string, position: number): SemanticSymbolFact[];
}

export function openTypeScriptSemanticQuery(options: TypeScriptSemanticQueryOptions): TypeScriptSemanticQueryFrontend {
  const configFile = resolve(options.configFile);
  const parsed = ts.getParsedCommandLineOfConfigFile(configFile, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic(diagnostic) {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
    },
  });
  if (!parsed) throw new Error(`TypeScript could not parse ${configFile}`);
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const checker = program.getTypeChecker();
  const roots = new Map(program.getRootFileNames().map((file) => [resolve(file), file]));
  let closed = false;

  const sourceAndNode = (file: string, position: number): { source: ts.SourceFile; node: ts.Node } => {
    if (closed) throw new Error("TypeScript semantic-query frontend is closed");
    const known = roots.get(resolve(file));
    if (!known) throw new Error(`${resolve(file)} is not part of the TypeScript project`);
    const source = program.getSourceFile(known);
    if (!source) throw new Error(`TypeScript source file is unavailable: ${known}`);
    if (!Number.isInteger(position) || position < 0 || position > source.text.length) {
      throw new Error(`position ${position} is outside ${known}`);
    }
    let selected: ts.Node = source;
    const visit = (node: ts.Node): void => {
      if (node.getFullStart() <= position && position < node.getEnd()) {
        selected = node;
        ts.forEachChild(node, visit);
      }
    };
    ts.forEachChild(source, visit);
    return { source, node: selected };
  };

  return {
    compilerRevision: `typescript-api@${ts.version}`,
    rootFiles: [...roots.values()],
    queryPosition(file, position): SemanticPositionFact {
      const { node } = sourceAndNode(file, position);
      let symbol = checker.getSymbolAtLocation(node);
      if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol);
      const type = checker.getTypeAtLocation(node);
      const typeText = checker.typeToString(type, node, ts.TypeFormatFlags.NoTruncation);
      const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
      return {
        symbol: symbol ? {
          id: declaration
            ? `${resolve(declaration.getSourceFile().fileName)}:${declaration.getStart()}:${declaration.getEnd()}`
            : `typescript-symbol:${symbol.name}`,
          name: symbol.name,
        } : null,
        type: type ? {
          id: `typescript-type:${typeText}`,
          texts: [typeText],
        } : null,
      };
    },
    getExportsAtPosition(file, position) {
      const { node } = sourceAndNode(file, position);
      let symbol = checker.getSymbolAtLocation(node);
      if (!symbol) return [];
      if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol);
      if ((symbol.flags & ts.SymbolFlags.Module) === 0) return [];
      return checker.getExportsOfModule(symbol).map((exported) => {
        const declaration = exported.valueDeclaration ?? exported.declarations?.[0];
        return {
          id: declaration
            ? `${resolve(declaration.getSourceFile().fileName)}:${declaration.getStart()}:${declaration.getEnd()}`
            : `typescript-symbol:${exported.name}`,
          name: exported.name,
        };
      });
    },
    close() {
      closed = true;
    },
  };
}
