import ts from "typescript";
import { analyzeAsyncPatternsInProgram } from "./async-patterns.js";
import { analyzeAsyncSafetyInProgram, type PromiseBinding } from "./async-safety.js";
import { bindingIdentityKey, symbolIdentityKey } from "./binding-identity.js";
import { analyzeAbortSignalsInProgram } from "./host-neutral-transitions.js";

export interface AbortableFetch {
  readonly owner: string;
  readonly binding: string;
  readonly url: string;
  readonly controller: string;
  readonly signalKind: "controller-direct" | "controller-alias" | "abort-any";
  readonly optionsKind: "inline" | "single-use-const-alias";
  readonly promiseStatus: PromiseBinding["status"];
  readonly promiseObservations: readonly string[];
  readonly responseBinding?: string;
  readonly responseBodyStatus: "not-acquired" | "consumed" | "stream-owned" | "unconsumed" | "unknown";
  readonly responseBodyOperation?: "arrayBuffer" | "blob" | "bytes" | "formData" | "getReader" | "json" | "pipeThroughTo" | "pipeTo" | "text";
  readonly responseStreamDischarge?: "cancel" | "drain" | "pipe-through-to" | "pipe-to" | "release-lock";
  readonly abortComposition?: number;
  readonly abortReason?: string;
  readonly abortConditional?: boolean;
  readonly span: { start: number; end: number };
  readonly evidence: "exact";
}

export interface AbortableFetchUnknown {
  readonly expression: string;
  readonly reason: string;
  readonly span: { start: number; end: number };
}

export interface AbortableFetchAnalysis {
  readonly fileName: string;
  readonly fetches: readonly AbortableFetch[];
  readonly unknown: readonly AbortableFetchUnknown[];
}

function resolvedSymbol(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
  const symbol = checker.getSymbolAtLocation(node);
  return symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
}

function ownerName(node: ts.Node): string {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if ((ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current) || ts.isFunctionExpression(current)) && current.name) return current.name.getText();
    if (ts.isArrowFunction(current) && ts.isVariableDeclaration(current.parent) && ts.isIdentifier(current.parent.name)) return current.parent.name.text;
  }
  return "<module>";
}

