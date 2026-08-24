import ts from "typescript";
import { extractAnnotations } from "./annotations.js";

export type ReactPhase = "render" | "event" | "passive-effect" | "layout-effect" | "cleanup";
export type ReactDiagnosticKind =
  | "render-effect"
  | "non-idempotent-render"
  | "immutable-input-mutation"
  | "conditional-hook"
  | "missing-effect-cleanup"
  | "invalid-react-annotation"
  | "unknown-hook-summary"
  | "recursive-hook";

export interface ReactPhaseSummary {
  phase: ReactPhase;
  effects: string[];
}

export interface ReactComponentSummary {
  name: string;
  span: { start: number; end: number };
  phases: ReactPhaseSummary[];
}
export interface ReactHookSummary extends ReactComponentSummary {}

export interface ReactSemanticDiagnostic {
  fileName: string;
  component: string;
  functionName: string;
  kind: ReactDiagnosticKind;
  phase: ReactPhase;
  severity: "error";
  line: number;
  message: string;
  effect?: string;
  operation?: string;
  hook?: string;
  notes?: Array<{ label: string; detail: string }>;
}

export interface ReactSemanticsResult {
  components: ReactComponentSummary[];
  hooks: ReactHookSummary[];
  diagnostics: ReactSemanticDiagnostic[];
}

type ComponentNode = (ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction) & { body: ts.ConciseBody };
type AnnotatableFunction = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction;
type HookKind = "passive-effect" | "layout-effect";
type BuiltinHookKind = HookKind | "render-hook";
interface CustomHookSummary { phases: Map<ReactPhase, Set<string>>; leaked: Array<{ phase: HookKind; capabilities: string[] }> }

function ownerNode(node: AnnotatableFunction): ts.Node {
  return (ts.isArrowFunction(node) || ts.isFunctionExpression(node))
    && ts.isVariableDeclaration(node.parent)
    && ts.isVariableDeclarationList(node.parent.parent)
    && ts.isVariableStatement(node.parent.parent.parent)
    ? node.parent.parent.parent
    : node;
}

function leadingText(source: ts.SourceFile, node: AnnotatableFunction): string {
  const owner = ownerNode(node);
  return source.text.slice(owner.getFullStart(), owner.getStart(source));
}

function componentName(node: AnnotatableFunction): string {
  if (ts.isFunctionDeclaration(node) && node.name) return node.name.text;
  if ((ts.isFunctionExpression(node) || ts.isArrowFunction(node)) && ts.isVariableDeclaration(node.parent)) {
    return node.parent.name.getText(node.getSourceFile());
  }
  return "<anonymous>";
}

function annotationParts(source: ts.SourceFile, node: ts.Node): string[][] {
  const text = source.text.slice(node.getFullStart(), node.getStart(source));
  return extractAnnotations(text, "react").map((value) => value.trim().split(/\s+/u));
}

function effectDeclarations(source: ts.SourceFile): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const statement of source.statements) {
    if (!ts.isFunctionDeclaration(statement) || !statement.name) continue;
    const text = source.text.slice(statement.getFullStart(), statement.getStart(source));
    const effects = extractAnnotations(text, "effect").flatMap((value) => value.split("|").map((part) => part.trim()));
    if (effects.length > 0) result.set(statement.name.text, effects);
  }
  return result;
}

function lifecycleDeclarations(source: ts.SourceFile, lifecycle: "acquire" | "release"): Map<string, string> {
  const result = new Map<string, string>();
  for (const statement of source.statements) {
    if (!ts.isFunctionDeclaration(statement) || !statement.name) continue;
    for (const [kind, capability] of annotationParts(source, statement)) {
      if (kind === lifecycle && capability) result.set(statement.name.text, capability);
    }
  }
  return result;
}

function importedHooks(source: ts.SourceFile): Map<string, BuiltinHookKind> {
  const hooks = new Map<string, BuiltinHookKind>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
      || statement.moduleSpecifier.text !== "react") continue;
    for (const element of statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)
      ? statement.importClause.namedBindings.elements : []) {
      const imported = element.propertyName?.text ?? element.name.text;
      if (imported === "useEffect") hooks.set(element.name.text, "passive-effect");
      else if (imported === "useLayoutEffect") hooks.set(element.name.text, "layout-effect");
      else if (/^use[A-Z0-9]/u.test(imported)) hooks.set(element.name.text, "render-hook");
    }
  }
  return hooks;
}

