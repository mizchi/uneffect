import ts from "typescript";
import { createHash } from "node:crypto";
import { builtinContractApplies, builtinContractRegistry, type BuiltinContract, type BuiltinContractRegistry, type BuiltinResultRefinement, type BuiltinSymbolKey } from "./builtin-contracts.js";
import type { SourceSpan } from "./annotations.js";
import type { BuiltinSemantics } from "./builtin-semantic-schema.js";
import { hasStableRootPath } from "./stable-callable.js";

export interface ResolvedCallSite {
  symbol: BuiltinSymbolKey;
  span: SourceSpan;
  evidence?: "trusted" | "unknown";
  result?: BuiltinResultRefinement;
  semantics?: BuiltinSemantics;
  callableResult?: BuiltinContract["callableResult"];
  capturedCallbacks?: readonly ts.Expression[];
  queryRefinement?: { kind: "css-selector"; selector: string };
}
export interface ResolvedPropertySite {
  symbol: BuiltinSymbolKey;
  span: SourceSpan;
  semantics?: BuiltinSemantics;
  evidence?: "trusted" | "unknown";
}

export interface FrontendSymbolAdapter {
  resolveCall(call: ts.CallExpression): ResolvedCallSite | undefined;
  resolveConstruct(construction: ts.NewExpression): ResolvedCallSite | undefined;
  resolveProperty(access: ts.PropertyAccessExpression | ts.ElementAccessExpression): ResolvedPropertySite | undefined;
  resolveDomReceiverRegion(expression: ts.Expression): ts.Expression | undefined;
  isDomReceiver(expression: ts.Expression): boolean;
  mayInvokeUserCode(node: ts.Node): boolean;
  ownershipKind(expression: ts.Expression): "detached" | "transferred" | "locked" | "shared";
  thrownErrorType(expression: ts.Expression): string;
  resolveConstInitializer(expression: ts.Expression): ts.Expression | undefined;
  resolveStaticString(expression: ts.Expression): string | undefined;
  isSameReference(left: ts.Expression, right: ts.Expression): boolean;
}

function targetSymbol(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
  const symbol = checker.getSymbolAtLocation(node);
  return symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
}

/** Authenticate a direct standard Proxy construction through immutable local aliases. */
export function isAuthenticatedProxyExpression(checker: ts.TypeChecker, expression: ts.Expression): boolean {
  const seen = new Set<ts.Symbol>();
  const resolve = (value: ts.Expression): boolean => {
    if (ts.isParenthesizedExpression(value) || ts.isAsExpression(value)
      || ts.isTypeAssertionExpression(value) || ts.isNonNullExpression(value)) return resolve(value.expression);
    if (ts.isNewExpression(value) && ts.isIdentifier(value.expression) && value.expression.text === "Proxy") {
      const constructor = targetSymbol(checker, value.expression);
      return constructor?.declarations?.some((declaration) => declaration.getSourceFile().isDeclarationFile
        && /(?:^|[/\\])typescript[/\\]lib[/\\]lib\.[^/\\]+\.d\.ts$/.test(declaration.getSourceFile().fileName)) ?? false;
    }
    if (!ts.isIdentifier(value)) return false;
    const symbol = targetSymbol(checker, value);
    if (!symbol || seen.has(symbol)) return false;
    seen.add(symbol);
    const declaration = symbol.valueDeclaration;
    return Boolean(declaration && ts.isVariableDeclaration(declaration) && declaration.initializer
      && ts.isVariableDeclarationList(declaration.parent) && (declaration.parent.flags & ts.NodeFlags.Const) !== 0
      && resolve(declaration.initializer));
  };
  return resolve(expression);
}

export class TypeScriptFrontendAdapter implements FrontendSymbolAdapter {
  readonly #checker: ts.TypeChecker;
  readonly #contracts: Map<ts.Symbol, BuiltinContract>;
  readonly #rootedContracts: Map<ts.Symbol, Array<{ contract: BuiltinContract; root: ts.Symbol; path: readonly string[] }>>;
  readonly #declarationContracts: Map<ts.Declaration, BuiltinContract>;
  readonly #globalContracts: Map<string, BuiltinContract>;
  readonly #memberContracts: Map<string, BuiltinContract>;
  readonly #domPropertyContractsByName = new Map<string, Array<{ owner: string; contract: BuiltinContract }>>();
  readonly #domMethodContractsByName = new Map<string, Array<{ owner: string; contract: BuiltinContract }>>();
  readonly #errorType?: ts.Type;
  readonly #nodeType?: ts.Type;
  readonly #domOwnerTypes = new Map<string, ts.Type>();

