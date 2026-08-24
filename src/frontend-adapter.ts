import ts from "typescript";
import { createHash } from "node:crypto";
import { builtinContractRegistry, type BuiltinContract, type BuiltinContractRegistry, type BuiltinOperation, type BuiltinSymbolKey, type PathResultRefinement } from "./builtin-contracts.js";
import type { SourceSpan } from "./annotations.js";

export interface ResolvedCallSite {
  symbol: BuiltinSymbolKey;
  span: SourceSpan;
  result?: PathResultRefinement;
  operation?: BuiltinOperation;
  queryRefinement?: { kind: "css-selector"; selector: string };
}
export interface ResolvedPropertySite {
  symbol: BuiltinSymbolKey;
  span: SourceSpan;
  operation: Extract<BuiltinOperation, { kind: "dom-property" }>;
}

export interface FrontendSymbolAdapter {
  resolveCall(call: ts.CallExpression): ResolvedCallSite | undefined;
  resolveProperty(access: ts.PropertyAccessExpression | ts.ElementAccessExpression): ResolvedPropertySite | undefined;
  resolveDomReceiverRegion(expression: ts.Expression): ts.Expression | undefined;
  isDomReceiver(expression: ts.Expression): boolean;
  mayInvokeUserCode(node: ts.Node): boolean;
  ownershipKind(expression: ts.Expression): "detached" | "transferred" | "locked" | "shared";
  thrownErrorType(expression: ts.Expression): string;
}

function targetSymbol(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
  const symbol = checker.getSymbolAtLocation(node);
  return symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
}

export class TypeScriptFrontendAdapter implements FrontendSymbolAdapter {
  readonly #checker: ts.TypeChecker;
  readonly #contracts: Map<ts.Symbol, BuiltinContract>;
  readonly #declarationContracts: Map<ts.Declaration, BuiltinContract>;
  readonly #globalContracts: Map<string, BuiltinContract>;
  readonly #memberContracts: Map<string, BuiltinContract>;
  readonly #domPropertyContractsByName = new Map<string, Array<{ owner: string; contract: BuiltinContract }>>();
  readonly #errorType?: ts.Type;
  readonly #nodeType?: ts.Type;
  readonly #domOwnerTypes = new Map<string, ts.Type>();

