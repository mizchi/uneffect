import { resolve } from "node:path";
import ts from "typescript";
import { builtinContractRegistry, type BuiltinContractRegistry } from "./builtin-contracts.js";
import type { CorsaApiFrontend, CorsaApiSymbolFact, CorsaBuiltinCallQuery, CorsaBuiltinCallResolution } from "./corsa-api-frontend.js";
import type { FrontendSymbolAdapter, ResolvedCallSite } from "./frontend-adapter.js";

function declaredByDomLibrary(symbol: CorsaApiSymbolFact | null | undefined): symbol is CorsaApiSymbolFact {
  return symbol !== null && symbol !== undefined
    && (symbol.declarations ?? []).some((item) => /(?:^|[/\\])lib\.dom\.d\.ts$/.test(item));
}

type CorsaCatalogFrontend = Pick<CorsaApiFrontend, "rootFiles" | "classifyBuiltinCalls">
  & Partial<Pick<CorsaApiFrontend, "getTypeAtPosition" | "getSymbolOfType" | "getPropertyOfType" | "getSymbolAtPosition">>;

/**
 * Routes admitted Fetch/Console, lib.dom methods/properties, and DOM
 * constructors through Corsa when a sidecar is attached. Other builtins stay
 * on the TypeScript adapter. Corsa is not a complete FrontendSymbolAdapter.
 */
export function overlayCorsaBuiltinCatalog(
  adapter: FrontendSymbolAdapter,
  corsa: CorsaCatalogFrontend,
  registry: BuiltinContractRegistry = builtinContractRegistry,
): FrontendSymbolAdapter {
  const roots = new Set(corsa.rootFiles.map((file) => resolve(file)));
  const globals = new Map(
    registry.contracts.filter((contract) => contract.symbol.module === "global")
      .map((contract) => [contract.symbol.export, contract]),
  );
  const domMethods = new Map(
    registry.contracts.filter((contract) => contract.symbol.module === "lib.dom" && contract.symbol.export.includes("#"))
      .map((contract) => [contract.symbol.export, contract]),
  );
  const classified = new WeakMap<ts.SourceFile, Map<ts.CallExpression, CorsaBuiltinCallResolution | null>>();

  const classify = (source: ts.SourceFile): Map<ts.CallExpression, CorsaBuiltinCallResolution | null> => {
    const cached = classified.get(source);
    if (cached) return cached;
    const byCall = new Map<ts.CallExpression, CorsaBuiltinCallResolution | null>();
    classified.set(source, byCall);
    if (!roots.has(resolve(source.fileName))) return byCall;
    const calls: ts.CallExpression[] = [];
    const queries: CorsaBuiltinCallQuery[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const expression = node.expression;
        calls.push(node);
        queries.push(ts.isPropertyAccessExpression(expression)
          ? { calleePosition: expression.name.getStart(source), receiverPosition: expression.expression.getStart(source) }
          : { calleePosition: expression.getStart(source) });
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(source, visit);
    const results = corsa.classifyBuiltinCalls(source.fileName, queries);
    for (const [index, call] of calls.entries()) byCall.set(call, results[index] ?? null);
    return byCall;
  };

  const fromCorsa = (call: ts.CallExpression): ResolvedCallSite | undefined => {
    const source = call.getSourceFile();
    const resolution = classify(source).get(call);
    const exportName = resolution?.operation === "Fetch" ? "fetch"
      : resolution?.operation === "Console"
        ? `${resolution.receiver?.name ?? "console"}.${resolution.symbol.name}`
        : undefined;
    const classifiedContract = exportName === undefined ? undefined : globals.get(exportName);
    const expression = call.expression;
    const domContract = classifiedContract === undefined
      && ts.isPropertyAccessExpression(expression)
      && corsa.getTypeAtPosition && corsa.getSymbolOfType && corsa.getPropertyOfType
      ? (() => {
          const receiverType = corsa.getTypeAtPosition!(source.fileName, expression.expression.getStart(source));
          if (!receiverType) return undefined;
          const owner = corsa.getSymbolOfType!(receiverType);
          const member = corsa.getPropertyOfType!(receiverType, expression.name.text);
          if (!declaredByDomLibrary(owner) || !declaredByDomLibrary(member)) return undefined;
          return domMethods.get(`${owner.name}#${member.name}`);
        })()
      : undefined;
    const contract = classifiedContract ?? domContract;
    if (!contract) return undefined;
    return {
      symbol: contract.symbol,
      span: { start: call.getStart(), end: call.getEnd() },
      evidence: "trusted",
      semantics: contract.semantics,
      callableResult: contract.callableResult,
    };
  };

  const fromCorsaConstruct = (construction: ts.NewExpression) => {
    if (!ts.isIdentifier(construction.expression) || !corsa.getSymbolAtPosition) return undefined;
    const source = construction.getSourceFile();
    if (!roots.has(resolve(source.fileName))) return undefined;
    const symbol = corsa.getSymbolAtPosition(source.fileName, construction.expression.getStart(source));
    if (!declaredByDomLibrary(symbol)) return undefined;
    const contract = globals.get(symbol.name);
    if (!contract) return undefined;
    return {
      symbol: contract.symbol,
      span: { start: construction.getStart(), end: construction.getEnd() },
      evidence: "trusted" as const,
      semantics: contract.semantics,
      callableResult: contract.callableResult,
    };
  };

  const fromCorsaProperty = (access: ts.PropertyAccessExpression | ts.ElementAccessExpression) => {
    if (!ts.isPropertyAccessExpression(access)
      || !corsa.getTypeAtPosition || !corsa.getSymbolOfType || !corsa.getPropertyOfType) return undefined;
    const source = access.getSourceFile();
    if (!roots.has(resolve(source.fileName))) return undefined;
    const receiverType = corsa.getTypeAtPosition(source.fileName, access.expression.getStart(source));
    if (!receiverType) return undefined;
    const owner = corsa.getSymbolOfType(receiverType);
    const member = corsa.getPropertyOfType(receiverType, access.name.text);
    if (!declaredByDomLibrary(owner) || !declaredByDomLibrary(member)) return undefined;
    const contract = domMethods.get(`${owner.name}#${member.name}`);
    if (!contract) return undefined;
    return {
      symbol: contract.symbol,
      span: { start: access.getStart(), end: access.getEnd() },
      evidence: "trusted" as const,
      semantics: contract.semantics,
    };
  };

  return {
    resolveCall(call) {
      return fromCorsa(call) ?? adapter.resolveCall(call);
    },
    resolveConstruct: (construction) => fromCorsaConstruct(construction) ?? adapter.resolveConstruct(construction),
    resolveProperty: (access) => fromCorsaProperty(access) ?? adapter.resolveProperty(access),
    resolveDomReceiverRegion: (expression) => adapter.resolveDomReceiverRegion(expression),
    isDomReceiver: (expression) => adapter.isDomReceiver(expression),
    mayInvokeUserCode: (node) => adapter.mayInvokeUserCode(node),
    ownershipKind: (expression) => adapter.ownershipKind(expression),
    thrownErrorType: (expression) => adapter.thrownErrorType(expression),
    resolveConstInitializer: (expression) => adapter.resolveConstInitializer(expression),
    resolveStaticString: (expression) => adapter.resolveStaticString(expression),
    isSameReference: (left, right) => adapter.isSameReference(left, right),
  };
}
