import ts from "typescript";
import { extractAnnotations } from "./annotations.js";

export type ReactPhase = "render" | "event" | "external-store-snapshot" | "server-snapshot" | "external-store-subscribe" | "insertion-effect" | "passive-effect" | "layout-effect" | "ref-callback" | "cleanup";
export type ReactDiagnosticKind =
  | "render-effect"
  | "non-idempotent-render"
  | "immutable-input-mutation"
  | "render-ref-access"
  | "unknown-ref-callback"
  | "unknown-event-handler"
  | "unknown-transition-action"
  | "insertion-effect-state-update"
  | "insertion-effect-ref-access"
  | "invalid-effect-event-call"
  | "effect-event-dependency"
  | "unknown-external-store-callback"
  | "uncached-external-store-snapshot"
  | "missing-external-store-cleanup"
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
export type ReactCommitPhase = "insertion-effect" | "external-store-subscribe" | "passive-effect" | "layout-effect" | "ref-callback";
export interface ReactLifecycleStep {
  transition: ReactEffectTransition;
  commit: string;
}
export interface ReactReplayEffect {
  instance: string;
  phase: ReactCommitPhase;
  transitions: ReactEffectTransition[];
  lifecycle: ReactLifecycleStep[];
  setupEffects: string[];
  cleanupEffects: string[];
}
export interface ReactRenderAttempt {
  instance: string;
  outcome: "committed" | "discarded" | "suspended";
  reason?: "strict-mode-replay" | "concurrent-interruption";
  commit?: string;
  suspension?: string;
  retryOf?: string;
}
export interface ReactReplayScenario {
  renderInvocations: number;
  renderAttempts: ReactRenderAttempt[];
  effects: ReactReplayEffect[];
}
export interface ReactReplayModel {
  production: ReactReplayScenario;
  strictModeDevelopment: ReactReplayScenario;
  concurrentInterruption: ReactReplayScenario;
  dependencyChange: ReactReplayScenario;
  suspenseRetry: ReactReplayScenario;
  repeatedSuspenseRetry: ReactReplayScenario;
}

export interface ReactComponentSummary {
  name: string;
  span: { start: number; end: number };
  phases: ReactPhaseSummary[];
  replay: ReactReplayModel;
  suspensions: ReactSuspensionSource[];
}
export interface ReactHookSummary extends ReactComponentSummary {}

export interface ReactSuspensionSource {
  kind: "react-use" | "throw-thenable";
  certainty: "unknown" | "thenable" | "non-thenable";
  fileName: string;
  expression: string;
  span: { start: number; end: number };
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
  dependencies?: string[];
  notes?: Array<{ label: string; detail: string }>;
}

export interface ReactSemanticsResult {
  components: ReactComponentSummary[];
  hooks: ReactHookSummary[];
  diagnostics: ReactSemanticDiagnostic[];
  suspenseBoundaries: ReactSuspenseBoundarySummary[];
  unsupportedSuspenseBoundaries: ReactUnsupportedSuspenseBoundary[];
}

export interface ReactSuspenseBoundarySummary {
  instance: string;
  primary: string;
  fallback: string;
  primaryKey: string;
  fallbackKey: string;
  /** Direct child boundary when this boundary's primary is another Suspense node. */
  primaryBoundary?: string;
  /** Direct primary-owning boundary. Fallback-subtree boundaries are deliberately not linked here. */
  parentBoundary?: string;
  /** Ordered, Fragment-flattened direct primary nodes. This is the canonical tree representation. */
  primaryNodes: ReactSuspensePrimaryNode[];
  span: { start: number; end: number };
}

export type ReactSuspensePrimaryNode =
  | { kind: "component"; displayName: string; componentKey: string }
  | { kind: "boundary"; instance: string };

export type ReactUnsupportedSuspenseBoundaryReason =
  | "missing-fallback"
  | "fallback-must-be-one-direct-component"
  | "primary-must-be-one-direct-component"
  | "unannotated-primary"
  | "unannotated-fallback";

export interface ReactUnsupportedSuspenseBoundary {
  instance: string;
  reason: ReactUnsupportedSuspenseBoundaryReason;
  span: { start: number; end: number };
}

type ComponentNode = (ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction) & { body: ts.ConciseBody };
type AnnotatableFunction = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction;
type HookKind = "insertion-effect" | "passive-effect" | "layout-effect";
type BuiltinHookKind = HookKind | "render-hook";
interface DependencyHook { callback: number; dependencies: number; phase: ReactPhase }
interface DependencyIssue {
  kind: "missing-hook-dependency" | "unknown-hook-closure" | "unknown-hook-dependencies" | "unstable-hook-dependency" | "effect-event-dependency";
  node: ts.Node;
  operation?: string;
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
  instances: CommitInstanceSummary[];
  leaked: Array<{ phase: ReactCommitPhase; capabilities: string[] }>;
  lifecycleIssues: Array<LifecycleIssue & { phase: ReactCommitPhase }>;
  suspensions: ReactSuspensionSource[];
}

interface CommitInstanceSummary {
  instance: string;
  phase: ReactCommitPhase;
  setupEffects: string[];
  cleanupEffects: string[];
}

const reactCommitPhaseOrder = new Map<ReactCommitPhase, number>([
  ["insertion-effect", 0], ["ref-callback", 1], ["layout-effect", 2], ["external-store-subscribe", 3], ["passive-effect", 3],
]);

function replayModel(instances: readonly CommitInstanceSummary[]): ReactReplayModel {
  const ordered = [...instances].sort((left, right) => reactCommitPhaseOrder.get(left.phase)! - reactCommitPhaseOrder.get(right.phase)!);
  const effects = (lifecycle: ReactLifecycleStep[]): ReactReplayEffect[] => ordered.map((effect) => ({
    ...effect,
    transitions: lifecycle.map(({ transition }) => transition),
    lifecycle: lifecycle.map((step) => ({ ...step })),
  }));
  return {
    production: {
      renderInvocations: 1,
      renderAttempts: [{ instance: "render@0", outcome: "committed", commit: "commit@0" }],
      effects: effects([{ transition: "setup", commit: "commit@0" }]),
    },
    strictModeDevelopment: {
      renderInvocations: 2,
      renderAttempts: [
        { instance: "render@0", outcome: "discarded", reason: "strict-mode-replay" },
        { instance: "render@1", outcome: "committed", commit: "commit@0" },
      ],
      effects: effects([
        { transition: "setup", commit: "commit@0" },
        { transition: "cleanup", commit: "commit@0" },
        { transition: "setup", commit: "commit@0" },
      ]),
    },
    concurrentInterruption: {
      renderInvocations: 2,
      renderAttempts: [
        { instance: "render@0", outcome: "discarded", reason: "concurrent-interruption" },
        { instance: "render@1", outcome: "committed", commit: "commit@0" },
      ],
      effects: effects([{ transition: "setup", commit: "commit@0" }]),
    },
    dependencyChange: {
      renderInvocations: 2,
      renderAttempts: [
        { instance: "render@0", outcome: "committed", commit: "commit@0" },
        { instance: "render@1", outcome: "committed", commit: "commit@1" },
      ],
      effects: effects([
        { transition: "setup", commit: "commit@0" },
        { transition: "cleanup", commit: "commit@0" },
        { transition: "setup", commit: "commit@1" },
      ]),
    },
    suspenseRetry: {
      renderInvocations: 2,
      renderAttempts: [
        { instance: "render@0", outcome: "suspended", suspension: "suspension@0" },
        { instance: "render@1", outcome: "committed", commit: "commit@0", retryOf: "suspension@0" },
      ],
      effects: effects([{ transition: "setup", commit: "commit@0" }]),
    },
    repeatedSuspenseRetry: {
      renderInvocations: 3,
      renderAttempts: [
        { instance: "render@0", outcome: "suspended", suspension: "suspension@0" },
        { instance: "render@1", outcome: "suspended", suspension: "suspension@1", retryOf: "suspension@0" },
        { instance: "render@2", outcome: "committed", commit: "commit@0", retryOf: "suspension@1" },
      ],
      effects: effects([{ transition: "setup", commit: "commit@0" }]),
    },
  };
}

function commitInstance(
  phase: ReactCommitPhase,
  node: ts.Node,
  setupEffects: readonly string[],
  cleanupEffects: readonly string[],
): CommitInstanceSummary {
  return {
    instance: `${phase}@${node.getStart(node.getSourceFile())}`,
    phase,
    setupEffects: [...new Set(setupEffects)],
    cleanupEffects: [...new Set(cleanupEffects)],
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
  setup: LocalEventCallback,
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
      else if (imported === "useInsertionEffect") hooks.set(element.name.text, "insertion-effect");
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
      else if (imported === "useInsertionEffect") hooks.set(element.name.text, { callback: 0, dependencies: 1, phase: "insertion-effect" });
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
  const reactImports = reactImportNames(source);
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
  for (const name of localEffectEventCallbacks(boundary, source).keys()) stable.add(name);
  return { bindings, stable };
}

/** State dispatchers are stable identities, but are forbidden inside insertion Effects. */
function stateUpdaterBindings(boundary: ComponentNode, source: ts.SourceFile): ReadonlySet<string> {
  const updaters = new Set<string>();
  const aliases: Array<{ name: string; target: string }> = [];
  const imports = reactImportNames(source);
  const visit = (node: ts.Node): void => {
    if (node !== boundary.body && ts.isFunctionLike(node)) return;
    if (ts.isVariableDeclaration(node)
      && ts.isVariableDeclarationList(node.parent)
      && (node.parent.flags & ts.NodeFlags.Const) !== 0
      && node.initializer) {
      const initializer = unwrapExpression(node.initializer);
      if (ts.isCallExpression(initializer)
        && ts.isIdentifier(initializer.expression)
        && (imports.get(initializer.expression.text) === "useState" || imports.get(initializer.expression.text) === "useReducer")
        && ts.isArrayBindingPattern(node.name)) {
        const dispatcher = node.name.elements[1];
        if (dispatcher && !ts.isOmittedExpression(dispatcher)) {
          for (const name of bindingNames(dispatcher.name)) updaters.add(name);
        }
      } else if (ts.isIdentifier(node.name) && ts.isIdentifier(initializer)) {
        aliases.push({ name: node.name.text, target: initializer.text });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(boundary.body);
  let changed = true;
  while (changed) {
    changed = false;
    for (const alias of aliases) if (updaters.has(alias.target) && !updaters.has(alias.name)) {
      updaters.add(alias.name);
      changed = true;
    }
  }
  return updaters;
}

function stateUpdates(node: ts.Node, updaters: ReadonlySet<string>): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  const visit = (candidate: ts.Node): void => {
    if (candidate !== node && ts.isFunctionLike(candidate)) return;
    if (ts.isCallExpression(candidate) && ts.isIdentifier(candidate.expression) && updaters.has(candidate.expression.text)) {
      calls.push(candidate);
    }
    ts.forEachChild(candidate, visit);
  };
  visit(node);
  return calls;
}

function refAccesses(node: ts.Node, refs: ReadonlySet<string>): ts.Expression[] {
  const accesses: ts.Expression[] = [];
  const visit = (candidate: ts.Node): void => {
    if (candidate !== node && ts.isFunctionLike(candidate)) return;
    const access = refCurrentAccess(candidate, refs);
    if (access) accesses.push(access);
    ts.forEachChild(candidate, visit);
  };
  visit(node);
  return accesses;
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
  const effectEvents = localEffectEventCallbacks(boundary, source);
  for (const element of dependencyNode.elements) {
    const expression = unwrapExpression(element);
    if (ts.isIdentifier(expression) && effectEvents.has(expression.text)) issues.push({
      kind: "effect-event-dependency", node: element, operation: expression.text, dependencies: [expression.text],
      detail: `${expression.text} is an Effect Event and must be omitted from dependency arrays`,
    });
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

type LocalEventCallback = (ts.FunctionDeclaration & { body: ts.Block }) | ts.ArrowFunction | ts.FunctionExpression;

function localEventCallbacks(component: ComponentNode): ReadonlyMap<string, LocalEventCallback> {
  if (!ts.isBlock(component.body)) return new Map();
  const callbacks = new Map<string, LocalEventCallback>();
  const aliases = new Map<string, string>();
  const reassigned = new Set<string>();
  for (const statement of component.body.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) callbacks.set(statement.name.text, statement as ts.FunctionDeclaration & { body: ts.Block });
    if (!ts.isVariableStatement(statement)
      || (statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      if (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer)) {
        callbacks.set(declaration.name.text, declaration.initializer);
      } else if (ts.isIdentifier(declaration.initializer)) aliases.set(declaration.name.text, declaration.initializer.text);
    }
  }
  const visitWrites = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node)
      && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      && ts.isIdentifier(node.left)) reassigned.add(node.left.text);
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
      && ts.isIdentifier(node.operand)) reassigned.add(node.operand.text);
    ts.forEachChild(node, visitWrites);
  };
  visitWrites(component.body);
  const resolved = new Map<string, LocalEventCallback>();
  const resolve = (name: string, seen = new Set<string>()): LocalEventCallback | undefined => {
    if (reassigned.has(name) || seen.has(name)) return undefined;
    const callback = callbacks.get(name);
    if (callback) return callback;
    const alias = aliases.get(name);
    return alias ? resolve(alias, new Set(seen).add(name)) : undefined;
  };
  for (const name of [...callbacks.keys(), ...aliases.keys()]) {
    const callback = resolve(name);
    if (callback) resolved.set(name, callback);
  }
  return resolved;
}