function importedRenderCallbacks(source: ts.SourceFile): Map<string, number> {
  const callbacks = new Map<string, number>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
      || statement.moduleSpecifier.text !== "react" || !statement.importClause?.namedBindings
      || !ts.isNamedImports(statement.importClause.namedBindings)) continue;
    for (const element of statement.importClause.namedBindings.elements) {
      const imported = element.propertyName?.text ?? element.name.text;
      if (imported === "useMemo" || imported === "useState") callbacks.set(element.name.text, 0);
      else if (imported === "useReducer") callbacks.set(element.name.text, 2);
    }
  }
  return callbacks;
}

function inlineCallback(call: ts.CallExpression, index: number | undefined): ts.ArrowFunction | ts.FunctionExpression | undefined {
  const argument = index === undefined ? undefined : call.arguments[index];
  return argument && (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) ? argument : undefined;
}

function callName(call: ts.CallExpression): string | undefined {
  if (ts.isIdentifier(call.expression)) return call.expression.text;
  if (ts.isPropertyAccessExpression(call.expression)) return call.expression.getText(call.getSourceFile());
  return undefined;
}

function looksLikeHook(name: string | undefined): name is string { return name !== undefined && /^use[A-Z0-9]/u.test(name); }

function effectsForCall(call: ts.CallExpression, declared: ReadonlyMap<string, string[]>): string[] {
  const name = callName(call);
  if (name?.startsWith("console.")) return ["Console"];
  if (name === "fetch" || name === "globalThis.fetch") return ["Fetch"];
  return name ? declared.get(name) ?? [] : [];
}

function directEffects(node: ts.Node, declared: ReadonlyMap<string, string[]>): string[] {
  const effects: string[] = [];
  const visit = (current: ts.Node): void => {
    if (current !== node && ts.isFunctionLike(current)) return;
    if (ts.isCallExpression(current)) effects.push(...effectsForCall(current, declared));
    if (ts.isBinaryExpression(current) && current.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && current.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      && (current.left.getText().startsWith("document.") || current.left.getText().startsWith("window."))) effects.push("DomWrite");
    ts.forEachChild(current, visit);
  };
  visit(node);
  return [...new Set(effects)];
}

function returnedCleanup(callback: ts.ArrowFunction | ts.FunctionExpression): ts.ArrowFunction | ts.FunctionExpression | undefined {
  if (!ts.isBlock(callback.body)) return undefined;
  for (const statement of callback.body.statements) {
    if (ts.isReturnStatement(statement) && statement.expression
      && (ts.isArrowFunction(statement.expression) || ts.isFunctionExpression(statement.expression))) return statement.expression;
  }
  return undefined;
}

function isConditionalWithin(node: ts.Node, boundary: ComponentNode): boolean {
  for (let current = node.parent; current && current !== boundary.body; current = current.parent) {
    if (ts.isIfStatement(current) || ts.isConditionalExpression(current) || ts.isSwitchStatement(current)
      || ts.isIterationStatement(current, false) || ts.isCaseClause(current) || ts.isDefaultClause(current)
      || ts.isBinaryExpression(current) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(current.operatorToken.kind)) return true;
    if (ts.isFunctionLike(current)) return true;
  }
  return false;
}

function isPropsMutation(node: ts.BinaryExpression, parameters: ReadonlySet<string>): boolean {
  if (node.operatorToken.kind < ts.SyntaxKind.FirstAssignment || node.operatorToken.kind > ts.SyntaxKind.LastAssignment) return false;
  const root = /^[A-Za-z_$][\w$]*/u.exec(node.left.getText())?.[0];
  return root !== undefined && parameters.has(root) && node.left.getText() !== root;
}

interface InternalReactAnalysis { result: ReactSemanticsResult; hookSummaries: Map<string, CustomHookSummary> }

