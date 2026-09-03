import { resolve } from "node:path";
import ts from "typescript";
import { builtinContractRegistry, type BuiltinContractRegistry } from "./builtin-contracts.js";
import type { CorsaApiFrontend, CorsaBuiltinCallQuery, CorsaBuiltinCallResolution } from "./corsa-api-frontend.js";
import type { FrontendSymbolAdapter, ResolvedCallSite } from "./frontend-adapter.js";

/**
 * Routes the admitted Fetch/Console catalog through Corsa when a sidecar is
 * attached. Other builtins stay on the TypeScript adapter. Corsa is not a
 * complete FrontendSymbolAdapter.
 */
export function overlayCorsaBuiltinCatalog(
  adapter: FrontendSymbolAdapter,
  corsa: Pick<CorsaApiFrontend, "rootFiles" | "classifyBuiltinCalls">,
  registry: BuiltinContractRegistry = builtinContractRegistry,
): FrontendSymbolAdapter {
  const roots = new Set(corsa.rootFiles.map((file) => resolve(file)));
  const globals = new Map(
    registry.contracts.filter((contract) => contract.symbol.module === "global")
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
    const resolution = classify(call.getSourceFile()).get(call);
    if (!resolution) return undefined;
    const exportName = resolution.operation === "Fetch" ? "fetch"
      : resolution.operation === "Console"
        ? `${resolution.receiver?.name ?? "console"}.${resolution.symbol.name}`
        : undefined;
    const contract = exportName === undefined ? undefined : globals.get(exportName);
    if (!contract) return undefined;
    return {
      symbol: contract.symbol,
      span: { start: call.getStart(), end: call.getEnd() },
      evidence: "trusted",
      semantics: contract.semantics,
      callableResult: contract.callableResult,
    };
  };

  return {
    resolveCall(call) {
      return fromCorsa(call) ?? adapter.resolveCall(call);
    },
    resolveConstruct: (construction) => adapter.resolveConstruct(construction),
    resolveProperty: (access) => adapter.resolveProperty(access),
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