const sourceCallbackCache = new WeakMap<ts.SourceFile, ReadonlyMap<string, LocalEventCallback>>();

function sourceCallbacks(source: ts.SourceFile): ReadonlyMap<string, LocalEventCallback> {
  const cached = sourceCallbackCache.get(source);
  if (cached) return cached;
  const callbacks = new Map<string, LocalEventCallback>();
  const aliases = new Map<string, string>();
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) callbacks.set(statement.name.text, statement as ts.FunctionDeclaration & { body: ts.Block });
    if (!ts.isVariableStatement(statement) || (statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      const initializer = unwrapExpression(declaration.initializer);
      if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) callbacks.set(declaration.name.text, initializer);
      else if (ts.isIdentifier(initializer)) aliases.set(declaration.name.text, initializer.text);
    }
  }
  const resolve = (name: string, seen = new Set<string>()): LocalEventCallback | undefined => {
    if (seen.has(name)) return undefined;
    const callback = callbacks.get(name);
    if (callback) return callback;
    const alias = aliases.get(name);
    return alias ? resolve(alias, new Set(seen).add(name)) : undefined;
  };
  const resolved = new Map<string, LocalEventCallback>();
  for (const name of [...callbacks.keys(), ...aliases.keys()]) {
    const callback = resolve(name);
    if (callback) resolved.set(name, callback);
  }
  sourceCallbackCache.set(source, resolved);
  return resolved;
}

function callbackArgument(
  argument: ts.Expression | undefined,
  callbacks: ReadonlyMap<string, LocalEventCallback>,
): LocalEventCallback | undefined {
  if (!argument) return undefined;
  const expression = unwrapExpression(argument);
  if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) return expression;
  return ts.isIdentifier(expression) ? callbacks.get(expression.text) : undefined;
}

function isUseSyncExternalStoreCall(source: ts.SourceFile, expression: ts.LeftHandSideExpression): boolean {
  if (ts.isIdentifier(expression)) return reactImportNames(source).get(expression.text) === "useSyncExternalStore";
  return ts.isPropertyAccessExpression(expression) && expression.name.text === "useSyncExternalStore"
    && ts.isIdentifier(expression.expression) && reactNamespaceImportNames(source).has(expression.expression.text);
}

function returnsFreshSnapshot(callback: LocalEventCallback): ts.Expression | undefined {
  if (!ts.isBlock(callback.body)) {
    const expression = unwrapExpression(callback.body);
    return ts.isObjectLiteralExpression(expression) || ts.isArrayLiteralExpression(expression) ? expression : undefined;
  }
  let fresh: ts.Expression | undefined;
  const visit = (node: ts.Node): void => {
    if (fresh || (node !== callback.body && ts.isFunctionLike(node))) return;
    if (ts.isReturnStatement(node) && node.expression) {
      const expression = unwrapExpression(node.expression);
      if (ts.isObjectLiteralExpression(expression) || ts.isArrayLiteralExpression(expression)) fresh = expression;
    }
    ts.forEachChild(node, visit);
  };
  visit(callback.body);
  return fresh;
}

const localEffectEventCallbackCache = new WeakMap<ComponentNode, ReadonlyMap<string, ts.ArrowFunction | ts.FunctionExpression>>();

function localEffectEventCallbacks(
  boundary: ComponentNode,
  source: ts.SourceFile,
): ReadonlyMap<string, ts.ArrowFunction | ts.FunctionExpression> {
  const cached = localEffectEventCallbackCache.get(boundary);
  if (cached) return cached;
  if (!ts.isBlock(boundary.body)) {
    const empty = new Map<string, ts.ArrowFunction | ts.FunctionExpression>();
    localEffectEventCallbackCache.set(boundary, empty);
    return empty;
  }
  const imports = reactImportNames(source);
  const callbacks = new Map<string, ts.ArrowFunction | ts.FunctionExpression>();
  const aliases = new Map<string, string>();
  for (const statement of boundary.body.statements) {
    if (!ts.isVariableStatement(statement) || (statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      const initializer = unwrapExpression(declaration.initializer);
      if (ts.isCallExpression(initializer) && ts.isIdentifier(initializer.expression)
        && imports.get(initializer.expression.text) === "useEffectEvent") {
        const callback = initializer.arguments[0];
        if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
          callbacks.set(declaration.name.text, callback);
        }
      } else if (ts.isIdentifier(initializer)) aliases.set(declaration.name.text, initializer.text);
    }
  }
  const resolved = new Map<string, ts.ArrowFunction | ts.FunctionExpression>();
  const resolve = (name: string, seen = new Set<string>()): ts.ArrowFunction | ts.FunctionExpression | undefined => {
    if (seen.has(name)) return undefined;
    const callback = callbacks.get(name);
    if (callback) return callback;
    const alias = aliases.get(name);
    return alias ? resolve(alias, new Set(seen).add(name)) : undefined;
  };
  for (const name of [...callbacks.keys(), ...aliases.keys()]) {
    const callback = resolve(name);
    if (callback) resolved.set(name, callback);
  }
  localEffectEventCallbackCache.set(boundary, resolved);
  return resolved;
}

function effectEventCallsInPhase(
  node: ts.Node,
  bindings: ReadonlyMap<string, unknown>,
  immediateCallbacks: ReadonlySet<string>,
  localCallbacks: ReadonlyMap<string, LocalEventCallback>,
): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  const visit = (candidate: ts.Node): void => {
    if (candidate !== node && ts.isFunctionLike(candidate)) return;
    if (ts.isCallExpression(candidate) && ts.isIdentifier(candidate.expression) && bindings.has(candidate.expression.text)) {
      calls.push(candidate);
    }
    if (ts.isCallExpression(candidate) && immediateCallbacks.has(callName(candidate) ?? "")) {
      const action = candidate.arguments[0];
      const callback = action && (ts.isArrowFunction(action) || ts.isFunctionExpression(action))
        ? action : action && ts.isIdentifier(action) ? localCallbacks.get(action.text) : undefined;
      if (callback?.body) visit(callback.body);
    }
    ts.forEachChild(candidate, visit);
  };
  visit(node);
  return calls;
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

function directEffects(
  node: ts.Node,
  declared: ReadonlyMap<string, string[]>,
  immediateCallbacks: ReadonlySet<string> = new Set(),
  localCallbacks: ReadonlyMap<string, LocalEventCallback> = new Map(),
  invokedCallbacks: ReadonlyMap<string, ts.ArrowFunction | ts.FunctionExpression> = new Map(),
): string[] {
  const effects: string[] = [];
  const activeCallbacks = new Set<ts.ArrowFunction | ts.FunctionExpression>();
  const visit = (current: ts.Node): void => {
    if (current !== node && ts.isFunctionLike(current)) return;
    if (ts.isCallExpression(current)) {
      effects.push(...effectsForCall(current, declared));
      if (immediateCallbacks.has(callName(current) ?? "")) {
        const action = current.arguments[0];
        const callback = action && (ts.isArrowFunction(action) || ts.isFunctionExpression(action))
          ? action : action && ts.isIdentifier(action) ? localCallbacks.get(action.text) : undefined;
        if (callback?.body) visit(callback.body);
      }
      if (ts.isIdentifier(current.expression)) {
        const callback = invokedCallbacks.get(current.expression.text);
        if (callback && !activeCallbacks.has(callback)) {
          activeCallbacks.add(callback);
          visit(callback.body);
          activeCallbacks.delete(callback);
        }
      }
    }
    if (ts.isBinaryExpression(current) && current.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && current.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      && (current.left.getText().startsWith("document.") || current.left.getText().startsWith("window."))) effects.push("DomWrite");
    ts.forEachChild(current, visit);
  };
  visit(node);
  return [...new Set(effects)];
}

function unknownImmediateActions(
  node: ts.Node,
  immediateCallbacks: ReadonlySet<string>,
  localCallbacks: ReadonlyMap<string, LocalEventCallback>,
): ts.Expression[] {
  const unknown: ts.Expression[] = [];
  const visit = (current: ts.Node): void => {
    if (current !== node && ts.isFunctionLike(current)) return;
    if (ts.isCallExpression(current) && immediateCallbacks.has(callName(current) ?? "")) {
      const action = current.arguments[0];
      const callback = action && (ts.isArrowFunction(action) || ts.isFunctionExpression(action))
        ? action : action && ts.isIdentifier(action) ? localCallbacks.get(action.text) : undefined;
      if (callback?.body) visit(callback.body);
      else if (action) unknown.push(action);
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return unknown;
}

const reactTransitionCallbackCache = new WeakMap<ComponentNode, ReadonlySet<string>>();

function reactTransitionCallbacks(source: ts.SourceFile, boundary: ComponentNode): ReadonlySet<string> {
  const cached = reactTransitionCallbackCache.get(boundary);
  if (cached) return cached;
  const callbacks = new Set<string>();
  for (const [local, imported] of reactImportNames(source)) if (imported === "startTransition") callbacks.add(local);
  for (const object of reactNamespaceImportNames(source)) callbacks.add(`${object}.startTransition`);
  const imports = reactImportNames(source), objects = reactNamespaceImportNames(source);
  const isUseTransition = (expression: ts.LeftHandSideExpression): boolean =>
    ts.isIdentifier(expression) ? imports.get(expression.text) === "useTransition"
      : ts.isPropertyAccessExpression(expression) && expression.name.text === "useTransition"
        && ts.isIdentifier(expression.expression) && objects.has(expression.expression.text);
  const visit = (node: ts.Node): void => {
    if (node !== boundary.body && ts.isFunctionLike(node)) return;
    if (ts.isVariableDeclaration(node) && ts.isArrayBindingPattern(node.name)
      && node.initializer && ts.isCallExpression(node.initializer) && isUseTransition(node.initializer.expression)) {
      const start = node.name.elements[1];
      if (start && !ts.isOmittedExpression(start)) for (const name of bindingNames(start.name)) callbacks.add(name);
    }
    ts.forEachChild(node, visit);
  };
  visit(boundary.body);
  reactTransitionCallbackCache.set(boundary, callbacks);
  return callbacks;
}

function returnedCleanup(callback: LocalEventCallback): ts.ArrowFunction | ts.FunctionExpression | undefined {
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

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current) || ts.isNonNullExpression(current)
    || ts.isSatisfiesExpression(current)) current = current.expression;
  return current;
}

function expressionRoot(expression: ts.Expression): string | undefined {
  let current = unwrapExpression(expression);
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) current = unwrapExpression(current.expression);
  return ts.isIdentifier(current) ? current.text : undefined;
}

const reactImportNameCache = new WeakMap<ts.SourceFile, ReadonlyMap<string, string>>();
const reactNamespaceImportCache = new WeakMap<ts.SourceFile, ReadonlySet<string>>();

function reactImportNames(source: ts.SourceFile): ReadonlyMap<string, string> {
  const cached = reactImportNameCache.get(source);
  if (cached) return cached;
  const imports = new Map<string, string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
      || statement.moduleSpecifier.text !== "react" || !statement.importClause?.namedBindings
      || !ts.isNamedImports(statement.importClause.namedBindings)) continue;
    for (const element of statement.importClause.namedBindings.elements) {
      imports.set(element.name.text, element.propertyName?.text ?? element.name.text);
    }
  }
  reactImportNameCache.set(source, imports);
  return imports;
}

function reactNamespaceImportNames(source: ts.SourceFile): ReadonlySet<string> {
  const cached = reactNamespaceImportCache.get(source);
  if (cached) return cached;
  const imports = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
      || statement.moduleSpecifier.text !== "react" || !statement.importClause) continue;
    if (statement.importClause.name) imports.add(statement.importClause.name.text);
    if (statement.importClause.namedBindings && ts.isNamespaceImport(statement.importClause.namedBindings)) {
      imports.add(statement.importClause.namedBindings.name.text);
    }
  }
  reactNamespaceImportCache.set(source, imports);
  return imports;
}

function isReactSuspenseTag(source: ts.SourceFile, tag: ts.JsxTagNameExpression): boolean {
  if (ts.isIdentifier(tag)) return reactImportNames(source).get(tag.text) === "Suspense";
  return ts.isPropertyAccessExpression(tag) && tag.name.text === "Suspense"
    && ts.isIdentifier(tag.expression) && reactNamespaceImportNames(source).has(tag.expression.text);
}

function isReactUseCall(source: ts.SourceFile, expression: ts.LeftHandSideExpression): boolean {
  if (ts.isIdentifier(expression)) return reactImportNames(source).get(expression.text) === "use";
  return ts.isPropertyAccessExpression(expression) && expression.name.text === "use"
    && ts.isIdentifier(expression.expression) && reactNamespaceImportNames(source).has(expression.expression.text);
}

/** Immutable render snapshots are distinct from stable identities such as setters and refs. */
const immutableSnapshotCache = new WeakMap<ComponentNode, ReadonlySet<string>>();

