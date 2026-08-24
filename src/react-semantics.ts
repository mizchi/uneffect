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
  | "recursive-hook"
  | "resource-identity-mismatch"
  | "duplicate-effect-cleanup"
  | "conditional-resource-lifecycle"
  | "missing-hook-dependency"
  | "unknown-hook-closure"
  | "unknown-hook-dependencies"
  | "unstable-hook-dependency";

export interface ReactPhaseSummary {
  phase: ReactPhase;
  effects: string[];
}

export type ReactEffectTransition = "setup" | "cleanup";
export interface ReactReplayEffect {
  phase: HookKind;
  transitions: ReactEffectTransition[];
  setupEffects: string[];
  /** Conservative union until per-call Effect instances are preserved through custom Hook summaries. */
  possibleCleanupEffects: string[];
}
export interface ReactReplayScenario {
  renderInvocations: number;
  effects: ReactReplayEffect[];
}
export interface ReactReplayModel {
  production: ReactReplayScenario;
  strictModeDevelopment: ReactReplayScenario;
}

export interface ReactComponentSummary {
  name: string;
  span: { start: number; end: number };
  phases: ReactPhaseSummary[];
  replay: ReactReplayModel;
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
  dependencies?: string[];
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
interface DependencyHook { callback: number; dependencies: number; phase: ReactPhase }
interface DependencyIssue {
  kind: "missing-hook-dependency" | "unknown-hook-closure" | "unknown-hook-dependencies" | "unstable-hook-dependency";
  node: ts.Node;
  dependencies?: string[];
  detail: string;
}
interface LifecycleContract { capability: string; identity?: "result" | number }
interface LifecycleIssue {
  kind: "resource-identity-mismatch" | "duplicate-effect-cleanup" | "conditional-resource-lifecycle";
  capability: string;
  node: ts.Node;
  detail: string;
}
interface LifecycleSummary {
  acquired: string[];
  released: string[];
  missing: string[];
  issues: LifecycleIssue[];
}
interface CustomHookSummary {
  phases: Map<ReactPhase, Set<string>>;
  leaked: Array<{ phase: HookKind; capabilities: string[] }>;
  lifecycleIssues: Array<LifecycleIssue & { phase: HookKind }>;
}

function replayModel(phases: ReadonlyMap<ReactPhase, ReadonlySet<string>>): ReactReplayModel {
  const cleanup = [...(phases.get("cleanup") ?? [])];
  const effects = (["layout-effect", "passive-effect"] as const)
    .filter((phase) => phases.has(phase))
    .map((phase) => ({ phase, setupEffects: [...(phases.get(phase) ?? [])], possibleCleanupEffects: cleanup }));
  return {
    production: {
      renderInvocations: 1,
      effects: effects.map((effect) => ({ ...effect, transitions: ["setup"] })),
    },
    strictModeDevelopment: {
      renderInvocations: 2,
      effects: effects.map((effect) => ({ ...effect, transitions: ["setup", "cleanup", "setup"] })),
    },
  };
}

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

function validReactAnnotation(value: string, node: AnnotatableFunction): boolean {
  if (value === "component" || value === "hook" || /^(?:acquire|release)\s+\S+$/u.test(value)) return true;
  if (/^acquire\s+\S+\s+result$/u.test(value)) return node.type?.kind !== ts.SyntaxKind.VoidKeyword;
  const release = /^release\s+\S+\s+parameter\s+(\d+)$/u.exec(value);
  return release !== null && Number(release[1]) < node.parameters.length;
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

function lifecycleDeclarations(source: ts.SourceFile, lifecycle: "acquire" | "release"): Map<string, LifecycleContract> {
  const result = new Map<string, LifecycleContract>();
  for (const statement of source.statements) {
    if (!ts.isFunctionDeclaration(statement) || !statement.name) continue;
    for (const [kind, capability, identityKind, identityValue] of annotationParts(source, statement)) {
      if (kind !== lifecycle || !capability) continue;
      if (!identityKind) result.set(statement.name.text, { capability });
      else if (lifecycle === "acquire" && identityKind === "result" && !identityValue) {
        result.set(statement.name.text, { capability, identity: "result" });
      } else if (lifecycle === "release" && identityKind === "parameter" && /^\d+$/u.test(identityValue ?? "")
        && Number(identityValue) < statement.parameters.length) {
        result.set(statement.name.text, { capability, identity: Number(identityValue) });
      }
    }
  }
  return result;
}

function lifecycleSummary(
  setup: ts.ArrowFunction | ts.FunctionExpression,
  cleanup: ts.ArrowFunction | ts.FunctionExpression | undefined,
  acquisitions: ReadonlyMap<string, LifecycleContract>,
  releases: ReadonlyMap<string, LifecycleContract>,
): LifecycleSummary {
  const acquired = new Set<string>(), released = new Set<string>();
  const acquiredIdentities = new Map<string, string>();
  const identityAcquisitionCounts = new Map<string, number>();
  const aliases = new Map<string, string>();
  const releaseCalls: Array<{ contract: LifecycleContract; call: ts.CallExpression; identity?: string; conditional: boolean }> = [];
  const issues: LifecycleIssue[] = [];
  const canonical = (name: string): string => {
    const seen = new Set<string>();
    let current = name;
    while (aliases.has(current) && !seen.has(current)) {
      seen.add(current);
      current = aliases.get(current)!;
    }
    return current;
  };
  const collectAliases = (root: ts.Node): void => {
    const visit = (node: ts.Node): void => {
      if (node !== root && ts.isFunctionLike(node)) return;
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
        && ts.isVariableDeclarationList(node.parent) && (node.parent.flags & ts.NodeFlags.Const) !== 0) {
        if (ts.isIdentifier(node.initializer)) aliases.set(node.name.text, canonical(node.initializer.text));
        if (ts.isCallExpression(node.initializer)) {
          const contract = acquisitions.get(callName(node.initializer) ?? "");
          if (contract?.identity === "result") acquiredIdentities.set(node.name.text, contract.capability);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(root);
  };
  collectAliases(setup.body);
  if (cleanup) collectAliases(cleanup.body);
  const collectSetup = (node: ts.Node): void => {
    if (node !== setup.body && ts.isFunctionLike(node)) return;
    if (ts.isCallExpression(node)) {
      const contract = acquisitions.get(callName(node) ?? "");
      if (contract) {
        acquired.add(contract.capability);
        if (isConditionalWithin(node, setup as ComponentNode)) issues.push({
          kind: "conditional-resource-lifecycle", capability: contract.capability, node,
          detail: `${node.expression.getText()} is control-flow-dependent, so a balanced Effect lifecycle is not established`,
        });
        if (contract.identity === "result") identityAcquisitionCounts.set(
          contract.capability,
          (identityAcquisitionCounts.get(contract.capability) ?? 0) + 1,
        );
      }
    }
    ts.forEachChild(node, collectSetup);
  };
  collectSetup(setup.body);
  if (cleanup) {
    const collectCleanup = (node: ts.Node): void => {
      if (node !== cleanup.body && ts.isFunctionLike(node)) return;
      if (ts.isCallExpression(node)) {
        const contract = releases.get(callName(node) ?? "");
        if (contract) {
          released.add(contract.capability);
          const argument = typeof contract.identity === "number" ? node.arguments[contract.identity] : undefined;
          releaseCalls.push({
            contract, call: node,
            identity: argument && ts.isIdentifier(argument) ? canonical(argument.text) : undefined,
            conditional: isConditionalWithin(node, cleanup as ComponentNode),
          });
        }
      }
      ts.forEachChild(node, collectCleanup);
    };
    collectCleanup(cleanup.body);
  }
  const identityCapabilities = new Set([...acquisitions.values()].filter((contract) => contract.identity === "result").map((contract) => contract.capability));
  const matchedIdentities = new Set<string>();
  const counts = new Map<string, number>();
  for (const entry of releaseCalls) {
    if (typeof entry.contract.identity !== "number") continue;
    if (entry.conditional) {
      issues.push({
        kind: "conditional-resource-lifecycle", capability: entry.contract.capability, node: entry.call,
        detail: `${entry.call.expression.getText()} is control-flow-dependent, so exactly-once cleanup is not established`,
      });
      continue;
    }
    const identity = entry.identity;
    const capability = identity && acquiredIdentities.get(identity);
    if (!identity || capability !== entry.contract.capability) {
      issues.push({
        kind: "resource-identity-mismatch", capability: entry.contract.capability, node: entry.call,
        detail: `${entry.call.expression.getText()} does not receive an identity acquired by this Effect setup`,
      });
      continue;
    }
    matchedIdentities.add(identity);
    const key = `${capability}:${identity}`;
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    if (count > 1) issues.push({
      kind: "duplicate-effect-cleanup", capability, node: entry.call,
      detail: `${identity} is released more than once by the same cleanup`,
    });
  }
  const missing = [...acquired].filter((capability) => identityCapabilities.has(capability)
    ? [...acquiredIdentities].some(([identity, acquiredCapability]) => acquiredCapability === capability && !matchedIdentities.has(canonical(identity)))
      || (identityAcquisitionCounts.get(capability) ?? 0) > [...acquiredIdentities.values()].filter((item) => item === capability).length
    : !released.has(capability));
  return { acquired: [...acquired], released: [...released], missing, issues };
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

function importedDependencyHooks(source: ts.SourceFile): Map<string, DependencyHook> {
  const hooks = new Map<string, DependencyHook>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
      || statement.moduleSpecifier.text !== "react" || !statement.importClause?.namedBindings
      || !ts.isNamedImports(statement.importClause.namedBindings)) continue;
    for (const element of statement.importClause.namedBindings.elements) {
      const imported = element.propertyName?.text ?? element.name.text;
      if (imported === "useEffect") hooks.set(element.name.text, { callback: 0, dependencies: 1, phase: "passive-effect" });
      else if (imported === "useLayoutEffect") hooks.set(element.name.text, { callback: 0, dependencies: 1, phase: "layout-effect" });
      else if (imported === "useMemo" || imported === "useCallback") hooks.set(element.name.text, { callback: 0, dependencies: 1, phase: "render" });
    }
  }
  return hooks;
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) => ts.isOmittedExpression(element) ? [] : bindingNames(element.name));
}

function ownerBindingFacts(boundary: ComponentNode, source: ts.SourceFile): { bindings: Set<string>; stable: Set<string> } {
  const bindings = new Set(boundary.parameters.flatMap((parameter) => bindingNames(parameter.name)));
  const stable = new Set<string>();
  const reactImports = new Map<string, string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
      || statement.moduleSpecifier.text !== "react" || !statement.importClause?.namedBindings
      || !ts.isNamedImports(statement.importClause.namedBindings)) continue;
    for (const element of statement.importClause.namedBindings.elements) {
      reactImports.set(element.name.text, element.propertyName?.text ?? element.name.text);
    }
  }
  const visit = (node: ts.Node): void => {
    if (node !== boundary.body && ts.isFunctionLike(node)) {
      if (ts.isFunctionDeclaration(node) && node.name) bindings.add(node.name.text);
      return;
    }
    if (ts.isVariableDeclaration(node)) {
      for (const name of bindingNames(node.name)) bindings.add(name);
      if (node.initializer && ts.isCallExpression(node.initializer) && ts.isIdentifier(node.initializer.expression)) {
        const imported = reactImports.get(node.initializer.expression.text);
        if (ts.isArrayBindingPattern(node.name) && (imported === "useState" || imported === "useReducer" || imported === "useTransition")) {
          const element = node.name.elements[1];
          if (element && !ts.isOmittedExpression(element)) for (const name of bindingNames(element.name)) stable.add(name);
        } else if (ts.isIdentifier(node.name) && imported === "useRef") stable.add(node.name.text);
      }
    }
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) bindings.add(node.name.text);
    ts.forEachChild(node, visit);
  };
  visit(boundary.body);
  return { bindings, stable };
}

function isReferenceIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === node && !ts.isComputedPropertyName(parent.name)) return false;
  if (ts.isBindingElement(parent) && parent.propertyName === node) return false;
  if (ts.isMethodDeclaration(parent) && parent.name === node) return false;
  if ((ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isBindingElement(parent)
    || ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent) || ts.isClassDeclaration(parent)) && parent.name === node) return false;
  if (ts.isTypeReferenceNode(parent) || ts.isTypeQueryNode(parent) || ts.isPropertySignature(parent)) return false;
  if (ts.isLabeledStatement(parent) || ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) return false;
  return true;
}

function directScopeBindings(block: ts.Block): Set<string> {
  const names = new Set<string>();
  for (const statement of block.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) for (const name of bindingNames(declaration.name)) names.add(name);
    } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) names.add(statement.name.text);
  }
  return names;
}

function capturedDependencies(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  ownerBindings: ReadonlySet<string>,
  stableBindings: ReadonlySet<string>,
): Set<string> {
  const required = new Set<string>();
  const initial = new Set(callback.parameters.flatMap((parameter) => bindingNames(parameter.name)));
  const visit = (node: ts.Node, shadowed: ReadonlySet<string>): void => {
    if (node !== callback && ts.isFunctionLike(node)) {
      const nested = new Set(shadowed);
      if (node.name && ts.isIdentifier(node.name)) nested.add(node.name.text);
      for (const parameter of node.parameters) for (const name of bindingNames(parameter.name)) nested.add(name);
      if ("body" in node && node.body) visit(node.body, nested);
      return;
    }
    if (ts.isCatchClause(node)) {
      const caught = new Set(shadowed);
      if (node.variableDeclaration) for (const name of bindingNames(node.variableDeclaration.name)) caught.add(name);
      visit(node.block, caught);
      return;
    }
    if (ts.isForStatement(node) && node.initializer && ts.isVariableDeclarationList(node.initializer)) {
      const loop = new Set(shadowed);
      for (const declaration of node.initializer.declarations) for (const name of bindingNames(declaration.name)) loop.add(name);
      visit(node.initializer, loop);
      if (node.condition) visit(node.condition, loop);
      if (node.incrementor) visit(node.incrementor, loop);
      visit(node.statement, loop);
      return;
    }
    if ((ts.isForInStatement(node) || ts.isForOfStatement(node)) && ts.isVariableDeclarationList(node.initializer)) {
      const loop = new Set(shadowed);
      for (const declaration of node.initializer.declarations) for (const name of bindingNames(declaration.name)) loop.add(name);
      visit(node.initializer, loop);
      visit(node.expression, loop);
      visit(node.statement, loop);
      return;
    }
    if (ts.isBlock(node)) {
      const scoped = new Set(shadowed);
      for (const name of directScopeBindings(node)) scoped.add(name);
      for (const statement of node.statements) visit(statement, scoped);
      return;
    }
    if (ts.isIdentifier(node) && isReferenceIdentifier(node) && ownerBindings.has(node.text)
      && !shadowed.has(node.text) && !stableBindings.has(node.text)) required.add(capturedPath(node));
    ts.forEachChild(node, (child) => visit(child, shadowed));
  };
  visit(callback.body, initial);
  return required;
}