  constructor(program: ts.Program, registry: BuiltinContractRegistry = builtinContractRegistry) {
    this.#checker = program.getTypeChecker();
    this.#contracts = new Map();
    this.#rootedContracts = new Map();
    this.#declarationContracts = new Map();
    this.#globalContracts = new Map(registry.contracts.filter((contract) => contract.symbol.module === "global").map((contract) => [contract.symbol.export, contract]));
    this.#memberContracts = new Map(registry.contracts.filter((contract) => contract.symbol.module.startsWith("lib.")).map((contract) => [contract.symbol.export, contract]));
    for (const contract of registry.contracts) {
      const separator = contract.symbol.export.indexOf("#");
      if (separator < 0) continue;
      const owner = contract.symbol.export.slice(0, separator);
      const name = contract.symbol.export.slice(separator + 1);
      const properties = contract.semantics?.primitives.some((primitive) => primitive.kind === "property");
      const table = properties ? this.#domPropertyContractsByName : this.#domMethodContractsByName;
      const candidates = table.get(name) ?? [];
      candidates.push({ owner, contract });
      table.set(name, candidates);
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
        let symbol = memberName && exportedTarget
          ? this.#checker.getPropertyOfType(
              (exportedTarget.flags & (ts.SymbolFlags.Class | ts.SymbolFlags.Interface)) !== 0
                ? this.#checker.getDeclaredTypeOfSymbol(exportedTarget)
                : exportedTarget.valueDeclaration
                ? this.#checker.getTypeOfSymbolAtLocation(exportedTarget, exportedTarget.valueDeclaration)
                : this.#checker.getDeclaredTypeOfSymbol(exportedTarget),
              memberName,
            )
          : exportedTarget;
        if (symbol && contract.symbol.path) for (const member of contract.symbol.path) {
          const location: ts.Declaration | undefined = symbol.valueDeclaration ?? symbol.declarations?.[0];
          symbol = location ? this.#checker.getPropertyOfType(
            this.#checker.getTypeOfSymbolAtLocation(symbol, location), member,
          ) : undefined;
          if (!symbol) break;
        }
        if (symbol) {
          if (contract.symbol.path && exportedTarget) {
            const rooted = this.#rootedContracts.get(symbol) ?? [];
            rooted.push({ contract, root: exportedTarget, path: contract.symbol.path });
            this.#rootedContracts.set(symbol, rooted);
          } else {
            this.#contracts.set(symbol, contract);
            for (const declaration of symbol.declarations ?? []) this.#declarationContracts.set(declaration, contract);
          }
        }
      }
    };
    for (const source of program.getSourceFiles()) for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const registered = modules.get(statement.moduleSpecifier.text);
      if (!registered) continue;
      const contracts = registered.filter((contract) => builtinContractApplies(program, source.fileName, contract));
      if (contracts.length === 0) continue;
      const moduleSymbol = this.#checker.getSymbolAtLocation(statement.moduleSpecifier);
      if (!moduleSymbol) continue;
      bindModuleContracts(moduleSymbol, contracts);
      const defaultBinding = statement.importClause?.name;
      const defaultContract = defaultBinding
        ? contracts.find((candidate) => candidate.symbol.export === "default")
        : undefined;
      const defaultSymbol = defaultBinding ? targetSymbol(this.#checker, defaultBinding) : undefined;
      if (defaultContract && defaultSymbol) {
        this.#contracts.set(defaultSymbol, defaultContract);
        for (const declaration of defaultSymbol.declarations ?? []) this.#declarationContracts.set(declaration, defaultContract);
      }
      const named = statement.importClause?.namedBindings;
      if (named && ts.isNamedImports(named)) for (const element of named.elements) {
        const importedName = element.propertyName?.text ?? element.name.text;
        const contract = contracts.find((candidate) => candidate.symbol.export === importedName);
        if (!contract) continue;
        const symbol = targetSymbol(this.#checker, element.name);
        if (!symbol) continue;
        this.#contracts.set(symbol, contract);
        for (const declaration of symbol.declarations ?? []) this.#declarationContracts.set(declaration, contract);
      }
    }
    // Bind the original declaration identity even when consumers only see it
    // through a local/package barrel. TypeScript resolves the downstream alias
    // back to this export symbol, so no spelling-based propagation is needed.
    for (const source of program.getSourceFiles()) for (const statement of source.statements) {
      if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier
        || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const registered = modules.get(statement.moduleSpecifier.text);
      if (!registered) continue;
      const contracts = registered.filter((contract) => builtinContractApplies(program, source.fileName, contract));
      if (contracts.length === 0) continue;
      const moduleSymbol = this.#checker.getSymbolAtLocation(statement.moduleSpecifier);
      if (moduleSymbol) bindModuleContracts(moduleSymbol, contracts);
    }
    for (const source of program.getSourceFiles()) {
      const visitDynamicImports = (node: ts.Node): void => {
        if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name)
          && node.name.elements.length === 1 && node.initializer && ts.isAwaitExpression(node.initializer)
          && ts.isCallExpression(node.initializer.expression)
          && node.initializer.expression.expression.kind === ts.SyntaxKind.ImportKeyword
          && node.initializer.expression.arguments.length === 1
          && ts.isStringLiteral(node.initializer.expression.arguments[0]!)) {
          const declarationList = node.parent;
          const element = node.name.elements[0]!;
          const moduleName = node.initializer.expression.arguments[0].text;
          const immutable = ts.isVariableDeclarationList(declarationList)
            && declarationList.declarations.length === 1
            && (declarationList.flags & ts.NodeFlags.Const) !== 0;
          const importedName = element.propertyName === undefined && ts.isIdentifier(element.name)
            ? element.name.text
            : undefined;
          const contract = immutable && importedName
            ? modules.get(moduleName)?.find((candidate) => candidate.symbol.export === importedName
              && builtinContractApplies(program, source.fileName, candidate))
            : undefined;
          const symbol = contract && ts.isIdentifier(element.name)
            ? this.#checker.getSymbolAtLocation(element.name)
            : undefined;
          if (contract && symbol) {
            this.#contracts.set(symbol, contract);
            for (const declaration of symbol.declarations ?? []) this.#declarationContracts.set(declaration, contract);
          }
        }
        ts.forEachChild(node, visitDynamicImports);
      };
      visitDynamicImports(source);
    }
    for (const moduleSymbol of this.#checker.getAmbientModules()) {
      const moduleName = moduleSymbol.name.replace(/^"|"$/g, "");
      const contracts = moduleName.startsWith("node:")
        ? modules.get(moduleName)?.filter((contract) => builtinContractApplies(program, program.getCurrentDirectory(), contract))
        : undefined;
      if (contracts) bindModuleContracts(moduleSymbol, contracts);
    }
  }

  #resolveSymbolContract(symbol: ts.Symbol, seen = new Set<ts.Symbol>()): BuiltinContract | undefined {
    if (seen.has(symbol)) return undefined;
    seen.add(symbol);
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
      if (ts.isModuleBlock(parent) && ts.isModuleDeclaration(parent.parent)
        && (ts.isIdentifier(parent.parent.name) || ts.isStringLiteral(parent.parent.name))) {
        contract = this.#memberContracts.get(`${parent.parent.name.text}#${symbol.name}`);
        if (contract) break;
      }
    }
    if (!contract) {
      const declaration = symbol.valueDeclaration;
      if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer
        && ts.isVariableDeclarationList(declaration.parent)
        && (declaration.parent.flags & ts.NodeFlags.Const) !== 0) {
        let initializer = declaration.initializer;
        while (ts.isParenthesizedExpression(initializer) || ts.isAsExpression(initializer)
          || ts.isTypeAssertionExpression(initializer) || ts.isNonNullExpression(initializer)) initializer = initializer.expression;
        const lookup = ts.isPropertyAccessExpression(initializer) ? initializer.name
          : ts.isElementAccessExpression(initializer) && initializer.argumentExpression
            && (ts.isStringLiteral(initializer.argumentExpression) || ts.isNumericLiteral(initializer.argumentExpression))
            ? initializer.argumentExpression : ts.isIdentifier(initializer) ? initializer : undefined;
        const target = lookup ? targetSymbol(this.#checker, lookup) : undefined;
        if (target) contract = this.#resolveSymbolContract(target, seen);
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
    let contract = symbol ? this.#resolveMemberContract(lookup) : undefined;
    if (!contract) {
      const rooted = [...this.#rootedContracts.values()].flat().filter(({ root, path }) =>
        hasStableRootPath(this.#checker, call.expression, new Set([root]), path));
      if (rooted.length === 1) contract = rooted[0]!.contract;
      else if (rooted.length > 1) return {
        symbol: rooted[0]!.contract.symbol,
        span: { start: call.getStart(), end: call.getEnd() },
        evidence: "unknown",
      };
      else if (symbol) {
        const candidates = this.#rootedContracts.get(symbol) ?? [];
        if (candidates.length > 0) return {
          symbol: candidates[0]!.contract.symbol,
          span: { start: call.getStart(), end: call.getEnd() },
          evidence: "unknown",
        };
      }
    }
    if (!contract && ts.isPropertyAccessExpression(call.expression)) {
      const receiverType = this.#checker.getTypeAtLocation(call.expression.expression);
      if ((receiverType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) === 0) {
        const matches = (this.#domMethodContractsByName.get(call.expression.name.text) ?? []).filter(({ owner }) => {
          const ownerType = this.#domOwnerTypes.get(owner);
          return ownerType !== undefined && this.#checker.isTypeAssignableTo(receiverType, ownerType);
        });
        if (matches.length === 1) contract = matches[0]!.contract;
      }
    }
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
    if (!contract) {
      const factoryCall = ts.isCallExpression(call.expression)
        ? call.expression
        : ts.isIdentifier(call.expression)
          ? (() => {
              const declaration = symbol?.valueDeclaration;
              return declaration && ts.isVariableDeclaration(declaration) && declaration.initializer
                && ts.isVariableDeclarationList(declaration.parent)
                && (declaration.parent.flags & ts.NodeFlags.Const) !== 0
                && ts.isCallExpression(declaration.initializer)
                ? declaration.initializer : undefined;
            })()
          : undefined;
      const factory = factoryCall ? this.resolveCall(factoryCall) : undefined;
      if (!factory?.callableResult || !factoryCall) return undefined;
      const capturedCallbacks = factory.callableResult.capturedCallbackArguments?.flatMap((index) => {
        const argument = factoryCall.arguments[index];
        return argument ? [argument] : [];
      });
      return {
        symbol: factory.symbol,
        span: { start: call.getStart(), end: call.getEnd() },
        semantics: factory.callableResult.semantics,
        ...(capturedCallbacks?.length ? { capturedCallbacks } : {}),
      };
    }
    return {
      symbol: contract.symbol,
      span: { start: call.getStart(), end: call.getEnd() },
      evidence: "trusted",
      result: (() => {
        const result = contract.semantics?.primitives.find((primitive) => primitive.kind === "result"
          && (primitive.refinement.kind === "fresh" || primitive.refinement.kind === "path"));
        return result?.kind === "result" && (result.refinement.kind === "fresh" || result.refinement.kind === "path")
          ? result.refinement : undefined;
      })(),
      semantics: contract.semantics,
      callableResult: contract.callableResult,
      queryRefinement: (() => {
        const refinement = contract.semantics?.primitives.find((primitive) => primitive.kind === "result" && primitive.refinement.kind === "css-selector");
        if (refinement?.kind !== "result" || refinement.refinement.kind !== "css-selector"
          || refinement.refinement.target.kind !== "argument") return undefined;
        const argument = call.arguments[refinement.refinement.target.index];
        return argument && ts.isStringLiteralLike(argument) ? { kind: "css-selector" as const, selector: argument.text } : undefined;
      })(),
    };
  }

  resolveConstruct(construction: ts.NewExpression): ResolvedCallSite | undefined {
    const lookup = ts.isPropertyAccessExpression(construction.expression) ? construction.expression.name : construction.expression;
    const symbol = targetSymbol(this.#checker, lookup);
    let contract = symbol ? this.#resolveMemberContract(lookup) : undefined;
    if (!contract) {
      const rooted = [...this.#rootedContracts.values()].flat().filter(({ root, path }) =>
        hasStableRootPath(this.#checker, construction.expression, new Set([root]), path));
      if (rooted.length === 1) contract = rooted[0]!.contract;
      else if (rooted.length > 1) return {
        symbol: rooted[0]!.contract.symbol,
        span: { start: construction.getStart(), end: construction.getEnd() }, evidence: "unknown",
      };
      else if (symbol) {
        const candidates = this.#rootedContracts.get(symbol) ?? [];
        if (candidates.length > 0) return {
          symbol: candidates[0]!.contract.symbol,
          span: { start: construction.getStart(), end: construction.getEnd() }, evidence: "unknown",
        };
      }
    }
    if (!contract && ts.isIdentifier(construction.expression)) {
      const rootSymbol = targetSymbol(this.#checker, construction.expression);
      const isLibraryGlobal = rootSymbol?.declarations?.some((declaration) => declaration.getSourceFile().isDeclarationFile) ?? false;
      if (isLibraryGlobal) contract = this.#globalContracts.get(construction.expression.text);
    }
    return contract ? {
      symbol: contract.symbol,
      span: { start: construction.getStart(), end: construction.getEnd() },
      evidence: "trusted",
      semantics: contract.semantics,
      callableResult: contract.callableResult,
    } : undefined;
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
    if (!contract) {
      const rooted = [...this.#rootedContracts.values()].flat().filter(({ root, path }) =>
        hasStableRootPath(this.#checker, access, new Set([root]), path));
      if (rooted.length === 1) contract = rooted[0]!.contract;
      else if (rooted.length > 1) return {
        symbol: rooted[0]!.contract.symbol, span: { start: access.getStart(), end: access.getEnd() }, evidence: "unknown",
      };
      else if (symbol) {
        const candidates = this.#rootedContracts.get(symbol) ?? [];
        if (candidates.length > 0) return {
          symbol: candidates[0]!.contract.symbol,
          span: { start: access.getStart(), end: access.getEnd() },
          evidence: "unknown",
        };
      }
    }
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
    if (!contract?.semantics?.primitives.some((primitive) => primitive.kind === "property")) return undefined;
    return {
      symbol: contract.symbol,
      span: { start: access.getStart(), end: access.getEnd() },
      semantics: contract.semantics,
      evidence: "trusted",
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
        const aliasesReceiver = property?.semantics?.primitives.some((primitive) => primitive.kind === "property"
          && primitive.read.some((nested) => nested.kind === "result" && nested.refinement.kind === "alias"
            && nested.refinement.target.kind === "receiver"));
        if (aliasesReceiver) return resolve(value.expression) ?? value.expression;
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
    const definitelyPrimitive = (value: ts.Expression): boolean => {
      const type = this.#checker.getTypeAtLocation(value);
      const members = type.isUnion() ? type.types : [type];
      return members.every((member) => (member.flags & (
        ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BigIntLike
        | ts.TypeFlags.BooleanLike | ts.TypeFlags.ESSymbolLike
        | ts.TypeFlags.Null | ts.TypeFlags.Undefined
      )) !== 0);
    };
    const directProxyReceiver = (expression: ts.Expression): boolean =>
      isAuthenticatedProxyExpression(this.#checker, expression);
    const localGlobalSymbolMethod = (expression: ts.Expression, member: string): boolean =>
      this.#checker.getTypeAtLocation(expression).getProperties().some((property) =>
        property.declarations?.some((declaration) => {
          if (!ts.isMethodDeclaration(declaration) || !declaration.body
            || !ts.isComputedPropertyName(declaration.name)
            || !ts.isPropertyAccessExpression(declaration.name.expression)
            || declaration.name.expression.name.text !== member) return false;
          const symbol = targetSymbol(this.#checker, declaration.name.expression.expression);
          return symbol?.declarations?.some((owner) => owner.getSourceFile().isDeclarationFile
            && /(?:^|[/\\])typescript[/\\]lib[/\\]lib\.[^/\\]+\.d\.ts$/.test(owner.getSourceFile().fileName)) ?? false;
        }) ?? false);
    const hasEnumerableObjectLiteralGetter = (type: ts.Type): boolean => type.getProperties().some((property) =>
      property.declarations?.some((declaration) => ts.isGetAccessorDeclaration(declaration)
        && ts.isObjectLiteralExpression(declaration.parent)) ?? false);
    const objectBindingMayInvoke = (pattern: ts.ObjectBindingPattern, sourceType: ts.Type): boolean => {
      if ((sourceType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) return true;
      for (const element of pattern.elements) {
        if (element.propertyName && ts.isComputedPropertyName(element.propertyName)
          && !definitelyPrimitive(element.propertyName.expression)) return true;
        if (element.dotDotDotToken) {
          if (hasEnumerableObjectLiteralGetter(sourceType)) return true;
          continue;
        }
        const propertyName = element.propertyName
          ? ts.isIdentifier(element.propertyName) || ts.isStringLiteralLike(element.propertyName)
            || ts.isNumericLiteral(element.propertyName) ? element.propertyName.text : undefined
          : ts.isIdentifier(element.name) ? element.name.text : undefined;
        if (propertyName === undefined) continue;
        const property = this.#checker.getPropertyOfType(sourceType, propertyName);
        if (property?.declarations?.some(ts.isGetAccessorDeclaration)) return true;
        if (property && ts.isObjectBindingPattern(element.name)
          && objectBindingMayInvoke(element.name, this.#checker.getTypeOfSymbolAtLocation(property, element))) return true;
      }
      return false;
    };
    const jsonTypeMayInvoke = (type: ts.Type, seen = new Set<ts.Type>()): boolean => {
      const members = type.isUnion() ? type.types : [type];
      return members.some((member) => {
        if ((member.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) return true;
        if ((member.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BigIntLike
          | ts.TypeFlags.BooleanLike | ts.TypeFlags.ESSymbolLike | ts.TypeFlags.Null | ts.TypeFlags.Undefined)) !== 0) return false;
        if (member.getCallSignatures().length > 0) return false; // JSON omits function values.
        if (seen.has(member)) return false;
        seen.add(member);
        if (this.#checker.getPropertyOfType(member, "toJSON") !== undefined || hasEnumerableObjectLiteralGetter(member)) return true;
        for (const kind of [ts.IndexKind.Number, ts.IndexKind.String]) {
          const indexed = this.#checker.getIndexTypeOfType(member, kind);
          if (indexed && jsonTypeMayInvoke(indexed, seen)) return true;
        }
        return member.getProperties().some((property) => {
          if (property.declarations?.some(ts.isGetAccessorDeclaration)) return true;
          const location = property.valueDeclaration ?? property.declarations?.[0];
          return Boolean(location && jsonTypeMayInvoke(this.#checker.getTypeOfSymbolAtLocation(property, location), seen));
        });
      });
    };
    const structuredCloneTypeMayInvoke = (type: ts.Type, seen = new Set<ts.Type>()): boolean => {
      const members = type.isUnion() ? type.types : [type];
      return members.some((member) => {
        if ((member.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) !== 0) return true;
        if ((member.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BigIntLike
          | ts.TypeFlags.BooleanLike | ts.TypeFlags.ESSymbolLike | ts.TypeFlags.Null | ts.TypeFlags.Undefined)) !== 0) return false;
        if (member.getCallSignatures().length > 0 || seen.has(member)) return false;
        seen.add(member);
        // Structured clone visits own enumerable properties. Accessors declared
        // by built-in interfaces/classes live on prototypes and are not invoked.
        if (hasEnumerableObjectLiteralGetter(member)) return true;
        for (const kind of [ts.IndexKind.Number, ts.IndexKind.String]) {
          const indexed = this.#checker.getIndexTypeOfType(member, kind);
          if (indexed && structuredCloneTypeMayInvoke(indexed, seen)) return true;
        }
        return member.getProperties().some((property) => {
          const location = property.valueDeclaration ?? property.declarations?.[0];
          return Boolean(location && structuredCloneTypeMayInvoke(this.#checker.getTypeOfSymbolAtLocation(property, location), seen));
        });
      });
    };
    const hasLocalCallableBody = (expression: ts.Expression): boolean =>
      !directProxyReceiver(expression) && this.#checker.getTypeAtLocation(expression).getCallSignatures().some((signature) => {
        const declaration = signature.declaration;
        return Boolean(declaration && ts.isFunctionLike(declaration) && (declaration as ts.FunctionLikeDeclaration).body
          && !declaration.getSourceFile().isDeclarationFile);
      });
    const isStaticApplyList = (raw: ts.Expression, seen = new Set<ts.Symbol>()): boolean => {
      const expression = ts.isParenthesizedExpression(raw) || ts.isAsExpression(raw)
        || ts.isTypeAssertionExpression(raw) || ts.isNonNullExpression(raw) ? raw.expression : raw;
      if (ts.isArrayLiteralExpression(expression)) return expression.elements.every((item) => !ts.isSpreadElement(item));
      if (!ts.isIdentifier(expression)) return false;
      const symbol = targetSymbol(this.#checker, expression);
      if (!symbol || seen.has(symbol)) return false;
      seen.add(symbol);
      const variable = symbol.valueDeclaration;
      if (!(variable && ts.isVariableDeclaration(variable) && variable.initializer
        && ts.isVariableDeclarationList(variable.parent) && (variable.parent.flags & ts.NodeFlags.Const) !== 0)) return false;
      let scope: ts.Node = variable;
      while (scope.parent && !ts.isFunctionLike(scope) && !ts.isSourceFile(scope)) scope = scope.parent;
      let unstable = false;
      const screen = (candidate: ts.Node): void => {
        if (unstable) return;
        if (ts.isIdentifier(candidate) && targetSymbol(this.#checker, candidate) === symbol
          && candidate !== variable.name && candidate !== expression) unstable = true;
        ts.forEachChild(candidate, screen);
      };
      screen(scope);
      return !unstable && isStaticApplyList(variable.initializer, seen);
    };
    const boundTargetExpression = (
      raw: ts.Expression, seen = new Set<ts.Symbol>(),
    ): { target: ts.Expression; stable: boolean } | undefined => {
      const expression = ts.isParenthesizedExpression(raw) || ts.isAsExpression(raw)
        || ts.isTypeAssertionExpression(raw) || ts.isNonNullExpression(raw) ? raw.expression : raw;
      let initializer: ts.Expression = expression;
      if (ts.isIdentifier(expression)) {
        const symbol = targetSymbol(this.#checker, expression);
        const variable = symbol?.valueDeclaration;
        if (!symbol || seen.has(symbol) || !variable || !ts.isVariableDeclaration(variable) || !variable.initializer
          || !ts.isVariableDeclarationList(variable.parent) || (variable.parent.flags & ts.NodeFlags.Const) === 0) return undefined;
        seen.add(symbol);
        const possibleAlias = ts.isIdentifier(variable.initializer);
        const possibleBind = ts.isCallExpression(variable.initializer)
          && ts.isPropertyAccessExpression(variable.initializer.expression)
          && variable.initializer.expression.name.text === "bind";
        if (!possibleAlias && !possibleBind) return undefined;
        let scope: ts.Node = variable;
        while (scope.parent && !ts.isFunctionLike(scope) && !ts.isSourceFile(scope)) scope = scope.parent;
        let unstable = false;
        const screen = (candidate: ts.Node): void => {
          if (unstable) return;
          if (ts.isIdentifier(candidate) && targetSymbol(this.#checker, candidate) === symbol
            && candidate !== variable.name && candidate !== expression) {
            const directCall = ts.isCallExpression(candidate.parent) && candidate.parent.expression === candidate;
            const wrapperCall = ts.isPropertyAccessExpression(candidate.parent) && candidate.parent.expression === candidate
              && (candidate.parent.name.text === "call" || candidate.parent.name.text === "apply")
              && ts.isCallExpression(candidate.parent.parent) && candidate.parent.parent.expression === candidate.parent;
            const immutableAlias = ts.isVariableDeclaration(candidate.parent) && candidate.parent.initializer === candidate
              && ts.isVariableDeclarationList(candidate.parent.parent)
              && (candidate.parent.parent.flags & ts.NodeFlags.Const) !== 0;
            if (!directCall && !wrapperCall && !immutableAlias) unstable = true;
          }
          ts.forEachChild(candidate, screen);
        };
        screen(scope);
        initializer = variable.initializer;
        if (ts.isIdentifier(initializer)) {
          const nested = boundTargetExpression(initializer, seen);
          return nested ? { ...nested, stable: nested.stable && !unstable } : undefined;
        }
        if (unstable && !(ts.isCallExpression(initializer) && ts.isPropertyAccessExpression(initializer.expression)
          && initializer.expression.name.text === "bind")) return undefined;
        if (ts.isCallExpression(initializer) && ts.isPropertyAccessExpression(initializer.expression)
          && initializer.expression.name.text === "bind") {
          const source = this.#checker.getResolvedSignature(initializer)?.declaration?.getSourceFile();
          return source?.isDeclarationFile
            && /(?:^|[/\\])typescript[/\\]lib[/\\]lib\.[^/\\]+\.d\.ts$/.test(source.fileName)
            ? { target: initializer.expression.expression, stable: !unstable } : undefined;
        }
      }
      if (!ts.isCallExpression(initializer) || !ts.isPropertyAccessExpression(initializer.expression)
        || initializer.expression.name.text !== "bind") return undefined;
      const source = this.#checker.getResolvedSignature(initializer)?.declaration?.getSourceFile();
      return source?.isDeclarationFile
        && /(?:^|[/\\])typescript[/\\]lib[/\\]lib\.[^/\\]+\.d\.ts$/.test(source.fileName)
        ? { target: initializer.expression.expression, stable: true } : undefined;
    };
    const hasLocalConstructor = (expression: ts.Expression): boolean => {
      if (directProxyReceiver(expression)) return false;
      const symbol = targetSymbol(this.#checker, expression);
      if (symbol?.declarations?.some((declaration) =>
        (ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration))
        && !declaration.getSourceFile().isDeclarationFile)) return true;
      return this.#checker.getTypeAtLocation(expression).getConstructSignatures().some((signature) =>
        Boolean(signature.declaration && ts.isConstructorDeclaration(signature.declaration)
          && signature.declaration.body && !signature.declaration.getSourceFile().isDeclarationFile));
    };
    const descriptorMayInvoke = (descriptor: ts.Expression): boolean => {
      const type = this.#checker.getTypeAtLocation(descriptor);
      return (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) !== 0
        || directProxyReceiver(descriptor)
        || ["enumerable", "configurable", "value", "writable", "get", "set"].some((name) =>
          this.#checker.getPropertyOfType(type, name)?.declarations?.some(ts.isGetAccessorDeclaration));
    };
    const descriptorMapMayInvoke = (descriptors: ts.Expression): boolean => {
      const type = this.#checker.getTypeAtLocation(descriptors);
      if ((type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) !== 0
        || directProxyReceiver(descriptors) || hasEnumerableObjectLiteralGetter(type)) return true;
      return ts.isObjectLiteralExpression(descriptors) && descriptors.properties.some((property) => {
        const descriptor = ts.isPropertyAssignment(property) ? property.initializer
          : ts.isShorthandPropertyAssignment(property) ? property.name : undefined;
        return !descriptor || descriptorMayInvoke(descriptor);
      });
    };
    if (ts.isSpreadAssignment(node)) {
      const sourceType = this.#checker.getTypeAtLocation(node.expression);
      if ((sourceType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0
        || directProxyReceiver(node.expression) || hasEnumerableObjectLiteralGetter(sourceType)) return true;
    }
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer) {
      const sourceType = this.#checker.getTypeAtLocation(node.initializer);
      if (directProxyReceiver(node.initializer) || objectBindingMayInvoke(node.name, sourceType)) return true;
    }
    if (ts.isObjectBindingPattern(node) && ts.isParameter(node.parent)) {
      if (objectBindingMayInvoke(node, this.#checker.getTypeAtLocation(node))) return true;
    }
    if (ts.isCallExpression(node) && node.arguments[0] && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "stringify" && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === "JSON") {
      const stringify = targetSymbol(this.#checker, node.expression.name);
      const standard = stringify?.declarations?.some((declaration) => declaration.getSourceFile().isDeclarationFile
        && /(?:^|[/\\])typescript[/\\]lib[/\\]lib\.[^/\\]+\.d\.ts$/.test(declaration.getSourceFile().fileName));
      if (standard) {
        const value = node.arguments[0];
        const type = this.#checker.getTypeAtLocation(value);
        if (directProxyReceiver(value) || jsonTypeMayInvoke(type)) return true;
      }
    }
    if (ts.isCallExpression(node) && node.arguments[0] && ts.isIdentifier(node.expression)
      && node.expression.text === "structuredClone") {
      const source = this.#checker.getResolvedSignature(node)?.declaration?.getSourceFile();
      const standard = source?.isDeclarationFile
        && /(?:^|[/\\])typescript[/\\]lib[/\\]lib\.[^/\\]+\.d\.ts$/.test(source.fileName);
      const value = node.arguments[0];
      if (standard && !directProxyReceiver(value)
        && structuredCloneTypeMayInvoke(this.#checker.getTypeAtLocation(value))) return true;
    }
    if (ts.isCallExpression(node) && node.arguments[0] && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "Object"
      && node.expression.name.text === "create") {
      const source = this.#checker.getResolvedSignature(node)?.declaration?.getSourceFile();
      const standard = source?.isDeclarationFile
        && /(?:^|[/\\])typescript[/\\]lib[/\\]lib\.[^/\\]+\.d\.ts$/.test(source.fileName);
      if (standard && node.arguments[1] && descriptorMapMayInvoke(node.arguments[1])) return true;
    }
    if (ts.isCallExpression(node) && node.arguments[0] && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "Object"
      && ["getOwnPropertyDescriptor", "getOwnPropertyDescriptors", "hasOwn"].includes(node.expression.name.text)) {
      const source = this.#checker.getResolvedSignature(node)?.declaration?.getSourceFile();
      const standard = source?.isDeclarationFile
        && /(?:^|[/\\])typescript[/\\]lib[/\\]lib\.[^/\\]+\.d\.ts$/.test(source.fileName);
      if (standard) {
        const target = node.arguments[0], type = this.#checker.getTypeAtLocation(target);
        if ((type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) !== 0
          || directProxyReceiver(target)) return true;
        if (node.expression.name.text !== "getOwnPropertyDescriptors"
          && node.arguments[1] && !definitelyPrimitive(node.arguments[1])) return true;
      }
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && (node.expression.name.text === "call" || node.expression.name.text === "apply")
      && !(node.expression.name.text === "apply" && ts.isIdentifier(node.expression.expression)
        && node.expression.expression.text === "Reflect")) {
      const source = this.#checker.getResolvedSignature(node)?.declaration?.getSourceFile();
      const standard = source?.isDeclarationFile
        && /(?:^|[/\\])typescript[/\\]lib[/\\]lib\.[^/\\]+\.d\.ts$/.test(source.fileName);
      if (standard) {
        const target = node.expression.expression;
        if (directProxyReceiver(target) || !hasLocalCallableBody(target)) return true;
        if (node.expression.name.text === "apply" && (!node.arguments[1] || !isStaticApplyList(node.arguments[1]))) return true;
      }
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "construct" && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === "Reflect") {
      const source = this.#checker.getResolvedSignature(node)?.declaration?.getSourceFile();
      const standard = source?.isDeclarationFile
        && /(?:^|[/\\])typescript[/\\]lib[/\\]lib\.[^/\\]+\.d\.ts$/.test(source.fileName);
      if (standard && node.arguments[0]) {
        if (directProxyReceiver(node.arguments[0]) || !hasLocalConstructor(node.arguments[0])) return true;
        if (!node.arguments[1] || !isStaticApplyList(node.arguments[1])) return true;
        if (node.arguments[2] && directProxyReceiver(node.arguments[2])) return true;
      }
    }
    if (ts.isCallExpression(node) && !ts.isPropertyAccessExpression(node.expression)
      && !ts.isElementAccessExpression(node.expression)) {
      const target = boundTargetExpression(node.expression);
      if (target && (!target.stable || directProxyReceiver(target.target) || !hasLocalCallableBody(target.target))) return true;
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "apply" && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === "Reflect") {
      const source = this.#checker.getResolvedSignature(node)?.declaration?.getSourceFile();
      const standard = source?.isDeclarationFile
        && /(?:^|[/\\])typescript[/\\]lib[/\\]lib\.[^/\\]+\.d\.ts$/.test(source.fileName);
      if (standard && node.arguments[0]) {
        if (directProxyReceiver(node.arguments[0]) || !hasLocalCallableBody(node.arguments[0])) return true;
        if (!node.arguments[2] || !isStaticApplyList(node.arguments[2])) return true;
      }
    }
    if (ts.isCallExpression(node) && node.arguments[0] && ts.isPropertyAccessExpression(node.expression)
      && ["get", "set", "has", "deleteProperty"].includes(node.expression.name.text)
      && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "Reflect") {
      const source = this.#checker.getResolvedSignature(node)?.declaration?.getSourceFile();
      const standard = source?.isDeclarationFile
        && /(?:^|[/\\])typescript[/\\]lib[/\\]lib\.[^/\\]+\.d\.ts$/.test(source.fileName);
      if (standard) {
        const target = node.arguments[0];
        const targetType = this.#checker.getTypeAtLocation(target);
        if ((targetType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) !== 0
          || directProxyReceiver(target)) return true;
        const key = node.arguments[1];
        if (key) {
          const keyType = this.#checker.getTypeAtLocation(key);
          const members = keyType.isUnion() ? keyType.types : [keyType];
          const names = members.flatMap((member) => {
            if ((member.flags & ts.TypeFlags.StringLiteral) !== 0) return [(member as ts.StringLiteralType).value];
            if ((member.flags & ts.TypeFlags.NumberLiteral) !== 0) return [String((member as ts.NumberLiteralType).value)];
            return [];
          });
          if (names.length !== members.length && node.expression.name.text !== "has") return true;
          if (node.expression.name.text === "get" && names.some((name) =>
            this.#checker.getPropertyOfType(targetType, name)?.declarations?.some(ts.isGetAccessorDeclaration))) return true;
          if (node.expression.name.text === "set" && names.some((name) =>
            this.#checker.getPropertyOfType(targetType, name)?.declarations?.some(ts.isSetAccessorDeclaration))) return true;
        }
        const receiverIndex = node.expression.name.text === "get" ? 2 : node.expression.name.text === "set" ? 3 : -1;
        const receiver = receiverIndex >= 0 ? node.arguments[receiverIndex] : undefined;
        if (receiver) {
          const receiverType = this.#checker.getTypeAtLocation(receiver);
          if ((receiverType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) !== 0
            || directProxyReceiver(receiver)) return true;
        }
      }
    }
    if (ts.isCallExpression(node) && node.arguments.length >= 2 && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "assign" && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === "Object") {
      const assign = targetSymbol(this.#checker, node.expression.name);
      const standard = assign?.declarations?.some((declaration) => declaration.getSourceFile().isDeclarationFile
        && /(?:^|[/\\])typescript[/\\]lib[/\\]lib\.[^/\\]+\.d\.ts$/.test(declaration.getSourceFile().fileName));
      if (standard) {
        const target = node.arguments[0]!;
        const sources = node.arguments.slice(1);
        const targetType = this.#checker.getTypeAtLocation(target);
        if ((targetType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) !== 0
          || directProxyReceiver(target)) return true;
        for (const source of sources) {
          const sourceType = this.#checker.getTypeAtLocation(source);
          if ((sourceType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) !== 0
            || directProxyReceiver(source) || hasEnumerableObjectLiteralGetter(sourceType)) return true;
          if (sourceType.getProperties().some((sourceProperty) => {
            const declarations = sourceProperty.declarations ?? [];
            const potentiallyOwnEnumerable = declarations.length === 0 || declarations.some((item) =>
              !((ts.isClassDeclaration(item.parent) || ts.isClassExpression(item.parent))
                && (ts.isMethodDeclaration(item) || ts.isGetAccessorDeclaration(item) || ts.isSetAccessorDeclaration(item))));
            return potentiallyOwnEnumerable
              && this.#checker.getPropertyOfType(targetType, sourceProperty.name)?.declarations?.some(ts.isSetAccessorDeclaration);
          })) return true;
        }
      }
    }
    if (ts.isCallExpression(node) && node.arguments[0] && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
      && ((node.expression.expression.text === "Object"
        && ["defineProperty", "defineProperties", "freeze", "seal", "preventExtensions", "setPrototypeOf"].includes(node.expression.name.text))
        || (node.expression.expression.text === "Reflect"
          && ["defineProperty", "setPrototypeOf"].includes(node.expression.name.text)))) {
      const source = this.#checker.getResolvedSignature(node)?.declaration?.getSourceFile();
      const standard = source?.isDeclarationFile
        && /(?:^|[/\\])typescript[/\\]lib[/\\]lib\.[^/\\]+\.d\.ts$/.test(source.fileName);
      if (standard) {
        const target = node.arguments[0], targetType = this.#checker.getTypeAtLocation(target);
        if ((targetType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) !== 0
          || directProxyReceiver(target)) return true;
        if (node.expression.name.text === "defineProperty") {
          if (node.arguments[1] && !definitelyPrimitive(node.arguments[1])) return true;
          const descriptor = node.arguments[2];
          if (descriptor) {
            const descriptorType = this.#checker.getTypeAtLocation(descriptor);
            if ((descriptorType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) !== 0
              || directProxyReceiver(descriptor)) return true;
            if (["enumerable", "configurable", "value", "writable", "get", "set"].some((name) =>
              this.#checker.getPropertyOfType(descriptorType, name)?.declarations?.some(ts.isGetAccessorDeclaration))) return true;
          }
        }
        if (node.expression.name.text === "defineProperties" && node.arguments[1]) {
          if (descriptorMapMayInvoke(node.arguments[1])) return true;
        }
      }
    }
    if (ts.isCallExpression(node) && node.arguments[0] && ts.isPropertyAccessExpression(node.expression)
      && ["values", "entries", "keys"].includes(node.expression.name.text)
      && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "Object") {
      const operation = targetSymbol(this.#checker, node.expression.name);
      const standard = operation?.declarations?.some((declaration) => declaration.getSourceFile().isDeclarationFile
        && /(?:^|[/\\])typescript[/\\]lib[/\\]lib\.[^/\\]+\.d\.ts$/.test(declaration.getSourceFile().fileName));
      if (standard) {
        const source = node.arguments[0];
        const sourceType = this.#checker.getTypeAtLocation(source);
        if ((sourceType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) !== 0
          || directProxyReceiver(source)) return true;
        if (node.expression.name.text !== "keys" && hasEnumerableObjectLiteralGetter(sourceType)) return true;
      }
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const lookup = ts.isPropertyAccessExpression(node) ? node.name : node.argumentExpression;
      const symbol = lookup ? targetSymbol(this.#checker, lookup) : undefined;
      if (symbol?.declarations?.some((declaration) => ts.isGetAccessorDeclaration(declaration) || ts.isSetAccessorDeclaration(declaration))) return true;
      const receiverType = this.#checker.getTypeAtLocation(node.expression);
      if ((receiverType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) return true;
      if (directProxyReceiver(node.expression)) return true;
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
    if (ts.isBinaryExpression(node) && [
      ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.AsteriskToken,
      ts.SyntaxKind.SlashToken, ts.SyntaxKind.PercentToken, ts.SyntaxKind.AsteriskAsteriskToken,
      ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken,
      ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken,
      ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken,
      ts.SyntaxKind.AmpersandToken, ts.SyntaxKind.BarToken, ts.SyntaxKind.CaretToken,
      ts.SyntaxKind.LessThanLessThanToken, ts.SyntaxKind.GreaterThanGreaterThanToken,
      ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
      ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.MinusEqualsToken, ts.SyntaxKind.AsteriskEqualsToken,
      ts.SyntaxKind.SlashEqualsToken, ts.SyntaxKind.PercentEqualsToken, ts.SyntaxKind.AsteriskAsteriskEqualsToken,
      ts.SyntaxKind.AmpersandEqualsToken, ts.SyntaxKind.BarEqualsToken, ts.SyntaxKind.CaretEqualsToken,
      ts.SyntaxKind.LessThanLessThanEqualsToken, ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
      ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
    ].includes(node.operatorToken.kind)) {
      return !definitelyPrimitive(node.left) || !definitelyPrimitive(node.right);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword) {
      const type = this.#checker.getTypeAtLocation(node.right);
      return (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0
        || directProxyReceiver(node.right) || localGlobalSymbolMethod(node.right, "hasInstance");
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.InKeyword) {
      const type = this.#checker.getTypeAtLocation(node.right);
      return (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0 || directProxyReceiver(node.right);
    }
    if (ts.isDeleteExpression(node)
      && (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression))) {
      const receiver = node.expression.expression;
      const type = this.#checker.getTypeAtLocation(receiver);
      return (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0 || directProxyReceiver(receiver);
    }
    if (ts.isPrefixUnaryExpression(node)
      && [ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.TildeToken].includes(node.operator)
      && !definitelyPrimitive(node.operand)) return true;
    if (ts.isTemplateSpan(node) && !definitelyPrimitive(node.expression)) return true;
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

  resolveConstInitializer(expression: ts.Expression): ts.Expression | undefined {
    if (!ts.isIdentifier(expression)) return undefined;
    const declaration = targetSymbol(this.#checker, expression)?.valueDeclaration;
    return declaration && ts.isVariableDeclaration(declaration) && declaration.initializer
      && ts.isVariableDeclarationList(declaration.parent)
      && (declaration.parent.flags & ts.NodeFlags.Const) !== 0
      ? declaration.initializer : undefined;
  }

  resolveStaticString(input: ts.Expression): string | undefined {
    const seen = new Set<ts.Expression>();
    let expression = input;
    while (!seen.has(expression)) {
      seen.add(expression);
      if (ts.isStringLiteralLike(expression)) return expression.text;
      if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)
        || ts.isTypeAssertionExpression(expression) || ts.isSatisfiesExpression(expression)
        || ts.isNonNullExpression(expression)) { expression = expression.expression; continue; }
      const initializer = this.resolveConstInitializer(expression);
      if (!initializer) return undefined;
      expression = initializer;
    }
    return undefined;
  }

  isSameReference(left: ts.Expression, right: ts.Expression): boolean {
    if (!ts.isIdentifier(left) || !ts.isIdentifier(right)) return false;
    const leftSymbol = targetSymbol(this.#checker, left), rightSymbol = targetSymbol(this.#checker, right);
    return leftSymbol !== undefined && leftSymbol === rightSymbol;
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
