import ts from "typescript";

export type PromiseReactionKind = "then" | "catch" | "finally";
export type PromiseExecutorSettlement = "fulfilled" | "rejected" | "assimilating";
export interface PromiseExecutorEvent {
  kind: "resolve" | "reject" | "throw";
  settlement: PromiseExecutorSettlement;
  span: { start: number; end: number };
}
export interface PromiseExecutorPattern {
  owner: string;
  binding?: string;
  callback: string;
  synchronous: true;
  throwBecomesRejection: true;
  events: PromiseExecutorEvent[];
  possibleSettlements: PromiseExecutorSettlement[];
  adoptedExecutor?: number;
  adoptedExecutors?: number[];
  adoptedThenable?: number;
  adoptedThenables?: number[];
  selfResolution?: boolean;
  mayRemainPending: boolean;
  span: { start: number; end: number };
}
export type PromiseHandlerReturn = "absent" | "value" | "promise-like" | "unknown";
export interface PromiseReactionPattern { kind: PromiseReactionKind; handlers: string[]; handlerReturns: PromiseHandlerReturn[]; handlerExecutors?: (number | undefined)[]; span: { start: number; end: number } }
export interface PromiseChainPattern { owner: string; source: string; executor?: number; links: PromiseReactionPattern[]; span: { start: number; end: number } }
export interface PromiseThenablePattern {
  owner: string;
  binding: string;
  thenAccess: "throws" | "callable" | "dynamic";
  invokesUserCode: true;
  capabilityEffects: ["InvokeUserCode"];
  provenance: "local" | "proxy" | "external";
  possibleSettlements: Exclude<PromiseExecutorSettlement, "assimilating">[];
  firstCallWins: true;
  mayRemainPending: boolean;
  adoptedThenable?: number;
  span: { start: number; end: number };
}
export interface PromiseChainModel { executors: PromiseExecutorPattern[]; thenables: PromiseThenablePattern[]; chains: PromiseChainPattern[] }

function targetSymbol(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
  const symbol = checker.getSymbolAtLocation(node);
  return symbol && (symbol.flags & ts.SymbolFlags.Alias) ? checker.getAliasedSymbol(symbol) : symbol;
}
function librarySymbol(checker: ts.TypeChecker, node: ts.Node): boolean {
  return targetSymbol(checker, node)?.declarations?.some((declaration) => declaration.getSourceFile().isDeclarationFile) ?? false;
}
function ownerName(node: ts.SignatureDeclaration): string {
  if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node)) && node.name) return node.name.getText();
  if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) return node.parent.name.text;
  return "<anonymous>";
}
function reactionKind(call: ts.CallExpression, checker: ts.TypeChecker): PromiseReactionKind | undefined {
  if (!ts.isPropertyAccessExpression(call.expression)) return undefined;
  const name = call.expression.name.text;
  if (name !== "then" && name !== "catch" && name !== "finally") return undefined;
  return librarySymbol(checker, call.expression.name) ? name : undefined;
}

function handlerReturn(expression: ts.Expression, checker: ts.TypeChecker): PromiseHandlerReturn {
  if (expression.kind === ts.SyntaxKind.NullKeyword ||
      (ts.isIdentifier(expression) && (expression.text === "undefined" || expression.text === "null"))) return "absent";
  const type = checker.getTypeAtLocation(expression);
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return "unknown";
  const signatures = checker.getSignaturesOfType(type, ts.SignatureKind.Call);
  if (signatures.length === 0) return "unknown";
  const returns = signatures.map((signature) => checker.getReturnTypeOfSignature(signature));
  const promiseLike = returns.map((returnType) => Boolean(checker.getPropertyOfType(returnType, "then")));
  if (promiseLike.every(Boolean)) return "promise-like";
  if (promiseLike.some(Boolean)) return "unknown";
  return "value";
}

type ExecutorPath = "open" | PromiseExecutorSettlement;