function capturedPath(identifier: ts.Identifier): string {
  let current: ts.Expression = identifier;
  while ((ts.isPropertyAccessExpression(current.parent) && current.parent.expression === current)
    || (ts.isElementAccessExpression(current.parent) && current.parent.expression === current
      && current.parent.argumentExpression && (ts.isStringLiteral(current.parent.argumentExpression) || ts.isNumericLiteral(current.parent.argumentExpression)))) {
    current = current.parent;
  }
  let path = current.getText(identifier.getSourceFile()).replace(/\s+/gu, "");
  if (ts.isCallExpression(current.parent) && current.parent.expression === current && path.includes(".")) path = path.slice(0, path.lastIndexOf("."));
  return path;
}

function dependencyIssues(
  call: ts.CallExpression,
  hook: string,
  config: DependencyHook,
  boundary: ComponentNode,
  source: ts.SourceFile,
): DependencyIssue[] {
  const dependencyNode = call.arguments[config.dependencies];
  if (!dependencyNode) return [];
  const callbackNode = call.arguments[config.callback];
  const issues: DependencyIssue[] = [];
  if (!callbackNode || !(ts.isArrowFunction(callbackNode) || ts.isFunctionExpression(callbackNode))) {
    issues.push({ kind: "unknown-hook-closure", node: callbackNode ?? call, detail: `${hook} uses a callback whose captured values are not locally inspectable` });
  }
  if (!ts.isArrayLiteralExpression(dependencyNode) || dependencyNode.elements.some(ts.isSpreadElement)) {
    issues.push({ kind: "unknown-hook-dependencies", node: dependencyNode, detail: `${hook} dependency list is not a finite inline array` });
    return issues;
  }
  for (const element of dependencyNode.elements) {
    if (ts.isObjectLiteralExpression(element) || ts.isArrayLiteralExpression(element) || ts.isArrowFunction(element)
      || ts.isFunctionExpression(element) || ts.isCallExpression(element) || ts.isNewExpression(element)) {
      issues.push({ kind: "unstable-hook-dependency", node: element, dependencies: [element.getText(source)], detail: `${element.getText(source)} creates a new dependency identity during render` });
    }
  }
  if (!callbackNode || !(ts.isArrowFunction(callbackNode) || ts.isFunctionExpression(callbackNode))) return issues;
  const { bindings, stable } = ownerBindingFacts(boundary, source);
  const required = capturedDependencies(callbackNode, bindings, stable);
  const declared = dependencyNode.elements.map((element) => element.getText(source).replace(/\s+/gu, ""));
  const missing = [...required].filter((requiredPath) => !declared.some((dependency) => requiredPath === dependency || requiredPath.startsWith(`${dependency}.`) || requiredPath.startsWith(`${dependency}[`))).sort();
  if (missing.length > 0) issues.push({
    kind: "missing-hook-dependency", node: dependencyNode, dependencies: missing,
    detail: `${hook} captures ${missing.join(", ")} without a covering dependency`,
  });
  return issues;
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
  if (node === boundary.body) return false;
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

interface InternalReactAnalysis {
  result: ReactSemanticsResult;
  hookSummaries: Map<string, CustomHookSummary>;
  hookNodes: Map<string, ComponentNode>;
}

function analyzeReactSource(source: ts.SourceFile, externalHooks: ReadonlyMap<string, CustomHookSummary> = new Map()): InternalReactAnalysis {
  const fileName = source.fileName;
  const hooks = importedHooks(source), renderCallbacks = importedRenderCallbacks(source);
  const dependencyHooks = importedDependencyHooks(source), declared = effectDeclarations(source);
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
    if (validReactAnnotation(value, node)) continue;
    const name = componentName(node);
    diagnostics.push({
      fileName, component: name, functionName: name, kind: "invalid-react-annotation", phase: "render", severity: "error",
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      message: `invalid React annotation \`${value}\`; expected component, hook, acquire Capability [result], or release Capability [parameter N]`,
    });
  }
  const customHooks = new Map<string, ComponentNode>();
  for (const candidate of candidates) if (extractAnnotations(leadingText(source, candidate), "react").some((value) => value.trim() === "hook")) {
    customHooks.set(componentName(candidate), candidate);
  }
  const localHookCalls = new Map<string, Array<{ called: string; node: ts.CallExpression }>>();
  for (const [name, hook] of customHooks) {
    const calls: Array<{ called: string; node: ts.CallExpression }> = [];
    const visit = (node: ts.Node): void => {
      if (node !== hook.body && ts.isFunctionLike(node)) return;
      if (ts.isCallExpression(node)) {
        const called = callName(node);
        if (called && customHooks.has(called)) calls.push({ called, node });
      }
      ts.forEachChild(node, visit);
    };
    visit(hook.body);
    localHookCalls.set(name, calls);
  }
  const reachesHook = (from: string, target: string, seen = new Set<string>()): boolean => {
    if (from === target) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return (localHookCalls.get(from) ?? []).some(({ called }) => reachesHook(called, target, seen));
  };
  const recursiveLocalEdges = new Set<string>();
  for (const [from, calls] of localHookCalls) for (const { called } of calls) {
    if (reachesHook(called, from)) recursiveLocalEdges.add(`${from}->${called}`);
  }
  const customHookCache = new Map<string, CustomHookSummary>(externalHooks);
  for (const hookName of customHooks.keys()) customHookCache.delete(hookName);
  const summarizeCustomHook = (hookName: string, stack = new Set<string>()): CustomHookSummary => {
    const cached = customHookCache.get(hookName);
    if (cached) return cached;
    const phases = new Map<ReactPhase, Set<string>>([["render", new Set()]]), leaked: CustomHookSummary["leaked"] = [];
    const lifecycleIssues: CustomHookSummary["lifecycleIssues"] = [];
    const hook = customHooks.get(hookName);
    if (!hook || stack.has(hookName)) return { phases, leaked, lifecycleIssues };
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
            const lifecycle = lifecycleSummary(callback, cleanup, acquisitions, releases);
            add(builtinPhase, lifecycle.acquired.map((capability) => `Acquire<${capability}>`));
            add("cleanup", lifecycle.released.map((capability) => `Release<${capability}>`));
            if (lifecycle.missing.length > 0) leaked.push({ phase: builtinPhase, capabilities: lifecycle.missing });
            lifecycleIssues.push(...lifecycle.issues.map((issue) => ({ ...issue, phase: builtinPhase })));
          } else add(builtinPhase, []);
          return;
        }
        if (called && customHooks.has(called)) {
          const child = summarizeCustomHook(called, nextStack);
          for (const [phase, effects] of child.phases) add(phase, [...effects]);
          leaked.push(...child.leaked);
          lifecycleIssues.push(...child.lifecycleIssues);
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
    const summary = { phases, leaked, lifecycleIssues };
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
          const dependencyHook = called ? dependencyHooks.get(called) : undefined;
          if (called && dependencyHook) for (const issue of dependencyIssues(node, called, dependencyHook, hook, source)) reportHook(issue.node, {
            kind: issue.kind, phase: dependencyHook.phase, hook: called, dependencies: issue.dependencies, message: issue.detail,
          });
          if (called && recursiveLocalEdges.has(`${hookName}->${called}`)) reportHook(node, {
            kind: "recursive-hook", phase: "render", hook: called,
            message: `${hookName} -> ${called} participates in a recursive Hook cycle, so Hook order and phase summaries are not finite`,
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
    for (const issue of customHookCache.get(hookName)?.lifecycleIssues ?? []) reportHook(issue.node, {
      kind: issue.kind, phase: issue.phase, effect: issue.capability,
      message: issue.detail,
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
          const dependencyHook = called ? dependencyHooks.get(called) : undefined;
          if (called && dependencyHook) for (const issue of dependencyIssues(node, called, dependencyHook, component, source)) report(issue.node, {
            kind: issue.kind, phase: dependencyHook.phase, hook: called, dependencies: issue.dependencies, message: issue.detail,
          });
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
            const lifecycle = lifecycleSummary(callback, cleanup, acquisitions, releases);
            addPhase(hookPhase, lifecycle.acquired.map((capability) => `Acquire<${capability}>`));
            addPhase("cleanup", lifecycle.released.map((capability) => `Release<${capability}>`));
            if (lifecycle.missing.length > 0) report(node, {
              kind: "missing-effect-cleanup", phase: hookPhase,
              effect: lifecycle.missing.join(" | "), message: `Effect acquires ${lifecycle.missing.join(", ")} without a matching cleanup release`,
            });
            for (const issue of lifecycle.issues) report(issue.node, {
              kind: issue.kind, phase: hookPhase, effect: issue.capability, message: issue.detail,
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
      replay: replayModel(phaseEffects),
    });
  }
  const publicHooks = [...customHooks.keys()].map((name): ReactHookSummary => {
    const node = customHooks.get(name)!, summary = customHookCache.get(name)!;
    return {
      name, span: { start: node.getStart(source), end: node.getEnd() },
      phases: [...summary.phases].map(([phase, effects]) => ({ phase, effects: [...effects] })),
      replay: replayModel(summary.phases),
    };
  });
  return { result: { components, hooks: publicHooks, diagnostics }, hookSummaries: customHookCache, hookNodes: customHooks };
}

/** Analyze one source string without requiring React at runtime. */
export function analyzeReactSemantics(fileName: string, text: string): ReactSemanticsResult {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  return analyzeReactSource(source).result;
}

function declarationKey(node: AnnotatableFunction): string {
  return `${node.getSourceFile().fileName}:${componentName(node)}`;
}

function functionDeclarationForSymbol(
  checker: ts.TypeChecker,
  symbol: ts.Symbol | undefined,
  seen = new Set<ts.Symbol>(),
): AnnotatableFunction | undefined {
  if (!symbol || seen.has(symbol)) return undefined;
  seen.add(symbol);
  const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  if (target !== symbol) return functionDeclarationForSymbol(checker, target, seen);
  for (const declaration of target.declarations ?? []) {
    if (ts.isFunctionDeclaration(declaration) || ts.isFunctionExpression(declaration) || ts.isArrowFunction(declaration)) return declaration;
    if (ts.isVariableDeclaration(declaration) && declaration.initializer
      && (ts.isFunctionExpression(declaration.initializer) || ts.isArrowFunction(declaration.initializer))) return declaration.initializer;
    if (ts.isExportAssignment(declaration)) {
      const resolved = functionDeclarationForSymbol(checker, checker.getSymbolAtLocation(declaration.expression), seen);
      if (resolved) return resolved;
    }
  }
  return undefined;
}

function importedCustomHooks(
  source: ts.SourceFile,
  checker: ts.TypeChecker,
  summaries: ReadonlyMap<string, CustomHookSummary>,
): Map<string, CustomHookSummary> {
  const imports = new Map<string, CustomHookSummary>();
  const add = (localName: string, location: ts.Node): void => {
    const declaration = functionDeclarationForSymbol(checker, checker.getSymbolAtLocation(location));
    const summary = declaration ? summaries.get(declarationKey(declaration)) : undefined;
    if (summary) imports.set(localName, summary);
  };
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) continue;
    if (statement.importClause.name) add(statement.importClause.name.text, statement.importClause.name);
    const bindings = statement.importClause.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) add(element.name.text, element.name);
    } else if (bindings && ts.isNamespaceImport(bindings)) {
      const symbol = checker.getSymbolAtLocation(bindings.name);
      const moduleSymbol = symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
      if (moduleSymbol) for (const exported of checker.getExportsOfModule(moduleSymbol)) {
        const declaration = functionDeclarationForSymbol(checker, exported);
        const summary = declaration ? summaries.get(declarationKey(declaration)) : undefined;
        if (summary) imports.set(`${bindings.name.text}.${exported.name}`, summary);
      }
    }
  }
  return imports;
}