function immutableSnapshotBindings(boundary: ComponentNode, source: ts.SourceFile): ReadonlySet<string> {
  const cached = immutableSnapshotCache.get(boundary);
  if (cached) return cached;
  const immutable = new Set(boundary.parameters.flatMap((parameter) => bindingNames(parameter.name)));
  const imports = reactImportNames(source);
  const declarations: ts.VariableDeclaration[] = [];
  const collect = (node: ts.Node): void => {
    if (node !== boundary.body && ts.isFunctionLike(node)) return;
    if (ts.isVariableDeclaration(node)) declarations.push(node);
    ts.forEachChild(node, collect);
  };
  collect(boundary.body);

  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of declarations) {
      if (!ts.isVariableDeclarationList(declaration.parent)
        || (declaration.parent.flags & ts.NodeFlags.Const) === 0) continue;
      const names = bindingNames(declaration.name);
      const initializer = declaration.initializer && unwrapExpression(declaration.initializer);
      if (!initializer) continue;
      let snapshot = false;
      if (ts.isCallExpression(initializer) && ts.isIdentifier(initializer.expression)) {
        const imported = imports.get(initializer.expression.text);
        if (imported === "useContext") snapshot = true;
        if ((imported === "useState" || imported === "useReducer") && ts.isArrayBindingPattern(declaration.name)) {
          const value = declaration.name.elements[0];
          if (value && !ts.isOmittedExpression(value)) for (const name of bindingNames(value.name)) {
            if (!immutable.has(name)) { immutable.add(name); changed = true; }
          }
          continue;
        }
      }
      const root = expressionRoot(initializer);
      if (root && immutable.has(root)) snapshot = true;
      if (snapshot) for (const name of names) if (!immutable.has(name)) {
        immutable.add(name);
        changed = true;
      }
    }
  }
  immutableSnapshotCache.set(boundary, immutable);
  return immutable;
}

const renderRefBindingCache = new WeakMap<ComponentNode, ReadonlySet<string>>();

function renderRefBindings(boundary: ComponentNode, source: ts.SourceFile): ReadonlySet<string> {
  const cached = renderRefBindingCache.get(boundary);
  if (cached) return cached;
  const refs = new Set<string>();
  const imports = reactImportNames(source);
  const declarations: ts.VariableDeclaration[] = [];
  const collect = (node: ts.Node): void => {
    if (node !== boundary.body && ts.isFunctionLike(node)) return;
    if (ts.isVariableDeclaration(node)) declarations.push(node);
    ts.forEachChild(node, collect);
  };
  collect(boundary.body);
  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of declarations) {
      if (!ts.isVariableDeclarationList(declaration.parent)
        || (declaration.parent.flags & ts.NodeFlags.Const) === 0
        || !ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      const initializer = unwrapExpression(declaration.initializer);
      const directRef = ts.isCallExpression(initializer) && ts.isIdentifier(initializer.expression)
        && imports.get(initializer.expression.text) === "useRef";
      const alias = ts.isIdentifier(initializer) && refs.has(initializer.text);
      if ((directRef || alias) && !refs.has(declaration.name.text)) {
        refs.add(declaration.name.text);
        changed = true;
      }
    }
  }
  renderRefBindingCache.set(boundary, refs);
  return refs;
}

function refCurrentAccess(node: ts.Node, refs: ReadonlySet<string>): ts.Expression | undefined {
  if (ts.isPropertyAccessExpression(node) && node.name.text === "current") {
    const root = expressionRoot(node.expression);
    if (root && refs.has(root)) return node;
  }
  if (ts.isElementAccessExpression(node) && node.argumentExpression && ts.isStringLiteral(node.argumentExpression)
    && node.argumentExpression.text === "current") {
    const root = expressionRoot(node.expression);
    if (root && refs.has(root)) return node;
  }
  return undefined;
}

function mutationTarget(node: ts.Node): ts.Expression | undefined {
  if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
    && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) return node.left;
  if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
    && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) return node.operand;
  if (ts.isDeleteExpression(node)) return node.expression;
  return undefined;
}

function isImmutableSnapshotMutation(node: ts.Node, immutable: ReadonlySet<string>): node is ts.Node {
  const target = mutationTarget(node);
  if (!target || ts.isIdentifier(unwrapExpression(target))) return false;
  const root = expressionRoot(target);
  return root !== undefined && immutable.has(root);
}

interface InternalReactAnalysis {
  result: ReactSemanticsResult;
  hookSummaries: Map<string, CustomHookSummary>;
  hookNodes: Map<string, ComponentNode>;
}

interface DirectJsxComponentTag { displayName: string; location: ts.Identifier }

type DirectSuspensePrimary =
  | { kind: "component"; tag: DirectJsxComponentTag }
  | { kind: "boundary"; node: ts.JsxElement; instance: string };

function directJsxComponentTag(node: ts.Node | undefined): DirectJsxComponentTag | undefined {
  if (!node) return undefined;
  const expression = ts.isJsxExpression(node) ? node.expression : node;
  if (!expression) return undefined;
  const unwrapped = ts.isExpression(expression) ? unwrapExpression(expression) : expression;
  const tag = ts.isJsxElement(unwrapped)
    ? unwrapped.openingElement.tagName
    : ts.isJsxSelfClosingElement(unwrapped) ? unwrapped.tagName : undefined;
  if (tag && ts.isIdentifier(tag) && /^[A-Z]/u.test(tag.text)) return { displayName: tag.text, location: tag };
  if (tag && ts.isPropertyAccessExpression(tag) && ts.isIdentifier(tag.name) && /^[A-Z]/u.test(tag.name.text)) {
    return { displayName: tag.getText(tag.getSourceFile()), location: tag.name };
  }
  return undefined;
}

function directJsxComponentName(node: ts.Node | undefined): string | undefined {
  return directJsxComponentTag(node)?.displayName;
}

function isReactFragmentTag(source: ts.SourceFile, tag: ts.JsxTagNameExpression): boolean {
  if (ts.isIdentifier(tag)) return reactImportNames(source).get(tag.text) === "Fragment";
  return ts.isPropertyAccessExpression(tag) && tag.name.text === "Fragment"
    && ts.isIdentifier(tag.expression) && reactNamespaceImportNames(source).has(tag.expression.text);
}

function significantJsxChildren(children: readonly ts.JsxChild[]): ts.JsxChild[] {
  return children.filter((child) => !(ts.isJsxText(child) && child.text.trim() === "")
    && !(ts.isJsxExpression(child) && child.expression === undefined));
}

function directSuspensePrimaries(source: ts.SourceFile, children: readonly ts.JsxChild[]): DirectSuspensePrimary[] | undefined {
  const output: DirectSuspensePrimary[] = [];
  const collect = (child: ts.JsxChild): boolean => {
    if (ts.isJsxFragment(child)) return significantJsxChildren(child.children).every(collect);
    if (ts.isJsxElement(child) && isReactFragmentTag(source, child.openingElement.tagName)) {
      return significantJsxChildren(child.children).every(collect);
    }
    if (ts.isJsxElement(child) && isReactSuspenseTag(source, child.openingElement.tagName)) {
      output.push({ kind: "boundary", node: child, instance: `suspense@${child.getStart(source)}` });
      return true;
    }
    const tag = directJsxComponentTag(child);
    if (!tag) return false;
    output.push({ kind: "component", tag });
    return true;
  };
  return significantJsxChildren(children).every(collect) && output.length > 0 ? output : undefined;
}