function analyzeReactSource(source: ts.SourceFile, externalHooks: ReadonlyMap<string, CustomHookSummary> = new Map()): InternalReactAnalysis {
  const fileName = source.fileName;
  const hooks = importedHooks(source), renderCallbacks = importedRenderCallbacks(source), declared = effectDeclarations(source);
  const acquisitions = lifecycleDeclarations(source, "acquire"), releases = lifecycleDeclarations(source, "release");
  const components: ReactComponentSummary[] = [], diagnostics: ReactSemanticDiagnostic[] = [];
  const candidates: ComponentNode[] = [], annotatable: AnnotatableFunction[] = [];
  const collect = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
      annotatable.push(node);
      if (node.body) candidates.push(node as ComponentNode);
    }
    ts.forEachChild(node, collect);
  };
  collect(source);
  for (const node of annotatable) for (const value of extractAnnotations(leadingText(source, node), "react")) {
    if (value === "component" || value === "hook" || /^(?:acquire|release)\s+\S+$/u.test(value)) continue;
    const name = componentName(node);
    diagnostics.push({
      fileName, component: name, functionName: name, kind: "invalid-react-annotation", phase: "render", severity: "error",
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      message: `invalid React annotation \`${value}\`; expected component, hook, acquire Capability, or release Capability`,
    });
  }
  const customHooks = new Map<string, ComponentNode>();
  for (const candidate of candidates) if (extractAnnotations(leadingText(source, candidate), "react").some((value) => value.trim() === "hook")) {
    customHooks.set(componentName(candidate), candidate);
  }
  const customHookCache = new Map<string, CustomHookSummary>(externalHooks);
  for (const hookName of customHooks.keys()) customHookCache.delete(hookName);
  const summarizeCustomHook = (hookName: string, stack = new Set<string>()): CustomHookSummary => {
    const cached = customHookCache.get(hookName);
    if (cached) return cached;
    const phases = new Map<ReactPhase, Set<string>>([["render", new Set()]]), leaked: CustomHookSummary["leaked"] = [];
    const hook = customHooks.get(hookName);
    if (!hook || stack.has(hookName)) return { phases, leaked };
    const nextStack = new Set(stack).add(hookName);
    const add = (phase: ReactPhase, effects: readonly string[]): void => {
      const target = phases.get(phase) ?? new Set<string>();
      for (const effect of effects) target.add(effect);
      phases.set(phase, target);
    };
    const visit = (node: ts.Node): void => {
      if (node !== hook.body && ts.isFunctionLike(node)) return;
      if (ts.isCallExpression(node)) {
        const called = callName(node), builtinPhase = called ? hooks.get(called) : undefined;
        if (builtinPhase) {
          if (builtinPhase === "render-hook") {
            const callback = inlineCallback(node, called ? renderCallbacks.get(called) : undefined);
            if (callback) add("render", directEffects(callback.body, declared));
            return;
          }
          const callback = node.arguments[0];
          if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
            add(builtinPhase, directEffects(callback.body, declared));
            const cleanup = returnedCleanup(callback);
            if (cleanup) add("cleanup", directEffects(cleanup.body, declared));
            const acquired = new Set<string>(), released = new Set<string>();
            const collectLifecycle = (current: ts.Node, declarations: ReadonlyMap<string, string>, target: Set<string>, root: ts.Node): void => {
              if (current !== root && ts.isFunctionLike(current)) return;
              if (ts.isCallExpression(current)) {
                const capability = declarations.get(callName(current) ?? "");
                if (capability) target.add(capability);
              }
              ts.forEachChild(current, (child) => collectLifecycle(child, declarations, target, root));
            };
            collectLifecycle(callback.body, acquisitions, acquired, callback.body);
            if (cleanup) collectLifecycle(cleanup.body, releases, released, cleanup.body);
            add(builtinPhase, [...acquired].map((capability) => `Acquire<${capability}>`));
            add("cleanup", [...released].map((capability) => `Release<${capability}>`));
            const missing = [...acquired].filter((capability) => !released.has(capability));
            if (missing.length > 0) leaked.push({ phase: builtinPhase, capabilities: missing });
          } else add(builtinPhase, []);
          return;
        }
        if (called && customHooks.has(called)) {
          const child = summarizeCustomHook(called, nextStack);
          for (const [phase, effects] of child.phases) add(phase, [...effects]);
          leaked.push(...child.leaked);
          return;
        }
        add("render", effectsForCall(node, declared));
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
        && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
        && (node.left.getText(source).startsWith("document.") || node.left.getText(source).startsWith("window."))) add("render", ["DomWrite"]);
      ts.forEachChild(node, visit);
    };
    visit(hook.body);
    const summary = { phases, leaked };
    customHookCache.set(hookName, summary);
    return summary;
  };
  for (const hookName of customHooks.keys()) summarizeCustomHook(hookName);
  for (const [hookName, hook] of customHooks) {
    const reportHook = (node: ts.Node, diagnostic: Omit<ReactSemanticDiagnostic, "fileName" | "component" | "functionName" | "severity" | "line">): void => {
      diagnostics.push({
        fileName, component: hookName, functionName: hookName, severity: "error",
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, ...diagnostic,
      });
    };
    const parameters = new Set(hook.parameters.flatMap((parameter) => ts.isIdentifier(parameter.name) ? [parameter.name.text] : []));
    const visitHookRender = (node: ts.Node): void => {
      if (node !== hook.body && ts.isFunctionLike(node)) return;
      if (ts.isCallExpression(node)) {
        const called = callName(node), builtinHook = called ? hooks.has(called) : false, customHook = called ? customHooks.has(called) || externalHooks.has(called) : false;
        if (builtinHook || customHook) {
          if (called === hookName) reportHook(node, {
            kind: "recursive-hook", phase: "render", hook: called,
            message: `${called} recursively calls itself, so its Hook order and phase summary are not finite`,
          });
          if (isConditionalWithin(node, hook)) reportHook(node, {
            kind: "conditional-hook", phase: "render", hook: called,
            message: `${called} has control-flow-dependent call order`,
          });
          const callback = called ? inlineCallback(node, renderCallbacks.get(called)) : undefined;
          if (callback) visitHookRender(callback.body);
          return;
        }
        if (looksLikeHook(called)) {
          reportHook(node, { kind: "unknown-hook-summary", phase: "render", hook: called, message: `${called} has no resolved /* uneffect: react hook */ summary` });
          return;
        }
        if (called === "Date.now" || called === "Math.random" || called === "crypto.randomUUID" || called === "performance.now") reportHook(node, {
          kind: "non-idempotent-render", phase: "render", operation: called,
          message: `${called} is not idempotent during custom Hook render`,
        });
        for (const effect of effectsForCall(node, declared)) reportHook(node, {
          kind: "render-effect", phase: "render", effect, message: `${effect} is observable during custom Hook render`,
        });
      }
      if (ts.isBinaryExpression(node) && isPropsMutation(node, parameters)) reportHook(node, {
        kind: "immutable-input-mutation", phase: "render", operation: node.left.getText(source),
        message: "React Hook arguments are immutable render snapshots",
      });
      if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
        && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
        && (node.left.getText(source).startsWith("document.") || node.left.getText(source).startsWith("window."))) reportHook(node, {
        kind: "render-effect", phase: "render", effect: "DomWrite", message: "DomWrite is observable during custom Hook render",
      });
      ts.forEachChild(node, visitHookRender);
    };
    visitHookRender(hook.body);
    for (const leak of customHookCache.get(hookName)?.leaked ?? []) reportHook(hook, {
      kind: "missing-effect-cleanup", phase: leak.phase, effect: leak.capabilities.join(" | "),
      message: `${hookName} acquires ${leak.capabilities.join(", ")} without a matching cleanup release`,
    });
  }
  for (const component of candidates) {
    if (!extractAnnotations(leadingText(source, component), "react").some((value) => value.trim() === "component")) continue;
    const name = componentName(component), phaseEffects = new Map<ReactPhase, Set<string>>([["render", new Set()]]);
    const addPhase = (phase: ReactPhase, effects: readonly string[] = []): void => {
      const target = phaseEffects.get(phase) ?? new Set<string>();
      for (const effect of effects) target.add(effect);
      phaseEffects.set(phase, target);
    };
    const report = (node: ts.Node, diagnostic: Omit<ReactSemanticDiagnostic, "fileName" | "component" | "functionName" | "severity" | "line">): void => {
      diagnostics.push({ fileName, component: name, functionName: name, severity: "error", line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, ...diagnostic });
    };
    const parameters = new Set(component.parameters.flatMap((parameter) => ts.isIdentifier(parameter.name) ? [parameter.name.text] : []));
    const visitRender = (node: ts.Node): void => {
      if (node !== component.body && ts.isFunctionLike(node)) return;
      if (ts.isJsxAttribute(node) && node.name.getText(source).startsWith("on") && node.initializer && ts.isJsxExpression(node.initializer)) {
        const expression = node.initializer.expression;
        if (expression && (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression))) addPhase("event", directEffects(expression.body, declared));
        return;
      }
      if (ts.isCallExpression(node)) {
        const called = callName(node), hookPhase = called ? hooks.get(called) : undefined;
        const customHook = called ? customHookCache.get(called) : undefined;
        if (customHook) {
          if (isConditionalWithin(node, component)) report(node, { kind: "conditional-hook", phase: "render", hook: called, message: `${called} has control-flow-dependent call order` });
          for (const [phase, effects] of customHook.phases) {
            addPhase(phase, [...effects]);
            if (phase === "render") for (const effect of effects) report(node, { kind: "render-effect", phase, effect, message: `${effect} is observable during render through ${called}` });
          }
          for (const leak of customHook.leaked) report(node, {
            kind: "missing-effect-cleanup", phase: leak.phase, effect: leak.capabilities.join(" | "),
            message: `${called} acquires ${leak.capabilities.join(", ")} without a matching cleanup release`,
          });
          return;
        }
        if (hookPhase) {
          if (isConditionalWithin(node, component)) report(node, { kind: "conditional-hook", phase: "render", hook: called, message: `${called} has control-flow-dependent call order` });
          if (hookPhase === "render-hook") {
            addPhase("render");
            const callback = called ? inlineCallback(node, renderCallbacks.get(called)) : undefined;
            if (callback) visitRender(callback.body);
            return;
          }
          const callback = node.arguments[0];
          if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
            const effects = directEffects(callback.body, declared);
            addPhase(hookPhase, effects);
            const cleanup = returnedCleanup(callback);
            if (cleanup) addPhase("cleanup", directEffects(cleanup.body, declared));
            const acquired = new Set<string>();
            const findAcquisition = (current: ts.Node): void => {
              if (current !== callback.body && ts.isFunctionLike(current)) return;
              if (ts.isCallExpression(current)) {
                const acquisition = acquisitions.get(callName(current) ?? "");
                if (acquisition) acquired.add(acquisition);
              }
              ts.forEachChild(current, findAcquisition);
            };
            findAcquisition(callback.body);
            addPhase(hookPhase, [...acquired].map((capability) => `Acquire<${capability}>`));
            const released = new Set<string>();
            if (cleanup) {
              const findRelease = (current: ts.Node): void => {
                if (current !== cleanup.body && ts.isFunctionLike(current)) return;
                if (ts.isCallExpression(current)) {
                  const release = releases.get(callName(current) ?? "");
                  if (release) released.add(release);
                }
                ts.forEachChild(current, findRelease);
              };
              findRelease(cleanup.body);
              addPhase("cleanup", [...released].map((capability) => `Release<${capability}>`));
            }
            const leaked = [...acquired].filter((capability) => !released.has(capability));
            if (leaked.length > 0) report(node, {
              kind: "missing-effect-cleanup", phase: hookPhase,
              effect: leaked.join(" | "), message: `Effect acquires ${leaked.join(", ")} without a matching cleanup release`,
            });
          } else addPhase(hookPhase);
          return;
        }
        if (looksLikeHook(called)) {
          report(node, { kind: "unknown-hook-summary", phase: "render", hook: called, message: `${called} has no resolved /* uneffect: react hook */ summary` });
          return;
        }
        const operation = called;
        if (operation === "Date.now" || operation === "Math.random" || operation === "crypto.randomUUID" || operation === "performance.now") {
          report(node, { kind: "non-idempotent-render", phase: "render", operation, message: `${operation} is not idempotent during render` });
        }
        const effects = effectsForCall(node, declared);
        for (const effect of effects) {
          addPhase("render", [effect]);
          report(node, { kind: "render-effect", phase: "render", effect, message: `${effect} is observable during render` });
        }
      }
      if (ts.isBinaryExpression(node) && isPropsMutation(node, parameters)) report(node, {
        kind: "immutable-input-mutation", phase: "render", operation: node.left.getText(source), message: "React component inputs are immutable render snapshots",
      });
      if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
        && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
        && (node.left.getText(source).startsWith("document.") || node.left.getText(source).startsWith("window."))) {
        addPhase("render", ["DomWrite"]);
        report(node, { kind: "render-effect", phase: "render", effect: "DomWrite", message: "DomWrite is observable during render" });
      }
      ts.forEachChild(node, visitRender);
    };
    visitRender(component.body);
    components.push({
      name, span: { start: component.getStart(source), end: component.getEnd() },
      phases: [...phaseEffects].map(([phase, effects]) => ({ phase, effects: [...effects] })),
    });
  }
  const publicHooks = [...customHooks.keys()].map((name): ReactHookSummary => {
    const node = customHooks.get(name)!, summary = customHookCache.get(name)!;
    return {
      name, span: { start: node.getStart(source), end: node.getEnd() },
      phases: [...summary.phases].map(([phase, effects]) => ({ phase, effects: [...effects] })),
    };
  });
  return { result: { components, hooks: publicHooks, diagnostics }, hookSummaries: customHookCache };
}