function addProgramHookCycleDiagnostics(
  program: ts.Program,
  results: Map<string, ReactSemanticsResult>,
  hooks: ReadonlyMap<string, ComponentNode>,
): Map<string, ReactSemanticsResult> {
  const checker = program.getTypeChecker();
  const edges = new Map<string, Array<{ target: string; called: string; node: ts.CallExpression }>>();
  for (const [key, hook] of hooks) {
    const calls: Array<{ target: string; called: string; node: ts.CallExpression }> = [];
    const visit = (node: ts.Node): void => {
      if (node !== hook.body && ts.isFunctionLike(node)) return;
      if (ts.isCallExpression(node)) {
        const called = callName(node);
        const location = ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression;
        const target = functionDeclarationForSymbol(checker, checker.getSymbolAtLocation(location));
        const targetKey = target ? declarationKey(target) : undefined;
        if (called && targetKey && hooks.has(targetKey)) calls.push({ target: targetKey, called, node });
      }
      ts.forEachChild(node, visit);
    };
    visit(hook.body);
    edges.set(key, calls);
  }
  const reaches = (from: string, target: string, seen = new Set<string>()): boolean => {
    if (from === target) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return (edges.get(from) ?? []).some((edge) => reaches(edge.target, target, seen));
  };
  for (const [from, calls] of edges) for (const edge of calls) {
    if (!reaches(edge.target, from)) continue;
    const hook = hooks.get(from)!, source = hook.getSourceFile(), name = componentName(hook);
    const line = source.getLineAndCharacterOfPosition(edge.node.getStart(source)).line + 1;
    const result = results.get(source.fileName);
    if (!result || result.diagnostics.some((diagnostic) => diagnostic.kind === "recursive-hook"
      && diagnostic.functionName === name && diagnostic.hook === edge.called && diagnostic.line === line)) continue;
    result.diagnostics.push({
      fileName: source.fileName, component: name, functionName: name, kind: "recursive-hook",
      phase: "render", severity: "error", line, hook: edge.called,
      message: `${name} -> ${edge.called} participates in a recursive Hook cycle, so Hook order and phase summaries are not finite`,
    });
  }
  return results;
}