  constructor(program: ts.Program, registry: BuiltinContractRegistry = builtinContractRegistry) {
    this.#checker = program.getTypeChecker();
    this.#contracts = new Map();
    this.#declarationContracts = new Map();
    this.#globalContracts = new Map(registry.contracts.filter((contract) => contract.symbol.module === "global").map((contract) => [contract.symbol.export, contract]));
    this.#memberContracts = new Map(registry.contracts.filter((contract) => contract.symbol.module.startsWith("lib.")).map((contract) => [contract.symbol.export, contract]));
    for (const contract of registry.contracts) {
      if (contract.operation?.kind !== "dom-property") continue;
      const separator = contract.symbol.export.indexOf("#");
      if (separator < 0) continue;
      const owner = contract.symbol.export.slice(0, separator);
      const name = contract.symbol.export.slice(separator + 1);
      const candidates = this.#domPropertyContractsByName.get(name) ?? [];
      candidates.push({ owner, contract });
      this.#domPropertyContractsByName.set(name, candidates);
    }
    const errorDeclaration = program.getSourceFiles().flatMap((source) => [...source.statements]).find((node): node is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(node) && node.name.text === "Error");
    const errorSymbol = errorDeclaration ? this.#checker.getSymbolAtLocation(errorDeclaration.name) : undefined;
    this.#errorType = errorSymbol ? this.#checker.getDeclaredTypeOfSymbol(errorSymbol) : undefined;
    const nodeDeclaration = program.getSourceFiles().flatMap((source) => [...source.statements]).find((node): node is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(node) && node.name.text === "Node" && node.getSourceFile().fileName.endsWith("lib.dom.d.ts"));
    const nodeSymbol = nodeDeclaration ? this.#checker.getSymbolAtLocation(nodeDeclaration.name) : undefined;
    this.#nodeType = nodeSymbol ? this.#checker.getDeclaredTypeOfSymbol(nodeSymbol) : undefined;
    for (const source of program.getSourceFiles()) {
      if (!source.fileName.endsWith("lib.dom.d.ts")) continue;
      for (const statement of source.statements) {
        if (!ts.isInterfaceDeclaration(statement) || !statement.name) continue;
        const symbol = this.#checker.getSymbolAtLocation(statement.name);
        if (symbol) this.#domOwnerTypes.set(statement.name.text, this.#checker.getDeclaredTypeOfSymbol(symbol));
      }
    }
    const modules = new Map<string, BuiltinContract[]>();
    for (const contract of registry.contracts) {
      const values = modules.get(contract.symbol.module) ?? [];
      values.push(contract);
      modules.set(contract.symbol.module, values);
    }
    const bindModuleContracts = (moduleSymbol: ts.Symbol, contracts: BuiltinContract[]): void => {
      const exports = new Map(this.#checker.getExportsOfModule(moduleSymbol).map((symbol) => [symbol.name, symbol]));
      for (const contract of contracts) {
        const [exportName, memberName] = contract.symbol.export.split("#");
        const exported = exportName ? exports.get(exportName) : undefined;
        const exportedTarget = exported && (exported.flags & ts.SymbolFlags.Alias) !== 0 ? this.#checker.getAliasedSymbol(exported) : exported;
        const symbol = memberName && exportedTarget
          ? this.#checker.getPropertyOfType(this.#checker.getDeclaredTypeOfSymbol(exportedTarget), memberName)
          : exported;
        if (symbol) {
          this.#contracts.set(symbol, contract);
          for (const declaration of symbol.declarations ?? []) this.#declarationContracts.set(declaration, contract);
        }
      }
    };
    for (const source of program.getSourceFiles()) for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const contracts = modules.get(statement.moduleSpecifier.text);
      if (!contracts) continue;
      const moduleSymbol = this.#checker.getSymbolAtLocation(statement.moduleSpecifier);
      if (!moduleSymbol) continue;
      bindModuleContracts(moduleSymbol, contracts);
    }
    for (const moduleSymbol of this.#checker.getAmbientModules()) {
      const moduleName = moduleSymbol.name.replace(/^"|"$/g, "");
      const contracts = moduleName.startsWith("node:") ? modules.get(moduleName) : undefined;
      if (contracts) bindModuleContracts(moduleSymbol, contracts);
    }
  }

