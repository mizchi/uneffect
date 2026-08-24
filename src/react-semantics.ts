import ts from "typescript";
import { extractAnnotations } from "./annotations.js";

export type ReactPhase = "render" | "event" | "passive-effect" | "layout-effect" | "cleanup";
export type ReactDiagnosticKind =
  | "render-effect"
  | "non-idempotent-render"
  | "immutable-input-mutation"
  | "conditional-hook"
  | "missing-effect-cleanup"
  | "invalid-react-annotation";

export interface ReactPhaseSummary {
  phase: ReactPhase;
  effects: string[];
}

export interface ReactComponentSummary {
  name: string;
  span: { start: number; end: number };
  phases: ReactPhaseSummary[];
}

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
  diagnostics: ReactSemanticDiagnostic[];
}

type ComponentNode = (ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction) & { body: ts.ConciseBody };
type AnnotatableFunction = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction;
type HookKind = "passive-effect" | "layout-effect";

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

function importedHooks(source: ts.SourceFile): Map<string, HookKind> {
  const hooks = new Map<string, HookKind>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
      || statement.moduleSpecifier.text !== "react") continue;
    for (const element of statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)
      ? statement.importClause.namedBindings.elements : []) {
      const imported = element.propertyName?.text ?? element.name.text;
      if (imported === "useEffect") hooks.set(element.name.text, "passive-effect");
      if (imported === "useLayoutEffect") hooks.set(element.name.text, "layout-effect");
    }
  }
  return hooks;
}

function callName(call: ts.CallExpression): string | undefined {
  if (ts.isIdentifier(call.expression)) return call.expression.text;
  if (ts.isPropertyAccessExpression(call.expression)) return call.expression.getText(call.getSourceFile());
  return undefined;
}

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

/** Analyze explicitly opted-in React function components without requiring React at runtime. */
export function analyzeReactSemantics(fileName: string, text: string): ReactSemanticsResult {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const hooks = importedHooks(source), declared = effectDeclarations(source);
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
    if (value === "component" || /^(?:acquire|release)\s+\S+$/u.test(value)) continue;
    const name = componentName(node);
    diagnostics.push({
      fileName, component: name, functionName: name, kind: "invalid-react-annotation", phase: "render", severity: "error",
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      message: `invalid React annotation \`${value}\`; expected component, acquire Capability, or release Capability`,
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
        if (hookPhase) {
          if (isConditionalWithin(node, component)) report(node, { kind: "conditional-hook", phase: "render", hook: called, message: `${called} has control-flow-dependent call order` });
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
  return { components, diagnostics };
}