/** Analyze one source string without requiring React at runtime. */
export function analyzeReactSemantics(fileName: string, text: string): ReactSemanticsResult {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  return analyzeReactSource(source).result;
}

function resolvedSymbol(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
  const symbol = checker.getSymbolAtLocation(node);
  return symbol && (symbol.flags & ts.SymbolFlags.Alias) ? checker.getAliasedSymbol(symbol) : symbol;
}

function declarationKey(node: AnnotatableFunction): string {
  return `${node.getSourceFile().fileName}:${componentName(node)}`;
}

function importedCustomHooks(
  source: ts.SourceFile,
  checker: ts.TypeChecker,
  summaries: ReadonlyMap<string, CustomHookSummary>,
): Map<string, CustomHookSummary> {
  const imports = new Map<string, CustomHookSummary>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause?.namedBindings
      || !ts.isNamedImports(statement.importClause.namedBindings)) continue;
    for (const element of statement.importClause.namedBindings.elements) {
      const target = resolvedSymbol(checker, element.name);
      const declaration = target?.declarations?.find((candidate): candidate is AnnotatableFunction =>
        ts.isFunctionDeclaration(candidate) || ts.isFunctionExpression(candidate) || ts.isArrowFunction(candidate));
      if (!declaration) continue;
      const summary = summaries.get(declarationKey(declaration));
      if (summary) imports.set(element.name.text, summary);
    }
  }
  return imports;
}