function analyzeExecutor(
  callback: ts.Expression | ts.MethodDeclaration | undefined,
  checker: ts.TypeChecker,
  source: ts.SourceFile,
): Pick<PromiseExecutorPattern, "events" | "possibleSettlements" | "mayRemainPending"> & { adoptedSymbols: ts.Symbol[]; adoptedExpressions: ts.Expression[] } {
  if (!callback || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback) && !ts.isMethodDeclaration(callback)) || !callback.body) {
    return { events: [], possibleSettlements: ["fulfilled", "rejected", "assimilating"], mayRemainPending: true, adoptedSymbols: [], adoptedExpressions: [] };
  }
  const resolveParameter = callback.parameters[0]?.name;
  const rejectParameter = callback.parameters[1]?.name;
  const resolveName = resolveParameter && ts.isIdentifier(resolveParameter) ? resolveParameter.text : undefined;
  const rejectName = rejectParameter && ts.isIdentifier(rejectParameter) ? rejectParameter.text : undefined;
  const events: PromiseExecutorEvent[] = [];
  const adoptedSymbols: ts.Symbol[] = [];
  const adoptedExpressions: ts.Expression[] = [];
  const unique = (paths: ExecutorPath[]): ExecutorPath[] => [...new Set(paths)];
  const expressionSettlement = (expression: ts.Expression): PromiseExecutorEvent | undefined => {
    if (!ts.isCallExpression(expression) || !ts.isIdentifier(expression.expression)) return undefined;
    const name = expression.expression.text;
    if (name !== resolveName && name !== rejectName) return undefined;
    let settlement: PromiseExecutorSettlement = "rejected";
    if (name === resolveName) {
      const argument = expression.arguments[0];
      const promiseLike = argument && checker.getPropertyOfType(checker.getTypeAtLocation(argument), "then");
      settlement = promiseLike ? "assimilating" : "fulfilled";
      const adopted = argument && promiseLike ? targetSymbol(checker, argument) : undefined;
      if (adopted) adoptedSymbols.push(adopted);
      if (argument && promiseLike) adoptedExpressions.push(argument);
    }
    return { kind: name === resolveName ? "resolve" : "reject", settlement, span: { start: expression.getStart(source), end: expression.getEnd() } };
  };
  const executeStatement = (statement: ts.Statement, paths: ExecutorPath[]): ExecutorPath[] => {
    if (ts.isBlock(statement)) return executeStatements(statement.statements, paths);
    if (ts.isIfStatement(statement)) {
      const open = paths.filter((path) => path === "open");
      const settled = paths.filter((path) => path !== "open");
      const thenPaths = executeStatement(statement.thenStatement, open);
      const elsePaths = statement.elseStatement ? executeStatement(statement.elseStatement, open) : open;
      return unique([...settled, ...thenPaths, ...elsePaths]);
    }
    if (ts.isThrowStatement(statement)) {
      events.push({ kind: "throw", settlement: "rejected", span: { start: statement.getStart(source), end: statement.getEnd() } });
      return unique(paths.map((path) => path === "open" ? "rejected" : path));
    }
    if (ts.isExpressionStatement(statement)) {
      const event = expressionSettlement(statement.expression);
      if (event) {
        events.push(event);
        return unique(paths.map((path) => path === "open" ? event.settlement : path));
      }
    }
    return paths;
  };
  const executeStatements = (statements: ts.NodeArray<ts.Statement>, initial: ExecutorPath[]): ExecutorPath[] =>
    statements.reduce((paths, statement) => executeStatement(statement, paths), initial);
  let paths: ExecutorPath[];
  if (ts.isBlock(callback.body)) paths = executeStatements(callback.body.statements, ["open"]);
  else {
    const event = expressionSettlement(callback.body);
    if (event) events.push(event);
    paths = [event?.settlement ?? "open"];
  }
  return {
    events,
    possibleSettlements: paths.filter((path): path is PromiseExecutorSettlement => path !== "open"),
    mayRemainPending: paths.includes("open"),
    adoptedSymbols,
    adoptedExpressions,
  };
}