export function analyzeAbortableFetchesInProgram(program: ts.Program, source: ts.SourceFile): AbortableFetchAnalysis {
  const checker = program.getTypeChecker();
  const aborts = analyzeAbortSignalsInProgram(program, source);
  const asyncPatterns = analyzeAsyncPatternsInProgram(program, source);
  const asyncSafety = analyzeAsyncSafetyInProgram(program, source);
  const fetches: AbortableFetch[] = [], unknown: AbortableFetchUnknown[] = [];
  const fetchBindingSymbols = new Map<number, ts.Symbol>();
  const symbolReferenceCount = (target: ts.Symbol): number => {
    let count = 0;
    const countReferences = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && resolvedSymbol(checker, node) === target) count++;
      ts.forEachChild(node, countReferences);
    };
    countReferences(source);
    return count;
  };
  const signalFromObjectLiteral = (object: ts.ObjectLiteralExpression): ts.Expression | undefined => {
    const property = object.properties.find((candidate) =>
      (ts.isPropertyAssignment(candidate) || ts.isShorthandPropertyAssignment(candidate))
        && candidate.name.getText(source).replaceAll(/["']/gu, "") === "signal");
    return property && (ts.isPropertyAssignment(property) ? property.initializer
      : ts.isShorthandPropertyAssignment(property) ? property.name : undefined);
  };
  const resolveOptions = (expression: ts.Expression | undefined, owner: string): { signal: ts.Expression; kind: AbortableFetch["optionsKind"] } | undefined => {
    if (!expression) return undefined;
    if (ts.isObjectLiteralExpression(expression)) {
      const signal = signalFromObjectLiteral(expression);
      return signal ? { signal, kind: "inline" } : undefined;
    }
    if (!ts.isIdentifier(expression)) return undefined;
    const symbol = resolvedSymbol(checker, expression);
    const declaration = symbol?.valueDeclaration;
    if (!symbol || !declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer
      || !ts.isObjectLiteralExpression(declaration.initializer)
      || !ts.isVariableDeclarationList(declaration.parent) || (declaration.parent.flags & ts.NodeFlags.Const) === 0
      || ownerName(declaration) !== owner || symbolReferenceCount(symbol) !== 2) return undefined;
    const signal = signalFromObjectLiteral(declaration.initializer);
    return signal ? { signal, kind: "single-use-const-alias" } : undefined;
  };
  type SignalTarget = { controllerIndex?: number; composition?: number; alias: boolean };
  const resolveSignal = (expression: ts.Expression, owner: string, seen = new Set<ts.Symbol>()): SignalTarget | undefined => {
    if (ts.isPropertyAccessExpression(expression) && expression.name.text === "signal" && ts.isIdentifier(expression.expression)) {
      const receiver = resolvedSymbol(checker, expression.expression);
      const receiverIdentity = symbolIdentityKey(receiver);
      const controller = aborts.controllers.find((item) => bindingIdentityKey(item.identity) === receiverIdentity);
      return controller ? { controllerIndex: controller.index, alias: false } : undefined;
    }
    if (ts.isIdentifier(expression)) {
      const shorthand = ts.isShorthandPropertyAssignment(expression.parent)
        ? checker.getShorthandAssignmentValueSymbol(expression.parent) : undefined;
      const symbol = shorthand ?? resolvedSymbol(checker, expression);
      if (!symbol || seen.has(symbol)) return undefined;
      seen.add(symbol);
      const declaration = symbol.valueDeclaration;
      if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer
        || !ts.isVariableDeclarationList(declaration.parent)
        || (declaration.parent.flags & ts.NodeFlags.Const) === 0
        || ownerName(declaration) !== owner) return undefined;
      const target = resolveSignal(declaration.initializer, owner, seen);
      return target ? { ...target, alias: true } : undefined;
    }
    if (ts.isCallExpression(expression)) {
      const composition = asyncPatterns.abortCompositions.findIndex((item) =>
        item.owner === owner && item.span.start === expression.getStart(source) && item.span.end === expression.getEnd());
      return composition >= 0 ? { composition, alias: false } : undefined;
    }
    return undefined;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "fetch") {
      const symbol = resolvedSymbol(checker, node.expression);
      const builtin = symbol?.declarations?.some((declaration) => program.isSourceFileDefaultLibrary(declaration.getSourceFile())) ?? false;
      if (!builtin) { ts.forEachChild(node, visit); return; }
      const owner = ownerName(node);
      const options = resolveOptions(node.arguments[1], owner);
      const target = options ? resolveSignal(options.signal, owner) : undefined;
      const controller = target?.controllerIndex === undefined ? undefined : aborts.controllers[target.controllerIndex];
      const composition = target?.composition === undefined ? undefined : asyncPatterns.abortCompositions[target.composition];
      const binding = ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)
        && ts.isVariableDeclarationList(node.parent.parent) && (node.parent.parent.flags & ts.NodeFlags.Const) !== 0
        ? node.parent.name.text : undefined;
      if ((!controller && !composition) || !binding) unknown.push({
        expression: node.getText(source),
        reason: !binding ? "abortable fetch result requires an immutable local binding"
          : !options ? "fetch RequestInit must be an inline object or a single-use const object-literal alias"
          : "fetch signal is not a statically resolved local builtin AbortController signal or AbortSignal.any composition",
        span: { start: node.getStart(source), end: node.getEnd() },
      });
      else {
        const linkedControllers = composition ? aborts.compositionLinks.filter((item) => item.composition === target!.composition) : [];
        const event = controller
          ? aborts.events.find((item) => item.controllerIndex === controller.index)
          : aborts.events.find((item) => linkedControllers.some((link) => link.controllerIndex === item.controllerIndex));
        const initialSource = composition?.initiallyAbortedSource;
        const initialReason = initialSource === undefined ? undefined : composition?.sourceReasons[initialSource] ?? "AbortError";
        const promise = asyncSafety.promiseBindings.find((item) => item.owner === owner && item.binding === binding);
        const fetchIndex = fetches.length;
        fetches.push({
          owner, binding, url: node.arguments[0]?.getText(source) ?? "<missing>",
          controller: controller?.binding ?? "<AbortSignal.any>",
          signalKind: composition ? "abort-any" : target!.alias ? "controller-alias" : "controller-direct",
          optionsKind: options!.kind,
          promiseStatus: promise?.status ?? "floating",
          promiseObservations: promise?.observations ?? [],
          responseBodyStatus: "not-acquired",
          ...(target?.composition === undefined ? {} : { abortComposition: target.composition }),
          ...(initialReason ? { abortReason: initialReason, abortConditional: false }
            : composition ? { abortConditional: true }
            : event ? { abortReason: event.reason, abortConditional: event.conditional } : {}),
          span: { start: node.getStart(source), end: node.getEnd() }, evidence: "exact",
        });
        const bindingSymbol = ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)
          ? resolvedSymbol(checker, node.parent.name) : undefined;
        if (bindingSymbol) fetchBindingSymbols.set(fetchIndex, bindingSymbol);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const bodyMethods = new Set(["arrayBuffer", "blob", "bytes", "formData", "json", "text"] as const);
  const unwrapExpression = (expression: ts.Expression): ts.Expression => ts.isParenthesizedExpression(expression)
    || ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression) || ts.isNonNullExpression(expression)
    ? unwrapExpression(expression.expression) : expression;
  const stableRootSymbol = (identifier: ts.Identifier, seen = new Set<ts.Symbol>()): ts.Symbol | undefined => {
    const symbol = resolvedSymbol(checker, identifier);
    if (!symbol || seen.has(symbol)) return symbol;
    const declaration = symbol.valueDeclaration;
    if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer
      || !ts.isVariableDeclarationList(declaration.parent) || (declaration.parent.flags & ts.NodeFlags.Const) === 0
      || !ts.isIdentifier(declaration.initializer)) return symbol;
    return stableRootSymbol(declaration.initializer, new Set(seen).add(symbol));
  };
  const conditionallyExecuted = (node: ts.Node): boolean => {
    for (let current: ts.Node | undefined = node.parent; current && !ts.isFunctionLike(current); current = current.parent) {
      if (ts.isIfStatement(current) || ts.isConditionalExpression(current) || ts.isSwitchStatement(current)
        || ts.isIterationStatement(current, false) || ts.isTryStatement(current)) return true;
    }
    return false;
  };
  const enriched = fetches.map((fetch, index): AbortableFetch => {
    const requestSymbol = fetchBindingSymbols.get(index);
    if (!requestSymbol) return fetch;
    let responseDeclaration: ts.VariableDeclaration | undefined;
    const findResponse = (node: ts.Node): void => {
      if (responseDeclaration || (node !== source && ts.isFunctionLike(node) && ownerName(node) !== fetch.owner)) return;
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
        && ts.isAwaitExpression(node.initializer) && ts.isIdentifier(node.initializer.expression)
        && resolvedSymbol(checker, node.initializer.expression) === requestSymbol) responseDeclaration = node;
      ts.forEachChild(node, findResponse);
    };
    findResponse(source);
    if (!responseDeclaration || !ts.isIdentifier(responseDeclaration.name)) return fetch;
    const responseSymbol = resolvedSymbol(checker, responseDeclaration.name);
    let operation: AbortableFetch["responseBodyOperation"] | undefined;
    let conditional = false;
    let readerSymbol: ts.Symbol | undefined;
    const findConsumption = (node: ts.Node): void => {
      if (operation || (node !== source && ts.isFunctionLike(node) && ownerName(node) !== fetch.owner)) return;
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression) && stableRootSymbol(node.expression.expression) === responseSymbol
        && bodyMethods.has(node.expression.name.text as NonNullable<typeof operation>)) {
        const method = resolvedSymbol(checker, node.expression.name);
        const builtin = method?.declarations?.some((declaration) => program.isSourceFileDefaultLibrary(declaration.getSourceFile())) ?? false;
        if (builtin) {
          operation = node.expression.name.text as NonNullable<typeof operation>;
          conditional = conditionallyExecuted(node);
        }
      }
      const readerReceiver = ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        ? unwrapExpression(node.expression.expression) : undefined;
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === "getReader" && readerReceiver && ts.isPropertyAccessExpression(readerReceiver)
        && readerReceiver.name.text === "body" && ts.isIdentifier(readerReceiver.expression)
        && stableRootSymbol(readerReceiver.expression) === responseSymbol) {
        const method = resolvedSymbol(checker, node.expression.name);
        const builtin = method?.declarations?.some((declaration) => program.isSourceFileDefaultLibrary(declaration.getSourceFile())) ?? false;
        if (builtin) {
          operation = "getReader";
          conditional = conditionallyExecuted(node);
          if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
            readerSymbol = resolvedSymbol(checker, node.parent.name);
          }
        }
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === "pipeTo" && readerReceiver && ts.isPropertyAccessExpression(readerReceiver)
        && readerReceiver.name.text === "body" && ts.isIdentifier(readerReceiver.expression)
        && stableRootSymbol(readerReceiver.expression) === responseSymbol) {
        const method = resolvedSymbol(checker, node.expression.name);
        const builtin = method?.declarations?.some((declaration) => program.isSourceFileDefaultLibrary(declaration.getSourceFile())) ?? false;
        if (builtin) {
          operation = "pipeTo";
          conditional = conditionallyExecuted(node) || !ts.isAwaitExpression(node.parent) || node.arguments.length !== 1;
        }
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === "pipeTo" && ts.isCallExpression(node.expression.expression)) {
        const pipeThrough = node.expression.expression;
        const pipeThroughAccess = pipeThrough.expression;
        if (ts.isPropertyAccessExpression(pipeThroughAccess) && pipeThroughAccess.name.text === "pipeThrough") {
          const sourceReceiver = unwrapExpression(pipeThroughAccess.expression);
          const pipeToMethod = resolvedSymbol(checker, node.expression.name);
          const pipeThroughMethod = resolvedSymbol(checker, pipeThroughAccess.name);
          const builtinPipeTo = pipeToMethod?.declarations?.some((declaration) => program.isSourceFileDefaultLibrary(declaration.getSourceFile())) ?? false;
          const builtinPipeThrough = pipeThroughMethod?.declarations?.some((declaration) => program.isSourceFileDefaultLibrary(declaration.getSourceFile())) ?? false;
          if (builtinPipeTo && builtinPipeThrough && ts.isPropertyAccessExpression(sourceReceiver)
            && sourceReceiver.name.text === "body" && ts.isIdentifier(sourceReceiver.expression)
            && stableRootSymbol(sourceReceiver.expression) === responseSymbol) {
            operation = "pipeThroughTo";
            conditional = conditionallyExecuted(node) || !ts.isAwaitExpression(node.parent)
              || node.arguments.length !== 1 || pipeThrough.arguments.length !== 1;
          }
        }
      }
      ts.forEachChild(node, findConsumption);
    };
    findConsumption(source);
    let readerDischarge: "cancel" | "drain" | "release-lock" | undefined;
    let dischargeConditional = false;
    if (readerSymbol) {
      const findDischarge = (node: ts.Node): void => {
        if (readerDischarge === "cancel" || (node !== source && ts.isFunctionLike(node) && ownerName(node) !== fetch.owner)) return;
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
          && ts.isIdentifier(node.expression.expression) && stableRootSymbol(node.expression.expression) === readerSymbol
          && (node.expression.name.text === "cancel" || node.expression.name.text === "releaseLock")) {
          const method = resolvedSymbol(checker, node.expression.name);
          const builtin = method?.declarations?.some((declaration) => program.isSourceFileDefaultLibrary(declaration.getSourceFile())) ?? false;
          if (builtin) {
            readerDischarge = node.expression.name.text === "cancel" ? "cancel" : "release-lock";
            dischargeConditional = conditionallyExecuted(node);
          }
        }
        ts.forEachChild(node, findDischarge);
      };
      findDischarge(source);
      if (!readerDischarge) {
        let sawReaderLoop = false;
        let drained = false;
        const findDrainLoop = (node: ts.Node): void => {
          if (drained || (node !== source && ts.isFunctionLike(node) && ownerName(node) !== fetch.owner)) return;
          if (ts.isWhileStatement(node) && node.expression.kind === ts.SyntaxKind.TrueKeyword && ts.isBlock(node.statement)) {
            let doneSymbol: ts.Symbol | undefined;
            const findRead = (child: ts.Node): void => {
              if (child !== node.statement && (ts.isFunctionLike(child) || ts.isIterationStatement(child, false))) return;
              if (ts.isVariableDeclaration(child) && ts.isObjectBindingPattern(child.name) && child.initializer
                && ts.isAwaitExpression(child.initializer) && ts.isCallExpression(child.initializer.expression)
                && ts.isPropertyAccessExpression(child.initializer.expression.expression)
                && child.initializer.expression.expression.name.text === "read"
                && ts.isIdentifier(child.initializer.expression.expression.expression)
                && stableRootSymbol(child.initializer.expression.expression.expression) === readerSymbol) {
                const method = resolvedSymbol(checker, child.initializer.expression.expression.name);
                const builtin = method?.declarations?.some((declaration) => program.isSourceFileDefaultLibrary(declaration.getSourceFile())) ?? false;
                const done = child.name.elements.find((element) => ts.isIdentifier(element.name)
                  && (element.propertyName?.getText(source) ?? element.name.text) === "done");
                if (builtin && done && ts.isIdentifier(done.name)) doneSymbol = resolvedSymbol(checker, done.name);
              }
              ts.forEachChild(child, findRead);
            };
            findRead(node.statement);
            if (doneSymbol) {
              sawReaderLoop = true;
              const breaks: ts.BreakStatement[] = [];
              let abrupt = false;
              const inspect = (child: ts.Node): void => {
                if (child !== node.statement && (ts.isFunctionLike(child) || ts.isIterationStatement(child, false))) return;
                if (ts.isBreakStatement(child)) breaks.push(child);
                if (ts.isContinueStatement(child) || ts.isReturnStatement(child) || ts.isThrowStatement(child)) abrupt = true;
                ts.forEachChild(child, inspect);
              };
              inspect(node.statement);
              const onlyDoneBreaks = breaks.length > 0 && breaks.every((statement) => {
                const parent = statement.parent;
                return ts.isIfStatement(parent) && parent.thenStatement === statement && ts.isIdentifier(parent.expression)
                  && resolvedSymbol(checker, parent.expression) === doneSymbol;
              });
              if (!abrupt && onlyDoneBreaks) drained = true;
            }
          }
          ts.forEachChild(node, findDrainLoop);
        };
        findDrainLoop(source);
        if (drained) readerDischarge = "drain";
        else if (sawReaderLoop) dischargeConditional = true;
      }
    }
    const responseStreamDischarge: AbortableFetch["responseStreamDischarge"] | undefined = conditional ? readerDischarge
      : operation === "pipeTo" ? "pipe-to"
        : operation === "pipeThroughTo" ? "pipe-through-to" : readerDischarge;
    const responseBodyStatus: AbortableFetch["responseBodyStatus"] = !operation ? "unconsumed"
      : conditional || dischargeConditional ? "unknown"
        : operation !== "getReader" ? "consumed"
          : readerDischarge === "cancel" || readerDischarge === "drain" ? "consumed"
            : readerDischarge === "release-lock" ? "unconsumed" : "stream-owned";
    return {
      ...fetch,
      responseBinding: responseDeclaration.name.text,
      responseBodyStatus,
      ...(operation ? { responseBodyOperation: operation } : {}),
      ...(responseStreamDischarge ? { responseStreamDischarge } : {}),
    };
  });
  return { fileName: source.fileName, fetches: enriched, unknown };
}

