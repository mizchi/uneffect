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
  mayRemainPending: boolean;
  span: { start: number; end: number };
}
export type PromiseHandlerReturn = "absent" | "value" | "promise-like" | "unknown";
export interface PromiseReactionPattern { kind: PromiseReactionKind; handlers: string[]; handlerReturns: PromiseHandlerReturn[]; span: { start: number; end: number } }
export interface PromiseChainPattern { owner: string; source: string; executor?: number; links: PromiseReactionPattern[]; span: { start: number; end: number } }
export interface PromiseChainModel { executors: PromiseExecutorPattern[]; chains: PromiseChainPattern[] }

function targetSymbol(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
  const symbol = checker.getSymbolAtLocation(node);
  return symbol && (symbol.flags & ts.SymbolFlags.Alias) ? checker.getAliasedSymbol(symbol) : symbol;
}
function librarySymbol(checker: ts.TypeChecker, node: ts.Node): boolean {
  return targetSymbol(checker, node)?.declarations?.some((declaration) => declaration.getSourceFile().isDeclarationFile) ?? false;
}
function ownerName(node: ts.FunctionLikeDeclaration): string {
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
  callback: ts.Expression | undefined,
  checker: ts.TypeChecker,
  source: ts.SourceFile,
): Pick<PromiseExecutorPattern, "events" | "possibleSettlements" | "mayRemainPending"> {
  if (!callback || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))) {
    return { events: [], possibleSettlements: ["fulfilled", "rejected", "assimilating"], mayRemainPending: true };
  }
  const resolveParameter = callback.parameters[0]?.name;
  const rejectParameter = callback.parameters[1]?.name;
  const resolveName = resolveParameter && ts.isIdentifier(resolveParameter) ? resolveParameter.text : undefined;
  const rejectName = rejectParameter && ts.isIdentifier(rejectParameter) ? rejectParameter.text : undefined;
  const events: PromiseExecutorEvent[] = [];
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
  };
}

export function analyzePromiseChainsInProgram(program: ts.Program, source: ts.SourceFile): PromiseChainModel {
  const checker = program.getTypeChecker(), executors: PromiseExecutorPattern[] = [], chains: PromiseChainPattern[] = [];
  const visitFunction = (owner: ts.FunctionLikeDeclaration): void => {
    if (!owner.body) return;
    const name = ownerName(owner);
    const visit = (node: ts.Node): void => {
      if (node !== owner.body && ts.isFunctionLike(node)) return;
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Promise" && librarySymbol(checker, node.expression)) {
        const binding = ts.isVariableDeclaration(node.parent) && node.parent.initializer === node && ts.isIdentifier(node.parent.name) ? node.parent.name.text : undefined;
        const callback = node.arguments?.[0];
        executors.push({ owner: name, binding, callback: callback?.getText(source) ?? "<unknown>", synchronous: true, throwBecomesRejection: true, ...analyzeExecutor(callback, checker, source), span: { start: node.getStart(source), end: node.getEnd() } });
      }
      if (ts.isCallExpression(node) && reactionKind(node, checker)) {
        const isInner = ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node && ts.isCallExpression(node.parent.parent);
        if (!isInner) {
          const links: PromiseReactionPattern[] = [];
          let current: ts.Expression = node;
          while (ts.isCallExpression(current)) {
            const kind = reactionKind(current, checker);
            if (!kind || !ts.isPropertyAccessExpression(current.expression)) break;
            links.unshift({
              kind,
              handlers: current.arguments.map((argument) => argument.getText(source)),
              handlerReturns: current.arguments.map((argument) => handlerReturn(argument, checker)),
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
    if (ts.isFunctionLike(node) && "body" in node && node.body) visitFunction(node as ts.FunctionLikeDeclaration);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { executors, chains };
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
  model.chains.forEach((chain, chainIndex) => {
    const root = `chain_${chainIndex}_state_0`;
    const settlements: readonly PromiseExecutorSettlement[] = chain.executor === undefined
      ? ["fulfilled", "rejected"]
      : model.executors[chain.executor].possibleSettlements;
    if (settlements.includes("fulfilled")) action(`settle_${chainIndex}_fulfilled`, [`${root} == 0`], new Map([[root, "1"]]));
    if (settlements.includes("rejected")) action(`settle_${chainIndex}_rejected`, [`${root} == 0`], new Map([[root, "2"]]));
    if (settlements.includes("assimilating")) {
      action(`settle_${chainIndex}_assimilating`, [`${root} == 0`], new Map([[root, "3"]]));
      action(`assimilate_${chainIndex}_fulfilled`, [`${root} == 3`], new Map([[root, "1"]]));
      action(`assimilate_${chainIndex}_rejected`, [`${root} == 3`], new Map([[root, "2"]]));
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
        action(`assimilate_${chainIndex}_${stage}_fulfilled`, [`${output} == 3`], new Map([[output, "1"]]));
        action(`assimilate_${chainIndex}_${stage}_rejected`, [`${output} == 3`], new Map([[output, "2"]]));
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