function returnedExpressions(handler: ts.Expression): ts.Expression[] {
  if (!ts.isArrowFunction(handler) && !ts.isFunctionExpression(handler)) return [];
  if (!ts.isBlock(handler.body)) return [handler.body];
  return handler.body.statements.flatMap((statement) =>
    ts.isReturnStatement(statement) && statement.expression ? [statement.expression] : []);
}

export function analyzePromiseChainsInProgram(program: ts.Program, source: ts.SourceFile): PromiseChainModel {
  const checker = program.getTypeChecker(), executors: PromiseExecutorPattern[] = [], thenables: PromiseThenablePattern[] = [], chains: PromiseChainPattern[] = [];
  const executorBySymbol = new Map<ts.Symbol, number>();
  const thenableBySymbol = new Map<ts.Symbol, number>();
  const pendingAdoptions: { executor: number; symbols: ts.Symbol[]; expressions: ts.Expression[] }[] = [];
  const ensureExternalThenable = (symbol: ts.Symbol): number | undefined => {
    const existing = thenableBySymbol.get(symbol);
    if (existing !== undefined) return existing;
    const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
    const type = declaration && checker.getTypeOfSymbolAtLocation(symbol, declaration);
    if (!declaration || !type || !checker.getPropertyOfType(type, "then")) return undefined;
    const thenable = thenables.length;
    thenableBySymbol.set(symbol, thenable);
    const external = declaration.getSourceFile() !== source || declaration.getSourceFile().isDeclarationFile
      || (ts.isVariableDeclaration(declaration) && declaration.initializer === undefined);
    thenables.push({ owner: external ? "<external>" : enclosingOwner(declaration), binding: symbol.getName(), thenAccess: "dynamic", invokesUserCode: true,
      capabilityEffects: ["InvokeUserCode"], provenance: external ? "external" : "local", possibleSettlements: ["fulfilled", "rejected"],
      firstCallWins: true, mayRemainPending: true, span: { start: declaration.getStart(declaration.getSourceFile()), end: declaration.getEnd() } });
    return thenable;
  };
  const thenablePattern = (
    expression: ts.Expression,
    seen = new Set<ts.Symbol>(),
  ): Omit<PromiseThenablePattern, "owner" | "binding" | "span"> | undefined => {
    const literal = ts.isObjectLiteralExpression(expression) ? expression : undefined;
    const proxy = ts.isNewExpression(expression) && ts.isIdentifier(expression.expression) && expression.expression.text === "Proxy" && librarySymbol(checker, expression.expression);
    const property = literal?.properties.find((item) => item.name?.getText(expression.getSourceFile()) === "then");
    if (property && ts.isGetAccessorDeclaration(property) && property.body?.statements.length === 1 && ts.isThrowStatement(property.body.statements[0]!)) {
      return { thenAccess: "throws", invokesUserCode: true, capabilityEffects: ["InvokeUserCode"], provenance: "local", possibleSettlements: ["rejected"], firstCallWins: true, mayRemainPending: false };
    }
    if (property && ts.isGetAccessorDeclaration(property)) {
      return { thenAccess: "dynamic", invokesUserCode: true, capabilityEffects: ["InvokeUserCode"], provenance: "local", possibleSettlements: ["fulfilled", "rejected"], firstCallWins: true, mayRemainPending: true };
    }
    const callback = property && ts.isMethodDeclaration(property) ? property
      : property && ts.isPropertyAssignment(property) && (ts.isArrowFunction(property.initializer) || ts.isFunctionExpression(property.initializer)) ? property.initializer
        : undefined;
    if (callback) {
      const analyzed = analyzeExecutor(callback, checker, expression.getSourceFile());
      const nestedAssimilation = analyzed.possibleSettlements.includes("assimilating");
      const adoptedThenables = [...new Set(analyzed.adoptedSymbols.flatMap((symbol) => {
        const thenable = thenableBySymbol.get(symbol) ?? ensureExternalThenable(symbol);
        return thenable === undefined ? [] : [thenable];
      }))];
      return {
        thenAccess: "callable", invokesUserCode: true,
        capabilityEffects: ["InvokeUserCode"], provenance: "local",
        possibleSettlements: nestedAssimilation
          ? ["fulfilled", "rejected"]
          : analyzed.possibleSettlements.filter((item): item is "fulfilled" | "rejected" => item !== "assimilating"),
        firstCallWins: true, mayRemainPending: analyzed.mayRemainPending || nestedAssimilation,
        adoptedThenable: adoptedThenables.length === 1 ? adoptedThenables[0] : undefined,
      };
    }
    if (proxy && checker.getPropertyOfType(checker.getTypeAtLocation(expression), "then")) {
      const handler = expression.arguments?.[1];
      const getTrap = handler && ts.isObjectLiteralExpression(handler)
        ? handler.properties.find((item) => item.name?.getText(handler.getSourceFile()) === "get")
        : undefined;
      const trapBody = getTrap && (ts.isMethodDeclaration(getTrap) || ts.isGetAccessorDeclaration(getTrap)) ? getTrap.body : undefined;
      if (trapBody?.statements.length === 1 && ts.isThrowStatement(trapBody.statements[0]!)) {
        return { thenAccess: "throws", invokesUserCode: true, capabilityEffects: ["InvokeUserCode"], provenance: "proxy", possibleSettlements: ["rejected"], firstCallWins: true, mayRemainPending: false };
      }
      return { thenAccess: "dynamic", invokesUserCode: true, capabilityEffects: ["InvokeUserCode"], provenance: "proxy", possibleSettlements: ["fulfilled", "rejected"], firstCallWins: true, mayRemainPending: true };
    }
    if (!ts.isCallExpression(expression)) return undefined;
    const symbol = targetSymbol(checker, expression.expression);
    if (!symbol || seen.has(symbol)) return undefined;
    seen.add(symbol);
    const declarations = symbol.declarations ?? [];
    const returns = declarations.flatMap((declaration) => {
      if (!ts.isFunctionLike(declaration) || !("body" in declaration) || !declaration.body) return [];
      const body = declaration.body as ts.ConciseBody;
      if (!ts.isBlock(body)) return [body];
      return body.statements.flatMap((statement) =>
        ts.isReturnStatement(statement) && statement.expression ? [statement.expression] : []);
    });
    const patterns = returns.map((returned) => thenablePattern(returned, seen)).filter((item): item is NonNullable<typeof item> => item !== undefined);
    if (patterns.length === 0 || patterns.length !== returns.length) return undefined;
    const thenAccess = patterns.every((item) => item.thenAccess === patterns[0]!.thenAccess) ? patterns[0]!.thenAccess : "dynamic";
    return {
      thenAccess,
      invokesUserCode: true,
      capabilityEffects: ["InvokeUserCode"],
      provenance: "local",
      possibleSettlements: [...new Set(patterns.flatMap((item) => item.possibleSettlements))],
      firstCallWins: true,
      mayRemainPending: patterns.some((item) => item.mayRemainPending),
    };
  };
  const collectThenables = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const pattern = thenablePattern(node.initializer);
      const symbol = pattern && targetSymbol(checker, node.name);
      if (pattern && symbol) {
        const existing = thenableBySymbol.get(symbol);
        const value = { owner: enclosingOwner(node), binding: node.name.text, ...pattern, span: { start: node.initializer.getStart(source), end: node.initializer.getEnd() } };
        if (existing === undefined) {
          thenableBySymbol.set(symbol, thenables.length);
          thenables.push(value);
        } else thenables[existing] = value;
      }
    }
    ts.forEachChild(node, collectThenables);
  };
  const enclosingOwner = (node: ts.Node): string => {
    for (let current = node.parent; current; current = current.parent) if (ts.isFunctionLike(current)) return ownerName(current);
    return "<module>";
  };
  collectThenables(source);
  const visitFunctionExecutors = (owner: ts.FunctionLikeDeclaration): void => {
    if (!owner.body) return;
    const name = ownerName(owner);
    const visit = (node: ts.Node): void => {
      if (node !== owner.body && ts.isFunctionLike(node)) return;
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Promise" && librarySymbol(checker, node.expression)) {
        const binding = ts.isVariableDeclaration(node.parent) && node.parent.initializer === node && ts.isIdentifier(node.parent.name) ? node.parent.name.text : undefined;
        const callback = node.arguments?.[0];
        const analyzed = analyzeExecutor(callback, checker, source);
        const index = executors.length;
        const { adoptedSymbols, adoptedExpressions, ...publicAnalysis } = analyzed;
        executors.push({ owner: name, binding, callback: callback?.getText(source) ?? "<unknown>", synchronous: true, throwBecomesRejection: true, ...publicAnalysis, span: { start: node.getStart(source), end: node.getEnd() } });
        if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
          const symbol = targetSymbol(checker, node.parent.name);
          if (symbol) executorBySymbol.set(symbol, index);
        }
        pendingAdoptions.push({ executor: index, symbols: adoptedSymbols, expressions: adoptedExpressions });
      }
      ts.forEachChild(node, visit);
    };
    visit(owner.body);
  };
  const visitFunctionChains = (owner: ts.FunctionLikeDeclaration): void => {
    if (!owner.body) return;
    const name = ownerName(owner);
    const visit = (node: ts.Node): void => {
      if (node !== owner.body && ts.isFunctionLike(node)) return;
      if (ts.isCallExpression(node) && reactionKind(node, checker)) {
        const isInner = ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node && ts.isCallExpression(node.parent.parent);
        if (!isInner) {
          const links: PromiseReactionPattern[] = [];
          let current: ts.Expression = node;
          while (ts.isCallExpression(current)) {
            const kind = reactionKind(current, checker);
            if (!kind || !ts.isPropertyAccessExpression(current.expression)) break;
            const handlerExecutors = current.arguments.map((argument) => {
              const candidates = [...new Set(returnedExpressions(argument).flatMap((returned) => {
                const symbol = targetSymbol(checker, returned);
                const executor = symbol && executorBySymbol.get(symbol);
                return executor === undefined ? [] : [executor];
              }))];
              return candidates.length === 1 ? candidates[0] : undefined;
            });
            links.unshift({
              kind,
              handlers: current.arguments.map((argument) => argument.getText(source)),
              handlerReturns: current.arguments.map((argument) => handlerReturn(argument, checker)),
              handlerExecutors,
              span: { start: current.getStart(source), end: current.getEnd() },
            });
            current = current.expression.expression;
          }
          const sourceText = current.getText(source);
          const executor = executors.findIndex((item) => item.owner === name && item.binding === sourceText);
          chains.push({ owner: name, source: sourceText, executor: executor < 0 ? undefined : executor, links, span: { start: node.getStart(source), end: node.getEnd() } });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(owner.body);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) && "body" in node && node.body) visitFunctionExecutors(node as ts.FunctionLikeDeclaration);
    ts.forEachChild(node, visit);
  };
  visit(source);
  for (const pending of pendingAdoptions) {
    const adopted = [...new Set(pending.symbols.flatMap((symbol) => {
      const executor = executorBySymbol.get(symbol);
      return executor === undefined ? [] : [executor];
    }))];
    if (adopted.length) executors[pending.executor]!.adoptedExecutors = adopted;
    if (adopted.length === 1) executors[pending.executor]!.adoptedExecutor = adopted[0];
    if (adopted.includes(pending.executor)) executors[pending.executor]!.selfResolution = true;
    const adoptedThenables = [...new Set(pending.symbols.flatMap((symbol) => {
      if (executorBySymbol.has(symbol)) return [];
      const thenable = thenableBySymbol.get(symbol) ?? ensureExternalThenable(symbol);
      return thenable === undefined ? [] : [thenable];
    }))];
    const selectedSymbols = (expression: ts.Expression): ts.Symbol[] => {
      if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)) return selectedSymbols(expression.expression);
      if (ts.isConditionalExpression(expression)) return [...selectedSymbols(expression.whenTrue), ...selectedSymbols(expression.whenFalse)];
      const symbol = targetSymbol(checker, expression);
      return symbol ? [symbol] : [];
    };
    for (const expression of pending.expressions) {
      if (targetSymbol(checker, expression)) continue;
      const selected = [...new Set(selectedSymbols(expression).flatMap((symbol) => {
        const thenable = thenableBySymbol.get(symbol);
        return thenable === undefined ? [] : [thenable];
      }))];
      if (selected.length > 0) {
        adoptedThenables.push(...selected);
        continue;
      }
      const type = checker.getTypeAtLocation(expression);
      if (!checker.getPropertyOfType(type, "then")) continue;
      const callTarget = ts.isCallExpression(expression) ? targetSymbol(checker, expression.expression) : undefined;
      const external = callTarget?.declarations?.some((declaration) => declaration.getSourceFile() !== source) ?? false;
      const thenable = thenables.length;
      thenables.push({
        owner: external ? "<external>" : enclosingOwner(expression), binding: expression.getText(source), thenAccess: "dynamic",
        invokesUserCode: true, capabilityEffects: ["InvokeUserCode"], provenance: external ? "external" : "local",
        possibleSettlements: ["fulfilled", "rejected"], firstCallWins: true, mayRemainPending: true,
        span: { start: expression.getStart(source), end: expression.getEnd() },
      });
      adoptedThenables.push(thenable);
    }
    const uniqueThenables = [...new Set(adoptedThenables)];
    if (uniqueThenables.length) executors[pending.executor]!.adoptedThenables = uniqueThenables;
    if (uniqueThenables.length === 1) executors[pending.executor]!.adoptedThenable = uniqueThenables[0];
  }
  const visitChains = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) && "body" in node && node.body) visitFunctionChains(node as ts.FunctionLikeDeclaration);
    ts.forEachChild(node, visitChains);
  };
  visitChains(source);
  return { executors, thenables, chains };
}