function analyzeProgramFixedPoint(program: ts.Program): Map<string, ReactSemanticsResult> {
  const checker = program.getTypeChecker();
  const sources = program.getSourceFiles().filter((candidate) => !candidate.isDeclarationFile);
  let summaries = new Map<string, CustomHookSummary>(), results = new Map<string, ReactSemanticsResult>();
  for (let iteration = 0; iteration <= sources.length; iteration++) {
    const next = new Map<string, CustomHookSummary>(), nextResults = new Map<string, ReactSemanticsResult>();
    for (const candidate of sources) {
      const analysis = analyzeReactSource(candidate, importedCustomHooks(candidate, checker, summaries));
      nextResults.set(candidate.fileName, analysis.result);
      for (const hook of analysis.result.hooks) next.set(`${candidate.fileName}:${hook.name}`, analysis.hookSummaries.get(hook.name)!);
    }
    const fingerprint = (values: ReadonlyMap<string, CustomHookSummary>): string => JSON.stringify([...values].map(([key, summary]) => [
      key, [...summary.phases].map(([phase, effects]) => [phase, [...effects].sort()]), summary.leaked,
    ]).sort(([left], [right]) => String(left).localeCompare(String(right))));
    if (fingerprint(next) === fingerprint(summaries)) return nextResults;
    summaries = next;
    results = nextResults;
  }
  return results;
}

/** Analyze every implementation source while computing the custom-Hook fixed point only once. */
export function analyzeReactProgram(program: ts.Program): Map<string, ReactSemanticsResult> {
  return analyzeProgramFixedPoint(program);
}

/** Program-backed path: composes annotated custom Hooks through resolved named imports and aliases. */
export function analyzeReactSemanticsInProgram(program: ts.Program, source: ts.SourceFile): ReactSemanticsResult {
  return analyzeReactProgram(program).get(source.fileName) ?? { components: [], hooks: [], diagnostics: [] };
}