  #resolveSymbolContract(symbol: ts.Symbol): BuiltinContract | undefined {
    let contract = this.#contracts.get(symbol);
    if (!contract) for (const declaration of symbol.declarations ?? []) {
      contract = this.#declarationContracts.get(declaration);
      if (contract) break;
    }
    if (!contract) for (const declaration of symbol.declarations ?? []) {
      const parent = declaration.parent;
      if ((ts.isInterfaceDeclaration(parent) || ts.isClassDeclaration(parent)) && parent.name) {
        contract = this.#memberContracts.get(`${parent.name.text}#${symbol.name}`);
        if (contract) break;
      }
    }
    return contract;
  }

  #resolveMemberContract(lookup: ts.Node): BuiltinContract | undefined {
    const symbol = targetSymbol(this.#checker, lookup);
    return symbol ? this.#resolveSymbolContract(symbol) : undefined;
  }

  resolveCall(call: ts.CallExpression): ResolvedCallSite | undefined {
    const lookup = ts.isPropertyAccessExpression(call.expression) ? call.expression.name : call.expression;
    const symbol = targetSymbol(this.#checker, lookup);
    if (!symbol) return undefined;
    let contract = this.#resolveMemberContract(lookup);
    if (!contract) {
      const path = ts.isIdentifier(call.expression) ? call.expression.text
        : ts.isPropertyAccessExpression(call.expression) && ts.isIdentifier(call.expression.expression)
          ? `${call.expression.expression.text}.${call.expression.name.text}` : undefined;
      const root = ts.isIdentifier(call.expression) ? call.expression
        : ts.isPropertyAccessExpression(call.expression) && ts.isIdentifier(call.expression.expression) ? call.expression.expression : undefined;
      const rootSymbol = root ? targetSymbol(this.#checker, root) : undefined;
      const isLibraryGlobal = rootSymbol?.declarations?.some((declaration) => declaration.getSourceFile().isDeclarationFile) ?? false;
      if (path && isLibraryGlobal) contract = this.#globalContracts.get(path);
    }
    if (!contract) return undefined;
    return {
      symbol: contract.symbol,
      span: { start: call.getStart(), end: call.getEnd() },
      result: contract.result,
      operation: contract.operation,
      queryRefinement: contract.operation?.kind === "dom" && contract.operation.queryArgument !== undefined
        && call.arguments[contract.operation.queryArgument] !== undefined
        && ts.isStringLiteralLike(call.arguments[contract.operation.queryArgument]!)
        ? { kind: "css-selector", selector: (call.arguments[contract.operation.queryArgument] as ts.StringLiteralLike).text }
        : undefined,
    };
  }

  resolveProperty(access: ts.PropertyAccessExpression | ts.ElementAccessExpression): ResolvedPropertySite | undefined {
    const literalName = ts.isElementAccessExpression(access) && access.argumentExpression
      ? ts.isStringLiteralLike(access.argumentExpression) || ts.isNumericLiteral(access.argumentExpression)
        ? access.argumentExpression.text
        : undefined
      : undefined;
    const symbol = ts.isPropertyAccessExpression(access)
      ? targetSymbol(this.#checker, access.name)
      : literalName === undefined
        ? undefined
        : this.#checker.getPropertyOfType(this.#checker.getTypeAtLocation(access.expression), literalName);
    let contract = symbol ? this.#resolveSymbolContract(symbol) : undefined;
    const propertyName = ts.isPropertyAccessExpression(access) ? access.name.text : literalName;
    if (!contract && propertyName !== undefined) {
      const receiverType = this.#checker.getTypeAtLocation(access.expression);
      if ((receiverType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) === 0) {
        for (const { owner, contract: candidate } of this.#domPropertyContractsByName.get(propertyName) ?? []) {
          const ownerType = this.#domOwnerTypes.get(owner);
          if (ownerType && this.#checker.isTypeAssignableTo(receiverType, ownerType)) {
            contract = candidate;
            break;
          }
        }
      }
    }
    if (contract?.operation?.kind !== "dom-property") return undefined;
    return {
      symbol: contract.symbol,
      span: { start: access.getStart(), end: access.getEnd() },
      operation: contract.operation,
    };
  }

  resolveDomReceiverRegion(original: ts.Expression): ts.Expression | undefined {
    const seen = new Set<ts.Symbol>();
    const resolve = (value: ts.Expression): ts.Expression | undefined => {
      while (ts.isParenthesizedExpression(value) || ts.isAsExpression(value)
        || ts.isTypeAssertionExpression(value) || ts.isSatisfiesExpression(value)
        || ts.isNonNullExpression(value)) value = value.expression;
      if (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) {
        const property = this.resolveProperty(value);
        if (property?.operation.resultRegion === "receiver") return resolve(value.expression) ?? value.expression;
        return undefined;
      }
      if (!ts.isIdentifier(value)) return undefined;
      const symbol = targetSymbol(this.#checker, value);
      if (!symbol || seen.has(symbol)) return undefined;
      seen.add(symbol);
      const declaration = symbol.valueDeclaration;
      if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer
        || !ts.isVariableDeclarationList(declaration.parent)
        || (declaration.parent.flags & ts.NodeFlags.Const) === 0) return undefined;
      return resolve(declaration.initializer);
    };
    return resolve(original);
  }

  isDomReceiver(expression: ts.Expression): boolean {
    if (!this.#nodeType) return false;
    const type = this.#checker.getTypeAtLocation(expression);
    return (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) === 0
      && this.#checker.isTypeAssignableTo(type, this.#nodeType);
  }

  mayInvokeUserCode(node: ts.Node): boolean {
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const lookup = ts.isPropertyAccessExpression(node) ? node.name : node.argumentExpression;
      const symbol = lookup ? targetSymbol(this.#checker, lookup) : undefined;
      if (symbol?.declarations?.some((declaration) => ts.isGetAccessorDeclaration(declaration) || ts.isSetAccessorDeclaration(declaration))) return true;
      const receiverType = this.#checker.getTypeAtLocation(node.expression);
      if ((receiverType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) return true;
      const receiverSymbol = targetSymbol(this.#checker, node.expression);
      if (receiverSymbol?.declarations?.some((declaration) => ts.isVariableDeclaration(declaration)
        && declaration.initializer && ts.isNewExpression(declaration.initializer)
        && ts.isIdentifier(declaration.initializer.expression) && declaration.initializer.expression.text === "Proxy")) return true;
      if (ts.isElementAccessExpression(node) && node.argumentExpression && !ts.isStringLiteralLike(node.argumentExpression) && !ts.isNumericLiteral(node.argumentExpression)) {
        const keyType = this.#checker.getTypeAtLocation(node.argumentExpression);
        const keyMembers = keyType.isUnion() ? keyType.types : [keyType];
        const literalPropertyNames = keyMembers.flatMap((member) => {
          if ((member.flags & ts.TypeFlags.StringLiteral) !== 0) return [(member as ts.StringLiteralType).value];
          if ((member.flags & ts.TypeFlags.NumberLiteral) !== 0) return [String((member as ts.NumberLiteralType).value)];
          return [];
        });
        if (literalPropertyNames.length === keyMembers.length && literalPropertyNames.some((name) =>
          this.#checker.getPropertyOfType(receiverType, name)?.declarations?.some((declaration) =>
            ts.isGetAccessorDeclaration(declaration) || ts.isSetAccessorDeclaration(declaration)))) return true;
        const staticallyPrimitiveKey = keyMembers.every((member) =>
          (member.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike)) !== 0);
        if (!staticallyPrimitiveKey) return true;
      }
    }
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.PlusToken, ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken, ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken].includes(node.operatorToken.kind)) {
      const primitive = (value: ts.Expression): boolean => {
        const flags = this.#checker.getTypeAtLocation(value).flags;
        return (flags & (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BigIntLike | ts.TypeFlags.BooleanLike)) !== 0;
      };
      return !primitive(node.left) || !primitive(node.right);
    }
    return false;
  }

  ownershipKind(expression: ts.Expression): "detached" | "transferred" | "locked" | "shared" {
    const type = this.#checker.getTypeAtLocation(expression);
    const name = type.aliasSymbol?.name ?? type.getSymbol()?.name ?? this.#checker.typeToString(type);
    if (name.includes("SharedArrayBuffer")) return "shared";
    if (name.includes("ArrayBuffer")) return "detached";
    if (name.includes("ReadableStream") || name.includes("WritableStream") || name.includes("TransformStream")) return "locked";
    return "transferred";
  }

  thrownErrorType(expression: ts.Expression): string {
    const type = this.#checker.getTypeAtLocation(expression);
    if (!this.#errorType || !this.#checker.isTypeAssignableTo(type, this.#errorType)) return "unknown";
    return this.#checker.typeToString(type, expression, ts.TypeFormatFlags.NoTruncation);
  }
}

export function collectBuiltinCallRefinements(
  program: ts.Program,
  source: ts.SourceFile,
  registry: BuiltinContractRegistry = builtinContractRegistry,
): ResolvedCallSite[] {
  const adapter = new TypeScriptFrontendAdapter(program, registry);
  const results: ResolvedCallSite[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const result = adapter.resolveCall(node);
      if (result) results.push(result);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return results;
}

export interface DeclarationDriftDiagnostic {
  library: string;
  expected: string;
  actual?: string;
  message: string;
}

export function auditBuiltinDeclarationDrift(
  program: ts.Program,
  registry: BuiltinContractRegistry = builtinContractRegistry,
): DeclarationDriftDiagnostic[] {
  const diagnostics: DeclarationDriftDiagnostic[] = [];
  for (const expected of registry.declarations) {
    const source = program.getSourceFiles().find((file) => file.fileName.endsWith(`/${expected.library}`) || file.fileName.endsWith(`\\${expected.library}`));
    const actual = source ? createHash("sha256").update(source.text).digest("hex") : undefined;
    if (actual !== expected.sha256) diagnostics.push({
      library: expected.library, expected: expected.sha256, actual,
      message: actual ? `${expected.library} changed; builtin DOM classifications require review` : `${expected.library} was not loaded`,
    });
  }
  return diagnostics;
}