export function analyzePromiseChains(fileName: string, text: string): PromiseChainModel {
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], types: ["node"], noEmit: true };
  const host = ts.createCompilerHost(options), original = host.getSourceFile.bind(host);
  host.getSourceFile = (name, version, onError, fresh) => name === fileName ? ts.createSourceFile(fileName, text, version, true, ts.ScriptKind.TS) : original(name, version, onError, fresh);
  const program = ts.createProgram([fileName], options, host);
  return analyzePromiseChainsInProgram(program, program.getSourceFile(fileName)!);
}

function safe(name: string): string { return name.replace(/[^A-Za-z0-9_]/g, "_"); }
export function generatePromiseChainsQuint(moduleName: string, model: PromiseChainModel, options: { allowEarlyReaction?: boolean; breakFinallyTransparency?: boolean; allowDoubleSettlement?: boolean; skipHandlerAssimilation?: boolean } = {}): string {
  const vars = model.chains.flatMap((chain, index) => [...chain.links.map((_, stage) => `chain_${index}_state_${stage}`), `chain_${index}_state_${chain.links.length}`, `chain_${index}_early`, `chain_${index}_finally_broken`, `chain_${index}_double_settlement`, `chain_${index}_flatten_broken`]);
  const isBool = (name: string): boolean => name.endsWith("early") || name.endsWith("broken") || name.endsWith("double_settlement");
  const lines = [`module ${safe(moduleName)} {`, ...vars.map((name) => `  var ${name}: ${isBool(name) ? "bool" : "int"}`), "", "  action init = all {"];
  for (const name of vars) lines.push(`    ${name}' = ${isBool(name) ? "false" : "0"},`);
  lines.push("  }");
  const actions: string[] = [];
  const action = (name: string, guards: string[], updates: Map<string, string>): void => {
    actions.push(name); lines.push("", `  action ${name} = all {`);
    guards.forEach((guard) => lines.push(`    ${guard},`));
    vars.forEach((variable) => lines.push(`    ${variable}' = ${updates.get(variable) ?? variable},`));
    lines.push("  }");
  };
  const chainForExecutor = (executor: number): number | undefined => {
    const index = model.chains.findIndex((chain) => chain.executor === executor);
    return index < 0 ? undefined : index;
  };
  const emitAdoption = (name: string, state: string, adoptedExecutor: number | undefined, fulfilled: string, rejected: string, adoptedThenable?: number, selfResolution = false, seenThenables = new Set<number>()): void => {
    if (selfResolution) {
      action(`${name}_self_resolution_rejected`, [`${state} == 3`], new Map([[state, rejected]]));
      return;
    }
    const adoptedChain = adoptedExecutor === undefined ? undefined : chainForExecutor(adoptedExecutor);
    const thenable = adoptedThenable === undefined ? undefined : model.thenables[adoptedThenable];
    if (thenable?.adoptedThenable !== undefined && !seenThenables.has(adoptedThenable!)) {
      emitAdoption(`${name}_thenable_${adoptedThenable}_nested`, state, undefined, fulfilled, rejected, thenable.adoptedThenable, false, new Set([...seenThenables, adoptedThenable!]));
      return;
    }
    if (thenable?.thenAccess === "throws") {
      action(`${name}_thenable_${adoptedThenable}_getter_rejected`, [`${state} == 3`], new Map([[state, rejected]]));
      return;
    }
    if (thenable) {
      if (thenable.possibleSettlements.includes("fulfilled")) action(`${name}_thenable_${adoptedThenable}_fulfilled`, [`${state} == 3`], new Map([[state, fulfilled]]));
      if (thenable.possibleSettlements.includes("rejected")) action(`${name}_thenable_${adoptedThenable}_rejected`, [`${state} == 3`], new Map([[state, rejected]]));
      return;
    }
    if (adoptedChain === undefined) {
      action(`${name}_fulfilled`, [`${state} == 3`], new Map([[state, fulfilled]]));
      action(`${name}_rejected`, [`${state} == 3`], new Map([[state, rejected]]));
      return;
    }
    const adoptedRoot = `chain_${adoptedChain}_state_0`;
    action(`${name}_from_${adoptedChain}_fulfilled`, [`${state} == 3`, `${adoptedRoot} == 1`], new Map([[state, fulfilled]]));
    action(`${name}_from_${adoptedChain}_rejected`, [`${state} == 3`, `${adoptedRoot} == 2`], new Map([[state, rejected]]));
  };
  model.chains.forEach((chain, chainIndex) => {
    const root = `chain_${chainIndex}_state_0`;
    const settlements: readonly PromiseExecutorSettlement[] = chain.executor === undefined
      ? ["fulfilled", "rejected"]
      : model.executors[chain.executor].possibleSettlements;
    if (settlements.includes("fulfilled")) action(`settle_${chainIndex}_fulfilled`, [`${root} == 0`], new Map([[root, "1"]]));
    if (settlements.includes("rejected")) action(`settle_${chainIndex}_rejected`, [`${root} == 0`], new Map([[root, "2"]]));
    if (settlements.includes("assimilating")) {
      action(`settle_${chainIndex}_assimilating`, [`${root} == 0`], new Map([[root, "3"]]));
      const executor = chain.executor === undefined ? undefined : model.executors[chain.executor];
      if ((executor?.adoptedThenables?.length ?? 0) > 1) executor!.adoptedThenables!.forEach((thenable, option) =>
        emitAdoption(`assimilate_${chainIndex}_thenable_option_${option}`, root, undefined, "1", "2", thenable));
      else emitAdoption(`assimilate_${chainIndex}`, root, executor?.adoptedExecutor, "1", "2", executor?.adoptedThenable, executor?.selfResolution);
    }
    if (options.allowDoubleSettlement) action(`settle_${chainIndex}_again`, [`${root} == 1`], new Map([[root, "2"], [`chain_${chainIndex}_double_settlement`, "true"]]));
    chain.links.forEach((link, stage) => {
      const input = `chain_${chainIndex}_state_${stage}`, output = `chain_${chainIndex}_state_${stage + 1}`;
      const emit = (suffix: string, inputState: 1 | 2, outputState: 1 | 2 | 3 | 4, extra = new Map<string, string>()) => action(`react_${chainIndex}_${stage}_${suffix}`, [`${input} == ${inputState}`, `${output} == 0`], new Map([[output, String(outputState)], ...extra]));
      const present = (index: number): boolean => Boolean(link.handlers[index] && link.handlers[index] !== "undefined" && link.handlers[index] !== "null");
      const mayReturnValue = (index: number): boolean => link.handlerReturns[index] === "value" || link.handlerReturns[index] === "unknown";
      const mayReturnPromise = (index: number): boolean => link.handlerReturns[index] === "promise-like" || link.handlerReturns[index] === "unknown";
      if (link.kind === "then") {
        if (present(0)) {
          if (mayReturnValue(0)) emit("handle_ok", 1, 1);
          if (mayReturnPromise(0)) emit("handle_assimilate", 1, 3);
          emit("handle_throw", 1, 2);
        } else emit("propagate_fulfill", 1, 1);
        if (present(1)) {
          if (mayReturnValue(1)) emit("handle_reject_ok", 2, 1);
          if (mayReturnPromise(1)) emit("handle_reject_assimilate", 2, 3);
          emit("handle_reject_throw", 2, 2);
        } else emit("propagate_reject", 2, 2);
      }
      if (link.kind === "catch") {
        emit("propagate_fulfill", 1, 1);
        if (present(0)) {
          if (mayReturnValue(0)) emit("recover_ok", 2, 1);
          if (mayReturnPromise(0)) emit("recover_assimilate", 2, 3);
          emit("recover_throw", 2, 2);
        } else emit("propagate_reject", 2, 2);
      }
      if (link.kind === "finally") {
        if (present(0)) {
          if (mayReturnValue(0)) { emit("preserve_fulfill", 1, 1); emit("preserve_reject", 2, 2); }
          if (mayReturnPromise(0)) {
            emit("finally_assimilate_after_fulfill", 1, 3);
            emit("finally_assimilate_after_reject", 2, 4);
          }
          emit("throw_after_fulfill", 1, 2);
          if (options.breakFinallyTransparency) emit("broken_recover", 2, 1, new Map([[`chain_${chainIndex}_finally_broken`, "true"]]));
        } else { emit("preserve_fulfill", 1, 1); emit("preserve_reject", 2, 2); }
      }
      if (link.handlerReturns.some((result) => result === "promise-like" || result === "unknown")) {
        const assimilatingHandlers = link.handlerReturns.flatMap((result, index) =>
          result === "promise-like" || result === "unknown" ? [{ result, executor: link.handlerExecutors?.[index] }] : []);
        const linkedHandlers = [...new Set(assimilatingHandlers.flatMap(({ result, executor }) =>
          result === "promise-like" && executor !== undefined ? [executor] : []))];
        const fullyLinked = assimilatingHandlers.length > 0 && assimilatingHandlers.every(({ result, executor }) => result === "promise-like" && executor !== undefined);
        emitAdoption(`assimilate_${chainIndex}_${stage}`, output, fullyLinked && linkedHandlers.length === 1 ? linkedHandlers[0] : undefined, "1", "2");
        if (link.kind === "finally") action(`assimilate_${chainIndex}_${stage}_preserve_reject`, [`${output} == 4`], new Map([[output, "2"]]));
        if (options.skipHandlerAssimilation) action(`react_${chainIndex}_${stage}_flatten_broken`, [`${input} != 0`, `${output} == 0`], new Map([[output, "1"], [`chain_${chainIndex}_flatten_broken`, "true"]]));
      }
      if (options.allowEarlyReaction) action(`react_${chainIndex}_${stage}_early`, [`${input} == 0`, `${output} == 0`], new Map([[output, "1"], [`chain_${chainIndex}_early`, "true"]]));
    });
  });
  lines.push("", "  action step = any {", ...actions.map((name) => `    ${name},`), "  }");
  const invariants = model.chains.flatMap((_, index) => [`not(chain_${index}_early)`, `not(chain_${index}_finally_broken)`, `not(chain_${index}_double_settlement)`, `not(chain_${index}_flatten_broken)`]);
  lines.push("", `  val promiseSafe = ${invariants.join(" and ") || "true"}`, "}", "");
  return lines.join("\n");
}