function safe(name: string): string { return name.replace(/[^A-Za-z0-9_]/gu, "_"); }

/** Bounded product: 0=pending, 1=fulfilled, 2=rejected, 3=aborted. */
export function generateAbortableFetchProductQuint(moduleName: string, analysis: AbortableFetchAnalysis): string {
  const lines = [`module ${safe(moduleName)} {`];
  analysis.fetches.forEach((_, index) => lines.push(`  var fetch_${index}_state: int`));
  lines.push("", "  action init = all {");
  analysis.fetches.forEach((fetch, index) => lines.push(`    fetch_${index}_state' = ${fetch.abortReason && !fetch.abortConditional ? 3 : 0},`));
  lines.push("  }");
  const actions: string[] = [];
  const action = (name: string, index: number, state: number): void => {
    actions.push(name);
    lines.push("", `  action ${name} = all {`, `    fetch_${index}_state == 0,`);
    analysis.fetches.forEach((_, candidate) => lines.push(`    fetch_${candidate}_state' = ${candidate === index ? state : `fetch_${candidate}_state`},`));
    lines.push("  }");
  };
  analysis.fetches.forEach((fetch, index) => {
    action(`fulfill_fetch_${index}`, index, 1);
    action(`reject_fetch_${index}`, index, 2);
    if (!fetch.abortReason || fetch.abortConditional) action(`abort_${index}`, index, 3);
  });
  lines.push("", "  action step = any {", ...actions.map((name) => `    ${name},`), "  }");
  const domains = analysis.fetches.map((_, index) => `(fetch_${index}_state >= 0 and fetch_${index}_state <= 3)`).join(" and ") || "true";
  const observed = analysis.fetches.every((fetch) => fetch.promiseStatus !== "floating");
  const bodiesConsumed = analysis.fetches.every((fetch) => fetch.responseBodyStatus === "consumed" || fetch.responseBodyStatus === "not-acquired");
  lines.push("", `  val abortableFetchSafe = ${domains}`, `  val abortableFetchObserved = ${observed}`, `  val abortableFetchBodiesConsumed = ${bodiesConsumed}`, "}", "");
  return lines.join("\n");
}