function analyzeProgramFixedPoint(program: ts.Program): Map<string, ReactSemanticsResult> {
  const checker = program.getTypeChecker();
  const sources = program.getSourceFiles().filter((candidate) => !candidate.isDeclarationFile);
  let summaries = new Map<string, CustomHookSummary>(), results = new Map<string, ReactSemanticsResult>();
  let hookNodes = new Map<string, ComponentNode>();
  for (let iteration = 0; iteration <= sources.length; iteration++) {
    const next = new Map<string, CustomHookSummary>(), nextResults = new Map<string, ReactSemanticsResult>();
    const nextHookNodes = new Map<string, ComponentNode>();
    for (const candidate of sources) {
      const analysis = analyzeReactSource(candidate, importedCustomHooks(candidate, checker, summaries));
      nextResults.set(candidate.fileName, analysis.result);
      for (const hook of analysis.result.hooks) next.set(`${candidate.fileName}:${hook.name}`, analysis.hookSummaries.get(hook.name)!);
      for (const [name, node] of analysis.hookNodes) nextHookNodes.set(`${candidate.fileName}:${name}`, node);
    }
    const fingerprint = (values: ReadonlyMap<string, CustomHookSummary>): string => JSON.stringify([...values].map(([key, summary]) => [
      key,
      [...summary.phases].map(([phase, effects]) => [phase, [...effects].sort()]),
      summary.leaked,
      summary.lifecycleIssues.map(({ kind, capability, phase, detail }) => ({ kind, capability, phase, detail })),
    ]).sort(([left], [right]) => String(left).localeCompare(String(right))));
    if (fingerprint(next) === fingerprint(summaries)) return addProgramHookCycleDiagnostics(program, nextResults, nextHookNodes);
    summaries = next;
    results = nextResults;
    hookNodes = nextHookNodes;
  }
  return addProgramHookCycleDiagnostics(program, results, hookNodes);
}

/** Analyze every implementation source while computing the custom-Hook fixed point only once. */
export function analyzeReactProgram(program: ts.Program): Map<string, ReactSemanticsResult> {
  return analyzeProgramFixedPoint(program);
}

/** Program-backed path: composes annotated custom Hooks through resolved named imports and aliases. */
export function analyzeReactSemanticsInProgram(program: ts.Program, source: ts.SourceFile): ReactSemanticsResult {
  return analyzeReactProgram(program).get(source.fileName) ?? { components: [], hooks: [], diagnostics: [] };
}