function suspenseBoundaryFacts(
  source: ts.SourceFile,
  components: readonly ReactComponentSummary[],
): { boundaries: ReactSuspenseBoundarySummary[]; unsupported: ReactUnsupportedSuspenseBoundary[] } {
  const componentNames = new Set(components.map(({ name }) => name));
  const boundaries: ReactSuspenseBoundarySummary[] = [];
  const unsupported: ReactUnsupportedSuspenseBoundary[] = [];
  const parents = new WeakMap<ts.JsxElement, string>();
  const visit = (node: ts.Node): void => {
    if (ts.isJsxElement(node) && isReactSuspenseTag(source, node.openingElement.tagName)) {
      const instance = `suspense@${node.getStart(source)}`;
      const span = { start: node.getStart(source), end: node.getEnd() };
      const fail = (reason: ReactUnsupportedSuspenseBoundaryReason): void => { unsupported.push({ instance, reason, span }); };
      const fallbackAttribute = node.openingElement.attributes.properties.find(
        (attribute): attribute is ts.JsxAttribute => ts.isJsxAttribute(attribute)
          && ts.isIdentifier(attribute.name) && attribute.name.text === "fallback",
      );
      if (!fallbackAttribute?.initializer) fail("missing-fallback");
      else {
        const fallback = directJsxComponentName(fallbackAttribute.initializer);
        const primaries = directSuspensePrimaries(source, node.children);
        for (const primary of primaries ?? []) if (primary.kind === "boundary") parents.set(primary.node, instance);
        const primaryNodes: ReactSuspensePrimaryNode[] | undefined = primaries?.map((primary) => primary.kind === "boundary"
          ? { kind: "boundary", instance: primary.instance }
          : { kind: "component", displayName: primary.tag.displayName, componentKey: `${source.fileName}:${primary.tag.displayName}` });
        const singleton = primaryNodes?.length === 1 ? primaryNodes[0] : undefined;
        const primaryBoundary = singleton?.kind === "boundary" ? singleton.instance : undefined;
        const primary = singleton?.kind === "component" ? singleton.displayName : primaryBoundary ?? `tree@${instance}`;
        if (!fallback) fail("fallback-must-be-one-direct-component");
        else if (!primaryNodes) fail("primary-must-be-one-direct-component");
        else if (primaryNodes.some((item) => item.kind === "component" && !componentNames.has(item.displayName))) fail("unannotated-primary");
        else if (!componentNames.has(fallback)) fail("unannotated-fallback");
        else boundaries.push({
          instance, primary, fallback,
          primaryKey: primaryBoundary ? `boundary:${primaryBoundary}`
            : singleton?.kind === "component" ? singleton.componentKey : `tree:${instance}`,
          fallbackKey: `${source.fileName}:${fallback}`,
          ...(primaryBoundary ? { primaryBoundary } : {}),
          ...(parents.get(node) ? { parentBoundary: parents.get(node)! } : {}),
          primaryNodes,
          span,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { boundaries, unsupported };
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
    const phases = new Map<ReactPhase, Set<string>>([["render", new Set()]]), instances: CommitInstanceSummary[] = [];
    const leaked: CustomHookSummary["leaked"] = [];
    const lifecycleIssues: CustomHookSummary["lifecycleIssues"] = [];
    const suspensions: ReactSuspensionSource[] = [];
    const hook = customHooks.get(hookName);
    if (!hook || stack.has(hookName)) return { phases, instances, leaked, lifecycleIssues, suspensions };
    const transitionCallbacks = reactTransitionCallbacks(source, hook);
    const localCallbacks = localEventCallbacks(hook);
    const callableCallbacks = new Map([...sourceCallbacks(source), ...localCallbacks]);
    const effectEvents = localEffectEventCallbacks(hook, source);
    const nextStack = new Set(stack).add(hookName);
    const add = (phase: ReactPhase, effects: readonly string[]): void => {
      const target = phases.get(phase) ?? new Set<string>();
      for (const effect of effects) target.add(effect);
      phases.set(phase, target);
    };
    const visit = (node: ts.Node): void => {
      if (node !== hook.body && ts.isFunctionLike(node)) return;
      if (ts.isThrowStatement(node) && node.expression) suspensions.push({
        kind: "throw-thenable", certainty: "unknown", fileName,
        expression: node.expression.getText(source), span: { start: node.getStart(source), end: node.getEnd() },
      });
      if (ts.isCallExpression(node)) {
        if (transitionCallbacks.has(callName(node) ?? "")) {
          const action = node.arguments[0];
          const callback = action && (ts.isArrowFunction(action) || ts.isFunctionExpression(action))
            ? action : action && ts.isIdentifier(action) ? localCallbacks.get(action.text) : undefined;
          if (callback?.body) visit(callback.body);
        }
        if (isReactUseCall(source, node.expression)) {
          const argument = node.arguments[0];
          suspensions.push({
            kind: "react-use", certainty: "unknown", fileName,
            expression: argument?.getText(source) ?? "<missing>",
            span: { start: node.getStart(source), end: node.getEnd() },
          });
        }
        if (isUseSyncExternalStoreCall(source, node.expression)) {
          const subscribe = callbackArgument(node.arguments[0], callableCallbacks);
          const snapshot = callbackArgument(node.arguments[1], callableCallbacks);
          const serverSnapshot = callbackArgument(node.arguments[2], callableCallbacks);
          if (snapshot) add("external-store-snapshot", directEffects(snapshot.body, declared, transitionCallbacks, localCallbacks));
          if (serverSnapshot) add("server-snapshot", directEffects(serverSnapshot.body, declared, transitionCallbacks, localCallbacks));
          if (subscribe) {
            const setupEffects = directEffects(subscribe.body, declared, transitionCallbacks, localCallbacks);
            const cleanup = returnedCleanup(subscribe);
            const cleanupEffects = cleanup ? directEffects(cleanup.body, declared, transitionCallbacks, localCallbacks) : [];
            const lifecycle = lifecycleSummary(subscribe, cleanup, acquisitions, releases);
            const acquired = lifecycle.acquired.map((capability) => `Acquire<${capability}>`);
            const released = lifecycle.released.map((capability) => `Release<${capability}>`);
            add("external-store-subscribe", [...setupEffects, ...acquired]);
            if (cleanup) add("cleanup", cleanupEffects);
            add("cleanup", released);
            instances.push(commitInstance("external-store-subscribe", node, [...setupEffects, ...acquired], [...cleanupEffects, ...released]));
            if (lifecycle.missing.length > 0) leaked.push({ phase: "external-store-subscribe", capabilities: lifecycle.missing });
            lifecycleIssues.push(...lifecycle.issues.map((issue) => ({ ...issue, phase: "external-store-subscribe" as const })));
          }
          return;
        }
        const called = callName(node), builtinPhase = called ? hooks.get(called) : undefined;
        if (builtinPhase) {
          if (builtinPhase === "render-hook") {
            const callback = inlineCallback(node, called ? renderCallbacks.get(called) : undefined);
            if (callback) add("render", directEffects(callback.body, declared, transitionCallbacks, localCallbacks));
            return;
          }
          const callback = node.arguments[0];
          if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
            const setupEffects = directEffects(callback.body, declared, transitionCallbacks, localCallbacks, effectEvents);
            add(builtinPhase, setupEffects);
            const cleanup = returnedCleanup(callback);
            const cleanupEffects = cleanup ? directEffects(cleanup.body, declared, transitionCallbacks, localCallbacks, effectEvents) : [];
            if (cleanup) add("cleanup", cleanupEffects);
            const lifecycle = lifecycleSummary(callback, cleanup, acquisitions, releases);
            const acquired = lifecycle.acquired.map((capability) => `Acquire<${capability}>`);
            const released = lifecycle.released.map((capability) => `Release<${capability}>`);
            add(builtinPhase, acquired);
            add("cleanup", released);
            instances.push(commitInstance(builtinPhase, node, [...setupEffects, ...acquired], [...cleanupEffects, ...released]));
            if (lifecycle.missing.length > 0) leaked.push({ phase: builtinPhase, capabilities: lifecycle.missing });
            lifecycleIssues.push(...lifecycle.issues.map((issue) => ({ ...issue, phase: builtinPhase })));
          } else {
            add(builtinPhase, []);
            instances.push(commitInstance(builtinPhase, node, [], []));
          }
          return;
        }
        if (called && (customHooks.has(called) || externalHooks.has(called))) {
          const child = summarizeCustomHook(called, nextStack);
          for (const [phase, effects] of child.phases) add(phase, [...effects]);
          instances.push(...child.instances.map((instance) => ({
            ...instance, instance: `${called}@${node.getStart(source)}/${instance.instance}`,
          })));
          leaked.push(...child.leaked);
          lifecycleIssues.push(...child.lifecycleIssues);
          suspensions.push(...child.suspensions);
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
    const summary = { phases, instances, leaked, lifecycleIssues, suspensions };
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
    const immutableSnapshots = immutableSnapshotBindings(hook, source);
    const refs = renderRefBindings(hook, source);
    const stateUpdaters = stateUpdaterBindings(hook, source);
    const effectEvents = localEffectEventCallbacks(hook, source);
    const callableCallbacks = new Map([...sourceCallbacks(source), ...localEventCallbacks(hook)]);
    const visitHookRender = (node: ts.Node): void => {
      if (node !== hook.body && ts.isFunctionLike(node)) return;
      if (ts.isCallExpression(node)) {
        if (isUseSyncExternalStoreCall(source, node.expression)) {
          const phases: ReactPhase[] = ["external-store-subscribe", "external-store-snapshot", "server-snapshot"];
          for (const [index, phase] of phases.entries()) {
            const argument = node.arguments[index];
            if (index === 2 && !argument) continue;
            if (!callbackArgument(argument, callableCallbacks)) reportHook(argument ?? node, {
              kind: "unknown-external-store-callback", phase,
              operation: argument?.getText(source) ?? `<argument ${index}>`,
              message: `useSyncExternalStore argument ${index} is not an inline, module-local, or immutable Hook-local callback`,
            });
          }
          const snapshot = callbackArgument(node.arguments[1], callableCallbacks);
          const fresh = snapshot && returnsFreshSnapshot(snapshot);
          if (fresh) reportHook(fresh, {
            kind: "uncached-external-store-snapshot", phase: "external-store-snapshot",
            operation: fresh.getText(source),
            message: "getSnapshot creates a fresh object or array on every read instead of returning a cached immutable snapshot",
          });
          const subscribe = callbackArgument(node.arguments[0], callableCallbacks);
          if (subscribe && !returnedCleanup(subscribe)) reportHook(node.arguments[0]!, {
            kind: "missing-external-store-cleanup", phase: "external-store-subscribe",
            operation: node.arguments[0]!.getText(source),
            message: "useSyncExternalStore subscribe must return an unsubscribe cleanup function",
          });
          if (isConditionalWithin(node, hook)) reportHook(node, {
            kind: "conditional-hook", phase: "render", hook: callName(node),
            message: `${callName(node)} has control-flow-dependent call order`,
          });
          return;
        }
        const called = callName(node), builtinHook = called ? hooks.has(called) : false, customHook = called ? customHooks.has(called) || externalHooks.has(called) : false;
        if (ts.isIdentifier(node.expression) && effectEvents.has(node.expression.text)) {
          reportHook(node, {
            kind: "invalid-effect-event-call", phase: "render", operation: node.expression.text,
            message: `${node.expression.text} is an Effect Event and may only be called from an Effect`,
          });
          return;
        }
        if (builtinHook || customHook) {
          const dependencyHook = called ? dependencyHooks.get(called) : undefined;
          if (called && dependencyHook) for (const issue of dependencyIssues(node, called, dependencyHook, hook, source)) reportHook(issue.node, {
            kind: issue.kind, phase: dependencyHook.phase, hook: called, operation: issue.operation, dependencies: issue.dependencies, message: issue.detail,
          });
          if (dependencyHook?.phase === "insertion-effect") {
            const callback = node.arguments[dependencyHook.callback];
            if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
              const cleanup = returnedCleanup(callback);
              for (const body of cleanup ? [callback.body, cleanup.body] : [callback.body]) {
                for (const update of stateUpdates(body, stateUpdaters)) reportHook(update, {
                  kind: "insertion-effect-state-update", phase: "insertion-effect",
                  operation: update.expression.getText(source),
                  message: "React forbids scheduling state updates from useInsertionEffect setup or cleanup",
                });
                for (const access of refAccesses(body, refs)) reportHook(access, {
                  kind: "insertion-effect-ref-access", phase: "insertion-effect",
                  operation: access.getText(source),
                  message: "React refs are not attached while useInsertionEffect runs",
                });
              }
            }
          }
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
      if (isImmutableSnapshotMutation(node, immutableSnapshots)) reportHook(node, {
        kind: "immutable-input-mutation", phase: "render", operation: mutationTarget(node)!.getText(source),
        message: "React Hook inputs, state, and context are immutable render snapshots",
      });
      const refAccess = refCurrentAccess(node, refs);
      if (refAccess) reportHook(refAccess, {
        kind: "render-ref-access", phase: "render", operation: refAccess.getText(source),
        message: `${refAccess.getText(source)} is read or written during replayable custom Hook render`,
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
    const instances: CommitInstanceSummary[] = [];
    const suspensions: ReactSuspensionSource[] = [];
    const addPhase = (phase: ReactPhase, effects: readonly string[] = []): void => {
      const target = phaseEffects.get(phase) ?? new Set<string>();
      for (const effect of effects) target.add(effect);
      phaseEffects.set(phase, target);
    };
    const report = (node: ts.Node, diagnostic: Omit<ReactSemanticDiagnostic, "fileName" | "component" | "functionName" | "severity" | "line">): void => {
      diagnostics.push({ fileName, component: name, functionName: name, severity: "error", line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, ...diagnostic });
    };
    const immutableSnapshots = immutableSnapshotBindings(component, source);
    const refs = renderRefBindings(component, source);
    const stateUpdaters = stateUpdaterBindings(component, source);
    const eventCallbacks = localEventCallbacks(component);
    const callableCallbacks = new Map([...sourceCallbacks(source), ...eventCallbacks]);
    const effectEvents = localEffectEventCallbacks(component, source);
    const transitionCallbacks = reactTransitionCallbacks(source, component);
    const visitRender = (node: ts.Node): void => {
      if (node !== component.body && ts.isFunctionLike(node)) return;
      if (ts.isThrowStatement(node) && node.expression) suspensions.push({
        kind: "throw-thenable", certainty: "unknown", fileName,
        expression: node.expression.getText(source), span: { start: node.getStart(source), end: node.getEnd() },
      });
      if (ts.isJsxAttribute(node) && node.name.getText(source) === "ref") {
        const callback = node.initializer && ts.isJsxExpression(node.initializer)
          ? node.initializer.expression : undefined;
        if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
          const setupEffects = directEffects(callback.body, declared, transitionCallbacks, eventCallbacks);
          addPhase("ref-callback", setupEffects);
          const cleanup = returnedCleanup(callback);
          const cleanupEffects = cleanup ? directEffects(cleanup.body, declared, transitionCallbacks, eventCallbacks) : [];
          if (cleanup) addPhase("cleanup", cleanupEffects);
          const lifecycle = lifecycleSummary(callback, cleanup, acquisitions, releases);
          const acquired = lifecycle.acquired.map((capability) => `Acquire<${capability}>`);
          const released = lifecycle.released.map((capability) => `Release<${capability}>`);
          addPhase("ref-callback", acquired);
          addPhase("cleanup", released);
          instances.push(commitInstance("ref-callback", node, [...setupEffects, ...acquired], [...cleanupEffects, ...released]));
          if (lifecycle.missing.length > 0) report(node, {
            kind: "missing-effect-cleanup", phase: "ref-callback", effect: lifecycle.missing.join(" | "),
            message: `callback ref acquires ${lifecycle.missing.join(", ")} without a matching returned cleanup release`,
          });
          for (const issue of lifecycle.issues) report(issue.node, {
            kind: issue.kind, phase: "ref-callback", effect: issue.capability, message: issue.detail,
          });
        } else if (!(callback && ts.isIdentifier(callback) && refs.has(callback.text))
          && callback?.kind !== ts.SyntaxKind.NullKeyword) {
          const operation = callback?.getText(source) ?? node.initializer?.getText(source) ?? "ref";
          report(callback ?? node, {
            kind: "unknown-ref-callback", phase: "ref-callback", operation,
            message: `${operation} is not an inline callback ref or a locally resolved object ref`,
          });
        }
        return;
      }
      if (ts.isJsxAttribute(node) && node.name.getText(source).startsWith("on") && node.initializer && ts.isJsxExpression(node.initializer)) {
        const expression = node.initializer.expression;
        const reportUnknownAction = (action: ts.Expression): void => report(action, {
          kind: "unknown-transition-action", phase: "event", operation: action.getText(source),
          message: `${action.getText(source)} is not an inline or immutable locally resolved transition action`,
        });
        if (expression && (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression))) {
          addPhase("event", directEffects(expression.body, declared, transitionCallbacks, eventCallbacks));
          for (const action of unknownImmediateActions(expression.body, transitionCallbacks, eventCallbacks)) reportUnknownAction(action);
          for (const call of effectEventCallsInPhase(expression.body, effectEvents, transitionCallbacks, eventCallbacks)) report(call, {
            kind: "invalid-effect-event-call", phase: "event", operation: call.expression.getText(source),
            message: `${call.expression.getText(source)} is an Effect Event and may only be called from an Effect`,
          });
        }
        else if (expression && ts.isIdentifier(expression)) {
          if (effectEvents.has(expression.text)) {
            report(expression, {
              kind: "invalid-effect-event-call", phase: "event", operation: expression.text,
              message: `${expression.text} is an Effect Event and cannot be used as a JSX event handler`,
            });
            return;
          }
          const callback = eventCallbacks.get(expression.text);
          if (callback?.body) {
            addPhase("event", directEffects(callback.body, declared, transitionCallbacks, eventCallbacks));
            for (const action of unknownImmediateActions(callback.body, transitionCallbacks, eventCallbacks)) reportUnknownAction(action);
            for (const call of effectEventCallsInPhase(callback.body, effectEvents, transitionCallbacks, eventCallbacks)) report(call, {
              kind: "invalid-effect-event-call", phase: "event", operation: call.expression.getText(source),
              message: `${call.expression.getText(source)} is an Effect Event and may only be called from an Effect`,
            });
          }
          else report(expression, {
            kind: "unknown-event-handler", phase: "event", operation: expression.text,
            message: `${expression.text} is not an immutable locally resolved event callback`,
          });
        } else if (expression) {
          report(expression, {
            kind: "unknown-event-handler", phase: "event", operation: expression.getText(source),
            message: `${expression.getText(source)} is not an inline or immutable locally resolved event callback`,
          });
        }
        return;
      }
      if (ts.isCallExpression(node)) {
        if (ts.isIdentifier(node.expression) && effectEvents.has(node.expression.text)) {
          report(node, {
            kind: "invalid-effect-event-call", phase: "render", operation: node.expression.text,
            message: `${node.expression.text} is an Effect Event and may only be called from an Effect`,
          });
          return;
        }
        if (isUseSyncExternalStoreCall(source, node.expression)) {
          const subscribe = callbackArgument(node.arguments[0], callableCallbacks);
          const snapshot = callbackArgument(node.arguments[1], callableCallbacks);
          const serverSnapshot = callbackArgument(node.arguments[2], callableCallbacks);
          const callbackPhases: ReactPhase[] = ["external-store-subscribe", "external-store-snapshot", "server-snapshot"];
          for (const [index, phase] of callbackPhases.entries()) {
            const argument = node.arguments[index];
            if (index === 2 && !argument) continue;
            if (!callbackArgument(argument, callableCallbacks)) report(argument ?? node, {
              kind: "unknown-external-store-callback", phase,
              operation: argument?.getText(source) ?? `<argument ${index}>`,
              message: `useSyncExternalStore argument ${index} is not an inline, module-local, or immutable component-local callback`,
            });
          }
          if (snapshot) {
            addPhase("external-store-snapshot", directEffects(snapshot.body, declared, transitionCallbacks, eventCallbacks));
            const fresh = returnsFreshSnapshot(snapshot);
            if (fresh) report(fresh, {
              kind: "uncached-external-store-snapshot", phase: "external-store-snapshot",
              operation: fresh.getText(source),
              message: "getSnapshot creates a fresh object or array on every read instead of returning a cached immutable snapshot",
            });
          }
          if (serverSnapshot) addPhase("server-snapshot", directEffects(serverSnapshot.body, declared, transitionCallbacks, eventCallbacks));
          if (subscribe) {
            const setupEffects = directEffects(subscribe.body, declared, transitionCallbacks, eventCallbacks);
            const cleanup = returnedCleanup(subscribe);
            if (!cleanup) report(node.arguments[0]!, {
              kind: "missing-external-store-cleanup", phase: "external-store-subscribe",
              operation: node.arguments[0]!.getText(source),
              message: "useSyncExternalStore subscribe must return an unsubscribe cleanup function",
            });
            const cleanupEffects = cleanup ? directEffects(cleanup.body, declared, transitionCallbacks, eventCallbacks) : [];
            const lifecycle = lifecycleSummary(subscribe, cleanup, acquisitions, releases);
            const acquired = lifecycle.acquired.map((capability) => `Acquire<${capability}>`);
            const released = lifecycle.released.map((capability) => `Release<${capability}>`);
            addPhase("external-store-subscribe", [...setupEffects, ...acquired]);
            if (cleanup) addPhase("cleanup", cleanupEffects);
            addPhase("cleanup", released);
            instances.push(commitInstance("external-store-subscribe", node, [...setupEffects, ...acquired], [...cleanupEffects, ...released]));
            if (lifecycle.missing.length > 0) report(node, {
              kind: "missing-effect-cleanup", phase: "external-store-subscribe",
              effect: lifecycle.missing.join(" | "), message: `external store subscription acquires ${lifecycle.missing.join(", ")} without a matching cleanup release`,
            });
            for (const issue of lifecycle.issues) report(issue.node, {
              kind: issue.kind, phase: "external-store-subscribe", effect: issue.capability, message: issue.detail,
            });
          }
          if (isConditionalWithin(node, component)) report(node, {
            kind: "conditional-hook", phase: "render", hook: callName(node),
            message: `${callName(node)} has control-flow-dependent call order`,
          });
          return;
        }
        if (transitionCallbacks.has(callName(node) ?? "")) {
          const action = node.arguments[0];
          const callback = action && (ts.isArrowFunction(action) || ts.isFunctionExpression(action))
            ? action : action && ts.isIdentifier(action) ? eventCallbacks.get(action.text) : undefined;
          if (callback?.body) visitRender(callback.body);
          else if (action) report(action, {
            kind: "unknown-transition-action", phase: "render", operation: action.getText(source),
            message: `${action.getText(source)} is not an inline or immutable locally resolved transition action`,
          });
        }
        if (isReactUseCall(source, node.expression)) {
          const argument = node.arguments[0];
          suspensions.push({
            kind: "react-use", certainty: "unknown", fileName, expression: argument?.getText(source) ?? "<missing>",
            span: { start: node.getStart(source), end: node.getEnd() },
          });
        }
        const called = callName(node), hookPhase = called ? hooks.get(called) : undefined;
        const customHook = called ? customHookCache.get(called) : undefined;
        if (customHook) {
          if (isConditionalWithin(node, component)) report(node, { kind: "conditional-hook", phase: "render", hook: called, message: `${called} has control-flow-dependent call order` });
          for (const [phase, effects] of customHook.phases) {
            addPhase(phase, [...effects]);
            if (phase === "render") for (const effect of effects) report(node, { kind: "render-effect", phase, effect, message: `${effect} is observable during render through ${called}` });
          }
          instances.push(...customHook.instances.map((instance) => ({
            ...instance, instance: `${called}@${node.getStart(source)}/${instance.instance}`,
          })));
          for (const leak of customHook.leaked) report(node, {
            kind: "missing-effect-cleanup", phase: leak.phase, effect: leak.capabilities.join(" | "),
            message: `${called} acquires ${leak.capabilities.join(", ")} without a matching cleanup release`,
          });
          suspensions.push(...customHook.suspensions);
          return;
        }
        if (hookPhase) {
          const dependencyHook = called ? dependencyHooks.get(called) : undefined;
          if (called && dependencyHook) for (const issue of dependencyIssues(node, called, dependencyHook, component, source)) report(issue.node, {
            kind: issue.kind, phase: dependencyHook.phase, hook: called, operation: issue.operation, dependencies: issue.dependencies, message: issue.detail,
          });
          if (dependencyHook?.phase === "insertion-effect") {
            const callback = node.arguments[dependencyHook.callback];
            if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
              const cleanup = returnedCleanup(callback);
              for (const body of cleanup ? [callback.body, cleanup.body] : [callback.body]) {
                for (const update of stateUpdates(body, stateUpdaters)) report(update, {
                  kind: "insertion-effect-state-update", phase: "insertion-effect",
                  operation: update.expression.getText(source),
                  message: "React forbids scheduling state updates from useInsertionEffect setup or cleanup",
                });
                for (const access of refAccesses(body, refs)) report(access, {
                  kind: "insertion-effect-ref-access", phase: "insertion-effect",
                  operation: access.getText(source),
                  message: "React refs are not attached while useInsertionEffect runs",
                });
              }
            }
          }
          if (isConditionalWithin(node, component)) report(node, { kind: "conditional-hook", phase: "render", hook: called, message: `${called} has control-flow-dependent call order` });
          if (hookPhase === "render-hook") {
            addPhase("render");
            const callback = called ? inlineCallback(node, renderCallbacks.get(called)) : undefined;
            if (callback) visitRender(callback.body);
            return;
          }
          const callback = node.arguments[0];
          if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
            const setupEffects = directEffects(callback.body, declared, transitionCallbacks, eventCallbacks, effectEvents);
            addPhase(hookPhase, setupEffects);
            const cleanup = returnedCleanup(callback);
            const cleanupEffects = cleanup ? directEffects(cleanup.body, declared, transitionCallbacks, eventCallbacks, effectEvents) : [];
            if (cleanup) addPhase("cleanup", cleanupEffects);
            const lifecycle = lifecycleSummary(callback, cleanup, acquisitions, releases);
            const acquired = lifecycle.acquired.map((capability) => `Acquire<${capability}>`);
            const released = lifecycle.released.map((capability) => `Release<${capability}>`);
            addPhase(hookPhase, acquired);
            addPhase("cleanup", released);
            instances.push(commitInstance(hookPhase, node, [...setupEffects, ...acquired], [...cleanupEffects, ...released]));
            if (lifecycle.missing.length > 0) report(node, {
              kind: "missing-effect-cleanup", phase: hookPhase,
              effect: lifecycle.missing.join(" | "), message: `Effect acquires ${lifecycle.missing.join(", ")} without a matching cleanup release`,
            });
            for (const issue of lifecycle.issues) report(issue.node, {
              kind: issue.kind, phase: hookPhase, effect: issue.capability, message: issue.detail,
            });
          } else {
            addPhase(hookPhase);
            instances.push(commitInstance(hookPhase, node, [], []));
          }
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
      if (isImmutableSnapshotMutation(node, immutableSnapshots)) report(node, {
        kind: "immutable-input-mutation", phase: "render", operation: mutationTarget(node)!.getText(source),
        message: "React component inputs, state, and context are immutable render snapshots",
      });
      const refAccess = refCurrentAccess(node, refs);
      if (refAccess) report(refAccess, {
        kind: "render-ref-access", phase: "render", operation: refAccess.getText(source),
        message: `${refAccess.getText(source)} is read or written during replayable render`,
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
      replay: replayModel(instances),
      suspensions,
    });
  }
  const publicHooks = [...customHooks.keys()].map((name): ReactHookSummary => {
    const node = customHooks.get(name)!, summary = customHookCache.get(name)!;
    return {
      name, span: { start: node.getStart(source), end: node.getEnd() },
      phases: [...summary.phases].map(([phase, effects]) => ({ phase, effects: [...effects] })),
      replay: replayModel(summary.instances),
      suspensions: [...summary.suspensions],
    };
  });
  const suspense = suspenseBoundaryFacts(source, components);
  return {
    result: { components, hooks: publicHooks, diagnostics, suspenseBoundaries: suspense.boundaries, unsupportedSuspenseBoundaries: suspense.unsupported },
    hookSummaries: customHookCache,
    hookNodes: customHooks,
  };
}

/** Analyze one source string without requiring React at runtime. */
export function analyzeReactSemantics(fileName: string, text: string): ReactSemanticsResult {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  return analyzeReactSource(source).result;
}

export type ReactLifecycleScenario = keyof ReactReplayModel;

/** Generate an instance-preserving bounded lifecycle model without imposing an order between commit instances. */
export function generateReactLifecycleQuint(
  moduleName: string,
  component: ReactComponentSummary,
  scenario: ReactLifecycleScenario = "strictModeDevelopment",
  options: { allowCleanupBeforeSetup?: boolean; allowCommitEffectsWithoutCommit?: boolean; allowSetupFromWrongCommit?: boolean; allowRetryBeforeResolution?: boolean } = {},
): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(moduleName)) throw new Error(`invalid Quint module name: ${moduleName}`);
  const replay = component.replay[scenario];
  if (replay.renderInvocations !== replay.renderAttempts.length) {
    throw new Error(`renderInvocations ${replay.renderInvocations} does not match ${replay.renderAttempts.length} render attempts`);
  }
  for (const attempt of replay.renderAttempts) {
    if (attempt.outcome === "committed" && !attempt.commit) throw new Error(`committed render ${attempt.instance} has no commit generation`);
    if (attempt.outcome !== "committed" && attempt.commit) throw new Error(`${attempt.outcome} render ${attempt.instance} cannot create commit generation ${attempt.commit}`);
    if (attempt.outcome === "suspended" && !attempt.suspension) throw new Error(`suspended render ${attempt.instance} has no suspension identity`);
    if (attempt.outcome !== "suspended" && attempt.suspension) throw new Error(`${attempt.outcome} render ${attempt.instance} cannot create suspension ${attempt.suspension}`);
    if (attempt.retryOf && attempt.outcome === "discarded") throw new Error(`discarded render ${attempt.instance} cannot retry suspension ${attempt.retryOf}`);
  }
  const commitIds = [...new Set(replay.renderAttempts.flatMap(({ commit }) => commit ? [commit] : []))];
  const suspensionIds = [...new Set(replay.renderAttempts.flatMap(({ suspension }) => suspension ? [suspension] : []))];
  for (const [index, attempt] of replay.renderAttempts.entries()) {
    if (!attempt.retryOf) continue;
    const suspendedAt = replay.renderAttempts.findIndex(({ suspension }) => suspension === attempt.retryOf);
    if (suspendedAt < 0) throw new Error(`retry render ${attempt.instance} refers to unknown suspension ${attempt.retryOf}`);
    if (suspendedAt >= index) throw new Error(`retry render ${attempt.instance} precedes suspension ${attempt.retryOf}`);
  }
  for (const effect of replay.effects) {
    if (effect.transitions.length !== effect.lifecycle.length
      || effect.transitions.some((transition, index) => transition !== effect.lifecycle[index]!.transition)) {
      throw new Error(`effect ${effect.instance} transitions do not match lifecycle steps`);
    }
    for (const step of effect.lifecycle) {
      if (!commitIds.includes(step.commit)) throw new Error(`effect ${effect.instance} refers to uncommitted generation ${step.commit}`);
    }
  }
  const commitVariables = new Map(commitIds.map((commit, index) => [commit, `commit_generation_${index}`]));
  const suspensionVariables = new Map(suspensionIds.map((suspension, index) => [suspension, {
    suspended: `suspension_${index}`,
    resolved: `resolved_suspension_${index}`,
  }]));
  const variables = [
    "render_attempt_count", "committed_render_count", "discarded_render_count", "suspended_render_count",
    ...commitVariables.values(),
    ...[...suspensionVariables.values()].flatMap(({ suspended, resolved }) => [suspended, resolved]),
    ...replay.effects.flatMap((_effect, index) => [`setup_${index}`, `cleanup_${index}`]),
  ];
  const lines = [`module ${moduleName} {`, ...variables.map((name) => `  var ${name}: int`), "", "  action init = all {"];
  for (const name of variables) lines.push(`    ${name}' = 0,`);
  lines.push("  }");
  const action = (name: string, guards: readonly string[], updates: ReadonlyMap<string, string>, comments: readonly string[] = []): void => {
    lines.push("", ...comments.map((comment) => `  // ${comment.replaceAll(/[\r\n]/gu, " ")}`), `  action ${name} = all {`);
    for (const guard of guards) lines.push(`    ${guard},`);
    for (const variable of variables) lines.push(`    ${variable}' = ${updates.get(variable) ?? variable},`);
    lines.push("  }");
  };
  for (const [suspension, state] of suspensionVariables) {
    action(
      `resolve_suspension_${suspensionIds.indexOf(suspension)}`,
      [`${state.suspended} == 1`, `${state.resolved} == 0`],
      new Map([[state.resolved, "1"]]),
      [`suspension: ${suspension}`],
    );
  }
  replay.renderAttempts.forEach((attempt, index) => {
    const committed = attempt.outcome === "committed";
    const commitVariable = attempt.commit ? commitVariables.get(attempt.commit) : undefined;
    if (committed && !commitVariable) throw new Error(`committed render ${attempt.instance} has no commit generation`);
    const outcomeVariable = attempt.outcome === "committed"
      ? "committed_render_count"
      : attempt.outcome === "suspended" ? "suspended_render_count" : "discarded_render_count";
    const updates = new Map([
      ["render_attempt_count", "render_attempt_count + 1"],
      [outcomeVariable, `${outcomeVariable} + 1`],
    ]);
    if (commitVariable) updates.set(commitVariable, "1");
    if (attempt.suspension) updates.set(suspensionVariables.get(attempt.suspension)!.suspended, "1");
    const guards = [`render_attempt_count == ${index}`];
    if (attempt.retryOf) guards.push(`${suspensionVariables.get(attempt.retryOf)!.resolved} == 1`);
    const actionVerb = committed ? "commit" : attempt.outcome === "suspended" ? "suspend" : "discard";
    action(
      `${actionVerb}_render_${index}`,
      guards,
      updates,
      [`instance: ${attempt.instance}`, `outcome: ${attempt.outcome}${attempt.reason ? ` (${attempt.reason})` : ""}${attempt.commit ? `; generation: ${attempt.commit}` : ""}`],
    );
    if (options.allowRetryBeforeResolution && attempt.retryOf) {
      const suspension = suspensionVariables.get(attempt.retryOf)!;
      const earlyUpdates = new Map([
        ["render_attempt_count", "render_attempt_count + 1"],
        [outcomeVariable, `${outcomeVariable} + 1`],
      ]);
      if (commitVariable) earlyUpdates.set(commitVariable, "1");
      if (attempt.suspension) earlyUpdates.set(suspensionVariables.get(attempt.suspension)!.suspended, "1");
      action(
        `retry_render_${index}_before_resolution`,
        [`render_attempt_count == ${index}`, `${suspension.suspended} == 1`, `${suspension.resolved} == 0`],
        earlyUpdates,
      );
    }
  });
  const lifecycleActions: string[][] = replay.effects.map(() => []);
  replay.effects.forEach((effect, index) => {
    const comment = [
      `instance: ${effect.instance}`,
      `phase: ${effect.phase}`,
      `setup effects: ${effect.setupEffects.join(" | ") || "none"}`,
      `cleanup effects: ${effect.cleanupEffects.join(" | ") || "none"}`,
    ];
    let setupCount = 0, cleanupCount = 0;
    effect.lifecycle.forEach((step, stepIndex) => {
      const commitVariable = commitVariables.get(step.commit);
      if (!commitVariable) throw new Error(`lifecycle step refers to unknown commit generation: ${step.commit}`);
      const isSetup = step.transition === "setup";
      if (isSetup) setupCount += 1;
      else cleanupCount += 1;
      const name = stepIndex === 0 && isSetup
        ? `setup_${index}_initial`
        : scenario === "strictModeDevelopment"
          ? `${step.transition}_${index}_strict_replay`
          : `${step.transition}_${index}_commit_${commitIds.indexOf(step.commit)}`;
      const guards = isSetup
        ? [`${commitVariable} == 1`, `setup_${index} == ${setupCount - 1}`, `cleanup_${index} == ${setupCount - 1}`]
        : [`${commitVariable} == 1`, `setup_${index} == ${cleanupCount}`, `cleanup_${index} == ${cleanupCount - 1}`];
      action(name, guards, new Map([[`${step.transition}_${index}`, String(isSetup ? setupCount : cleanupCount)]]), stepIndex === 0 ? comment : []);
      lifecycleActions[index]!.push(name);
    });
    if (options.allowCleanupBeforeSetup) action(`cleanup_${index}_before_setup`, [`setup_${index} == 0`, `cleanup_${index} == 0`], new Map([[`cleanup_${index}`, "1"]]));
    if (options.allowCommitEffectsWithoutCommit) action(`setup_${index}_after_discard`, ["discarded_render_count >= 1", "committed_render_count == 0", `setup_${index} == 0`], new Map([[`setup_${index}`, "1"]]));
    if (options.allowSetupFromWrongCommit && setupCount >= 2 && cleanupCount >= 1) {
      const firstCommit = commitVariables.get(effect.lifecycle[0]!.commit)!;
      const lastSetup = [...effect.lifecycle].reverse().find(({ transition }) => transition === "setup")!;
      const expectedCommit = commitVariables.get(lastSetup.commit)!;
      action(
        `setup_${index}_from_wrong_commit`,
        [`${firstCommit} == 1`, `${expectedCommit} == 0`, `setup_${index} == 0`, `cleanup_${index} == 0`],
        new Map([[`setup_${index}`, "2"], [`cleanup_${index}`, "1"]]),
      );
    }
  });
  lines.push("", "  action step = any {");
  for (const suspension of suspensionIds) lines.push(`    resolve_suspension_${suspensionIds.indexOf(suspension)},`);
  replay.renderAttempts.forEach((attempt, index) => {
    lines.push(`    ${attempt.outcome === "committed" ? "commit" : attempt.outcome === "suspended" ? "suspend" : "discard"}_render_${index},`);
    if (options.allowRetryBeforeResolution && attempt.retryOf) lines.push(`    retry_render_${index}_before_resolution,`);
  });
  replay.effects.forEach((_effect, index) => {
    for (const name of lifecycleActions[index]!) lines.push(`    ${name},`);
    if (options.allowCleanupBeforeSetup) lines.push(`    cleanup_${index}_before_setup,`);
    if (options.allowCommitEffectsWithoutCommit) lines.push(`    setup_${index}_after_discard,`);
    if (options.allowSetupFromWrongCommit && replay.effects[index]!.lifecycle.filter(({ transition }) => transition === "setup").length >= 2
      && replay.effects[index]!.lifecycle.some(({ transition }) => transition === "cleanup")) lines.push(`    setup_${index}_from_wrong_commit,`);
  });
  lines.push("  }");
  const bounds = [
    "0 <= render_attempt_count",
    `render_attempt_count <= ${replay.renderInvocations}`,
    "0 <= committed_render_count",
    "0 <= discarded_render_count",
    "0 <= suspended_render_count",
    "committed_render_count + discarded_render_count + suspended_render_count == render_attempt_count",
  ];
  for (const state of suspensionVariables.values()) bounds.push(
    `0 <= ${state.resolved}`,
    `${state.resolved} <= ${state.suspended}`,
  );
  for (const attempt of replay.renderAttempts) {
    if (!attempt.retryOf) continue;
    const retryMarker = attempt.commit
      ? commitVariables.get(attempt.commit)!
      : suspensionVariables.get(attempt.suspension!)!.suspended;
    bounds.push(`(${retryMarker} == 1 implies ${suspensionVariables.get(attempt.retryOf)!.resolved} == 1)`);
  }
  replay.effects.forEach((effect, index) => {
    const setupSteps = effect.lifecycle.filter(({ transition }) => transition === "setup");
    const cleanupSteps = effect.lifecycle.filter(({ transition }) => transition === "cleanup");
    bounds.push(
      `0 <= cleanup_${index}`,
      `cleanup_${index} <= setup_${index}`,
      `setup_${index} <= cleanup_${index} + 1`,
      `setup_${index} <= ${setupSteps.length}`,
      `cleanup_${index} <= ${cleanupSteps.length}`,
    );
    setupSteps.forEach((step, stepIndex) => bounds.push(
      `(setup_${index} >= ${stepIndex + 1} implies ${commitVariables.get(step.commit)} == 1)`,
    ));
    cleanupSteps.forEach((step, stepIndex) => bounds.push(
      `(cleanup_${index} >= ${stepIndex + 1} implies ${commitVariables.get(step.commit)} == 1)`,
    ));
  });
  for (let index = 1; index < replay.effects.length; index += 1) {
    const previous = replay.effects[index - 1]!;
    const current = replay.effects[index]!;
    if (reactCommitPhaseOrder.get(previous.phase)! < reactCommitPhaseOrder.get(current.phase)!) {
      bounds.push(`setup_${index} <= setup_${index - 1}`);
    }
  }
  lines.push("", `  val reactLifecycleSafe = ${bounds.join(" and ")}`, "}", "");
  return lines.join("\n");
}

export interface ReactSuspenseBoundaryOptions {
  /** Test-only fault injection proving that the cross-component cleanup invariant is load-bearing. */
  allowPrimarySetupBeforeFallbackCleanup?: boolean;
  /** Test-only fault injection proving that resolution is required before reveal. */
  allowRevealBeforeResolution?: boolean;
}

export interface ReactNestedSuspenseOptions {
  /** Test-only fault injection proving nearest-boundary ownership is load-bearing. */
  allowAncestorFallbackCommit?: boolean;
}

export interface ReactSuspenseTreeOptions {
  /** Test-only fault injection proving that fallback ownership is load-bearing. */
  allowWrongFallbackOwner?: boolean;
  /** Fail closed unless a leaf has Program-proven thenable evidence from React use(). */
  requireKnownSuspension?: boolean;
}

function validateBoundaryComponent(role: "primary" | "fallback", component: ReactComponentSummary): void {
  const replay = component.replay.production;
  if (replay.renderInvocations !== replay.renderAttempts.length) {
    throw new Error(`${role} renderInvocations ${replay.renderInvocations} does not match ${replay.renderAttempts.length} render attempts`);
  }
  const commits = new Set<string>();
  for (const attempt of replay.renderAttempts) {
    if (attempt.outcome === "committed" && !attempt.commit) throw new Error(`${role} committed render ${attempt.instance} has no commit generation`);
    if (attempt.outcome !== "committed" && attempt.commit) throw new Error(`${role} ${attempt.outcome} render ${attempt.instance} cannot create commit generation ${attempt.commit}`);
    if (attempt.commit) commits.add(attempt.commit);
  }
  for (const effect of replay.effects) {
    if (effect.transitions.length !== effect.lifecycle.length
      || effect.transitions.some((transition, index) => transition !== effect.lifecycle[index]!.transition)) {
      throw new Error(`${role} effect ${effect.instance} transitions do not match lifecycle steps`);
    }
    for (const step of effect.lifecycle) {
      if (!commits.has(step.commit)) throw new Error(`${role} effect ${effect.instance} refers to uncommitted generation ${step.commit}`);
    }
  }
}

/** Generate a bounded two-component Suspense fallback/reveal lifecycle projection. */
export function generateReactSuspenseBoundaryQuint(
  moduleName: string,
  primary: ReactComponentSummary,
  fallback: ReactComponentSummary,
  options: ReactSuspenseBoundaryOptions = {},
): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(moduleName)) throw new Error(`invalid Quint module name: ${moduleName}`);
  validateBoundaryComponent("primary", primary);
  validateBoundaryComponent("fallback", fallback);
  const primaryEffects = primary.replay.production.effects;
  const fallbackEffects = fallback.replay.production.effects;
  const variables = [
    "primary_suspended", "primary_suspension_resolved", "fallback_committed", "primary_committed",
    ...fallbackEffects.flatMap((_effect, index) => [`fallback_setup_${index}`, `fallback_cleanup_${index}`]),
    ...primaryEffects.map((_effect, index) => `primary_setup_${index}`),
  ];
  const lines = [`module ${moduleName} {`, ...variables.map((name) => `  var ${name}: int`), "", "  action init = all {"];
  for (const variable of variables) lines.push(`    ${variable}' = 0,`);
  lines.push("  }");
  const actions: string[] = [];
  const action = (name: string, guards: readonly string[], updates: ReadonlyMap<string, string>, comments: readonly string[] = []): void => {
    actions.push(name);
    lines.push("", ...comments.map((comment) => `  // ${comment.replaceAll(/[\r\n]/gu, " ")}`), `  action ${name} = all {`);
    for (const guard of guards) lines.push(`    ${guard},`);
    for (const variable of variables) lines.push(`    ${variable}' = ${updates.get(variable) ?? variable},`);
    lines.push("  }");
  };
  action("suspend_primary", ["primary_suspended == 0"], new Map([["primary_suspended", "1"]]), [`component: ${primary.name}`]);
  action("commit_fallback", ["primary_suspended == 1", "fallback_committed == 0"], new Map([["fallback_committed", "1"]]), [`component: ${fallback.name}`]);
  action("resolve_primary_suspension", ["primary_suspended == 1", "primary_suspension_resolved == 0"], new Map([["primary_suspension_resolved", "1"]]));
  action("reveal_primary", ["fallback_committed == 1", "primary_suspension_resolved == 1", "primary_committed == 0"], new Map([["primary_committed", "1"]]));
  if (options.allowRevealBeforeResolution) {
    action("reveal_primary_before_resolution", ["fallback_committed == 1", "primary_suspension_resolved == 0", "primary_committed == 0"], new Map([["primary_committed", "1"]]));
  }
  fallbackEffects.forEach((effect, index) => {
    action(`setup_fallback_${index}`, ["fallback_committed == 1", `fallback_setup_${index} == 0`], new Map([[`fallback_setup_${index}`, "1"]]), [
      `instance: fallback/${effect.instance}`,
      `phase: ${effect.phase}`,
      `setup effects: ${effect.setupEffects.join(" | ") || "none"}`,
    ]);
    action(`cleanup_fallback_${index}`, ["primary_committed == 1", `fallback_setup_${index} == 1`, `fallback_cleanup_${index} == 0`], new Map([[`fallback_cleanup_${index}`, "1"]]), [
      `instance: fallback/${effect.instance}`,
      `cleanup effects: ${effect.cleanupEffects.join(" | ") || "none"}`,
    ]);
  });
  primaryEffects.forEach((effect, index) => {
    const matchingFallback = fallbackEffects
      .map((candidate, fallbackIndex) => ({ candidate, fallbackIndex }))
      .filter(({ candidate }) => candidate.phase === effect.phase);
    action(`setup_primary_${index}`, [
      "primary_committed == 1",
      `primary_setup_${index} == 0`,
      ...matchingFallback.map(({ fallbackIndex }) => `fallback_cleanup_${fallbackIndex} == 1`),
    ], new Map([[`primary_setup_${index}`, "1"]]), [
      `instance: primary/${effect.instance}`,
      `phase: ${effect.phase}`,
      `setup effects: ${effect.setupEffects.join(" | ") || "none"}`,
    ]);
    if (options.allowPrimarySetupBeforeFallbackCleanup && matchingFallback.length > 0) {
      action(`setup_primary_${index}_before_fallback_cleanup`, [
        "primary_committed == 1",
        `primary_setup_${index} == 0`,
        ...matchingFallback.map(({ fallbackIndex }) => `fallback_cleanup_${fallbackIndex} == 0`),
      ], new Map([[`primary_setup_${index}`, "1"]]));
    }
  });
  lines.push("", "  action step = any {");
  for (const name of actions) lines.push(`    ${name},`);
  lines.push("  }");
  const bounds = [
    "0 <= primary_suspended", "primary_suspended <= 1",
    "0 <= primary_suspension_resolved", "primary_suspension_resolved <= primary_suspended",
    "0 <= fallback_committed", "fallback_committed <= primary_suspended",
    "0 <= primary_committed", "primary_committed <= fallback_committed",
    "(primary_committed == 1 implies primary_suspension_resolved == 1)",
  ];
  fallbackEffects.forEach((_effect, index) => bounds.push(
    `0 <= fallback_cleanup_${index}`,
    `fallback_cleanup_${index} <= fallback_setup_${index}`,
    `fallback_setup_${index} <= 1`,
    `(fallback_setup_${index} == 1 implies fallback_committed == 1)`,
    `(fallback_cleanup_${index} == 1 implies primary_committed == 1)`,
  ));
  primaryEffects.forEach((effect, index) => {
    bounds.push(`0 <= primary_setup_${index}`, `primary_setup_${index} <= 1`, `(primary_setup_${index} == 1 implies primary_committed == 1)`);
    fallbackEffects.forEach((candidate, fallbackIndex) => {
      if (candidate.phase === effect.phase) bounds.push(`(primary_setup_${index} == 1 implies fallback_cleanup_${fallbackIndex} == 1)`);
    });
  });
  lines.push("", `  val suspenseBoundarySafe = ${bounds.join(" and ")}`, "}", "");
  return lines.join("\n");
}

/**
 * Generate a bounded ownership projection for a direct chain of nested Suspense boundaries.
 * A suspension originating in the leaf primary is caught by the nearest boundary, so ancestor
 * fallbacks remain uncommitted. This does not model suspension while rendering a boundary or fallback.
 */
export function generateReactNestedSuspenseQuintFromAnalysis(
  moduleName: string,
  analysis: ReactSemanticsResult,
  rootBoundaryIndex = 0,
  options: ReactNestedSuspenseOptions = {},
): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(moduleName)) throw new Error(`invalid Quint module name: ${moduleName}`);
  const roots = analysis.suspenseBoundaries.filter(({ parentBoundary }) => parentBoundary === undefined);
  const root = roots[rootBoundaryIndex];
  if (!root) throw new Error(`nested Suspense root ${rootBoundaryIndex} is not available`);
  const byInstance = new Map(analysis.suspenseBoundaries.map((boundary) => [boundary.instance, boundary]));
  const chain: ReactSuspenseBoundarySummary[] = [];
  const visited = new Set<string>();
  let current: ReactSuspenseBoundarySummary | undefined = root;
  while (current) {
    if (visited.has(current.instance)) throw new Error(`nested Suspense cycle at ${current.instance}`);
    visited.add(current.instance);
    chain.push(current);
    current = current.primaryBoundary ? byInstance.get(current.primaryBoundary) : undefined;
    if (chain.at(-1)!.primaryBoundary && !current) {
      throw new Error(`nested Suspense child ${chain.at(-1)!.primaryBoundary} is not available`);
    }
  }
  if (chain.length < 2) throw new Error(`Suspense root ${root.instance} is not a nested boundary chain`);
  const leaf = chain.at(-1)!;
  if (leaf.primaryBoundary) throw new Error(`nested Suspense leaf ${leaf.instance} does not resolve to a component`);
  if (!analysis.components.some(({ name }) => name === leaf.primary)) {
    throw new Error(`nested Suspense leaf primary ${leaf.primary} is not available`);
  }
  for (const boundary of chain) if (!analysis.components.some(({ name }) => name === boundary.fallback)) {
    throw new Error(`nested Suspense fallback ${boundary.fallback} is not available`);
  }

  const nearest = chain.length - 1;
  const variables = [
    "leaf_suspended", "leaf_suspension_resolved", "leaf_committed",
    ...chain.flatMap((_boundary, index) => [`fallback_committed_${index}`, `fallback_cleaned_${index}`]),
  ];
  const lines = [`module ${moduleName} {`, ...variables.map((name) => `  var ${name}: int`), "", "  action init = all {"];
  for (const variable of variables) lines.push(`    ${variable}' = 0,`);
  lines.push("  }", "", `  // leaf component: ${leaf.primary}`, "  action suspend_leaf_primary = all {", "    leaf_suspended == 0,");
  for (const variable of variables) lines.push(`    ${variable}' = ${variable === "leaf_suspended" ? "1" : variable},`);
  lines.push("  }", "", `  // nearest boundary fallback: ${chain[nearest]!.fallback}`, `  action commit_fallback_${nearest} = all {`,
    "    leaf_suspended == 1,", `    fallback_committed_${nearest} == 0,`);
  for (const variable of variables) lines.push(`    ${variable}' = ${variable === `fallback_committed_${nearest}` ? "1" : variable},`);
  lines.push("  }", "", "  action resolve_leaf_suspension = all {", "    leaf_suspended == 1,", "    leaf_suspension_resolved == 0,");
  for (const variable of variables) lines.push(`    ${variable}' = ${variable === "leaf_suspension_resolved" ? "1" : variable},`);
  lines.push("  }", "", "  action reveal_leaf_primary = all {", "    leaf_suspension_resolved == 1,", `    fallback_committed_${nearest} == 1,`, "    leaf_committed == 0,");
  for (const variable of variables) {
    const update = variable === "leaf_committed" || variable === `fallback_cleaned_${nearest}` ? "1" : variable;
    lines.push(`    ${variable}' = ${update},`);
  }
  lines.push("  }");
  const ancestorActions: string[] = [];
  if (options.allowAncestorFallbackCommit) for (let index = 0; index < nearest; index++) {
    const name = `commit_ancestor_fallback_${index}`;
    ancestorActions.push(name);
    lines.push("", `  // fault injection: ancestor fallback ${chain[index]!.fallback}`, `  action ${name} = all {`,
      "    leaf_suspended == 1,", `    fallback_committed_${index} == 0,`);
    for (const variable of variables) lines.push(`    ${variable}' = ${variable === `fallback_committed_${index}` ? "1" : variable},`);
    lines.push("  }");
  }
  lines.push("", "  action step = any {", "    suspend_leaf_primary,", `    commit_fallback_${nearest},`,
    "    resolve_leaf_suspension,", "    reveal_leaf_primary,", ...ancestorActions.map((name) => `    ${name},`), "  }");
  const safety = [
    "0 <= leaf_suspension_resolved", "leaf_suspension_resolved <= leaf_suspended", "leaf_suspended <= 1",
    "0 <= leaf_committed", "leaf_committed <= leaf_suspension_resolved",
    ...chain.flatMap((_boundary, index) => [
      `0 <= fallback_cleaned_${index}`,
      `fallback_cleaned_${index} <= fallback_committed_${index}`,
      `fallback_committed_${index} <= 1`,
      ...(index === nearest ? [`(leaf_committed == 1 implies fallback_cleaned_${index} == 1)`] : [`fallback_committed_${index} == 0`]),
    ]),
  ];
  lines.push("", `  val nestedSuspenseSafe = ${safety.join(" and ")}`, "}", "");
  return lines.join("\n");
}

/** Generate the nested-boundary ownership projection with Program-resolved components. */
export function generateReactNestedSuspenseQuintFromProgram(
  moduleName: string,
  results: ReadonlyMap<string, ReactSemanticsResult>,
  sourceFileName: string,
  rootBoundaryIndex = 0,
  options: ReactNestedSuspenseOptions = {},
): string {
  const analysis = results.get(sourceFileName);
  if (!analysis) throw new Error(`React analysis is not available in ${sourceFileName}`);
  const components = new Map<string, ReactComponentSummary>();
  for (const [fileName, result] of results) for (const component of result.components) {
    components.set(`${fileName}:${component.name}`, component);
  }
  const projected: ReactComponentSummary[] = [];
  const add = (key: string, displayName: string): void => {
    const component = components.get(key);
    if (!component) throw new Error(`nested Suspense component summary ${key} is not available`);
    if (!projected.some(({ name }) => name === displayName)) projected.push({ ...component, name: displayName });
  };
  for (const boundary of analysis.suspenseBoundaries) {
    add(boundary.fallbackKey, boundary.fallback);
    if (!boundary.primaryBoundary) add(boundary.primaryKey, boundary.primary);
  }
  return generateReactNestedSuspenseQuintFromAnalysis(moduleName, { ...analysis, components: projected }, rootBoundaryIndex, options);
}

/** Generate a bounded one-suspension ownership model for a Fragment-flattened Suspense tree. */
export function generateReactSuspenseTreeQuintFromAnalysis(
  moduleName: string,
  analysis: ReactSemanticsResult,
  rootBoundaryIndex = 0,
  options: ReactSuspenseTreeOptions = {},
): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(moduleName)) throw new Error(`invalid Quint module name: ${moduleName}`);
  const roots = analysis.suspenseBoundaries.filter(({ parentBoundary }) => parentBoundary === undefined);
  const root = roots[rootBoundaryIndex];
  if (!root) throw new Error(`Suspense tree root ${rootBoundaryIndex} is not available`);
  const byInstance = new Map(analysis.suspenseBoundaries.map((boundary) => [boundary.instance, boundary]));
  const boundaries: ReactSuspenseBoundarySummary[] = [];
  const leaves: Array<{ displayName: string; componentKey: string; owner: number; cause?: ReactSuspensionSource }> = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const walk = (boundary: ReactSuspenseBoundarySummary): void => {
    if (visiting.has(boundary.instance)) throw new Error(`Suspense tree cycle at ${boundary.instance}`);
    if (visited.has(boundary.instance)) throw new Error(`Suspense boundary ${boundary.instance} has multiple primary parents`);
    visiting.add(boundary.instance);
    const owner = boundaries.length;
    boundaries.push(boundary);
    if (boundary.primaryNodes.length === 0) throw new Error(`Suspense boundary ${boundary.instance} has no primary nodes`);
    for (const primary of boundary.primaryNodes) {
      if (primary.kind === "component") {
        const component = analysis.components.find(({ name }) => name === primary.displayName);
        if (!component) {
          throw new Error(`Suspense primary ${primary.displayName} is not available`);
        }
        const cause = component.suspensions.find(({ certainty }) => certainty === "thenable");
        if (!options.requireKnownSuspension || cause) {
          leaves.push({ displayName: primary.displayName, componentKey: primary.componentKey, owner, ...(cause ? { cause } : {}) });
        }
      } else {
        const child = byInstance.get(primary.instance);
        if (!child) throw new Error(`Suspense child boundary ${primary.instance} is not available`);
        if (child.parentBoundary !== boundary.instance) throw new Error(`Suspense child ${primary.instance} does not name parent ${boundary.instance}`);
        walk(child);
      }
    }
    visiting.delete(boundary.instance);
    visited.add(boundary.instance);
  };
  walk(root);
  if (leaves.length === 0) throw new Error(options.requireKnownSuspension
    ? `Suspense tree ${root.instance} has no leaf with a known thenable suspension cause`
    : `Suspense tree ${root.instance} has no component leaves`);
  for (const boundary of boundaries) if (!analysis.components.some(({ name }) => name === boundary.fallback)) {
    throw new Error(`Suspense fallback ${boundary.fallback} is not available`);
  }

  const variables = ["suspension_leaf", "suspension_owner", "fallback_owner", "suspension_resolved", "leaf_committed"];
  const lines = [`module ${moduleName} {`, ...variables.map((name) => `  var ${name}: int`), "", "  action init = all {"];
  for (const variable of variables) lines.push(`    ${variable}' = 0,`);
  lines.push("  }");
  const actions: string[] = [];
  leaves.forEach((leaf, index) => {
    const name = `suspend_leaf_${index}`;
    actions.push(name);
    const cause = leaf.cause ? `; cause ${leaf.cause.kind}(${leaf.cause.expression})` : "";
    lines.push("", `  // leaf ${index}: ${leaf.displayName}; owner boundary ${leaf.owner}${cause}`, `  action ${name} = all {`,
      "    suspension_leaf == 0,", `    suspension_leaf' = ${index + 1},`, `    suspension_owner' = ${leaf.owner + 1},`,
      "    fallback_owner' = fallback_owner,", "    suspension_resolved' = suspension_resolved,", "    leaf_committed' = leaf_committed,", "  }");
  });
  boundaries.forEach((boundary, index) => {
    const name = `commit_fallback_${index}`;
    actions.push(name);
    lines.push("", `  // boundary ${index} fallback: ${boundary.fallback}`, `  action ${name} = all {`,
      `    suspension_owner == ${index + 1},`, "    fallback_owner == 0,", "    suspension_leaf' = suspension_leaf,",
      "    suspension_owner' = suspension_owner,", `    fallback_owner' = ${index + 1},`,
      "    suspension_resolved' = suspension_resolved,", "    leaf_committed' = leaf_committed,", "  }");
  });
  if (options.allowWrongFallbackOwner && boundaries.length > 1) {
    actions.push("commit_wrong_fallback_owner");
    lines.push("", "  // fault injection: commit a non-owning fallback", "  action commit_wrong_fallback_owner = all {",
      "    suspension_owner > 0,", "    fallback_owner == 0,", "    suspension_leaf' = suspension_leaf,",
      "    suspension_owner' = suspension_owner,", "    fallback_owner' = if (suspension_owner == 1) 2 else 1,",
      "    suspension_resolved' = suspension_resolved,", "    leaf_committed' = leaf_committed,", "  }");
  }
  actions.push("resolve_suspension", "reveal_leaf");
  lines.push("", "  action resolve_suspension = all {", "    suspension_leaf > 0,", "    suspension_resolved == 0,",
    "    suspension_leaf' = suspension_leaf,", "    suspension_owner' = suspension_owner,", "    fallback_owner' = fallback_owner,",
    "    suspension_resolved' = 1,", "    leaf_committed' = leaf_committed,", "  }", "",
    "  action reveal_leaf = all {", "    suspension_resolved == 1,", "    fallback_owner == suspension_owner,", "    leaf_committed == 0,",
    "    suspension_leaf' = suspension_leaf,", "    suspension_owner' = suspension_owner,", "    fallback_owner' = fallback_owner,",
    "    suspension_resolved' = suspension_resolved,", "    leaf_committed' = 1,", "  }", "", "  action step = any {");
  for (const action of actions) lines.push(`    ${action},`);
  lines.push("  }", "", `  val suspenseTreeSafe = 0 <= suspension_leaf and suspension_leaf <= ${leaves.length}`
    + ` and 0 <= suspension_owner and suspension_owner <= ${boundaries.length}`
    + ` and 0 <= fallback_owner and fallback_owner <= ${boundaries.length}`
    + " and 0 <= suspension_resolved and suspension_resolved <= 1"
    + " and 0 <= leaf_committed and leaf_committed <= suspension_resolved"
    + " and (fallback_owner == 0 or fallback_owner == suspension_owner)"
    + " and (leaf_committed == 1 implies fallback_owner == suspension_owner)", "}", "");
  return lines.join("\n");
}

/** Generate the bounded Suspense-tree model with Program-resolved component summaries. */
export function generateReactSuspenseTreeQuintFromProgram(
  moduleName: string,
  results: ReadonlyMap<string, ReactSemanticsResult>,
  sourceFileName: string,
  rootBoundaryIndex = 0,
  options: ReactSuspenseTreeOptions = {},
): string {
  const analysis = results.get(sourceFileName);
  if (!analysis) throw new Error(`React analysis is not available in ${sourceFileName}`);
  const components = new Map<string, ReactComponentSummary>();
  for (const [fileName, result] of results) for (const component of result.components) components.set(`${fileName}:${component.name}`, component);
  const projected: ReactComponentSummary[] = [];
  const add = (key: string, displayName: string): void => {
    const component = components.get(key);
    if (!component) throw new Error(`Suspense tree component summary ${key} is not available`);
    if (!projected.some(({ name }) => name === displayName)) projected.push({ ...component, name: displayName });
  };
  for (const boundary of analysis.suspenseBoundaries) {
    add(boundary.fallbackKey, boundary.fallback);
    for (const primary of boundary.primaryNodes) if (primary.kind === "component") add(primary.componentKey, primary.displayName);
  }
  return generateReactSuspenseTreeQuintFromAnalysis(moduleName, { ...analysis, components: projected }, rootBoundaryIndex, options);
}

/** Generate a boundary model from a source-extracted direct JSX Suspense edge. */
export function generateReactSuspenseBoundaryQuintFromAnalysis(
  moduleName: string,
  analysis: ReactSemanticsResult,
  boundaryIndex = 0,
  options: ReactSuspenseBoundaryOptions = {},
): string {
  const boundary = analysis.suspenseBoundaries[boundaryIndex];
  if (!boundary) throw new Error(`Suspense boundary ${boundaryIndex} is not available`);
  const primary = analysis.components.filter(({ name }) => name === boundary.primary);
  const fallback = analysis.components.filter(({ name }) => name === boundary.fallback);
  if (primary.length !== 1) throw new Error(`Suspense primary ${boundary.primary} does not resolve to exactly one component summary`);
  if (fallback.length !== 1) throw new Error(`Suspense fallback ${boundary.fallback} does not resolve to exactly one component summary`);
  return generateReactSuspenseBoundaryQuint(moduleName, primary[0]!, fallback[0]!, options);
}

/** Generate a boundary model whose component summaries may live in other Program source files. */
export function generateReactSuspenseBoundaryQuintFromProgram(
  moduleName: string,
  results: ReadonlyMap<string, ReactSemanticsResult>,
  sourceFileName: string,
  boundaryIndex = 0,
  options: ReactSuspenseBoundaryOptions = {},
): string {
  const analysis = results.get(sourceFileName);
  const boundary = analysis?.suspenseBoundaries[boundaryIndex];
  if (!boundary) throw new Error(`Suspense boundary ${boundaryIndex} is not available in ${sourceFileName}`);
  const components = new Map<string, ReactComponentSummary>();
  for (const [fileName, result] of results) for (const component of result.components) {
    const key = `${fileName}:${component.name}`;
    if (components.has(key)) throw new Error(`duplicate React component summary key ${key}`);
    components.set(key, component);
  }
  const primary = components.get(boundary.primaryKey);
  const fallback = components.get(boundary.fallbackKey);
  if (!primary) throw new Error(`Suspense primary summary ${boundary.primaryKey} is not available`);
  if (!fallback) throw new Error(`Suspense fallback summary ${boundary.fallbackKey} is not available`);
  return generateReactSuspenseBoundaryQuint(moduleName, primary, fallback, options);
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

function resolveProgramSuspenseBoundaries(
  program: ts.Program,
  results: Map<string, ReactSemanticsResult>,
): Map<string, ReactSemanticsResult> {
  const checker = program.getTypeChecker();
  const componentKeys = new Set<string>();
  for (const [fileName, result] of results) for (const component of result.components) componentKeys.add(`${fileName}:${component.name}`);
  for (const source of program.getSourceFiles()) {
    if (source.isDeclarationFile) continue;
    const result = results.get(source.fileName);
    if (!result) continue;
    const imports = reactImportNames(source);
    if (![...imports.values()].includes("Suspense") && reactNamespaceImportNames(source).size === 0) continue;
    const parents = new WeakMap<ts.JsxElement, string>();
    const visit = (node: ts.Node): void => {
      if (ts.isJsxElement(node) && isReactSuspenseTag(source, node.openingElement.tagName)) {
        const instance = `suspense@${node.getStart(source)}`;
        const fallbackAttribute = node.openingElement.attributes.properties.find(
          (attribute): attribute is ts.JsxAttribute => ts.isJsxAttribute(attribute)
            && ts.isIdentifier(attribute.name) && attribute.name.text === "fallback",
        );
        const fallbackTag = fallbackAttribute?.initializer ? directJsxComponentTag(fallbackAttribute.initializer) : undefined;
        const primaries = directSuspensePrimaries(source, node.children);
        for (const primary of primaries ?? []) if (primary.kind === "boundary") parents.set(primary.node, instance);
        const primaryNodes = primaries?.map((primary): ReactSuspensePrimaryNode | undefined => {
          if (primary.kind === "boundary") return { kind: "boundary", instance: primary.instance };
          const declaration = functionDeclarationForSymbol(checker, checker.getSymbolAtLocation(primary.tag.location));
          const componentKey = declaration ? declarationKey(declaration) : undefined;
          return componentKey && componentKeys.has(componentKey)
            ? { kind: "component", displayName: primary.tag.displayName, componentKey } : undefined;
        });
        if (primaryNodes?.every((primary): primary is ReactSuspensePrimaryNode => primary !== undefined) && fallbackTag) {
          const fallbackDeclaration = functionDeclarationForSymbol(checker, checker.getSymbolAtLocation(fallbackTag.location));
          const fallbackKey = fallbackDeclaration ? declarationKey(fallbackDeclaration) : undefined;
          if (primaryNodes.length > 0 && fallbackKey && componentKeys.has(fallbackKey)) {
            const singleton = primaryNodes.length === 1 ? primaryNodes[0] : undefined;
            const primaryBoundary = singleton?.kind === "boundary" ? singleton.instance : undefined;
            const primary = singleton?.kind === "component" ? singleton.displayName : primaryBoundary ?? `tree@${instance}`;
            const primaryKey = primaryBoundary ? `boundary:${primaryBoundary}`
              : singleton?.kind === "component" ? singleton.componentKey : `tree:${instance}`;
            const boundary: ReactSuspenseBoundarySummary = {
              instance,
              primary,
              fallback: fallbackTag.displayName,
              primaryKey,
              fallbackKey,
              ...(primaryBoundary ? { primaryBoundary } : {}),
              ...(parents.get(node) ? { parentBoundary: parents.get(node)! } : {}),
              primaryNodes,
              span: { start: node.getStart(source), end: node.getEnd() },
            };
            const existing = result.suspenseBoundaries.findIndex((candidate) => candidate.instance === instance);
            if (existing >= 0) result.suspenseBoundaries[existing] = boundary;
            else result.suspenseBoundaries.push(boundary);
            result.unsupportedSuspenseBoundaries = result.unsupportedSuspenseBoundaries.filter((candidate) => candidate.instance !== instance);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return results;
}

function thenableTypeCertainty(checker: ts.TypeChecker, type: ts.Type, location: ts.Node): ReactSuspensionSource["certainty"] {
  const members = type.isUnion() ? type.types : [type];
  if (members.some((member) => (member.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0)) return "unknown";
  const thenable = members.map((member) => {
    const then = member.getProperty("then");
    return then !== undefined && checker.getTypeOfSymbolAtLocation(then, location).getCallSignatures().length > 0;
  });
  if (thenable.length > 0 && thenable.every(Boolean)) return "thenable";
  if (thenable.every((value) => !value)) return "non-thenable";
  return "unknown";
}

function resolveProgramSuspensionSources(
  program: ts.Program,
  results: Map<string, ReactSemanticsResult>,
): Map<string, ReactSemanticsResult> {
  const checker = program.getTypeChecker();
  const expressions = new Map<string, ts.Expression>();
  for (const source of program.getSourceFiles()) {
    if (source.isDeclarationFile) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && isReactUseCall(source, node.expression)) {
        const argument = node.arguments[0];
        if (argument) expressions.set(`${source.fileName}:${node.getStart(source)}`, argument);
      }
      if (ts.isThrowStatement(node) && node.expression) {
        expressions.set(`${source.fileName}:${node.getStart(source)}`, node.expression);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  for (const result of results.values()) for (const summary of [...result.components, ...result.hooks]) {
    summary.suspensions = summary.suspensions.map((suspension) => {
      const expression = expressions.get(`${suspension.fileName}:${suspension.span.start}`);
      if (!expression) return suspension;
      const certainty = thenableTypeCertainty(checker, checker.getTypeAtLocation(expression), expression);
      return suspension.kind === "react-use" && certainty === "non-thenable"
        ? suspension
        : { ...suspension, certainty };
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
      summary.instances,
      summary.leaked,
      summary.lifecycleIssues.map(({ kind, capability, phase, detail }) => ({ kind, capability, phase, detail })),
      summary.suspensions,
    ]).sort(([left], [right]) => String(left).localeCompare(String(right))));
    if (fingerprint(next) === fingerprint(summaries)) {
      return resolveProgramSuspensionSources(program,
        resolveProgramSuspenseBoundaries(program, addProgramHookCycleDiagnostics(program, nextResults, nextHookNodes)));
    }
    summaries = next;
    results = nextResults;
    hookNodes = nextHookNodes;
  }
  return resolveProgramSuspensionSources(program,
    resolveProgramSuspenseBoundaries(program, addProgramHookCycleDiagnostics(program, results, hookNodes)));
}

/** Analyze every implementation source while computing the custom-Hook fixed point only once. */
export function analyzeReactProgram(program: ts.Program): Map<string, ReactSemanticsResult> {
  return analyzeProgramFixedPoint(program);
}

/** Program-backed path: composes annotated custom Hooks through resolved named imports and aliases. */
export function analyzeReactSemanticsInProgram(program: ts.Program, source: ts.SourceFile): ReactSemanticsResult {
  return analyzeReactProgram(program).get(source.fileName) ?? {
    components: [], hooks: [], diagnostics: [], suspenseBoundaries: [], unsupportedSuspenseBoundaries: [],
  };
}
