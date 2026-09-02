import { createHash } from "node:crypto";
import ts from "typescript";
import { extractAnnotations } from "./annotations.js";
import type { InvariantSpec } from "./spec-ir.js";
import { TypeScriptFrontendAdapter } from "./frontend-adapter.js";

export type LogicSort = "Int" | "Real" | "Bool";
export type NumericDomain = "int" | "nat" | "float" | "bool";
export type LogicExpression =
  | { kind: "variable"; name: string }
  | { kind: "integer"; value: string }
  | { kind: "real"; value: string }
  | { kind: "boolean"; value: boolean }
  | { kind: "unary"; operator: "not" | "negate" | "floor" | "ceil"; operand: LogicExpression }
  | { kind: "binary"; operator: string; left: LogicExpression; right: LogicExpression };

export interface ObligationVariable { name: string; sort: LogicSort; domain: NumericDomain }
/** How a source-level name (`result`, a local, a loop snapshot) is defined over the obligation variables. */
export interface ObligationBinding { name: string; expression: LogicExpression }
export interface ContractControlFlowEvidence {
  schema: "uneffect-contract-control-flow/v1";
  /** Stable identity of the source completion point shared by clauses proved at that point. */
  blockId: string;
  completion: "return" | "call" | "loop-entry" | "loop-back-edge" | "synthetic";
  /** Conditions assumed by the solver on the path reaching this completion point. */
  pathConditions: LogicExpression[];
  narrowing?: {
    source: "typescript-typechecker";
    typescriptVersion: string;
    programDigest: string;
    facts: string[];
  };
  exceptionFlow?: {
    schema: "uneffect-contract-exception-flow/v1";
    discharged: ContractThrowEdge[];
    escapes: ContractThrowEdge[];
  };
  relationalCalls?: ContractRelationalCallEvidence[];
  effectBoundary?: {
    schema: "uneffect-contract-effect-boundary/v1";
    evidence: "verified" | "trusted" | "inferred" | "unknown";
    inferred: string[];
    discharged: string[];
    escaping: string[];
    blockers: string[];
  };
}
export interface ContractRelationalCallEvidence {
  schema: "uneffect-contract-relational-call/v1";
  evidence: "verified" | "trusted";
  typescriptVersion: string;
  functionName: string;
  clauses: string[];
  preconditions?: string[];
  callSpan: { start: number; end: number };
  declarationFileName: string;
  declarationDigest: string;
  declarationSpan: { start: number; end: number };
}
export interface ContractThrowEdge {
  kind: "synchronous-throw" | "promise-rejection";
  evidence?: "verified" | "trusted";
  effect: string;
  originSpan: { start: number; end: number };
  handlerSpan?: { start: number; end: number };
  payload?: LogicExpression;
}
export interface InvariantObligation {
  id: string;
  kind: "postcondition" | "call-precondition" | "loop-init" | "loop-preserve";
  fileName: string;
  functionName: string;
  span: { start: number; end: number };
  variables: ObligationVariable[];
  assumptions: LogicExpression[];
  goal: LogicExpression;
  source: string;
  bindings: ObligationBinding[];
  /** Readable aliases for generated variables, e.g. `count_i_loop_84` displayed as `i@loop`. */
  displayNames: Record<string, string>;
  controlFlow: ContractControlFlowEvidence;
}

/** A lowering rejection that stays locatable and actionable instead of collapsing to a bare message. */
export class InvariantLoweringError extends Error {
  readonly functionName: string | undefined;
  readonly span: { start: number; end: number } | undefined;
  readonly hint: string | undefined;
  constructor(message: string, detail: { functionName?: string; span?: { start: number; end: number }; hint?: string } = {}) {
    super(message);
    this.name = "InvariantLoweringError";
    this.functionName = detail.functionName;
    this.span = detail.span;
    this.hint = detail.hint;
  }
}

type Environment = Map<string, LogicExpression>;
interface PendingPromiseState {
  fact: AwaitRejectionFact;
  argumentValues: Array<LogicExpression | undefined>;
  originSpan: { start: number; end: number };
  observed: boolean;
  preconditionsChecked: boolean;
}
interface PathState {
  env: Environment;
  pendingPromises: Map<string, PendingPromiseState>;
  assumptions: LogicExpression[];
  completion: "normal" | "return" | "throw" | "reject" | "break" | "continue";
  breakTarget?: number;
  continueTarget?: number;
  thrown?: ContractThrowEdge;
  dischargedThrows: ContractThrowEdge[];
  relationalCalls: ContractRelationalCallEvidence[];
  returnEnv?: Environment;
  returnStatement?: ts.ReturnStatement;
}
type SemanticGuardKind = "defined" | "typeof-number" | "typeof-boolean" | "discriminant";
interface SemanticGuardFact {
  kind: SemanticGuardKind;
  variable: string;
  label: string;
  nullish?: "undefined" | "null" | "nullish";
  property?: string;
  literal?: string;
  spans: string[];
  switchSpans?: string[];
  coalesceSpans?: string[];
  booleanComparisons?: Array<{ span: string; value: boolean }>;
  /** Scalar payload represented separately from this Boolean presence guard. */
  valueVariable?: string;
}
interface NarrowedValueFact { span: string; label: string; expression: LogicExpression; domain?: NumericDomain }
interface ObjectAliasFact { name: string; declarationSpan: string }
interface ParameterTypeFact {
  domain: NumericDomain;
  /** False when only synthetic guard variables, rather than the object itself, enter the scalar IR. */
  represented?: boolean;
  assumption?: LogicExpression;
  label?: string;
  guards?: SemanticGuardFact[];
  values?: NarrowedValueFact[];
  aliases?: ObjectAliasFact[];
  ignoredDeclarations?: string[];
  /** One reviewed readonly property path that exposes the discriminated-union root. */
  rootPath?: Array<{ name: string; symbol: ts.Symbol }>;
  programDigest: string;
}
interface DeclaredThrowCallFact { effects: string[]; definitelyThrows: boolean }
interface AssertionCallFact { effect: "Throw<AssertionError>"; condition: "truthy" | "strict-equal" | "strict-not-equal" | "nullish" | "always-throw" }
interface MathScalarCallFact { operation: "abs" | "min" | "max" | "floor" | "ceil" | "trunc" | "round" | "sign" | "pow"; exponent?: number }
interface AwaitFulfillmentFact {
  domain: NumericDomain;
  functionName: string;
  parameters: string[];
  clauses: Array<{ source: string; expression: LogicExpression }>;
  preconditions: Array<{ source: string; expression: LogicExpression }>;
  declarationFileName: string;
  declarationDigest: string;
  declarationSpan: { start: number; end: number };
}

/** An authenticated external contract bound to one declaration in this Program. */
export interface ExternalContractBinding {
  exportName: string;
  evidence: "verified" | "trusted";
  declarationFileName: string;
  declarationSpan: { start: number; end: number };
  declarationDigest: string;
  signature: string;
  summary: {
    functionName: string;
    parameters: string[];
    requires: string[];
    ensures: string[];
  };
}

export interface InvariantLoweringOptions {
  externalContractBindings?: readonly ExternalContractBinding[];
}
interface AwaitRejectionFact {
  effect?: string;
  definitelyRejects: boolean;
  synchronousThrows: string[];
  evidence: "verified" | "trusted";
  payloadFromFirstArgument: boolean;
  synchronousFulfillment?: boolean;
  fulfillment?: AwaitFulfillmentFact;
}

function finiteUnion(values: LogicExpression[]): LogicExpression | undefined {
  return values.reduce<LogicExpression | undefined>((left, right) => left === undefined ? right : { kind: "binary", operator: "or", left, right }, undefined);
}

function conjunction(values: LogicExpression[]): LogicExpression | undefined {
  return values.reduce<LogicExpression | undefined>((left, right) => left === undefined ? right : { kind: "binary", operator: "and", left, right }, undefined);
}

function exactlyOne(variables: readonly string[]): LogicExpression | undefined {
  const choices = variables.map(variable);
  const atLeastOne = finiteUnion(choices);
  if (!atLeastOne) return undefined;
  const exclusions: LogicExpression[] = [];
  for (let left = 0; left < choices.length; left++) for (let right = left + 1; right < choices.length; right++) {
    exclusions.push(negate({ kind: "binary", operator: "and", left: choices[left]!, right: choices[right]! }));
  }
  return conjunction([atLeastOne, ...exclusions]);
}

/** Extract only TypeChecker facts that map exactly into the current scalar logic IR. */
function typeCheckerParameterFacts(program: ts.Program | undefined, fileName: string, text: string): Map<string, ParameterTypeFact> {
  const facts = new Map<string, ParameterTypeFact>();
  if (!program) return facts;
  const source = program.getSourceFile(fileName);
  if (!source || source.text !== text) return facts;
  const errors = [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)]
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) return facts;
  const programDigest = createHash("sha256").update(JSON.stringify({
    compilerOptions: program.getCompilerOptions(),
    sources: program.getSourceFiles().filter((item) => !item.isDeclarationFile)
      .map((item) => [item.fileName, createHash("sha256").update(item.text).digest("hex")]).sort(([left], [right]) => left!.localeCompare(right!)),
  })).digest("hex");
  const checker = program.getTypeChecker();
  const discriminantFact = (
    members: readonly ts.Type[],
    rootName: string,
    location: ts.Node,
  ): Omit<ParameterTypeFact, "programDigest"> | undefined => {
    if (members.length < 2 || members.length > 8) return undefined;
    const candidates = checker.getPropertiesOfType(members[0]!).map((property) => property.name).sort();
    for (const propertyName of candidates) {
      const literals: string[] = [];
      let supported = true;
      for (const member of members) {
        const property = checker.getPropertyOfType(member, propertyName);
        const declarations = property?.declarations ?? [];
        const readonly = declarations.length > 0 && declarations.every((declaration) =>
          (ts.getCombinedModifierFlags(declaration as ts.Declaration) & ts.ModifierFlags.Readonly) !== 0);
        const propertyType = property && checker.getTypeOfSymbolAtLocation(property, location);
        if (!propertyType?.isStringLiteral() || !readonly) { supported = false; break; }
        literals.push(propertyType.value);
      }
      if (!supported || new Set(literals).size !== members.length) continue;
      const ordered = [...literals].sort();
      const safeRoot = rootName.replace(/[^A-Za-z0-9_$]/g, "_");
      const guards = ordered.map((literal, index): SemanticGuardFact => ({
        kind: "discriminant",
        variable: `${safeRoot}_uneffect_${propertyName}_${index}`,
        label: `${rootName}.${propertyName} === ${JSON.stringify(literal)}`,
        property: propertyName,
        literal,
        spans: [],
      }));
      return {
        domain: "bool",
        represented: false,
        assumption: exactlyOne(guards.map((guard) => guard.variable)),
        label: `${rootName}.${propertyName} ∈ {${ordered.map((literal) => JSON.stringify(literal)).join(", ")}}`,
        guards,
      };
    }
    return undefined;
  };
  for (const node of source.statements) {
    if (!ts.isFunctionDeclaration(node) || !node.name || !node.body) continue;
    for (const parameter of node.parameters) {
      if (!ts.isIdentifier(parameter.name)) continue;
      const parameterName = parameter.name.text;
      const type = checker.getTypeAtLocation(parameter.name);
      const key = `${node.getStart(source)}:${parameterName}`;
      const members = type.isUnion() ? type.types : [type];
      const numeric = members.map((member) => member.isNumberLiteral() ? member.value : undefined);
      if (numeric.every((value): value is number => value !== undefined && Number.isSafeInteger(value)) && numeric.length > 0 && numeric.length <= 16) {
        const choices = numeric.map((value): LogicExpression => ({ kind: "binary", operator: "eq", left: variable(parameterName), right: { kind: "integer", value: String(value) } }));
        facts.set(key, { domain: "int", assumption: finiteUnion(choices), label: `${parameterName} ∈ {${numeric.join(", ")}}`, programDigest });
      } else if ((type.flags & ts.TypeFlags.NumberLike) !== 0) {
        facts.set(key, { domain: "int", programDigest });
      } else if ((type.flags & ts.TypeFlags.BooleanLike) !== 0) {
        facts.set(key, { domain: "bool", programDigest });
      } else {
        const numberMembers = members.filter((member) => (member.flags & ts.TypeFlags.NumberLike) !== 0);
        const booleanMembers = members.filter((member) => (member.flags & ts.TypeFlags.BooleanLike) !== 0);
        const undefinedMembers = members.filter((member) => (member.flags & ts.TypeFlags.Undefined) !== 0);
        const nullMembers = members.filter((member) => (member.flags & ts.TypeFlags.Null) !== 0);
        const stringMembers = members.filter((member) => (member.flags & ts.TypeFlags.StringLike) !== 0);
        const objectMembers = members.filter((member) => (member.flags & (ts.TypeFlags.Object | ts.TypeFlags.NonPrimitive)) !== 0);
        const nullableScalar = numberMembers.length > 0 && booleanMembers.length === 0 ? { members: numberMembers, domain: "int" as const, label: "number" }
          : booleanMembers.length > 0 && numberMembers.length === 0 ? { members: booleanMembers, domain: "bool" as const, label: "boolean" }
            : undefined;
        if (nullableScalar && undefinedMembers.length + nullMembers.length > 0
          && nullableScalar.members.length + undefinedMembers.length + nullMembers.length === members.length) {
          const nullish = undefinedMembers.length > 0 && nullMembers.length > 0 ? "nullish" : undefinedMembers.length > 0 ? "undefined" : "null";
          const suffix = nullish === "nullish" ? `${nullableScalar.label} | null | undefined` : `${nullableScalar.label} | ${nullish}`;
          facts.set(key, { domain: nullableScalar.domain, programDigest, guards: [{ kind: "defined", variable: `${parameterName}_uneffect_defined`, valueVariable: parameterName, label: `${parameterName}: ${suffix} via nullish guard`, nullish, spans: [] }] });
        } else if (objectMembers.length > 0 && undefinedMembers.length + nullMembers.length > 0
          && objectMembers.length + undefinedMembers.length + nullMembers.length === members.length) {
          const nullish = undefinedMembers.length > 0 && nullMembers.length > 0 ? "nullish" : undefinedMembers.length > 0 ? "undefined" : "null";
          facts.set(key, {
            domain: "bool",
            represented: false,
            programDigest,
            guards: [{
              kind: "defined",
              variable: `${parameterName}_uneffect_defined`,
              label: `${parameterName}: presence-only object | ${nullish}`,
              nullish,
              spans: [],
            }],
          });
        } else if (numberMembers.length > 0 && stringMembers.length > 0 && numberMembers.length + stringMembers.length === members.length) {
          facts.set(key, { domain: "int", programDigest, guards: [{ kind: "typeof-number", variable: `${parameterName}_uneffect_is_number`, label: `${parameterName}: number | string via typeof number guard`, spans: [] }] });
        } else if (booleanMembers.length > 0 && stringMembers.length > 0 && booleanMembers.length + stringMembers.length === members.length) {
          facts.set(key, { domain: "bool", programDigest, guards: [{ kind: "typeof-boolean", variable: `${parameterName}_uneffect_is_boolean`, label: `${parameterName}: boolean | string via typeof boolean guard`, spans: [] }] });
        } else {
          const direct = discriminantFact(members, parameterName, parameter.name);
          if (direct) facts.set(key, { ...direct, programDigest });
        }
      }
      if (!facts.has(key)) {
        const roots: Array<{ path: Array<{ name: string; symbol: ts.Symbol }>; fact: Omit<ParameterTypeFact, "programDigest"> }> = [];
        const collectRoots = (
          currentType: ts.Type,
          path: Array<{ name: string; symbol: ts.Symbol }>,
          ancestors: ReadonlySet<ts.Type>,
        ): void => {
          if (path.length >= 4 || ancestors.has(currentType)) return;
          const nextAncestors = new Set(ancestors).add(currentType);
          for (const property of checker.getPropertiesOfType(currentType).sort((left, right) => left.name.localeCompare(right.name))) {
            const declarations = property.declarations ?? [];
            const readonly = declarations.length > 0 && declarations.every((declaration) =>
              (ts.getCombinedModifierFlags(declaration as ts.Declaration) & ts.ModifierFlags.Readonly) !== 0);
            if (!readonly) continue;
            const propertyType = checker.getTypeOfSymbolAtLocation(property, parameter.name);
            const nextPath = [...path, { name: property.name, symbol: property }];
            if (propertyType.isUnion()) {
              const rootName = `${parameterName}.${nextPath.map((item) => item.name).join(".")}`;
              const nested = discriminantFact(propertyType.types, rootName, parameter.name);
              if (nested) roots.push({ path: nextPath, fact: nested });
            } else if ((propertyType.flags & ts.TypeFlags.Object) !== 0) {
              collectRoots(propertyType, nextPath, nextAncestors);
            }
          }
        };
        collectRoots(type, [], new Set());
        if (roots.length === 1) {
          const root = roots[0]!;
          facts.set(key, { ...root.fact, rootPath: root.path, programDigest });
        }
      }
      if (!facts.has(key) && (type.flags & (ts.TypeFlags.Object | ts.TypeFlags.NonPrimitive)) !== 0) {
        facts.set(key, { domain: "bool", represented: false, label: `${parameterName}: opaque object`, programDigest });
      }
      const fact = facts.get(key);
      if (!fact?.guards) continue;
      const parameterSymbol = checker.getSymbolAtLocation(parameter.name);
      const aliasSymbols = new Map<ts.Symbol, string>();
      if (parameterSymbol && !fact.rootPath) aliasSymbols.set(parameterSymbol, parameterName);
      const matchesRootPath = (candidate: ts.Expression): boolean => {
        if (!fact.rootPath || !parameterSymbol) return false;
        const symbols: ts.Symbol[] = [];
        let current = candidate;
        while (ts.isPropertyAccessExpression(current)) {
          const symbol = checker.getSymbolAtLocation(current.name);
          if (!symbol) return false;
          symbols.unshift(symbol);
          current = current.expression;
        }
        return ts.isIdentifier(current) && checker.getSymbolAtLocation(current) === parameterSymbol
          && symbols.length === fact.rootPath.length
          && symbols.every((symbol, index) => symbol === fact.rootPath![index]!.symbol);
      };
      const collectAliases = (current: ts.Node): void => {
        if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name) && current.initializer
          && ts.isVariableDeclarationList(current.parent)
          && (current.parent.flags & ts.NodeFlags.Const) !== 0) {
          const aliasSymbol = checker.getSymbolAtLocation(current.name);
          const sourceSymbol = ts.isIdentifier(current.initializer)
            ? checker.getSymbolAtLocation(current.initializer)
            : undefined;
          const rootSource = matchesRootPath(current.initializer);
          if (aliasSymbol && ((sourceSymbol && aliasSymbols.has(sourceSymbol)) || rootSource)) {
            aliasSymbols.set(aliasSymbol, current.name.text);
            (fact.aliases ??= []).push({ name: current.name.text, declarationSpan: `${current.getStart(source)}:${current.getEnd()}` });
          }
        }
        ts.forEachChild(current, collectAliases);
      };
      collectAliases(node.body);
      const sameParameter = (candidate: ts.Expression): candidate is ts.Identifier =>
        ts.isIdentifier(candidate) && aliasSymbols.has(checker.getSymbolAtLocation(candidate)!);
      const sameParameterThroughScalarWrapper = (candidate: ts.Expression): boolean => {
        let current = candidate;
        while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current)
          || ts.isTypeAssertionExpression(current) || ts.isNonNullExpression(current)) current = current.expression;
        return sameParameter(current);
      };
      const rootedPropertyPath = (candidate: ts.PropertyAccessExpression): {
        root: ts.Identifier;
        properties: ts.PropertyAccessExpression[];
      } | undefined => {
        const properties: ts.PropertyAccessExpression[] = [];
        let current: ts.Expression = candidate;
        while (ts.isPropertyAccessExpression(current)) {
          properties.unshift(current);
          current = current.expression;
        }
        return sameParameter(current) ? { root: current, properties } : undefined;
      };
      const destructuredBindings = new Map<ts.Symbol, { expression: LogicExpression; domain?: NumericDomain; label: string }>();
      const collectDestructuredBindings = (current: ts.Node): void => {
        if (ts.isVariableDeclaration(current) && ts.isObjectBindingPattern(current.name) && current.initializer
          && ts.isVariableDeclarationList(current.parent)
          && (current.parent.flags & ts.NodeFlags.Const) !== 0) {
          const receiverPath = sameParameter(current.initializer)
            ? { root: current.initializer, properties: [] as ts.PropertyAccessExpression[] }
            : ts.isPropertyAccessExpression(current.initializer) ? rootedPropertyPath(current.initializer) : undefined;
          const receiverType = checker.getTypeAtLocation(current.initializer);
          const discriminant = fact.guards!.find((guard) => guard.kind === "discriminant");
          const rootType = receiverPath ? checker.getTypeAtLocation(receiverPath.root) : undefined;
          const selectedProperty = discriminant?.property && rootType ? checker.getPropertyOfType(rootType, discriminant.property) : undefined;
          const selectedType = selectedProperty && checker.getTypeOfSymbolAtLocation(selectedProperty, receiverPath!.root);
          const selectedLiteral = selectedType?.isStringLiteral() ? selectedType.value : undefined;
          const bindings: Array<[ts.Symbol, { expression: LogicExpression; domain?: NumericDomain; label: string }]> = [];
          const readonlyPrefix = receiverPath !== undefined && receiverPath.properties.every((access) => {
            const property = checker.getSymbolAtLocation(access.name);
            const declarations = property?.declarations ?? [];
            return declarations.length > 0 && declarations.every((declaration) =>
              (ts.getCombinedModifierFlags(declaration as ts.Declaration) & ts.ModifierFlags.Readonly) !== 0);
          });
          let supported = selectedLiteral !== undefined && readonlyPrefix;
          for (const element of current.name.elements) {
            const propertyName = element.propertyName && ts.isIdentifier(element.propertyName)
              ? element.propertyName.text
              : !element.propertyName && ts.isIdentifier(element.name) ? element.name.text : undefined;
            if (!supported || element.dotDotDotToken || element.initializer || !propertyName
              || !ts.isIdentifier(element.name) || propertyName === discriminant?.property) { supported = false; break; }
            const property = checker.getPropertyOfType(receiverType, propertyName);
            const declarations = property?.declarations ?? [];
            const readonly = declarations.length > 0 && declarations.every((declaration) =>
              (ts.getCombinedModifierFlags(declaration as ts.Declaration) & ts.ModifierFlags.Readonly) !== 0);
            const bindingSymbol = checker.getSymbolAtLocation(element.name);
            const narrowed = checker.getTypeAtLocation(element.name);
            if (!readonly || !bindingSymbol) { supported = false; break; }
            let expression: LogicExpression | undefined;
            let valueDomain: NumericDomain | undefined;
            if (narrowed.isNumberLiteral() && Number.isSafeInteger(narrowed.value)) {
              expression = { kind: "integer", value: String(narrowed.value) };
            } else if ((narrowed.flags & ts.TypeFlags.BooleanLiteral) !== 0) {
              expression = { kind: "boolean", value: checker.typeToString(narrowed) === "true" };
            } else if (!narrowed.isUnion()) {
              const declaredTypes = declarations.flatMap((declaration) => {
                const typeNode = ts.isPropertySignature(declaration) || ts.isPropertyDeclaration(declaration)
                  || ts.isParameter(declaration) ? declaration.type : undefined;
                return typeNode ? [typeNode.getText(declaration.getSourceFile())] : [];
              });
              if (declaredTypes.length > 0 && declaredTypes.every((value) => value === "Nat")) valueDomain = "nat";
              else if (declaredTypes.length > 0 && declaredTypes.every((value) => value === "Float")) valueDomain = "float";
              else if ((narrowed.flags & ts.TypeFlags.BooleanLike) !== 0) valueDomain = "bool";
              else if ((narrowed.flags & ts.TypeFlags.NumberLike) !== 0) valueDomain = "int";
              if (valueDomain) {
                const safeMember = selectedLiteral!.replace(/[^A-Za-z0-9_$]/g, "_");
                const safeProperty = [...receiverPath!.properties.map((access) => access.name.text), propertyName]
                  .join("_").replace(/[^A-Za-z0-9_$]/g, "_");
                expression = variable(`${parameterName}_uneffect_${discriminant!.property}_${safeMember}_${safeProperty}`);
              }
            }
            if (!expression) { supported = false; break; }
            const rendered = expression.kind === "variable" ? `: ${valueDomain}`
              : expression.kind === "boolean" || expression.kind === "integer" || expression.kind === "real"
                ? ` = ${String(expression.value)}` : "";
            bindings.push([bindingSymbol, { expression, ...(valueDomain ? { domain: valueDomain } : {}), label: `${element.name.text}${rendered} for ${discriminant!.property}=${JSON.stringify(selectedLiteral)}` }]);
          }
          if (supported && bindings.length > 0) {
            for (const [symbol, binding] of bindings) destructuredBindings.set(symbol, binding);
            (fact.ignoredDeclarations ??= []).push(`${current.getStart(source)}:${current.getEnd()}`);
          }
        }
        if (ts.isVariableDeclaration(current) && ts.isArrayBindingPattern(current.name) && current.initializer
          && ts.isPropertyAccessExpression(current.initializer) && ts.isVariableDeclarationList(current.parent)
          && (current.parent.flags & ts.NodeFlags.Const) !== 0) {
          const tuplePath = rootedPropertyPath(current.initializer);
          const tupleType = checker.getTypeAtLocation(current.initializer);
          const tupleTarget = tupleType as ts.Type & { target?: { readonly?: boolean } };
          const readonlyPath = tuplePath?.properties.every((access) => {
            const property = checker.getSymbolAtLocation(access.name);
            const declarations = property?.declarations ?? [];
            return declarations.length > 0 && declarations.every((declaration) =>
              (ts.getCombinedModifierFlags(declaration as ts.Declaration) & ts.ModifierFlags.Readonly) !== 0);
          });
          const discriminant = fact.guards!.find((guard) => guard.kind === "discriminant");
          const rootType = tuplePath ? checker.getTypeAtLocation(tuplePath.root) : undefined;
          const selectedProperty = discriminant?.property && rootType ? checker.getPropertyOfType(rootType, discriminant.property) : undefined;
          const selectedType = selectedProperty && checker.getTypeOfSymbolAtLocation(selectedProperty, tuplePath!.root);
          const selectedLiteral = selectedType?.isStringLiteral() ? selectedType.value : undefined;
          const terminalProperty = tuplePath
            ? checker.getSymbolAtLocation(tuplePath.properties[tuplePath.properties.length - 1]!.name) : undefined;
          const bindings: Array<[ts.Symbol, { expression: LogicExpression; domain?: NumericDomain; label: string }]> = [];
          let supported = tuplePath !== undefined && readonlyPath === true && checker.isTupleType(tupleType)
            && tupleTarget.target?.readonly === true && selectedLiteral !== undefined;
          for (const [index, element] of current.name.elements.entries()) {
            if (!supported || !ts.isBindingElement(element) || element.dotDotDotToken || element.initializer
              || element.propertyName || !ts.isIdentifier(element.name)) { supported = false; break; }
            const bindingSymbol = checker.getSymbolAtLocation(element.name);
            const narrowed = checker.getTypeAtLocation(element.name);
            if (!bindingSymbol) { supported = false; break; }
            let expression: LogicExpression | undefined;
            let valueDomain: NumericDomain | undefined;
            if (narrowed.isNumberLiteral() && Number.isSafeInteger(narrowed.value)) {
              expression = { kind: "integer", value: String(narrowed.value) };
            } else if ((narrowed.flags & ts.TypeFlags.BooleanLiteral) !== 0) {
              expression = { kind: "boolean", value: checker.typeToString(narrowed) === "true" };
            } else if (!narrowed.isUnion()) {
              const declaredTypes = (terminalProperty?.declarations ?? []).flatMap((declaration) => {
                let typeNode = ts.isPropertySignature(declaration) || ts.isPropertyDeclaration(declaration)
                  || ts.isParameter(declaration) ? declaration.type : undefined;
                if (typeNode && ts.isTypeOperatorNode(typeNode) && typeNode.operator === ts.SyntaxKind.ReadonlyKeyword) typeNode = typeNode.type;
                return typeNode && ts.isTupleTypeNode(typeNode) && typeNode.elements[index]
                  ? [typeNode.elements[index]!.getText(declaration.getSourceFile())] : [];
              });
              if (declaredTypes.length > 0 && declaredTypes.every((value) => value === "Nat")) valueDomain = "nat";
              else if (declaredTypes.length > 0 && declaredTypes.every((value) => value === "Float")) valueDomain = "float";
              else if ((narrowed.flags & ts.TypeFlags.BooleanLike) !== 0) valueDomain = "bool";
              else if ((narrowed.flags & ts.TypeFlags.NumberLike) !== 0) valueDomain = "int";
              if (valueDomain) {
                const safeMember = selectedLiteral!.replace(/[^A-Za-z0-9_$]/g, "_");
                const safePath = tuplePath!.properties.map((access) => access.name.text).join("_").replace(/[^A-Za-z0-9_$]/g, "_");
                expression = variable(`${parameterName}_uneffect_${discriminant!.property}_${safeMember}_${safePath}_${index}`);
              }
            }
            if (!expression) { supported = false; break; }
            const rendered = expression.kind === "variable" ? `: ${valueDomain}`
              : expression.kind === "boolean" || expression.kind === "integer" || expression.kind === "real"
                ? ` = ${String(expression.value)}` : "";
            bindings.push([bindingSymbol, { expression, ...(valueDomain ? { domain: valueDomain } : {}), label: `${element.name.text}${rendered} for ${discriminant!.property}=${JSON.stringify(selectedLiteral)}` }]);
          }
          if (supported && bindings.length > 0) {
            for (const [symbol, binding] of bindings) destructuredBindings.set(symbol, binding);
            (fact.ignoredDeclarations ??= []).push(`${current.getStart(source)}:${current.getEnd()}`);
          }
        }
        ts.forEachChild(current, collectDestructuredBindings);
      };
      collectDestructuredBindings(node.body);
      const visitGuards = (current: ts.Node): void => {
        if (ts.isIdentifier(current)) {
          const binding = destructuredBindings.get(checker.getSymbolAtLocation(current)!);
          if (binding) {
            const span = `${current.getStart(source)}:${current.getEnd()}`;
            (fact.values ??= []).push({ span, label: `${binding.label} at ${span}`, expression: binding.expression, ...(binding.domain ? { domain: binding.domain } : {}) });
          }
        }
        if (ts.isElementAccessExpression(current) && current.argumentExpression
          && ts.isNumericLiteral(current.argumentExpression) && /^\d+$/.test(current.argumentExpression.text)
          && ts.isPropertyAccessExpression(current.expression)) {
          const tuplePath = rootedPropertyPath(current.expression);
          const index = Number(current.argumentExpression.text);
          const tupleType = checker.getTypeAtLocation(current.expression);
          const tupleTarget = tupleType as ts.Type & { target?: { readonly?: boolean } };
          const readonlyPath = tuplePath?.properties.every((access) => {
            const pathProperty = checker.getSymbolAtLocation(access.name);
            const pathDeclarations = pathProperty?.declarations ?? [];
            return pathDeclarations.length > 0 && pathDeclarations.every((declaration) =>
              (ts.getCombinedModifierFlags(declaration as ts.Declaration) & ts.ModifierFlags.Readonly) !== 0);
          });
          if (tuplePath && readonlyPath && checker.isTupleType(tupleType) && tupleTarget.target?.readonly === true) {
            const discriminant = fact.guards!.find((guard) => guard.kind === "discriminant");
            const receiverType = checker.getTypeAtLocation(tuplePath.root);
            const selectedProperty = discriminant?.property ? checker.getPropertyOfType(receiverType, discriminant.property) : undefined;
            const selectedType = selectedProperty && checker.getTypeOfSymbolAtLocation(selectedProperty, tuplePath.root);
            const selectedLiteral = selectedType?.isStringLiteral() ? selectedType.value : undefined;
            const narrowed = checker.getTypeAtLocation(current);
            let expression: LogicExpression | undefined;
            let valueDomain: NumericDomain | undefined;
            if (selectedLiteral && narrowed.isNumberLiteral() && Number.isSafeInteger(narrowed.value)) {
              expression = { kind: "integer", value: String(narrowed.value) };
            } else if (selectedLiteral && (narrowed.flags & ts.TypeFlags.BooleanLiteral) !== 0) {
              expression = { kind: "boolean", value: checker.typeToString(narrowed) === "true" };
            } else if (selectedLiteral && !narrowed.isUnion()) {
              const terminalProperty = checker.getSymbolAtLocation(tuplePath.properties[tuplePath.properties.length - 1]!.name);
              const declaredTypes = (terminalProperty?.declarations ?? []).flatMap((declaration) => {
                let typeNode = ts.isPropertySignature(declaration) || ts.isPropertyDeclaration(declaration)
                  || ts.isParameter(declaration) ? declaration.type : undefined;
                if (typeNode && ts.isTypeOperatorNode(typeNode) && typeNode.operator === ts.SyntaxKind.ReadonlyKeyword) typeNode = typeNode.type;
                return typeNode && ts.isTupleTypeNode(typeNode) && typeNode.elements[index]
                  ? [typeNode.elements[index]!.getText(declaration.getSourceFile())] : [];
              });
              if (declaredTypes.length > 0 && declaredTypes.every((value) => value === "Nat")) valueDomain = "nat";
              else if (declaredTypes.length > 0 && declaredTypes.every((value) => value === "Float")) valueDomain = "float";
              else if ((narrowed.flags & ts.TypeFlags.BooleanLike) !== 0) valueDomain = "bool";
              else if ((narrowed.flags & ts.TypeFlags.NumberLike) !== 0) valueDomain = "int";
              if (valueDomain) {
                const safeMember = selectedLiteral.replace(/[^A-Za-z0-9_$]/g, "_");
                const safePath = tuplePath.properties.map((access) => access.name.text).join("_").replace(/[^A-Za-z0-9_$]/g, "_");
                expression = variable(`${parameterName}_uneffect_${discriminant!.property}_${safeMember}_${safePath}_${index}`);
              }
            }
            if (expression) {
              const span = `${current.getStart(source)}:${current.getEnd()}`;
              const rendered = expression.kind === "boolean" || expression.kind === "integer" || expression.kind === "real"
                ? ` = ${String(expression.value)}` : `: ${valueDomain} for ${discriminant!.property}=${JSON.stringify(selectedLiteral)}`;
              (fact.values ??= []).push({ span, label: `${current.getText(source)}${rendered} at ${span}`, expression, ...(valueDomain ? { domain: valueDomain } : {}) });
            }
          }
        }
        const payloadPath = ts.isPropertyAccessExpression(current) ? rootedPropertyPath(current) : undefined;
        if (payloadPath && !fact.guards!.some((guard) =>
          guard.kind === "discriminant" && guard.property === payloadPath.properties[0]?.name.text)) {
          const terminalAccess = payloadPath.properties[payloadPath.properties.length - 1]!;
          const property = checker.getSymbolAtLocation(terminalAccess.name);
          const declarations = property?.declarations ?? [];
          const readonly = payloadPath.properties.every((access) => {
            const pathProperty = checker.getSymbolAtLocation(access.name);
            const pathDeclarations = pathProperty?.declarations ?? [];
            return pathDeclarations.length > 0 && pathDeclarations.every((declaration) =>
              (ts.getCombinedModifierFlags(declaration as ts.Declaration) & ts.ModifierFlags.Readonly) !== 0);
          });
          const narrowed = checker.getTypeAtLocation(current);
          let expression: LogicExpression | undefined;
          let valueDomain: NumericDomain | undefined;
          let memberLabel: string | undefined;
          if (readonly && narrowed.isNumberLiteral() && Number.isSafeInteger(narrowed.value)) {
            expression = { kind: "integer", value: String(narrowed.value) };
          } else if (readonly && (narrowed.flags & ts.TypeFlags.BooleanLiteral) !== 0) {
            expression = { kind: "boolean", value: checker.typeToString(narrowed) === "true" };
          } else if (readonly && !narrowed.isUnion()) {
            const discriminant = fact.guards!.find((guard) => guard.kind === "discriminant");
            const receiverType = checker.getTypeAtLocation(payloadPath.root);
            const selectedProperty = discriminant?.property ? checker.getPropertyOfType(receiverType, discriminant.property) : undefined;
            const selectedType = selectedProperty && checker.getTypeOfSymbolAtLocation(selectedProperty, payloadPath.root);
            const selectedLiteral = selectedType?.isStringLiteral() ? selectedType.value : undefined;
            if (selectedLiteral && fact.guards!.some((guard) => guard.kind === "discriminant" && guard.literal === selectedLiteral)) {
              const declaredTypes = declarations.flatMap((declaration) => {
                const typeNode = ts.isPropertySignature(declaration) || ts.isPropertyDeclaration(declaration)
                  || ts.isParameter(declaration) ? declaration.type : undefined;
                return typeNode ? [typeNode.getText(declaration.getSourceFile())] : [];
              });
              if (declaredTypes.length > 0 && declaredTypes.every((value) => value === "Nat")) valueDomain = "nat";
              else if (declaredTypes.length > 0 && declaredTypes.every((value) => value === "Float")) valueDomain = "float";
              else if ((narrowed.flags & ts.TypeFlags.BooleanLike) !== 0) valueDomain = "bool";
              else if ((narrowed.flags & ts.TypeFlags.NumberLike) !== 0) valueDomain = "int";
              if (valueDomain) {
                const safeMember = selectedLiteral.replace(/[^A-Za-z0-9_$]/g, "_");
                const safeProperty = payloadPath.properties.map((access) => access.name.text)
                  .join("_").replace(/[^A-Za-z0-9_$]/g, "_");
                expression = variable(`${parameterName}_uneffect_${discriminant!.property}_${safeMember}_${safeProperty}`);
                memberLabel = `${discriminant!.property}=${JSON.stringify(selectedLiteral)}`;
              }
            }
          }
          if (expression) {
            const span = `${current.getStart(source)}:${current.getEnd()}`;
            const rendered = expression.kind === "boolean" || expression.kind === "integer" || expression.kind === "real"
              ? ` = ${String(expression.value)}` : `: ${valueDomain} for ${memberLabel}`;
            (fact.values ??= []).push({ span, label: `${current.getText(source)}${rendered} at ${span}`, expression, ...(valueDomain ? { domain: valueDomain } : {}) });
          }
        }
        if (ts.isSwitchStatement(current) && ts.isPropertyAccessExpression(current.expression)
          && sameParameter(current.expression.expression)) {
          const span = `${current.expression.getStart(source)}:${current.expression.getEnd()}`;
          for (const guard of fact.guards!) if (guard.kind === "discriminant"
            && guard.property === current.expression.name.text) (guard.switchSpans ??= []).push(span);
        }
        if (ts.isBinaryExpression(current)) {
          const span = `${current.getStart(source)}:${current.getEnd()}`;
          for (const guard of fact.guards!) {
            if (guard.kind === "defined" && fact.domain === "bool") {
              const comparison = (left: ts.Expression, right: ts.Expression): boolean | undefined => {
                if (!sameParameterThroughScalarWrapper(left)) return undefined;
                if (right.kind === ts.SyntaxKind.TrueKeyword) return true;
                if (right.kind === ts.SyntaxKind.FalseKeyword) return false;
                return undefined;
              };
              const value = comparison(current.left, current.right) ?? comparison(current.right, current.left);
              if (value !== undefined) (guard.booleanComparisons ??= []).push({ span, value });
            }
            if ((current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
              || current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionEqualsToken)
              && guard.kind === "defined" && sameParameter(current.left)) {
              (guard.coalesceSpans ??= []).push(span);
            }
            if (guard.kind === "typeof-number" || guard.kind === "typeof-boolean") {
              const expected = guard.kind === "typeof-number" ? "number" : "boolean";
              const matches = (left: ts.Expression, right: ts.Expression): boolean => ts.isTypeOfExpression(left) && sameParameter(left.expression) && ts.isStringLiteral(right) && (right.text === expected || right.text === "string");
              if (matches(current.left, current.right) || matches(current.right, current.left)) guard.spans.push(span);
            } else if (guard.kind === "defined") {
              const matches = (left: ts.Expression, right: ts.Expression): boolean => {
                if (sameParameter(left)) {
                  if (right.kind === ts.SyntaxKind.NullKeyword) return true;
                  return ts.isIdentifier(right) && (checker.getTypeAtLocation(right).flags & ts.TypeFlags.Undefined) !== 0;
                }
                return guard.nullish === "undefined" && ts.isTypeOfExpression(left)
                  && sameParameter(left.expression) && ts.isStringLiteral(right) && right.text === "undefined";
              };
              if (matches(current.left, current.right) || matches(current.right, current.left)) guard.spans.push(span);
            } else {
              const matches = (left: ts.Expression, right: ts.Expression): boolean =>
                ts.isPropertyAccessExpression(left) && sameParameter(left.expression)
                && left.name.text === guard.property && ts.isStringLiteral(right) && right.text === guard.literal;
              if (matches(current.left, current.right) || matches(current.right, current.left)) guard.spans.push(span);
            }
          }
        }
        ts.forEachChild(current, visitGuards);
      };
      visitGuards(node.body);
    }
  }
  return facts;
}

/** Exact source spans whose operands are both TypeChecker-proven Boolean values. */
function typeCheckerBooleanLogicalOperations(program: ts.Program | undefined, fileName: string, text: string): Set<string> {
  const expressions = new Set<string>();
  if (!program) return expressions;
  const source = program.getSourceFile(fileName);
  if (!source || source.text !== text) return expressions;
  const errors = [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)]
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) return expressions;
  const checker = program.getTypeChecker();
  const booleanType = (type: ts.Type): boolean => {
    const members = type.isUnion() ? type.types : [type];
    return members.length > 0 && members.every((member) =>
      (member.flags & (ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLiteral)) !== 0);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node)
      && (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
        || node.operatorToken.kind === ts.SyntaxKind.BarBarToken
        || node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken
        || node.operatorToken.kind === ts.SyntaxKind.BarBarEqualsToken)
      && booleanType(checker.getTypeAtLocation(node.left))
      && booleanType(checker.getTypeAtLocation(node.right))) {
      expressions.add(`${node.getStart(source)}:${node.getEnd()}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return expressions;
}

/** Identifier reads whose checked use-site type has already excluded null and undefined. */
function typeCheckerNarrowedScalarReads(program: ts.Program | undefined, fileName: string, text: string): Set<string> {
  const reads = new Set<string>();
  if (!program) return reads;
  const source = program.getSourceFile(fileName);
  if (!source || source.text !== text) return reads;
  const errors = [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)]
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) return reads;
  const checker = program.getTypeChecker();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const type = checker.getTypeAtLocation(node);
      const members = type.isUnion() ? type.types : [type];
      const scalar = members.length > 0 && (members.every((member) => (member.flags & ts.TypeFlags.NumberLike) !== 0)
        || members.every((member) => (member.flags & ts.TypeFlags.BooleanLike) !== 0));
      if (scalar) reads.add(`${node.getStart(source)}:${node.getEnd()}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return reads;
}

/** Identifier expressions whose checked value is exactly undefined. */
function typeCheckerUndefinedReads(program: ts.Program | undefined, fileName: string, text: string): Set<string> {
  const reads = new Set<string>();
  if (!program) return reads;
  const source = program.getSourceFile(fileName);
  if (!source || source.text !== text) return reads;
  const errors = [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)]
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) return reads;
  const checker = program.getTypeChecker();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && (checker.getTypeAtLocation(node).flags & ts.TypeFlags.Undefined) !== 0) {
      reads.add(`${node.getStart(source)}:${node.getEnd()}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return reads;
}

/** Exact spans of reviewed expressions known to produce a non-nullish object. */
function typeCheckerPresentObjectExpressions(program: ts.Program | undefined, fileName: string, text: string): Set<string> {
  const reads = new Set<string>();
  if (!program) return reads;
  const source = program.getSourceFile(fileName);
  if (!source || source.text !== text) return reads;
  const errors = [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)]
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) return reads;
  const checker = program.getTypeChecker();
  const objectLike = (type: ts.Type): boolean => {
    const members = type.isUnion() ? type.types : [type];
    return members.length > 0
      && members.every((member) => (member.flags & (ts.TypeFlags.Object | ts.TypeFlags.NonPrimitive)) !== 0);
  };
  const standardErrorConstructor = (node: ts.NewExpression): boolean => {
    if (!ts.isIdentifier(node.expression)
      || !new Set(["Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "URIError", "EvalError"]).has(node.expression.text)) return false;
    const symbol = checker.getSymbolAtLocation(node.expression);
    return Boolean(symbol?.declarations?.length)
      && symbol!.declarations!.every((declaration) => program.isSourceFileDefaultLibrary(declaration.getSourceFile()))
      && (node.arguments?.length ?? 0) <= 1
      && (node.arguments?.length !== 1 || ts.isStringLiteral(node.arguments[0]!) || ts.isNoSubstitutionTemplateLiteral(node.arguments[0]!));
  };
  const visit = (node: ts.Node): void => {
    if ((ts.isIdentifier(node) && objectLike(checker.getTypeAtLocation(node)))
      || (ts.isObjectLiteralExpression(node) && node.properties.length === 0)
      || (ts.isArrayLiteralExpression(node) && node.elements.length === 0)
      || (ts.isNewExpression(node) && standardErrorConstructor(node))) {
      reads.add(`${node.getStart(source)}:${node.getEnd()}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return reads;
}

/** Explicitly typed block-scoped scalar declarations whose Program has no definite-assignment error. */
function typeCheckerDelayedScalarDeclarations(
  program: ts.Program | undefined,
  fileName: string,
  text: string,
): { declarations: Map<string, NumericDomain>; programDigest?: string } {
  const declarations = new Map<string, NumericDomain>();
  if (!program) return { declarations };
  const source = program.getSourceFile(fileName);
  if (!source || source.text !== text) return { declarations };
  const errors = [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)]
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) return { declarations };
  const programDigest = createHash("sha256").update(JSON.stringify({
    compilerOptions: program.getCompilerOptions(),
    sources: program.getSourceFiles().filter((item) => !item.isDeclarationFile)
      .map((item) => [item.fileName, createHash("sha256").update(item.text).digest("hex")]).sort(([left], [right]) => left!.localeCompare(right!)),
  })).digest("hex");
  const supportedTypes = new Map<string, NumericDomain>([
    ["number", "int"], ["Int", "int"], ["Nat", "nat"], ["Float", "float"], ["boolean", "bool"],
  ]);
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && !node.initializer && node.type
      && ts.isVariableDeclarationList(node.parent)
      && (node.parent.flags & ts.NodeFlags.Let) !== 0
      && supportedTypes.has(node.type.getText(source))) {
      declarations.set(`${node.getStart(source)}:${node.getEnd()}`, supportedTypes.get(node.type.getText(source))!);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { declarations, programDigest };
}

function boundedLiteralExponent(expression: ts.Expression): number | undefined {
  let current = expression;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current) || ts.isNonNullExpression(current)) current = current.expression;
  if (!ts.isNumericLiteral(current)) return undefined;
  const value = Number(current.text);
  return Number.isInteger(value) && value >= 0 && value <= 8 ? value : undefined;
}

function repeatedPower(base: LogicExpression, exponent: number): LogicExpression {
  if (exponent === 0) return { kind: "integer", value: "1" };
  let result = base;
  for (let index = 1; index < exponent; index++) result = { kind: "binary", operator: "mul", left: result, right: base };
  return result;
}

function typeCheckerBoundedPowerExpressions(program: ts.Program | undefined, fileName: string, text: string): Map<string, number> {
  const powers = new Map<string, number>();
  if (!program) return powers;
  const source = program.getSourceFile(fileName);
  if (!source || source.text !== text) return powers;
  const errors = [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)]
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) return powers;
  const checker = program.getTypeChecker();
  const numeric = (type: ts.Type): boolean => {
    const members = type.isUnion() ? type.types : [type];
    return members.length > 0 && members.every((member) => (member.flags & ts.TypeFlags.NumberLike) !== 0);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AsteriskAsteriskToken) {
      const exponent = boundedLiteralExponent(node.right);
      if (exponent !== undefined && numeric(checker.getTypeAtLocation(node.left)) && numeric(checker.getTypeAtLocation(node.right))) {
        powers.set(`${node.getStart(source)}:${node.getEnd()}`, exponent);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return powers;
}

function signedNonzeroIntegerLiteral(expression: ts.Expression): number | undefined {
  let current = expression;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current) || ts.isNonNullExpression(current)) current = current.expression;
  const sign = ts.isPrefixUnaryExpression(current) && current.operator === ts.SyntaxKind.MinusToken ? -1 : 1;
  const literal = sign < 0 && ts.isPrefixUnaryExpression(current) ? current.operand : current;
  if (!ts.isNumericLiteral(literal)) return undefined;
  const value = sign * Number(literal.text);
  return Number.isSafeInteger(value) && value !== 0 ? value : undefined;
}

function typeCheckerConstantIntegerRemainders(program: ts.Program | undefined, fileName: string, text: string): Map<string, number> {
  const remainders = new Map<string, number>();
  if (!program) return remainders;
  const source = program.getSourceFile(fileName);
  if (!source || source.text !== text) return remainders;
  const errors = [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)]
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) return remainders;
  const checker = program.getTypeChecker();
  const numeric = (type: ts.Type): boolean => {
    const members = type.isUnion() ? type.types : [type];
    return members.length > 0 && members.every((member) => (member.flags & ts.TypeFlags.NumberLike) !== 0);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && (node.operatorToken.kind === ts.SyntaxKind.PercentToken
      || node.operatorToken.kind === ts.SyntaxKind.PercentEqualsToken)) {
      const divisor = signedNonzeroIntegerLiteral(node.right);
      if (divisor !== undefined && numeric(checker.getTypeAtLocation(node.left)) && numeric(checker.getTypeAtLocation(node.right))) {
        remainders.set(`${node.getStart(source)}:${node.getEnd()}`, divisor);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return remainders;
}

/** Reviewed scalar Math calls, identified through the standard library declaration. */
function typeCheckerMathScalarCalls(program: ts.Program | undefined, fileName: string, text: string): Map<string, MathScalarCallFact> {
  const calls = new Map<string, MathScalarCallFact>();
  if (!program) return calls;
  const source = program.getSourceFile(fileName);
  if (!source || source.text !== text) return calls;
  const errors = [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)]
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) return calls;
  const checker = program.getTypeChecker();
  const standardLibraryMember = (symbol: ts.Symbol | undefined): boolean => Boolean(symbol?.declarations?.length)
    && symbol!.declarations!.every((declaration) => declaration.getSourceFile().isDeclarationFile
      && /(?:^|\/)lib\..*\.d\.ts$/.test(declaration.getSourceFile().fileName.replaceAll("\\", "/")));
  const standardMath = (symbol: ts.Symbol | undefined): boolean => Boolean(symbol?.declarations?.length)
    && symbol!.declarations!.every((declaration) => declaration.getSourceFile().isDeclarationFile
      && /(?:^|\/)lib\..*\.d\.ts$/.test(declaration.getSourceFile().fileName.replaceAll("\\", "/")))
    && symbol!.declarations!.some((declaration) => /(?:^|\/)lib\.es5\.d\.ts$/.test(declaration.getSourceFile().fileName.replaceAll("\\", "/")));
  const numeric = (type: ts.Type): boolean => {
    const members = type.isUnion() ? type.types : [type];
    return members.length > 0 && members.every((member) => (member.flags & ts.TypeFlags.NumberLike) !== 0);
  };
  const operations = new Set<MathScalarCallFact["operation"]>(["abs", "min", "max", "floor", "ceil", "trunc", "round", "sign", "pow"]);
  const aliasOperations = new Map<ts.Symbol, MathScalarCallFact["operation"]>();
  const collectAliases = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isVariableDeclarationList(node.parent)
      && (node.parent.flags & ts.NodeFlags.Const) !== 0 && node.initializer) {
      if (ts.isIdentifier(node.name) && ts.isIdentifier(node.initializer)) {
        const operation = aliasOperations.get(checker.getSymbolAtLocation(node.initializer)!);
        const binding = checker.getSymbolAtLocation(node.name);
        if (operation && binding) aliasOperations.set(binding, operation);
      }
      if (ts.isIdentifier(node.name) && ts.isPropertyAccessExpression(node.initializer)
        && ts.isIdentifier(node.initializer.expression) && node.initializer.expression.text === "Math"
        && standardMath(checker.getSymbolAtLocation(node.initializer.expression))
        && standardLibraryMember(checker.getSymbolAtLocation(node.initializer.name))
        && operations.has(node.initializer.name.text as MathScalarCallFact["operation"])) {
        const binding = checker.getSymbolAtLocation(node.name);
        if (binding) aliasOperations.set(binding, node.initializer.name.text as MathScalarCallFact["operation"]);
      }
      if (ts.isObjectBindingPattern(node.name) && ts.isIdentifier(node.initializer)
        && node.initializer.text === "Math" && standardMath(checker.getSymbolAtLocation(node.initializer))) {
        for (const element of node.name.elements) {
          const property = element.propertyName && ts.isIdentifier(element.propertyName)
            ? element.propertyName : !element.propertyName && ts.isIdentifier(element.name) ? element.name : undefined;
          if (!property || !ts.isIdentifier(element.name) || element.dotDotDotToken || element.initializer
            || !operations.has(property.text as MathScalarCallFact["operation"])
            || !standardLibraryMember(checker.getPropertyOfType(checker.getTypeAtLocation(node.initializer), property.text))) continue;
          const binding = checker.getSymbolAtLocation(element.name);
          if (binding) aliasOperations.set(binding, property.text as MathScalarCallFact["operation"]);
        }
      }
    }
    ts.forEachChild(node, collectAliases);
  };
  collectAliases(source);
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const direct = ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "Math"
        && standardMath(checker.getSymbolAtLocation(node.expression.expression))
        && standardLibraryMember(checker.getSymbolAtLocation(node.expression.name))
        && operations.has(node.expression.name.text as MathScalarCallFact["operation"])
        ? node.expression.name.text as MathScalarCallFact["operation"] : undefined;
      const operation = direct ?? (ts.isIdentifier(node.expression)
        ? aliasOperations.get(checker.getSymbolAtLocation(node.expression)!) : undefined);
      const arity = node.arguments.length;
      const exponent = operation === "pow" && node.arguments[1] ? boundedLiteralExponent(node.arguments[1]) : undefined;
      const supportedArity = operation === "pow" ? arity === 2 && exponent !== undefined
        : operation === "abs" || operation === "floor" || operation === "ceil"
        || operation === "trunc" || operation === "round" || operation === "sign" ? arity === 1
        : (operation === "min" || operation === "max") && arity >= 1 && arity <= 4;
      const signature = checker.getResolvedSignature(node);
      const standardSignature = signature?.declaration?.getSourceFile().isDeclarationFile === true
        && /(?:^|\/)lib\..*\.d\.ts$/.test(signature.declaration.getSourceFile().fileName.replaceAll("\\", "/"));
      if (supportedArity && operation && standardSignature
        && node.arguments.every((argument) => numeric(checker.getTypeAtLocation(argument)))) {
        calls.set(`${node.getStart(source)}:${node.getEnd()}`, { operation, ...(exponent === undefined ? {} : { exponent }) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return calls;
}

function typeCheckerThrowEffects(program: ts.Program | undefined, fileName: string, text: string): Map<string, string> {
  const effects = new Map<string, string>();
  if (!program) return effects;
  const source = program.getSourceFile(fileName);
  if (!source || source.text !== text) return effects;
  const adapter = new TypeScriptFrontendAdapter(program);
  const visit = (node: ts.Node): void => {
    if (ts.isThrowStatement(node)) effects.set(`${node.getStart(source)}:${node.getEnd()}`, `Throw<${adapter.thrownErrorType(node.expression)}>`);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return effects;
}

/** Recognize only Node's reviewed assertion binding; arbitrary user `asserts` declarations are not trusted. */
function typeCheckerAssertionCalls(program: ts.Program | undefined, fileName: string, text: string): Map<string, AssertionCallFact> {
  const facts = new Map<string, AssertionCallFact>();
  if (!program) return facts;
  const source = program.getSourceFile(fileName);
  if (!source || source.text !== text) return facts;
  const errors = [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)]
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) return facts;
  const checker = program.getTypeChecker();
  const adapter = new TypeScriptFrontendAdapter(program);
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const resolved = adapter.resolveCall(node);
      const assertionExport = resolved?.symbol.export;
      const invoked = (resolved?.symbol.module === "node:assert/strict" || resolved?.symbol.module === "node:assert")
        && (assertionExport === "ok" || assertionExport === "strict" || assertionExport === "default"
          || assertionExport === "strictEqual" || assertionExport === "notStrictEqual"
          || assertionExport === "ifError" || assertionExport === "fail")
        && resolved.semantics?.primitives.some((primitive) => primitive.kind === "throw" && primitive.error === "AssertionError");
      const signature = invoked ? checker.getResolvedSignature(node) : undefined;
      const predicate = signature && checker.getTypePredicateOfSignature(signature);
      const assertionPredicate = predicate
        && (predicate.kind === ts.TypePredicateKind.AssertsIdentifier || predicate.kind === ts.TypePredicateKind.AssertsThis);
      if (signature && (assertionExport === "fail" || assertionExport === "notStrictEqual" || assertionPredicate)) {
        facts.set(`${node.getStart(source)}:${node.getEnd()}`, {
          effect: "Throw<AssertionError>",
          condition: assertionExport === "strictEqual" ? "strict-equal"
            : assertionExport === "notStrictEqual" ? "strict-not-equal"
              : assertionExport === "ifError" ? "nullish"
              : assertionExport === "fail" ? "always-throw" : "truthy",
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return facts;
}

function typeCheckerDeclaredThrowCalls(program: ts.Program | undefined, fileName: string, text: string): Map<string, DeclaredThrowCallFact> {
  const facts = new Map<string, DeclaredThrowCallFact>();
  if (!program) return facts;
  const source = program.getSourceFile(fileName);
  if (!source || source.text !== text) return facts;
  const checker = program.getTypeChecker();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const signature = checker.getResolvedSignature(node), declaration = signature?.declaration;
      if (signature && declaration) {
        const declarationSource = declaration.getSourceFile();
        const comments = declarationSource.text.slice(declaration.getFullStart(), declaration.getStart(declarationSource));
        const effects = extractAnnotations(comments, "effect").flatMap((annotation) =>
          [...annotation.matchAll(/(?:^|\|)\s*Throw<\s*([^>]+?)\s*>/g)].map((match) => `Throw<${match[1]!.trim()}>`));
        if (effects.length > 0) facts.set(`${node.getStart(source)}:${node.getEnd()}`, {
          effects: [...new Set(effects)].sort(),
          definitelyThrows: (checker.getReturnTypeOfSignature(signature).flags & ts.TypeFlags.Never) !== 0,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return facts;
}

function typeCheckerAwaitRejections(
  program: ts.Program | undefined,
  fileName: string,
  text: string,
  options: InvariantLoweringOptions = {},
): Map<string, AwaitRejectionFact> {
  const facts = new Map<string, AwaitRejectionFact>();
  if (!program) return facts;
  const source = program.getSourceFile(fileName);
  if (!source || source.text !== text) return facts;
  const errors = [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)]
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) return facts;
  const checker = program.getTypeChecker(), adapter = new TypeScriptFrontendAdapter(program);
  const reviewedPresentObjects = typeCheckerPresentObjectExpressions(program, fileName, text);
  const standardPromiseMember = (call: ts.CallExpression, name: string): boolean => {
    const declaration = checker.getResolvedSignature(call)?.declaration;
    if (!declaration || !("name" in declaration) || !declaration.name) return false;
    const declarationName = ts.isIdentifier(declaration.name) || ts.isStringLiteral(declaration.name)
      ? declaration.name.text : undefined;
    const declarationFileName = declaration.getSourceFile().fileName.replaceAll("\\", "/");
    return declarationName === name
      && declaration.getSourceFile().isDeclarationFile
      && /(?:^|\/)lib\..*\.promise\.d\.ts$/.test(declarationFileName);
  };
  const scalarDomain = (type: ts.Type): NumericDomain | undefined => (type.flags & ts.TypeFlags.BooleanLike) !== 0 ? "bool"
    : (type.flags & ts.TypeFlags.NumberLike) !== 0 ? "int" : undefined;
  const symbolIsWritten = (symbol: ts.Symbol): boolean => {
    let written = false;
    const scan = (node: ts.Node): void => {
      if (written) return;
      if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
        && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment && ts.isIdentifier(node.left)
        && checker.getSymbolAtLocation(node.left) === symbol) {
        written = true;
        return;
      }
      if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && ts.isIdentifier(node.operand)
        && checker.getSymbolAtLocation(node.operand) === symbol) {
        written = true;
        return;
      }
      ts.forEachChild(node, scan);
    };
    scan(source);
    return written;
  };
  type LocalAsyncCallable = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction;
  const callableIdentity = (declaration: LocalAsyncCallable): { name: string; symbol: ts.Symbol } | undefined => {
    if (ts.isFunctionDeclaration(declaration) && declaration.name) {
      const symbol = checker.getSymbolAtLocation(declaration.name);
      return symbol ? { name: declaration.name.text, symbol } : undefined;
    }
    const variable = declaration.parent;
    if (!ts.isVariableDeclaration(variable) || variable.initializer !== declaration || !ts.isIdentifier(variable.name)
      || !ts.isVariableDeclarationList(variable.parent) || (variable.parent.flags & ts.NodeFlags.Const) === 0) return undefined;
    const symbol = checker.getSymbolAtLocation(variable.name);
    return symbol ? { name: variable.name.text, symbol } : undefined;
  };
  const stableCallable = (call: ts.CallExpression, targetSymbol: ts.Symbol): boolean => {
    if (!ts.isIdentifier(call.expression)) return false;
    const callSymbol = checker.getSymbolAtLocation(call.expression);
    if (!callSymbol || !targetSymbol || symbolIsWritten(callSymbol) || symbolIsWritten(targetSymbol)) return false;
    return callSymbol.declarations?.every((candidate) => ts.isFunctionDeclaration(candidate)
      || (ts.isVariableDeclaration(candidate) && ts.isVariableDeclarationList(candidate.parent)
        && (candidate.parent.flags & ts.NodeFlags.Const) !== 0)) === true;
  };
  const immutableScalarLiteral = (identifier: ts.Identifier): LogicExpression | undefined => {
    const symbol = checker.getSymbolAtLocation(identifier);
    if (!symbol || symbol.declarations?.length !== 1) return undefined;
    const declaration = symbol.declarations[0];
    if (!declaration || !ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)
      || !declaration.initializer || !ts.isVariableDeclarationList(declaration.parent)
      || (declaration.parent.flags & ts.NodeFlags.Const) === 0) return undefined;
    const initializer = declaration.initializer;
    if (initializer.kind === ts.SyntaxKind.TrueKeyword) return { kind: "boolean", value: true };
    if (initializer.kind === ts.SyntaxKind.FalseKeyword) return { kind: "boolean", value: false };
    if (ts.isNumericLiteral(initializer)) {
      const value = Number(initializer.text);
      return Number.isSafeInteger(value) ? { kind: "integer", value: String(value) } : undefined;
    }
    if (ts.isPrefixUnaryExpression(initializer)
      && (initializer.operator === ts.SyntaxKind.MinusToken || initializer.operator === ts.SyntaxKind.PlusToken)
      && ts.isNumericLiteral(initializer.operand)) {
      const magnitude = Number(initializer.operand.text);
      if (!Number.isSafeInteger(magnitude)) return undefined;
      const value = initializer.operator === ts.SyntaxKind.MinusToken ? -magnitude : magnitude;
      return { kind: "integer", value: String(value) };
    }
    return undefined;
  };
  const inferredLocalFulfillment = (
    call: ts.CallExpression,
    signature: ts.Signature,
    declaration: ts.SignatureDeclaration | ts.JSDocSignature,
  ): { fulfillment?: AwaitFulfillmentFact; rejectionEffect?: string; definitelyRejects: boolean } | undefined => {
    if (!(ts.isFunctionDeclaration(declaration) || ts.isFunctionExpression(declaration) || ts.isArrowFunction(declaration))
      || !declaration.body || (ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Async) === 0) return undefined;
    const identity = callableIdentity(declaration);
    if (!identity || !stableCallable(call, identity.symbol)) return undefined;
    const statements = ts.isBlock(declaration.body) ? [...declaration.body.statements] : undefined;
    const localDeclarations: ts.VariableDeclaration[] = [];
    while (statements?.[0] && ts.isVariableStatement(statements[0])) {
      const statement = statements.shift()! as ts.VariableStatement;
      if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0
        || statement.declarationList.declarations.length !== 1) return undefined;
      const local = statement.declarationList.declarations[0]!;
      if (!ts.isIdentifier(local.name) || !local.initializer) return undefined;
      localDeclarations.push(local);
    }
    const returnExpression = (statement: ts.Statement): ts.Expression | undefined => {
      if (ts.isReturnStatement(statement)) return statement.expression;
      return ts.isBlock(statement) && statement.statements.length === 1 && ts.isReturnStatement(statement.statements[0])
        ? statement.statements[0].expression : undefined;
    };
    const throwExpression = (statement: ts.Statement): ts.Expression | undefined => {
      if (ts.isThrowStatement(statement)) return statement.expression;
      return ts.isBlock(statement) && statement.statements.length === 1 && ts.isThrowStatement(statement.statements[0])
        ? statement.statements[0].expression : undefined;
    };
    let condition: ts.Expression | undefined;
    let whenTrue: ts.Expression | undefined;
    let whenFalse: ts.Expression | undefined;
    let requiredNormalGuard: { expression: ts.Expression; truth: boolean } | undefined;
    let rejectionExpression: ts.Expression | undefined;
    let definiteRejectionExpression: ts.Expression | undefined;
    if (!ts.isBlock(declaration.body)) {
      whenTrue = declaration.body;
    } else if (statements!.length === 1 && ts.isThrowStatement(statements![0])) {
      definiteRejectionExpression = statements![0].expression;
    } else if (statements!.length === 1 && ts.isReturnStatement(statements![0])) {
      whenTrue = statements![0].expression;
    } else if (statements!.length === 1 && ts.isIfStatement(statements![0])
      && statements![0].elseStatement) {
      const thenReturn = returnExpression(statements![0].thenStatement);
      const elseReturn = returnExpression(statements![0].elseStatement);
      const thenThrow = throwExpression(statements![0].thenStatement);
      const elseThrow = throwExpression(statements![0].elseStatement);
      if (thenReturn && elseReturn) {
        condition = statements![0].expression;
        whenTrue = thenReturn;
        whenFalse = elseReturn;
      } else if (thenThrow && elseReturn) {
        requiredNormalGuard = { expression: statements![0].expression, truth: false };
        rejectionExpression = thenThrow;
        whenTrue = elseReturn;
      } else if (thenReturn && elseThrow) {
        requiredNormalGuard = { expression: statements![0].expression, truth: true };
        rejectionExpression = elseThrow;
        whenTrue = thenReturn;
      }
    } else if (statements!.length === 2 && ts.isIfStatement(statements![0])
      && !statements![0].elseStatement) {
      const guardedReturn = returnExpression(statements![0].thenStatement);
      const guardedThrow = throwExpression(statements![0].thenStatement);
      const trailingReturn = returnExpression(statements![1]);
      const trailingThrow = throwExpression(statements![1]);
      if (guardedReturn && trailingReturn) {
        condition = statements![0].expression;
        whenTrue = guardedReturn;
        whenFalse = trailingReturn;
      } else if (guardedThrow && trailingReturn) {
        requiredNormalGuard = { expression: statements![0].expression, truth: false };
        rejectionExpression = guardedThrow;
        whenTrue = trailingReturn;
      } else if (guardedReturn && trailingThrow) {
        requiredNormalGuard = { expression: statements![0].expression, truth: true };
        rejectionExpression = trailingThrow;
        whenTrue = guardedReturn;
      }
    }
    if (!condition && !requiredNormalGuard && whenTrue) {
      let returned = whenTrue;
      while (ts.isParenthesizedExpression(returned)) returned = returned.expression;
      if (ts.isConditionalExpression(returned)) {
        condition = returned.condition;
        whenTrue = returned.whenTrue;
        whenFalse = returned.whenFalse;
      }
    }
    if ((!whenTrue && !definiteRejectionExpression) || Boolean(condition) !== Boolean(whenFalse)) return undefined;
    if (declaration.parameters.some((parameter) => !ts.isIdentifier(parameter.name)
      || parameter.initializer !== undefined || parameter.dotDotDotToken !== undefined)) return undefined;
    const parameters = declaration.parameters.map((parameter) => (parameter.name as ts.Identifier).text);
    const allowed = new Set(parameters);
    const captured: Environment = new Map();
    let closed = true;
    const inspect = (node: ts.Node): void => {
      if (!closed) return;
      if (ts.isIdentifier(node) && !allowed.has(node.text)) {
        const literal = immutableScalarLiteral(node);
        if (literal) captured.set(node.text, literal);
        else closed = false;
        return;
      }
      ts.forEachChild(node, inspect);
    };
    for (const local of localDeclarations) {
      inspect(local.initializer!);
      if (!closed || !scalarDomain(checker.getTypeAtLocation(local.initializer!))) return undefined;
      let value: LogicExpression;
      try { value = substitute(parseLogicExpression(local.initializer!.getText(source)), captured); } catch { return undefined; }
      captured.set((local.name as ts.Identifier).text, value);
      allowed.add((local.name as ts.Identifier).text);
    }
    if (whenTrue) inspect(whenTrue);
    if (condition) inspect(condition);
    if (whenFalse) inspect(whenFalse);
    if (requiredNormalGuard) inspect(requiredNormalGuard.expression);
    const awaitedType = checker.getAwaitedType(checker.getReturnTypeOfSignature(signature));
    const domain = awaitedType ? scalarDomain(awaitedType) : undefined;
    if (!closed || (whenTrue && (!domain || scalarDomain(checker.getTypeAtLocation(whenTrue)) !== domain))
      || (whenFalse && (!domain || scalarDomain(checker.getTypeAtLocation(whenFalse)) !== domain))
      || (condition && scalarDomain(checker.getTypeAtLocation(condition)) !== "bool")
      || (requiredNormalGuard && scalarDomain(checker.getTypeAtLocation(requiredNormalGuard.expression)) !== "bool")) return undefined;
    const rejectedValue = rejectionExpression ?? definiteRejectionExpression;
    const reviewedRejection = rejectedValue && ts.isNewExpression(rejectedValue)
      && reviewedPresentObjects.has(`${rejectedValue.getStart(source)}:${rejectedValue.getEnd()}`);
    const rejectionType = reviewedRejection ? adapter.thrownErrorType(rejectedValue!) : undefined;
    if (rejectedValue && (!reviewedRejection || rejectionType === "unknown")) return undefined;
    let clauses: AwaitFulfillmentFact["clauses"] | undefined;
    try {
      if (whenTrue) {
        const trueValue = substitute(parseLogicExpression(whenTrue.getText(source)), captured);
      if (!condition || !whenFalse) {
        clauses = [{
          source: `result === ${whenTrue.getText(source)}`,
          expression: { kind: "binary", operator: "eq", left: variable("result"), right: trueValue },
        }];
      } else {
        const guard = substitute(parseLogicExpression(condition.getText(source)), captured);
        const falseValue = substitute(parseLogicExpression(whenFalse.getText(source)), captured);
        clauses = [
          {
            source: `!(${condition.getText(source)}) || result === ${whenTrue.getText(source)}`,
            expression: {
              kind: "binary", operator: "or", left: { kind: "unary", operator: "not", operand: guard },
              right: { kind: "binary", operator: "eq", left: variable("result"), right: trueValue },
            },
          },
          {
            source: `${condition.getText(source)} || result === ${whenFalse.getText(source)}`,
            expression: {
              kind: "binary", operator: "or", left: guard,
              right: { kind: "binary", operator: "eq", left: variable("result"), right: falseValue },
            },
          },
        ];
      }
      if (requiredNormalGuard) {
        const guard = substitute(parseLogicExpression(requiredNormalGuard.expression.getText(source)), captured);
        const normalGuard = requiredNormalGuard.truth ? guard : { kind: "unary", operator: "not", operand: guard } satisfies LogicExpression;
        clauses.unshift({
          source: requiredNormalGuard.truth
            ? requiredNormalGuard.expression.getText(source) : `!(${requiredNormalGuard.expression.getText(source)})`,
          expression: normalGuard,
        });
      }
      }
    } catch { return undefined; }
    const declarationSource = declaration.getSourceFile();
    const fulfillment = whenTrue && domain && clauses ? {
      domain,
      functionName: identity.name,
      parameters,
      clauses,
      preconditions: [],
      declarationFileName: declarationSource.fileName,
      declarationDigest: createHash("sha256").update(declarationSource.text.slice(declaration.getStart(declarationSource), declaration.getEnd())).digest("hex"),
      declarationSpan: { start: declaration.getStart(declarationSource), end: declaration.getEnd() },
    } satisfies AwaitFulfillmentFact : undefined;
    return {
      ...(fulfillment ? { fulfillment } : {}),
      ...(rejectionType ? { rejectionEffect: `Reject<${rejectionType}>` } : {}),
      definitelyRejects: Boolean(definiteRejectionExpression),
    };
  };
  const analyzeCall = (call: ts.CallExpression, keyNode: ts.Node): void => {
    const key = `${keyNode.getStart(source)}:${keyNode.getEnd()}`;
    if (standardPromiseMember(call, "reject") && call.arguments[0]) {
      const argument = call.arguments[0]!;
      const errorType = adapter.thrownErrorType(argument);
      const rejectionType = errorType === "unknown" ? checker.typeToString(checker.getTypeAtLocation(argument)) : errorType;
      facts.set(key, {
        effect: `Reject<${rejectionType}>`, definitelyRejects: true, synchronousThrows: [], evidence: "verified", payloadFromFirstArgument: true,
      });
    } else if (standardPromiseMember(call, "resolve") && call.arguments.length === 1) {
      const argument = call.arguments[0]!;
      const argumentType = checker.getTypeAtLocation(argument);
      const domain: NumericDomain | undefined = (argumentType.flags & ts.TypeFlags.BooleanLike) !== 0 ? "bool"
        : (argumentType.flags & ts.TypeFlags.NumberLike) !== 0 ? "int" : undefined;
      const signature = checker.getResolvedSignature(call), declaration = signature?.declaration;
      if (domain && declaration) {
        const declarationSource = declaration.getSourceFile();
        facts.set(key, {
          definitelyRejects: false,
          synchronousThrows: [],
          evidence: "verified",
          payloadFromFirstArgument: false,
          fulfillment: {
            domain,
            functionName: "Promise.resolve",
            parameters: ["value"],
            clauses: [{ source: "result === value", expression: { kind: "binary", operator: "eq", left: variable("result"), right: variable("value") } }],
            preconditions: [],
            declarationFileName: declarationSource.fileName,
            declarationDigest: createHash("sha256").update(declarationSource.text.slice(declaration.getStart(declarationSource), declaration.getEnd())).digest("hex"),
            declarationSpan: { start: declaration.getStart(declarationSource), end: declaration.getEnd() },
          },
        });
      }
    } else {
      const signature = checker.getResolvedSignature(call);
      const declaration = signature?.declaration;
      if (signature && declaration && checker.getPropertyOfType(checker.getReturnTypeOfSignature(signature), "then")) {
        const declarationSource = declaration.getSourceFile();
        const external = options.externalContractBindings?.find((binding) =>
          binding.declarationFileName === declarationSource.fileName
          && binding.declarationSpan.start === declaration.getStart(declarationSource)
          && binding.declarationSpan.end === declaration.getEnd());
        const comments = declarationSource.text.slice(declaration.getFullStart(), declaration.getStart(declarationSource));
        const rejected = extractAnnotations(comments, "temporal_rejects");
        const thrown = extractAnnotations(comments, "temporal_throws");
        const contractEnsures = external?.summary.ensures ?? extractAnnotations(comments, "ensures");
        const contractRequires = external?.summary.requires ?? extractAnnotations(comments, "requires");
        const awaitedType = checker.getAwaitedType(checker.getReturnTypeOfSignature(signature));
        const awaitedDomain = awaitedType ? scalarDomain(awaitedType) : undefined;
        const declarationName = "name" in declaration ? declaration.name : undefined;
        const named = external?.summary.functionName
          ?? (declarationName && ts.isIdentifier(declarationName) ? declarationName.text : undefined);
        const parameters = external?.summary.parameters ?? (declaration.parameters.every((parameter) => ts.isIdentifier(parameter.name))
          ? declaration.parameters.map((parameter) => (parameter.name as ts.Identifier).text) : undefined);
        const declaredFulfillment = contractEnsures.length > 0 && awaitedDomain && named && parameters ? {
          domain: awaitedDomain,
          functionName: named,
          parameters,
          clauses: contractEnsures.map((clause) => ({ source: clause, expression: parseLogicExpression(clause) })),
          preconditions: contractRequires.map((clause) => ({ source: clause, expression: parseLogicExpression(clause) })),
          declarationFileName: declarationSource.fileName,
          declarationDigest: createHash("sha256").update(declarationSource.text.slice(declaration.getStart(declarationSource), declaration.getEnd())).digest("hex"),
          declarationSpan: { start: declaration.getStart(declarationSource), end: declaration.getEnd() },
        } satisfies AwaitFulfillmentFact : undefined;
        const inferred = contractEnsures.length === 0 && rejected.length === 0 && thrown.length === 0
          ? inferredLocalFulfillment(call, signature, declaration) : undefined;
        const fulfillment = declaredFulfillment ?? inferred?.fulfillment;
        const rejectionEffect = rejected.length === 1 ? `Reject<${rejected[0]}>` : inferred?.rejectionEffect;
        if (rejectionEffect || fulfillment) facts.set(key, {
          ...(rejectionEffect ? { effect: rejectionEffect } : {}), definitelyRejects: inferred?.definitelyRejects ?? false,
          synchronousThrows: [...new Set(thrown.map((errorType) => `Throw<${errorType}>`))].sort(),
          evidence: external?.evidence ?? (declaredFulfillment || rejected.length === 1 || thrown.length > 0 ? "trusted" : "verified"),
          payloadFromFirstArgument: false, ...(fulfillment ? { fulfillment } : {}),
        });
      } else if (signature && declaration) {
        const declarationSource = declaration.getSourceFile();
        const external = options.externalContractBindings?.find((binding) =>
          binding.declarationFileName === declarationSource.fileName
          && binding.declarationSpan.start === declaration.getStart(declarationSource)
          && binding.declarationSpan.end === declaration.getEnd());
        const resultDomain = scalarDomain(checker.getReturnTypeOfSignature(signature));
        if (external && resultDomain && external.summary.ensures.length > 0) {
          facts.set(key, {
            definitelyRejects: false,
            synchronousThrows: [],
            evidence: external.evidence,
            payloadFromFirstArgument: false,
            synchronousFulfillment: true,
            fulfillment: {
              domain: resultDomain,
              functionName: external.summary.functionName,
              parameters: external.summary.parameters,
              clauses: external.summary.ensures.map((clause) => ({ source: clause, expression: parseLogicExpression(clause) })),
              preconditions: external.summary.requires.map((clause) => ({ source: clause, expression: parseLogicExpression(clause) })),
              declarationFileName: declarationSource.fileName,
              declarationDigest: createHash("sha256").update(declarationSource.text.slice(declaration.getStart(declarationSource), declaration.getEnd())).digest("hex"),
              declarationSpan: { start: declaration.getStart(declarationSource), end: declaration.getEnd() },
            },
          });
        }
      }
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isAwaitExpression(node) && ts.isCallExpression(node.expression)) analyzeCall(node.expression, node);
    if (ts.isCallExpression(node)) analyzeCall(node, node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return facts;
}

function parseTsExpression(text: string): ts.Expression {
  const source = ts.createSourceFile("logic.ts", `const value = (${text})`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const statement = source.statements[0];
  const expression = statement && ts.isVariableStatement(statement) ? statement.declarationList.declarations[0]?.initializer : undefined;
  if (!expression) throw new Error(`invalid invariant expression: ${text}`);
  return expression;
}

function semanticGuardExpression(node: ts.Expression, guards: ReadonlyMap<string, readonly SemanticGuardFact[]>): LogicExpression | undefined {
  if (!ts.isBinaryExpression(node)) return undefined;
  const equality = node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken || node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken;
  const inequality = node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken || node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken;
  if (!equality && !inequality) return undefined;
  const span = `${node.getStart()}:${node.getEnd()}`;
  const guarded = (name: string, kind: SemanticGuardKind, positive: boolean, nullish?: "undefined" | "null", strict = false): LogicExpression | undefined => {
    const fact = guards.get(name)?.find((item) => item.kind === kind);
    if (!fact || !fact.spans.includes(span) || strict && nullish !== undefined && fact.nullish !== nullish) return undefined;
    const value = variable(fact.variable);
    return positive ? value : negate(value);
  };
  const nullishKind = (value: ts.Expression): "undefined" | "null" | undefined =>
    ts.isIdentifier(value) && value.text === "undefined" ? "undefined" : value.kind === ts.SyntaxKind.NullKeyword ? "null" : undefined;
  const identifierNullish = (left: ts.Expression, right: ts.Expression): LogicExpression | undefined => {
    const kind = nullishKind(right);
    if (!ts.isIdentifier(left) || !kind) return undefined;
    const strict = node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken || node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken;
    return guarded(left.text, "defined", inequality, kind, strict);
  };
  const directNullish = identifierNullish(node.left, node.right) ?? identifierNullish(node.right, node.left);
  if (directNullish) return directNullish;
  const nullableBooleanLiteral = (left: ts.Expression, right: ts.Expression): LogicExpression | undefined => {
    let current = left;
    while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current)
      || ts.isTypeAssertionExpression(current) || ts.isNonNullExpression(current)) current = current.expression;
    if (!ts.isIdentifier(current)) return undefined;
    const literal = right.kind === ts.SyntaxKind.TrueKeyword ? true
      : right.kind === ts.SyntaxKind.FalseKeyword ? false : undefined;
    if (literal === undefined) return undefined;
    const fact = guards.get(current.text)?.find((candidate) => candidate.kind === "defined"
      && candidate.valueVariable && candidate.booleanComparisons?.some((comparison) => comparison.span === span && comparison.value === literal));
    if (!fact) return undefined;
    const payload = variable(fact.valueVariable!);
    const matchesPayload = literal ? payload : negate(payload);
    const matches: LogicExpression = { kind: "binary", operator: "and", left: variable(fact.variable), right: matchesPayload };
    return equality ? matches : negate(matches);
  };
  const directBoolean = nullableBooleanLiteral(node.left, node.right) ?? nullableBooleanLiteral(node.right, node.left);
  if (directBoolean) return directBoolean;
  const typeofScalar = (left: ts.Expression, right: ts.Expression): LogicExpression | undefined => {
    if (!ts.isTypeOfExpression(left) || !ts.isIdentifier(left.expression) || !ts.isStringLiteral(right)) return undefined;
    if (right.text === "number") return guarded(left.expression.text, "typeof-number", equality);
    if (right.text === "boolean") return guarded(left.expression.text, "typeof-boolean", equality);
    if (right.text === "string") {
      return guarded(left.expression.text, "typeof-number", !equality)
        ?? guarded(left.expression.text, "typeof-boolean", !equality);
    }
    return undefined;
  };
  const typeofUndefined = (left: ts.Expression, right: ts.Expression): LogicExpression | undefined =>
    ts.isTypeOfExpression(left) && ts.isIdentifier(left.expression) && ts.isStringLiteral(right) && right.text === "undefined"
      ? guarded(left.expression.text, "defined", !equality, "undefined", true) : undefined;
  const discriminant = (left: ts.Expression, right: ts.Expression): LogicExpression | undefined => {
    if (!ts.isPropertyAccessExpression(left) || !ts.isIdentifier(left.expression) || !ts.isStringLiteral(right)) return undefined;
    const fact = guards.get(left.expression.text)?.find((item) => item.kind === "discriminant"
      && item.property === left.name.text && item.literal === right.text && item.spans.includes(span));
    if (!fact) return undefined;
    const value = variable(fact.variable);
    return equality ? value : negate(value);
  };
  return typeofScalar(node.left, node.right) ?? typeofScalar(node.right, node.left)
    ?? typeofUndefined(node.left, node.right) ?? typeofUndefined(node.right, node.left)
    ?? discriminant(node.left, node.right) ?? discriminant(node.right, node.left);
}

function logic(node: ts.Expression, pipeBindings: ReadonlySet<string> = new Set(), semanticGuards: ReadonlyMap<string, readonly SemanticGuardFact[]> = new Map(), semanticValues: ReadonlyMap<string, LogicExpression> = new Map()): LogicExpression {
  const narrowed = semanticValues.get(`${node.getStart()}:${node.getEnd()}`);
  if (narrowed) return narrowed;
  if (ts.isParenthesizedExpression(node)) return logic(node.expression, pipeBindings, semanticGuards, semanticValues);
  if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node)) return logic(node.expression, pipeBindings, semanticGuards, semanticValues);
  const guard = semanticGuardExpression(node, semanticGuards);
  if (guard) return guard;
  if (ts.isIdentifier(node)) return { kind: "variable", name: node.text };
  if (ts.isNumericLiteral(node)) return node.text.includes(".") ? { kind: "real", value: node.text } : { kind: "integer", value: node.text };
  if (node.kind === ts.SyntaxKind.TrueKeyword) return { kind: "boolean", value: true };
  if (node.kind === ts.SyntaxKind.FalseKeyword) return { kind: "boolean", value: false };
  if (ts.isPrefixUnaryExpression(node)) {
    if (node.operator === ts.SyntaxKind.ExclamationToken) return { kind: "unary", operator: "not", operand: logic(node.operand, pipeBindings, semanticGuards, semanticValues) };
    if (node.operator === ts.SyntaxKind.MinusToken) return { kind: "unary", operator: "negate", operand: logic(node.operand, pipeBindings, semanticGuards, semanticValues) };
  }
  if (ts.isBinaryExpression(node)) {
    const operators = new Map<ts.SyntaxKind, string>([
      [ts.SyntaxKind.PlusToken, "add"], [ts.SyntaxKind.MinusToken, "sub"], [ts.SyntaxKind.AsteriskToken, "mul"],
      [ts.SyntaxKind.LessThanToken, "lt"],
      [ts.SyntaxKind.LessThanEqualsToken, "lte"], [ts.SyntaxKind.GreaterThanToken, "gt"], [ts.SyntaxKind.GreaterThanEqualsToken, "gte"],
      [ts.SyntaxKind.EqualsEqualsToken, "eq"], [ts.SyntaxKind.EqualsEqualsEqualsToken, "eq"],
      [ts.SyntaxKind.ExclamationEqualsToken, "neq"], [ts.SyntaxKind.ExclamationEqualsEqualsToken, "neq"],
      [ts.SyntaxKind.AmpersandAmpersandToken, "and"], [ts.SyntaxKind.BarBarToken, "or"],
    ]);
    const operator = operators.get(node.operatorToken.kind);
    if (operator) return { kind: "binary", operator, left: logic(node.left, pipeBindings, semanticGuards, semanticValues), right: logic(node.right, pipeBindings, semanticGuards, semanticValues) };
  }
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && pipeBindings.has(node.expression.text) && node.arguments.length >= 2) {
    let value = logic(node.arguments[0]!, pipeBindings, semanticGuards, semanticValues);
    for (const stage of node.arguments.slice(1)) {
      if ((!ts.isArrowFunction(stage) && !ts.isFunctionExpression(stage)) || stage.parameters.length !== 1
        || !ts.isIdentifier(stage.parameters[0]!.name) || ts.isBlock(stage.body)) {
        throw new Error("verified effect/Function pipe requires inline unary expression callbacks");
      }
      value = substitute(logic(stage.body, pipeBindings, semanticGuards, semanticValues), new Map([[stage.parameters[0]!.name.text, value]]));
    }
    return value;
  }
  throw new Error(`unsupported invariant expression: ${node.getText()}`);
}

export function parseLogicExpression(text: string): LogicExpression { return logic(parseTsExpression(text)); }

/** Decides small, purely-boolean implications over the same IR emitted to Z3. */
export function proveBooleanImplication(assumptionSources: string[], goalSource: string): boolean {
  try {
    const assumptions = assumptionSources.map(parseLogicExpression), goal = parseLogicExpression(goalSource);
    const names = new Set<string>();
    const collect = (expression: LogicExpression): void => {
      if (expression.kind === "variable") names.add(expression.name);
      else if (expression.kind === "unary") collect(expression.operand);
      else if (expression.kind === "binary") { collect(expression.left); collect(expression.right); }
    };
    [...assumptions, goal].forEach(collect);
    if (names.size > 12) return false;
    const variables = [...names];
    const evaluate = (expression: LogicExpression, values: Map<string, boolean>): boolean => {
      if (expression.kind === "boolean") return expression.value;
      if (expression.kind === "variable") return values.get(expression.name)!;
      if (expression.kind === "unary" && expression.operator === "not") return !evaluate(expression.operand, values);
      if (expression.kind === "binary" && expression.operator === "and") return evaluate(expression.left, values) && evaluate(expression.right, values);
      if (expression.kind === "binary" && expression.operator === "or") return evaluate(expression.left, values) || evaluate(expression.right, values);
      if (expression.kind === "binary" && expression.operator === "eq") return evaluate(expression.left, values) === evaluate(expression.right, values);
      if (expression.kind === "binary" && expression.operator === "neq") return evaluate(expression.left, values) !== evaluate(expression.right, values);
      throw new Error("non-boolean ownership guard");
    };
    for (let bits = 0; bits < 2 ** variables.length; bits++) {
      const values = new Map(variables.map((name, index) => [name, Boolean(bits & (1 << index))]));
      if (assumptions.every((item) => evaluate(item, values)) && !evaluate(goal, values)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function substitute(expression: LogicExpression, env: Environment): LogicExpression {
  if (expression.kind === "variable") return env.get(expression.name) ?? expression;
  if (expression.kind === "unary") return { ...expression, operand: substitute(expression.operand, env) };
  if (expression.kind === "binary") return { ...expression, left: substitute(expression.left, env), right: substitute(expression.right, env) };
  return expression;
}

function negate(expression: LogicExpression): LogicExpression { return { kind: "unary", operator: "not", operand: expression }; }
function variable(name: string): LogicExpression { return { kind: "variable", name }; }

function domain(type: ts.TypeNode | undefined, checkerFact?: ParameterTypeFact): NumericDomain {
  const name = type?.getText() ?? "number";
  if (name === "boolean") return "bool";
  if (name === "Nat") return "nat";
  if (name === "Float") return "float";
  if (name === "number" || name === "Int") return "int";
  if (checkerFact) return checkerFact.domain;
  throw new Error(`unsupported contract parameter type: ${name}`);
}
function sort(value: NumericDomain): LogicSort { return value === "bool" ? "Bool" : value === "float" ? "Real" : "Int"; }

function stableId(value: Omit<InvariantObligation, "id">): string {
  return `inv_${createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 20)}`;
}

function controlFlowBlockId(fileName: string, functionName: string, span: { start: number; end: number }, completion: ContractControlFlowEvidence["completion"]): string {
  return `cfg_${createHash("sha256").update(JSON.stringify({ fileName, functionName, span, completion })).digest("hex").slice(0, 20)}`;
}

function makeObligation(value: Omit<InvariantObligation, "id">): InvariantObligation { return { id: stableId(value), ...value }; }

/** Maps a lowering rejection to the concrete edit that brings the function back into the verified subset. */
function loweringHint(message: string): string | undefined {
  if (message.startsWith("call requires a verified function summary")) return "inline the callee, or move the call out of the contracted function; the prototype has no call summaries yet";
  if (message.startsWith("unsupported invariant statement")) return "the verified statement subset is: lexical blocks, initialized variables, scalar assignment, if/else, bounded literal switch, invariant-backed loops, try/catch/finally, throw, and return";
  if (message.startsWith("while requires")) return "write /* uneffect:loop_invariant ... */ directly above the while statement";
  if (message.startsWith("unsupported invariant expression") || message.startsWith("invalid invariant expression")) return "the expression language is scalar arithmetic/comparisons, Boolean short circuit, reviewed Math scalar operations, and imported effect/Function pipe with inline unary callbacks";
  if (message.startsWith("unsupported contract parameter type")) return "annotate the parameter as number, Int, Nat, Float, or boolean";
  if (message.startsWith("destructured contract parameters")) return "give the parameter one identifier name and destructure inside the body";
  if (message.startsWith("only initialized identifier variables")) return "declare one identifier per binding and initialize it where it is declared";
  if (message.startsWith("verified effect/Function pipe")) return "write each pipe stage as an inline arrow with one parameter and an expression body";
  return undefined;
}

function locatedLowering(cause: unknown, functionName: string, span: { start: number; end: number }): InvariantLoweringError {
  if (cause instanceof InvariantLoweringError) return cause;
  const message = cause instanceof Error ? cause.message : String(cause);
  return new InvariantLoweringError(message, { functionName, span, hint: loweringHint(message) });
}

export function lowerInvariantProgram(
  fileName: string,
  text: string,
  program?: ts.Program,
  options: InvariantLoweringOptions = {},
): InvariantObligation[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const checkerFacts = typeCheckerParameterFacts(program, fileName, text);
  const booleanLogicalOperations = typeCheckerBooleanLogicalOperations(program, fileName, text);
  const narrowedScalarReads = typeCheckerNarrowedScalarReads(program, fileName, text);
  const undefinedReads = typeCheckerUndefinedReads(program, fileName, text);
  const presentObjectExpressions = typeCheckerPresentObjectExpressions(program, fileName, text);
  const delayedScalars = typeCheckerDelayedScalarDeclarations(program, fileName, text);
  const boundedPowerExpressions = typeCheckerBoundedPowerExpressions(program, fileName, text);
  const constantIntegerRemainders = typeCheckerConstantIntegerRemainders(program, fileName, text);
  const mathScalarCalls = typeCheckerMathScalarCalls(program, fileName, text);
  const throwEffects = typeCheckerThrowEffects(program, fileName, text);
  const assertionCalls = typeCheckerAssertionCalls(program, fileName, text);
  const declaredThrowCalls = typeCheckerDeclaredThrowCalls(program, fileName, text);
  const awaitRejections = typeCheckerAwaitRejections(program, fileName, text, options);
  const pipeBindings = new Set(source.statements.flatMap((statement): string[] => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
      || statement.moduleSpecifier.text !== "effect/Function" || !statement.importClause?.namedBindings
      || !ts.isNamedImports(statement.importClause.namedBindings)) return [];
    return statement.importClause.namedBindings.elements
      .filter((element) => (element.propertyName ?? element.name).text === "pipe")
      .map((element) => element.name.text);
  }));
  const obligations: InvariantObligation[] = [];
  type ContractCallable = (ts.FunctionDeclaration | ts.MethodDeclaration) & {
    readonly name: ts.Identifier;
    readonly body: ts.Block;
  };
  const contractCallables: ContractCallable[] = [];
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
      contractCallables.push(statement as ContractCallable);
      continue;
    }
    const visitObjectMethods = (node: ts.Node): void => {
      if (ts.isMethodDeclaration(node) && ts.isObjectLiteralExpression(node.parent)
        && ts.isIdentifier(node.name) && node.body) {
        contractCallables.push(node as ContractCallable);
        return;
      }
      ts.forEachChild(node, visitObjectMethods);
    };
    visitObjectMethods(statement);
  }
  for (const node of contractCallables) {
    const comments = source.text.slice(node.getFullStart(), node.getStart(source));
    const header = { start: node.getStart(source), end: node.getEnd() };
    let requires: LogicExpression[];
    let ensures: Array<{ source: string; expression: LogicExpression }>;
    try {
      requires = extractAnnotations(comments, "requires").map(parseLogicExpression);
      ensures = extractAnnotations(comments, "ensures").map((value) => ({ source: value, expression: parseLogicExpression(value) }));
    } catch (cause) {
      throw locatedLowering(cause, node.name.text, header);
    }
    if (!requires.length && !ensures.length) continue;
    const variables: ObligationVariable[] = [];
    const env: Environment = new Map();
    const baseAssumptions = [...requires];
    const narrowingLabels: string[] = [];
    const semanticGuards = new Map<string, readonly SemanticGuardFact[]>();
    const semanticValues = new Map<string, LogicExpression>();
    const objectAliasDeclarations = new Set<string>();
    let checkerProgramDigest: string | undefined;
    const functionObligationStart = obligations.length;
    for (const parameter of node.parameters) {
      if (!ts.isIdentifier(parameter.name)) throw new InvariantLoweringError(`destructured contract parameters are unsupported: ${parameter.name.getText(source)}`, { functionName: node.name.text, span: { start: parameter.getStart(source), end: parameter.getEnd() }, hint: loweringHint("destructured contract parameters") });
      let parameterDomain: NumericDomain;
      const checkerFact = checkerFacts.get(`${node.getStart(source)}:${parameter.name.text}`);
      try {
        parameterDomain = domain(parameter.type, checkerFact);
      } catch (cause) {
        throw locatedLowering(cause, node.name.text, header);
      }
      if (checkerFact?.represented !== false) {
        variables.push({ name: parameter.name.text, domain: parameterDomain, sort: sort(parameterDomain) });
        env.set(parameter.name.text, variable(parameter.name.text));
      }
      if (checkerFact) checkerProgramDigest = checkerFact.programDigest;
      if (checkerFact?.assumption) baseAssumptions.push(checkerFact.assumption);
      if (checkerFact?.label) narrowingLabels.push(checkerFact.label);
      if (checkerFact?.guards?.length) {
        semanticGuards.set(parameter.name.text, checkerFact.guards);
        for (const alias of checkerFact.aliases ?? []) {
          semanticGuards.set(alias.name, checkerFact.guards);
          objectAliasDeclarations.add(alias.declarationSpan);
        }
        for (const declarationSpan of checkerFact.ignoredDeclarations ?? []) objectAliasDeclarations.add(declarationSpan);
        for (const guard of checkerFact.guards) {
          variables.push({ name: guard.variable, domain: "bool", sort: "Bool" });
          narrowingLabels.push(guard.label);
          if (guard.kind === "defined" && checkerFact.domain === "bool" && guard.valueVariable) {
            baseAssumptions.push({
              kind: "binary",
              operator: "or",
              left: variable(guard.variable),
              right: negate(variable(guard.valueVariable)),
            });
          }
        }
      }
      for (const value of checkerFact?.values ?? []) {
        semanticValues.set(value.span, value.expression);
        narrowingLabels.push(value.label);
        if (value.domain && value.expression.kind === "variable") {
          const valueName = value.expression.name;
          if (!variables.some((candidate) => candidate.name === valueName)) {
            variables.push({ name: valueName, domain: value.domain, sort: sort(value.domain) });
            if (value.domain === "nat") baseAssumptions.push({ kind: "binary", operator: "gte", left: value.expression, right: { kind: "integer", value: "0" } });
          }
        }
      }
      if (parameterDomain === "nat") baseAssumptions.push({ kind: "binary", operator: "gte", left: variable(parameter.name.text), right: { kind: "integer", value: "0" } });
    }
    const fn = node.name.text;
    const asyncBoundary = (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Async) !== 0;
    const displayNames: Record<string, string> = {};
    const visibleBindings = (bound: Environment): ObligationBinding[] => [...bound]
      .filter(([name, expression]) => !(expression.kind === "variable" && expression.name === name))
      .map(([name, expression]) => ({ name, expression }));
    const add = (kind: InvariantObligation["kind"], target: ts.Node, assumptions: LogicExpression[], goal: LogicExpression, clause: string, bound: Environment, dischargedThrows: ContractThrowEdge[] = [], relationalCalls: ContractRelationalCallEvidence[] = []): void => {
      const span = { start: target.getStart(source), end: target.getEnd() };
      const completion: ContractControlFlowEvidence["completion"] = kind === "postcondition" ? "return" : kind === "call-precondition" ? "call" : kind === "loop-init" ? "loop-entry" : "loop-back-edge";
      const controlFlow: ContractControlFlowEvidence = {
        schema: "uneffect-contract-control-flow/v1",
        blockId: controlFlowBlockId(fileName, fn, span, completion),
        completion,
        pathConditions: [...assumptions],
        ...(relationalCalls.length === 0 ? {} : { relationalCalls: [...relationalCalls] }),
        ...(narrowingLabels.length === 0 ? {} : { narrowing: { source: "typescript-typechecker", typescriptVersion: ts.version, programDigest: checkerProgramDigest!, facts: [...narrowingLabels] } }),
        exceptionFlow: { schema: "uneffect-contract-exception-flow/v1", discharged: [...dischargedThrows], escapes: [] },
      };
      const value: Omit<InvariantObligation, "id"> = { kind, fileName, functionName: fn, span, variables: [...variables], assumptions, goal, source: clause, bindings: visibleBindings(bound), displayNames: { ...displayNames }, controlFlow };
      obligations.push(makeObligation(value));
    };
    interface ExecutionContext { breakTarget?: number; continueTarget?: number }
    const execute = (statements: readonly ts.Statement[], initial: PathState[], context: ExecutionContext = {}): PathState[] => {
      let paths = initial;
      for (const statement of statements) {
        try {
          const abrupt = paths.filter((path) => path.completion !== "normal");
          const normal = paths.filter((path) => path.completion === "normal");
          paths = [...abrupt, ...step(statement, normal, context)];
        } catch (cause) {
          throw locatedLowering(cause, fn, { start: statement.getStart(source), end: statement.getEnd() });
        }
      }
      return paths;
    };
    const executeAwait = (
      awaited: ts.AwaitExpression,
      incoming: PathState[],
      target?: { binding?: string; nullableGuard?: SemanticGuardFact; returnStatement?: ts.ReturnStatement },
    ): PathState[] => {
      const directCall = ts.isCallExpression(awaited.expression) ? awaited.expression : undefined;
      const directFact = directCall ? awaitRejections.get(`${awaited.getStart(source)}:${awaited.getEnd()}`) : undefined;
      const binding = ts.isIdentifier(awaited.expression) ? awaited.expression.text : undefined;
      const settle = (path: PathState): PathState[] => {
        const pending = binding ? path.pendingPromises.get(binding) : undefined;
        const fact = directFact ?? pending?.fact;
        if (!fact) throw new Error(`await requires a verified rejection or fulfillment summary: ${awaited.expression.getText(source)}`);
        const originSpan = pending?.originSpan ?? { start: awaited.getStart(source), end: awaited.getEnd() };
        const argumentValues = pending?.argumentValues ?? directCall?.arguments.map((argument) => {
          try { return substitute(logic(argument, pipeBindings, semanticGuards, semanticValues), path.env); } catch { return undefined; }
        }) ?? [];
        const pendingPromises = new Map(path.pendingPromises);
        if (pending) {
          const observed: PendingPromiseState = { ...pending, observed: true };
          for (const [name, candidate] of pendingPromises) if (candidate === pending) pendingPromises.set(name, observed);
        }
        const base: PathState = { ...path, env: new Map(path.env), pendingPromises };
        const fulfilled: PathState[] = [];
        if (!fact.definitelyRejects) {
          if (target?.binding || target?.returnStatement) {
            if (!fact.fulfillment) throw new Error(`awaited value requires a scalar contract ensures summary: ${awaited.expression.getText(source)}`);
            if (argumentValues.length !== fact.fulfillment.parameters.length || argumentValues.some((value) => value === undefined)) {
              throw new Error(`awaited contract arguments require scalar snapshots matching ${fact.fulfillment.functionName}`);
            }
            const fresh = `${fn}_await_result_${awaited.getStart(source)}`;
            if (!variables.some(({ name }) => name === fresh)) variables.push({ name: fresh, domain: fact.fulfillment.domain, sort: sort(fact.fulfillment.domain) });
            if (target.nullableGuard) {
              if (!target.binding || !target.nullableGuard.valueVariable) throw new Error(`awaited scalar fulfillment requires a scalar nullable target: ${awaited.expression.getText(source)}`);
              if (sort(fact.fulfillment.domain) !== scalarExpressionSort(variable(target.nullableGuard.valueVariable))) {
                throw new Error(`awaited scalar fulfillment does not match nullable target: ${target.binding} = ${awaited.expression.getText(source)}`);
              }
            }
            const summaryEnv: Environment = new Map([["result", variable(fresh)]]);
            fact.fulfillment.parameters.forEach((name, index) => summaryEnv.set(name, argumentValues[index]!));
            const nextEnv = new Map(base.env);
            if (target.binding) nextEnv.set(target.binding, variable(fresh));
            if (target.nullableGuard) nextEnv.set(target.nullableGuard.variable, { kind: "boolean", value: true });
            const evidence: ContractRelationalCallEvidence = {
              schema: "uneffect-contract-relational-call/v1", evidence: fact.evidence, typescriptVersion: ts.version,
              functionName: fact.fulfillment.functionName,
              clauses: fact.fulfillment.clauses.map(({ source: clause }) => clause), callSpan: originSpan,
              ...(fact.fulfillment.preconditions.length === 0 ? {} : { preconditions: fact.fulfillment.preconditions.map(({ source: clause }) => clause) }),
              declarationFileName: fact.fulfillment.declarationFileName,
              declarationDigest: fact.fulfillment.declarationDigest,
              declarationSpan: fact.fulfillment.declarationSpan,
            };
            if (!pending?.preconditionsChecked) for (const precondition of fact.fulfillment.preconditions) {
              add("call-precondition", awaited, base.assumptions, substitute(precondition.expression, summaryEnv), precondition.source, base.env, base.dischargedThrows, [...base.relationalCalls, evidence]);
            }
            const assumptions = [...base.assumptions, ...fact.fulfillment.clauses.map(({ expression }) => substitute(expression, summaryEnv))];
            if (!target.returnStatement) fulfilled.push({ ...base, env: nextEnv, assumptions, relationalCalls: [...base.relationalCalls, evidence] });
            else {
              const returnEnv = new Map(nextEnv); returnEnv.set("result", variable(fresh));
              fulfilled.push({ ...base, env: nextEnv, assumptions, completion: "return", returnEnv, returnStatement: target.returnStatement, relationalCalls: [...base.relationalCalls, evidence] });
            }
          } else fulfilled.push(base);
        }
        const rejected: PathState[] = fact.effect ? [{
          ...base, completion: "reject",
          thrown: { kind: "promise-rejection", evidence: fact.evidence, effect: fact.effect, originSpan, ...(argumentValues[0] ? { payload: argumentValues[0] } : {}) },
        }] : [];
        const synchronousThrows = pending ? [] : fact.synchronousThrows.map((effect): PathState => ({
          ...base, completion: "throw", thrown: { kind: "synchronous-throw", evidence: fact.evidence, effect, originSpan },
        }));
        return [...fulfilled, ...rejected, ...synchronousThrows];
      };
      return incoming.flatMap(settle);
    };
    const scalarExpressionSort = (expression: LogicExpression): LogicSort | undefined => {
      if (expression.kind === "boolean") return "Bool";
      if (expression.kind === "integer") return "Int";
      if (expression.kind === "real") return "Real";
      if (expression.kind === "variable") return variables.find(({ name }) => name === expression.name)?.sort;
      if (expression.kind === "unary") return expression.operator === "not" ? "Bool"
        : expression.operator === "floor" || expression.operator === "ceil" ? "Int" : scalarExpressionSort(expression.operand);
      if (["lt", "lte", "gt", "gte", "eq", "neq", "and", "or"].includes(expression.operator)) return "Bool";
      return scalarExpressionSort(expression.left);
    };
    const evaluateCondition = (expression: ts.Expression, environment: Environment): LogicExpression => {
      const condition = substitute(logic(expression, pipeBindings, semanticGuards, semanticValues), environment);
      if (scalarExpressionSort(condition) !== "Bool") {
        throw new Error(`control-flow condition requires a Boolean-valued expression: ${expression.getText(source)}`);
      }
      return condition;
    };
    const unsafeNullableScalarCopy = (expression: ts.Expression): string | undefined => {
      let current = expression;
      while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current)
        || ts.isTypeAssertionExpression(current) || ts.isNonNullExpression(current)) current = current.expression;
      if (!ts.isIdentifier(current) || !semanticGuards.get(current.text)?.some((guard) => guard.kind === "defined")) return undefined;
      return narrowedScalarReads.has(`${current.getStart(source)}:${current.getEnd()}`) ? undefined : current.text;
    };
    const directNullishValue = (expression: ts.Expression): "null" | "undefined" | undefined => {
      let current = expression;
      while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current)
        || ts.isTypeAssertionExpression(current) || ts.isNonNullExpression(current)) current = current.expression;
      if (current.kind === ts.SyntaxKind.NullKeyword) return "null";
      return ts.isIdentifier(current) && undefinedReads.has(`${current.getStart(source)}:${current.getEnd()}`)
        ? "undefined" : undefined;
    };
    const assertNoSharedNullableAliasMutation = (name: string, expression: ts.Expression): void => {
      const state = semanticGuards.get(name);
      if (state?.some((guard) => guard.kind === "defined")
        && [...semanticGuards].some(([other, candidate]) => other !== name && candidate === state)) {
        throw new Error(`nullable mutation would change shared immutable-alias state: ${expression.getText(source)}`);
      }
    };
    const evaluateIntegerRemainder = (
      left: ts.Expression,
      divisor: number,
      path: PathState,
    ): Array<{ path: PathState; value: LogicExpression }> => evaluateScalar(left, path).flatMap(({ path: branch, value }) => {
      if (scalarExpressionSort(value) !== "Int") {
        throw new Error(`integer remainder requires an Int-valued left operand: ${left.getText(source)}`);
      }
      const zero: LogicExpression = { kind: "integer", value: "0" };
      const magnitude: LogicExpression = { kind: "integer", value: String(Math.abs(divisor)) };
      const nonNegative: LogicExpression = { kind: "binary", operator: "gte", left: value, right: zero };
      return [
        {
          path: { ...branch, env: new Map(branch.env), assumptions: [...branch.assumptions, nonNegative] },
          value: { kind: "binary", operator: "int-mod", left: value, right: magnitude },
        },
        {
          path: { ...branch, env: new Map(branch.env), assumptions: [...branch.assumptions, negate(nonNegative)] },
          value: { kind: "unary", operator: "negate", operand: { kind: "binary", operator: "int-mod", left: { kind: "unary", operator: "negate", operand: value }, right: magnitude } },
        },
      ];
    });
    const evaluateScalar = (expression: ts.Expression, path: PathState): Array<{ path: PathState; value: LogicExpression }> => {
      let unwrapped = expression;
      while (ts.isParenthesizedExpression(unwrapped) || ts.isAsExpression(unwrapped)
        || ts.isTypeAssertionExpression(unwrapped) || ts.isNonNullExpression(unwrapped)) unwrapped = unwrapped.expression;
      if (ts.isConditionalExpression(unwrapped)) {
        const condition = evaluateCondition(unwrapped.condition, path.env);
        const whenTrue = { ...path, env: new Map(path.env), assumptions: [...path.assumptions, condition] };
        const whenFalse = { ...path, env: new Map(path.env), assumptions: [...path.assumptions, negate(condition)] };
        return [
          ...evaluateScalar(unwrapped.whenTrue, whenTrue),
          ...evaluateScalar(unwrapped.whenFalse, whenFalse),
        ];
      }
      if (ts.isBinaryExpression(unwrapped) && unwrapped.operatorToken.kind === ts.SyntaxKind.AsteriskAsteriskToken) {
        const exponent = boundedPowerExpressions.get(`${unwrapped.getStart(source)}:${unwrapped.getEnd()}`);
        if (exponent === undefined) throw new Error(`unsupported invariant expression: ${unwrapped.getText(source)}`);
        return evaluateScalar(unwrapped.left, path).map(({ path: branch, value }) => ({ path: branch, value: repeatedPower(value, exponent) }));
      }
      if (ts.isBinaryExpression(unwrapped) && unwrapped.operatorToken.kind === ts.SyntaxKind.PercentToken) {
        const divisor = constantIntegerRemainders.get(`${unwrapped.getStart(source)}:${unwrapped.getEnd()}`);
        if (divisor === undefined) throw new Error(`unsupported invariant expression: ${unwrapped.getText(source)}`);
        return evaluateIntegerRemainder(unwrapped.left, divisor, path);
      }
      if (ts.isBinaryExpression(unwrapped)
        && unwrapped.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
        && ts.isIdentifier(unwrapped.left)) {
        const span = `${unwrapped.getStart(source)}:${unwrapped.getEnd()}`;
        const guard = semanticGuards.get(unwrapped.left.text)?.find((candidate) =>
          candidate.kind === "defined" && candidate.valueVariable !== undefined
          && candidate.coalesceSpans?.includes(span));
        if (!guard) throw new Error(`unsupported invariant expression: ${unwrapped.getText(source)}`);
        const valueVariable = guard.valueVariable!;
        const defined = substitute(variable(guard.variable), path.env);
        const whenDefined = { ...path, env: new Map(path.env), assumptions: [...path.assumptions, defined] };
        const whenNullish = { ...path, env: new Map(path.env), assumptions: [...path.assumptions, negate(defined)] };
        return [
          { path: whenDefined, value: substitute(variable(valueVariable), whenDefined.env) },
          ...evaluateScalar(unwrapped.right, whenNullish),
        ];
      }
      if (ts.isBinaryExpression(unwrapped)
        && (unwrapped.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
          || unwrapped.operatorToken.kind === ts.SyntaxKind.BarBarToken)) {
        const span = `${unwrapped.getStart(source)}:${unwrapped.getEnd()}`;
        if (!booleanLogicalOperations.has(span)) {
          throw new Error(`unsupported invariant expression: ${unwrapped.getText(source)}`);
        }
        const left = substitute(logic(unwrapped.left, pipeBindings, semanticGuards, semanticValues), path.env);
        const whenTrue = { ...path, env: new Map(path.env), assumptions: [...path.assumptions, left] };
        const whenFalse = { ...path, env: new Map(path.env), assumptions: [...path.assumptions, negate(left)] };
        if (unwrapped.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
          return [
            { path: whenFalse, value: { kind: "boolean", value: false } },
            ...evaluateScalar(unwrapped.right, whenTrue),
          ];
        }
        return [
          { path: whenTrue, value: { kind: "boolean", value: true } },
          ...evaluateScalar(unwrapped.right, whenFalse),
        ];
      }
      const mathFact = ts.isCallExpression(unwrapped)
        ? mathScalarCalls.get(`${unwrapped.getStart(source)}:${unwrapped.getEnd()}`) : undefined;
      const externalFact = ts.isCallExpression(unwrapped)
        ? awaitRejections.get(`${unwrapped.getStart(source)}:${unwrapped.getEnd()}`) : undefined;
      if (ts.isCallExpression(unwrapped) && externalFact?.synchronousFulfillment && externalFact.fulfillment) {
        const fulfillment = externalFact.fulfillment;
        let argumentsByPath: Array<{ path: PathState; values: LogicExpression[] }> = [{ path, values: [] }];
        for (const argument of unwrapped.arguments) {
          argumentsByPath = argumentsByPath.flatMap((current) =>
            evaluateScalar(argument, current.path).map(({ path: branch, value }) => ({ path: branch, values: [...current.values, value] })));
        }
        if (argumentsByPath.some(({ values }) => values.length !== fulfillment.parameters.length)) {
          throw new Error(`contract arguments require scalar snapshots matching ${fulfillment.functionName}`);
        }
        const fresh = `${fn}_call_result_${unwrapped.getStart(source)}`;
        if (!variables.some(({ name }) => name === fresh)) variables.push({ name: fresh, domain: fulfillment.domain, sort: sort(fulfillment.domain) });
        return argumentsByPath.map(({ path: branch, values }) => {
          const summaryEnv: Environment = new Map([["result", variable(fresh)]]);
          fulfillment.parameters.forEach((name, index) => summaryEnv.set(name, values[index]!));
          const evidence: ContractRelationalCallEvidence = {
            schema: "uneffect-contract-relational-call/v1", evidence: externalFact.evidence, typescriptVersion: ts.version,
            functionName: fulfillment.functionName,
            clauses: fulfillment.clauses.map(({ source: clause }) => clause), callSpan: { start: unwrapped.getStart(source), end: unwrapped.getEnd() },
            ...(fulfillment.preconditions.length === 0 ? {} : { preconditions: fulfillment.preconditions.map(({ source: clause }) => clause) }),
            declarationFileName: fulfillment.declarationFileName,
            declarationDigest: fulfillment.declarationDigest,
            declarationSpan: fulfillment.declarationSpan,
          };
          for (const precondition of fulfillment.preconditions) {
            add("call-precondition", unwrapped, branch.assumptions, substitute(precondition.expression, summaryEnv), precondition.source, branch.env, branch.dischargedThrows, [...branch.relationalCalls, evidence]);
          }
          return {
            path: {
              ...branch,
              assumptions: [...branch.assumptions, ...fulfillment.clauses.map(({ expression }) => substitute(expression, summaryEnv))],
              relationalCalls: [...branch.relationalCalls, evidence],
            },
            value: variable(fresh),
          };
        });
      }
      if (ts.isCallExpression(unwrapped) && mathFact) {
        const fact = mathFact;
        let argumentsByPath: Array<{ path: PathState; values: LogicExpression[] }> = [{ path, values: [] }];
        for (const argument of unwrapped.arguments) {
          argumentsByPath = argumentsByPath.flatMap((current) =>
            evaluateScalar(argument, current.path).map(({ path: branch, value }) => ({ path: branch, values: [...current.values, value] })));
        }
        if (fact.operation === "abs") {
          return argumentsByPath.flatMap(({ path: branch, values }) => {
            const value = values[0]!;
            const nonNegative: LogicExpression = { kind: "binary", operator: "gte", left: value, right: { kind: "integer", value: "0" } };
            return [
              { path: { ...branch, env: new Map(branch.env), assumptions: [...branch.assumptions, nonNegative] }, value },
              { path: { ...branch, env: new Map(branch.env), assumptions: [...branch.assumptions, negate(nonNegative)] }, value: { kind: "unary", operator: "negate", operand: value } as LogicExpression },
            ];
          });
        }
        if (fact.operation === "floor" || fact.operation === "ceil" || fact.operation === "round") {
          return argumentsByPath.map(({ path: branch, values }) => {
            const operand = fact.operation === "round" ? {
              kind: "binary", operator: "add", left: values[0]!, right: { kind: "real", value: "0.5" },
            } as LogicExpression : values[0]!;
            return { path: branch, value: { kind: "unary", operator: fact.operation === "ceil" ? "ceil" : "floor", operand } };
          });
        }
        if (fact.operation === "trunc") {
          return argumentsByPath.flatMap(({ path: branch, values }) => {
            const value = values[0]!;
            const nonNegative: LogicExpression = { kind: "binary", operator: "gte", left: value, right: { kind: "integer", value: "0" } };
            return [
              { path: { ...branch, env: new Map(branch.env), assumptions: [...branch.assumptions, nonNegative] }, value: { kind: "unary", operator: "floor", operand: value } as LogicExpression },
              { path: { ...branch, env: new Map(branch.env), assumptions: [...branch.assumptions, negate(nonNegative)] }, value: { kind: "unary", operator: "ceil", operand: value } as LogicExpression },
            ];
          });
        }
        if (fact.operation === "sign") {
          return argumentsByPath.flatMap(({ path: branch, values }) => {
            const value = values[0]!, zero: LogicExpression = { kind: "integer", value: "0" };
            const negative: LogicExpression = { kind: "binary", operator: "lt", left: value, right: zero };
            const equal: LogicExpression = { kind: "binary", operator: "eq", left: value, right: zero };
            const positive: LogicExpression = { kind: "binary", operator: "gt", left: value, right: zero };
            return [
              { path: { ...branch, env: new Map(branch.env), assumptions: [...branch.assumptions, negative] }, value: { kind: "integer", value: "-1" } as LogicExpression },
              { path: { ...branch, env: new Map(branch.env), assumptions: [...branch.assumptions, equal] }, value: zero },
              { path: { ...branch, env: new Map(branch.env), assumptions: [...branch.assumptions, positive] }, value: { kind: "integer", value: "1" } as LogicExpression },
            ];
          });
        }
        if (fact.operation === "pow") {
          return argumentsByPath.map(({ path: branch, values }) => ({ path: branch, value: repeatedPower(values[0]!, fact.exponent!) }));
        }
        return argumentsByPath.flatMap(({ path: branch, values }) => {
          let candidates: Array<{ path: PathState; value: LogicExpression }> = [{ path: branch, value: values[0]! }];
          for (const next of values.slice(1)) {
            candidates = candidates.flatMap((candidate) => {
              const selected: LogicExpression = {
                kind: "binary", operator: fact.operation === "min" ? "lte" : "gte",
                left: candidate.value, right: next,
              };
              return [
                { path: { ...candidate.path, env: new Map(candidate.path.env), assumptions: [...candidate.path.assumptions, selected] }, value: candidate.value },
                { path: { ...candidate.path, env: new Map(candidate.path.env), assumptions: [...candidate.path.assumptions, negate(selected)] }, value: next },
              ];
            });
          }
          return candidates;
        });
      }
      return [{ path, value: substitute(logic(unwrapped, pipeBindings, semanticGuards, semanticValues), path.env) }];
    };
    const evaluateNullableAssignment = (
      expression: ts.Expression,
      path: PathState,
      targetName: string,
      target: SemanticGuardFact,
    ): PathState[] => {
      let unwrapped = expression;
      while (ts.isParenthesizedExpression(unwrapped) || ts.isAsExpression(unwrapped)
        || ts.isTypeAssertionExpression(unwrapped) || ts.isNonNullExpression(unwrapped)) unwrapped = unwrapped.expression;
      if (ts.isConditionalExpression(unwrapped)) {
        const condition = evaluateCondition(unwrapped.condition, path.env);
        return [
          ...evaluateNullableAssignment(unwrapped.whenTrue, {
            ...path, env: new Map(path.env), assumptions: [...path.assumptions, condition],
          }, targetName, target),
          ...evaluateNullableAssignment(unwrapped.whenFalse, {
            ...path, env: new Map(path.env), assumptions: [...path.assumptions, negate(condition)],
          }, targetName, target),
        ];
      }
      const nullish = directNullishValue(unwrapped);
      if (nullish) {
        if (target.nullish !== nullish && target.nullish !== "nullish") {
          throw new Error(`nullable target does not admit direct ${nullish} assignment: ${targetName} = ${expression.getText(source)}`);
        }
        const nextEnv = new Map(path.env);
        nextEnv.set(target.variable, { kind: "boolean", value: false });
        if (target.valueVariable && scalarExpressionSort(variable(target.valueVariable)) === "Bool") {
          nextEnv.set(targetName, { kind: "boolean", value: false });
        }
        return [{ ...path, env: nextEnv }];
      }
      if (!target.valueVariable && presentObjectExpressions.has(`${unwrapped.getStart(source)}:${unwrapped.getEnd()}`)) {
        const nextEnv = new Map(path.env);
        nextEnv.set(target.variable, { kind: "boolean", value: true });
        return [{ ...path, env: nextEnv }];
      }
      if (ts.isIdentifier(unwrapped)) {
        const sourceGuard = semanticGuards.get(unwrapped.text)?.find((guard) => guard.kind === "defined");
        const sourceIsNarrowed = narrowedScalarReads.has(`${unwrapped.getStart(source)}:${unwrapped.getEnd()}`);
        if (sourceGuard && !sourceIsNarrowed) {
          if (target.nullish !== "nullish" && sourceGuard.nullish !== target.nullish) {
            throw new Error(`nullable source absence is not admitted by target: ${targetName} = ${unwrapped.text}`);
          }
          if (Boolean(sourceGuard.valueVariable) !== Boolean(target.valueVariable)) {
            throw new Error(`nullable assignment requires matching presence representation: ${targetName} = ${unwrapped.text}`);
          }
          const nextEnv = new Map(path.env);
          if (sourceGuard.valueVariable && target.valueVariable) {
            const payload = substitute(variable(sourceGuard.valueVariable), path.env);
            if (scalarExpressionSort(payload) !== scalarExpressionSort(variable(target.valueVariable))) {
              throw new Error(`nullable scalar assignment requires matching payload sorts: ${targetName} = ${unwrapped.text}`);
            }
            nextEnv.set(targetName, payload);
          }
          nextEnv.set(target.variable, substitute(variable(sourceGuard.variable), path.env));
          return [{ ...path, env: nextEnv }];
        }
      }
      if (!target.valueVariable) {
        throw new Error(`presence-only object assignment requires nullish, a present object identifier, or a compatible nullable identifier: ${targetName} = ${expression.getText(source)}`);
      }
      const nullableSource = unsafeNullableScalarCopy(unwrapped);
      if (nullableSource) throw new Error(`scalar assignment would erase nullable presence: ${targetName} = ${nullableSource}`);
      return evaluateScalar(unwrapped, path).map(({ path: branch, value }) => {
        if (scalarExpressionSort(value) !== scalarExpressionSort(variable(target.valueVariable!))) {
          throw new Error(`nullable scalar assignment requires a matching right operand: ${targetName} = ${expression.getText(source)}`);
        }
        const nextEnv = new Map(branch.env);
        nextEnv.set(targetName, value);
        nextEnv.set(target.variable, { kind: "boolean", value: true });
        return { ...branch, env: nextEnv };
      });
    };
    const applyScalarUpdate = (update: ts.Expression | undefined, path: PathState): PathState => {
      if (!update) return path;
      const next = { ...path, env: new Map(path.env) };
      if ((ts.isPostfixUnaryExpression(update) || ts.isPrefixUnaryExpression(update))
        && (update.operator === ts.SyntaxKind.PlusPlusToken || update.operator === ts.SyntaxKind.MinusMinusToken)
        && ts.isIdentifier(update.operand)) {
        assertNoSharedNullableAliasMutation(update.operand.text, update);
        const previous = next.env.get(update.operand.text) ?? variable(update.operand.text);
        next.env.set(update.operand.text, {
          kind: "binary", operator: update.operator === ts.SyntaxKind.PlusPlusToken ? "add" : "sub",
          left: previous, right: { kind: "integer", value: "1" },
        });
        return next;
      }
      if (ts.isBinaryExpression(update) && update.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(update.left)) {
        assertNoSharedNullableAliasMutation(update.left.text, update);
        next.env.set(update.left.text, substitute(logic(update.right, pipeBindings, semanticGuards, semanticValues), next.env));
        return next;
      }
      if (ts.isBinaryExpression(update) && ts.isIdentifier(update.left)) {
        const operators = new Map<ts.SyntaxKind, Extract<LogicExpression, { kind: "binary" }>["operator"]>([
          [ts.SyntaxKind.PlusEqualsToken, "add"], [ts.SyntaxKind.MinusEqualsToken, "sub"],
          [ts.SyntaxKind.AsteriskEqualsToken, "mul"],
        ]);
        const operator = operators.get(update.operatorToken.kind);
        if (operator) {
          assertNoSharedNullableAliasMutation(update.left.text, update);
          const previous = next.env.get(update.left.text) ?? variable(update.left.text);
          next.env.set(update.left.text, { kind: "binary", operator, left: previous, right: substitute(logic(update.right, pipeBindings, semanticGuards, semanticValues), next.env) });
          return next;
        }
      }
      throw new Error("scalar update must be one identifier assignment, arithmetic compound assignment, or ++/-- expression");
    };
    const executeScopedBlock = (block: ts.Block, initial: PathState[], context: ExecutionContext): PathState[] => {
      const lexicalNames: string[] = [];
      const functionNames: string[] = [];
      const bindingNames = (name: ts.BindingName): string[] => {
        if (ts.isIdentifier(name)) return [name.text];
        return name.elements.flatMap((element): string[] => ts.isOmittedExpression(element) ? [] : bindingNames(element.name));
      };
      for (const child of block.statements) {
        if (!ts.isVariableStatement(child)) continue;
        const lexical = (child.declarationList.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) !== 0;
        for (const declaration of child.declarationList.declarations) {
          (lexical ? lexicalNames : functionNames).push(...bindingNames(declaration.name));
        }
      }
      if (new Set(lexicalNames).size !== lexicalNames.length) throw new Error("duplicate lexical bindings in a block are unsupported");
      const shadowed = lexicalNames.find((name) => initial.some((path) => path.env.has(name) || path.pendingPromises.has(name)));
      if (shadowed) throw new Error(`block lexical binding shadows a tracked scalar: ${shadowed}`);
      const retained = new Set([...initial.flatMap((path) => [...path.env.keys()]), ...functionNames]);
      return execute(block.statements, initial, context).map((exit): PathState => {
        const env = new Map([...exit.env].filter(([name]) => retained.has(name)));
        for (const [name, pending] of exit.pendingPromises) {
          if (lexicalNames.includes(name) && !pending.observed
            && ![...exit.pendingPromises].some(([other, candidate]) => retained.has(other) && candidate === pending)) {
            throw new Error(`unobserved Promise binding left its lexical scope: ${name}`);
          }
        }
        const pendingPromises = new Map([...exit.pendingPromises].filter(([name]) => retained.has(name)));
        const returnEnv = exit.returnEnv && new Map([...exit.returnEnv].filter(([name]) => name === "result" || retained.has(name)));
        return { ...exit, env, pendingPromises, ...(returnEnv ? { returnEnv } : {}) };
      });
    };
    /** One statement of the verified subset; anything else is rejected with its own location. */
    const step = (statement: ts.Statement, incoming: PathState[], context: ExecutionContext): PathState[] => {
      let paths = incoming;
      if (ts.isBlock(statement)) {
        paths = executeScopedBlock(statement, paths, context);
      } else if (ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1
        && ts.isIdentifier(statement.declarationList.declarations[0]!.name)
        && statement.declarationList.declarations[0]!.initializer
        && ts.isAwaitExpression(statement.declarationList.declarations[0]!.initializer)) {
        const declaration = statement.declarationList.declarations[0]!;
        paths = executeAwait(declaration.initializer as ts.AwaitExpression, paths, { binding: (declaration.name as ts.Identifier).text });
      } else if (ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1
        && ts.isIdentifier(statement.declarationList.declarations[0]!.name)
        && statement.declarationList.declarations[0]!.initializer
        && ts.isCallExpression(statement.declarationList.declarations[0]!.initializer)
        && awaitRejections.has(`${statement.declarationList.declarations[0]!.initializer.getStart(source)}:${statement.declarationList.declarations[0]!.initializer.getEnd()}`)) {
        const declaration = statement.declarationList.declarations[0]!;
        const call = declaration.initializer as ts.CallExpression;
        const fact = awaitRejections.get(`${call.getStart(source)}:${call.getEnd()}`);
        if (!fact) throw new Error(`Promise binding requires a verified rejection or fulfillment summary: ${call.getText(source)}`);
        if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) throw new Error(`Promise-producing binding must be const: ${declaration.getText(source)}`);
        const name = (declaration.name as ts.Identifier).text;
        const originSpan = { start: call.getStart(source), end: call.getEnd() };
        paths = paths.flatMap((path): PathState[] => {
          const argumentValues = call.arguments.map((argument): LogicExpression | undefined => {
            try { return substitute(logic(argument, pipeBindings, semanticGuards, semanticValues), path.env); } catch { return undefined; }
          });
          if (fact.fulfillment && (argumentValues.length !== fact.fulfillment.parameters.length || argumentValues.some((value) => value === undefined))) {
            throw new Error(`Promise-producing call arguments require scalar snapshots matching ${fact.fulfillment.functionName}`);
          }
          if (fact.fulfillment?.preconditions.length) {
            const summaryEnv: Environment = new Map();
            fact.fulfillment.parameters.forEach((parameter, index) => summaryEnv.set(parameter, argumentValues[index]!));
            const evidence: ContractRelationalCallEvidence = {
              schema: "uneffect-contract-relational-call/v1", evidence: fact.evidence, typescriptVersion: ts.version,
              functionName: fact.fulfillment.functionName,
              clauses: fact.fulfillment.clauses.map(({ source: clause }) => clause), callSpan: originSpan,
              preconditions: fact.fulfillment.preconditions.map(({ source: clause }) => clause),
              declarationFileName: fact.fulfillment.declarationFileName,
              declarationDigest: fact.fulfillment.declarationDigest,
              declarationSpan: fact.fulfillment.declarationSpan,
            };
            for (const precondition of fact.fulfillment.preconditions) {
              add("call-precondition", call, path.assumptions, substitute(precondition.expression, summaryEnv), precondition.source, path.env, path.dischargedThrows, [...path.relationalCalls, evidence]);
            }
          }
          const pending: PendingPromiseState = { fact, argumentValues, originSpan, observed: false, preconditionsChecked: true };
          const pendingPromises = new Map(path.pendingPromises); pendingPromises.set(name, pending);
          const normal: PathState = { ...path, env: new Map(path.env), pendingPromises };
          const synchronous = fact.synchronousThrows.map((effect): PathState => ({
            ...path, env: new Map(path.env), pendingPromises: new Map(path.pendingPromises), completion: "throw",
            thrown: { kind: "synchronous-throw", evidence: fact.evidence, effect, originSpan },
          }));
          return [normal, ...synchronous];
        });
      } else if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (objectAliasDeclarations.has(`${declaration.getStart(source)}:${declaration.getEnd()}`)) continue;
          const delayedDomain = !declaration.initializer
            ? delayedScalars.declarations.get(`${declaration.getStart(source)}:${declaration.getEnd()}`) : undefined;
          if (delayedDomain && ts.isIdentifier(declaration.name)) {
            const bindingName = declaration.name.text;
            checkerProgramDigest ??= delayedScalars.programDigest;
            narrowingLabels.push(`${bindingName}: ${declaration.type!.getText(source)} definite assignment checked by TypeScript`);
            const fresh = `${fn}_${bindingName}_uninitialized_${declaration.getStart(source)}`;
            if (!variables.some(({ name }) => name === fresh)) variables.push({ name: fresh, domain: delayedDomain, sort: sort(delayedDomain) });
            paths = paths.map((path): PathState => {
              const nextEnv = new Map(path.env);
              nextEnv.set(bindingName, variable(fresh));
              return { ...path, env: nextEnv };
            });
            continue;
          }
          if (!ts.isIdentifier(declaration.name) || !declaration.initializer) throw new Error(`only initialized identifier variables are supported: ${declaration.getText(source)}`);
          const pendingAliasSource = ts.isIdentifier(declaration.initializer) ? declaration.initializer.text : undefined;
          if (pendingAliasSource && paths.some((path) => path.pendingPromises.has(pendingAliasSource))) {
            if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0
              || !paths.every((path) => path.pendingPromises.has(pendingAliasSource))) {
              throw new Error(`Promise alias must be an unconditional const binding: ${declaration.getText(source)}`);
            }
            const alias = declaration.name.text;
            paths = paths.map((path): PathState => {
              const pendingPromises = new Map(path.pendingPromises);
              pendingPromises.set(alias, pendingPromises.get(pendingAliasSource)!);
              return { ...path, env: new Map(path.env), pendingPromises };
            });
            continue;
          }
          const nullableSource = unsafeNullableScalarCopy(declaration.initializer);
          if (nullableSource) throw new Error(`mutable scalar alias would erase nullable presence: ${declaration.name.text} = ${nullableSource}`);
          const name = declaration.name.text;
          paths = paths.flatMap((path) => evaluateScalar(declaration.initializer!, path).map(({ path: branch, value }) => {
            const nextEnv = new Map(branch.env); nextEnv.set(name, value);
            return { ...branch, env: nextEnv };
          }));
        }
      } else if (ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression)
        && statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && ts.isIdentifier(statement.expression.left) && ts.isAwaitExpression(statement.expression.right)) {
        const name = statement.expression.left.text;
        const nullableGuard = semanticGuards.get(name)?.find((guard) => guard.kind === "defined");
        if (nullableGuard) assertNoSharedNullableAliasMutation(name, statement.expression);
        paths = executeAwait(statement.expression.right, paths, { binding: name, ...(nullableGuard ? { nullableGuard } : {}) });
      } else if (ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression)
        && statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(statement.expression.left)) {
        const name = statement.expression.left.text;
        const right = statement.expression.right;
        const nullableTarget = semanticGuards.get(name)?.find((guard) => guard.kind === "defined");
        if (nullableTarget) assertNoSharedNullableAliasMutation(name, statement.expression);
        if (nullableTarget) {
          paths = paths.flatMap((path) => evaluateNullableAssignment(right, path, name, nullableTarget));
        } else {
          const nullableSource = unsafeNullableScalarCopy(right);
          if (nullableSource) throw new Error(`scalar assignment would erase nullable presence: ${name} = ${nullableSource}`);
          paths = paths.flatMap((path) => evaluateScalar(right, path).map(({ path: branch, value }) => {
            const nextEnv = new Map(branch.env);
            nextEnv.set(name, value);
            return { ...branch, env: nextEnv };
          }));
        }
      } else if (ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression)
        && (statement.expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken
          || statement.expression.operatorToken.kind === ts.SyntaxKind.BarBarEqualsToken)
        && ts.isIdentifier(statement.expression.left)) {
        const operation = statement.expression;
        const span = `${operation.getStart(source)}:${operation.getEnd()}`;
        if (!booleanLogicalOperations.has(span)) {
          throw new Error(`unsupported invariant expression: ${operation.getText(source)}`);
        }
        const name = (operation.left as ts.Identifier).text;
        assertNoSharedNullableAliasMutation(name, operation);
        paths = paths.flatMap((path): PathState[] => {
          const previous = substitute(path.env.get(name) ?? variable(name), path.env);
          const whenTrue = { ...path, env: new Map(path.env), assumptions: [...path.assumptions, previous] };
          const whenFalse = { ...path, env: new Map(path.env), assumptions: [...path.assumptions, negate(previous)] };
          const assignRight = (branch: PathState): PathState[] => evaluateScalar(operation.right, branch).map(({ path: evaluated, value }) => {
            const nextEnv = new Map(evaluated.env); nextEnv.set(name, value);
            return { ...evaluated, env: nextEnv };
          });
          return operation.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken
            ? [whenFalse, ...assignRight(whenTrue)]
            : [whenTrue, ...assignRight(whenFalse)];
        });
      } else if (ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression)
        && statement.expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionEqualsToken
        && ts.isIdentifier(statement.expression.left)) {
        const operation = statement.expression;
        const name = (operation.left as ts.Identifier).text;
        const span = `${operation.getStart(source)}:${operation.getEnd()}`;
        const guard = semanticGuards.get(name)?.find((candidate) => candidate.kind === "defined"
          && candidate.coalesceSpans?.includes(span));
        if (!guard) throw new Error(`unsupported invariant expression: ${operation.getText(source)}`);
        assertNoSharedNullableAliasMutation(name, operation);
        paths = paths.flatMap((path): PathState[] => {
          const defined = substitute(variable(guard.variable), path.env);
          const alreadyDefinedEnv = new Map(path.env);
          alreadyDefinedEnv.set(guard.variable, { kind: "boolean", value: true });
          const alreadyDefined: PathState = {
            ...path,
            env: alreadyDefinedEnv,
            assumptions: [...path.assumptions, defined],
          };
          const nullish: PathState = {
            ...path,
            env: new Map(path.env),
            assumptions: [...path.assumptions, negate(defined)],
          };
          const assigned = evaluateNullableAssignment(operation.right, nullish, name, guard);
          return [alreadyDefined, ...assigned];
        });
      } else if (ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression)
        && ts.isIdentifier(statement.expression.left)
        && [ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.MinusEqualsToken, ts.SyntaxKind.AsteriskEqualsToken,
          ts.SyntaxKind.PercentEqualsToken]
          .includes(statement.expression.operatorToken.kind)) {
        const operation = statement.expression;
        const operators = new Map<ts.SyntaxKind, Extract<LogicExpression, { kind: "binary" }>["operator"]>([
          [ts.SyntaxKind.PlusEqualsToken, "add"], [ts.SyntaxKind.MinusEqualsToken, "sub"],
          [ts.SyntaxKind.AsteriskEqualsToken, "mul"],
        ]);
        const operator = operators.get(operation.operatorToken.kind)!;
        const name = (operation.left as ts.Identifier).text;
        assertNoSharedNullableAliasMutation(name, operation);
        if (operation.operatorToken.kind === ts.SyntaxKind.PercentEqualsToken) {
          const divisor = constantIntegerRemainders.get(`${operation.getStart(source)}:${operation.getEnd()}`);
          if (divisor === undefined) throw new Error(`unsupported invariant expression: ${operation.getText(source)}`);
          paths = paths.flatMap((path) => evaluateIntegerRemainder(operation.left, divisor, path).map(({ path: branch, value }) => {
            const nextEnv = new Map(branch.env);
            nextEnv.set(name, value);
            return { ...branch, env: nextEnv };
          }));
          return paths;
        }
        paths = paths.flatMap((path) => {
          const previous = substitute(path.env.get(name) ?? variable(name), path.env);
          const previousSort = scalarExpressionSort(previous);
          if (previousSort !== "Int" && previousSort !== "Real") {
            throw new Error(`arithmetic compound assignment requires a numeric left operand: ${operation.left.getText(source)}`);
          }
          return evaluateScalar(operation.right, path).map(({ path: branch, value }) => {
            if (scalarExpressionSort(value) !== previousSort) {
              throw new Error(`arithmetic compound assignment requires matching numeric operands: ${operation.getText(source)}`);
            }
            const nextEnv = new Map(branch.env);
            nextEnv.set(name, { kind: "binary", operator, left: previous, right: value });
            return { ...branch, env: nextEnv };
          });
        });
      } else if (ts.isExpressionStatement(statement)
        && ((ts.isPostfixUnaryExpression(statement.expression)
          && (statement.expression.operator === ts.SyntaxKind.PlusPlusToken || statement.expression.operator === ts.SyntaxKind.MinusMinusToken))
          || (ts.isPrefixUnaryExpression(statement.expression)
            && (statement.expression.operator === ts.SyntaxKind.PlusPlusToken || statement.expression.operator === ts.SyntaxKind.MinusMinusToken))
          || (ts.isBinaryExpression(statement.expression) && [
            ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.MinusEqualsToken,
            ts.SyntaxKind.AsteriskEqualsToken, ts.SyntaxKind.SlashEqualsToken, ts.SyntaxKind.PercentEqualsToken,
            ts.SyntaxKind.AmpersandAmpersandEqualsToken, ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken,
          ].includes(statement.expression.operatorToken.kind)))) {
        paths = paths.map((path) => applyScalarUpdate(statement.expression, path));
      } else if (ts.isIfStatement(statement)) {
        const forked: PathState[] = [];
        for (const path of paths) {
          const condition = evaluateCondition(statement.expression, path.env);
          const thenInput = [{ ...path, env: new Map(path.env), assumptions: [...path.assumptions, condition] }];
          forked.push(...(ts.isBlock(statement.thenStatement)
            ? executeScopedBlock(statement.thenStatement, thenInput, context)
            : execute([statement.thenStatement], thenInput, context)));
          const elseInput = [{ ...path, env: new Map(path.env), assumptions: [...path.assumptions, negate(condition)] }];
          forked.push(...(!statement.elseStatement ? elseInput : ts.isBlock(statement.elseStatement)
            ? executeScopedBlock(statement.elseStatement, elseInput, context)
            : execute([statement.elseStatement], elseInput, context)));
        }
        paths = forked;
      } else if (ts.isSwitchStatement(statement)) {
        const switchTarget = statement.getStart(source);
        const clauses = statement.caseBlock.clauses;
        if (clauses.length === 0 || clauses.length > 8) throw new Error("switch requires one to eight literal clauses");
        const switchSpan = `${statement.expression.getStart(source)}:${statement.expression.getEnd()}`;
        const switchProperty = ts.isPropertyAccessExpression(statement.expression) ? statement.expression : undefined;
        const stringGuards = switchProperty && ts.isIdentifier(switchProperty.expression)
          ? (semanticGuards.get(switchProperty.expression.text) ?? []).filter((guard) =>
              guard.kind === "discriminant" && guard.property === switchProperty.name.text
              && guard.switchSpans?.includes(switchSpan))
          : [];
        const literal = (expression: ts.Expression): { key: string; expression?: LogicExpression; stringLiteral?: string } | undefined => {
          if (ts.isNumericLiteral(expression) && Number.isSafeInteger(Number(expression.text))) {
            return { key: `n:${Number(expression.text)}`, expression: { kind: "integer", value: String(Number(expression.text)) } };
          }
          if (ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.MinusToken
            && ts.isNumericLiteral(expression.operand) && Number.isSafeInteger(-Number(expression.operand.text))) {
            return { key: `n:${-Number(expression.operand.text)}`, expression: { kind: "integer", value: String(-Number(expression.operand.text)) } };
          }
          if (expression.kind === ts.SyntaxKind.TrueKeyword || expression.kind === ts.SyntaxKind.FalseKeyword) {
            const value = expression.kind === ts.SyntaxKind.TrueKeyword;
            return { key: `b:${value}`, expression: { kind: "boolean", value } };
          }
          if (ts.isStringLiteral(expression) && stringGuards.some((guard) => guard.literal === expression.text)) {
            return { key: `s:${expression.text}`, stringLiteral: expression.text };
          }
          return undefined;
        };
        const caseValues = clauses.map((clause) => ts.isCaseClause(clause) ? literal(clause.expression) : undefined);
        if (clauses.some((clause, index) => ts.isCaseClause(clause) && !caseValues[index])) {
          throw new Error("switch case expressions must be reviewed safe-integer, boolean, or discriminant string literals");
        }
        if (clauses.filter(ts.isDefaultClause).length > 1) throw new Error("switch has multiple default clauses");
        const keys = caseValues.flatMap((value) => value ? [value.key] : []);
        if (new Set(keys).size !== keys.length) throw new Error("switch case literals must be unique");
        const caseSorts = new Set(keys.map((key) => key.startsWith("b:") ? "Bool" : key.startsWith("n:") ? "Int" : "Discriminant"));
        if (caseSorts.size > 1) throw new Error("switch case literals must use one scalar sort");
        const switched: PathState[] = [];
        for (const path of paths) {
          const stringSwitch = caseSorts.has("Discriminant");
          const discriminant = stringSwitch ? undefined
            : substitute(logic(statement.expression, pipeBindings, semanticGuards, semanticValues), path.env);
          const expectedSort = caseSorts.values().next().value;
          if (discriminant && expectedSort !== "Discriminant" && scalarExpressionSort(discriminant) !== expectedSort) {
            throw new Error("switch discriminant and case literals must use the same scalar sort");
          }
          const conditionFor = (value: NonNullable<(typeof caseValues)[number]>): LogicExpression => {
            if (value.stringLiteral !== undefined) {
              const guard = stringGuards.find((candidate) => candidate.literal === value.stringLiteral)!;
              return variable(guard.variable);
            }
            return { kind: "binary", operator: "eq", left: discriminant!, right: value.expression! };
          };
          const nonMatches = caseValues.flatMap((value): LogicExpression[] => value ? [negate(conditionFor(value))] : []);
          for (let index = 0; index < clauses.length; index++) {
            const clause = clauses[index]!;
            const entry = caseValues[index];
            const condition: LogicExpression = entry
              ? conditionFor(entry)
              : conjunction(nonMatches) ?? { kind: "boolean", value: true };
            const suffix = clauses.slice(index).flatMap((item) => [...item.statements]);
            const exits = execute(suffix, [{ ...path, env: new Map(path.env), assumptions: [...path.assumptions, condition] }], { ...context, breakTarget: switchTarget });
            switched.push(...exits.map((exit): PathState => exit.completion === "break" && exit.breakTarget === switchTarget
              ? { ...exit, completion: "normal", breakTarget: undefined } : exit));
          }
          if (!clauses.some(ts.isDefaultClause)) {
            switched.push({ ...path, env: new Map(path.env), assumptions: [...path.assumptions, ...(nonMatches.length ? [conjunction(nonMatches)!] : [])] });
          }
        }
        paths = switched;
      } else if (ts.isWhileStatement(statement)) {
        const loopTarget = statement.getStart(source);
        const invariantSource = extractAnnotations(source.text.slice(statement.getFullStart(), statement.getStart(source)), "invariant")[0];
        if (!invariantSource) throw new Error(`while requires /* uneffect:loop_invariant ... */ but ${statement.expression.getText(source)} has none`);
        const invariant = parseLogicExpression(invariantSource);
        const exited: PathState[] = [];
        for (const path of paths) {
          add("loop-init", statement, path.assumptions, substitute(invariant, path.env), invariantSource, path.env);
          const loopEnv: Environment = new Map();
          for (const name of path.env.keys()) {
            const fresh = `${fn}_${name}_loop_${statement.getStart(source)}`;
            displayNames[fresh] = `${name}@loop`;
            if (!variables.some((item) => item.name === fresh)) variables.push({ name: fresh, domain: "int", sort: "Int" });
            loopEnv.set(name, variable(fresh));
          }
          const inv = substitute(invariant, loopEnv), condition = evaluateCondition(statement.expression, loopEnv);
          const bodyInput = [{ ...path, env: new Map(loopEnv), assumptions: [inv, condition] }];
          const loopContext = { breakTarget: loopTarget, continueTarget: loopTarget };
          const bodyPaths = ts.isBlock(statement.statement)
            ? executeScopedBlock(statement.statement, bodyInput, loopContext)
            : execute([statement.statement], bodyInput, loopContext);
          const backEdges = bodyPaths.filter((item) => item.completion === "normal"
            || (item.completion === "continue" && item.continueTarget === loopTarget));
          for (const bodyPath of backEdges) add("loop-preserve", statement, bodyPath.assumptions, substitute(invariant, bodyPath.env), invariantSource, bodyPath.env);
          exited.push(...bodyPaths.flatMap((item): PathState[] => {
            if (item.completion === "normal" || (item.completion === "continue" && item.continueTarget === loopTarget)) return [];
            if (item.completion === "break" && item.breakTarget === loopTarget) {
              return [{ ...item, completion: "normal", breakTarget: undefined }];
            }
            return [item];
          }), { ...path, env: loopEnv, assumptions: [inv, negate(condition)] });
        }
        paths = exited;
      } else if (ts.isForStatement(statement)) {
        const loopTarget = statement.getStart(source);
        const initializer = statement.initializer;
        if (!initializer || !ts.isVariableDeclarationList(initializer) || initializer.declarations.length !== 1) {
          throw new Error("for requires one scalar variable declaration initializer");
        }
        const declaration = initializer.declarations[0]!;
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer || !statement.condition) {
          throw new Error("for requires one initialized identifier and an explicit condition");
        }
        const initializerName = declaration.name.text;
        const invariantSource = extractAnnotations(source.text.slice(statement.getFullStart(), statement.getStart(source)), "invariant")[0];
        if (!invariantSource) throw new Error(`for requires /* uneffect:loop_invariant ... */ but ${statement.condition.getText(source)} has none`);
        const invariant = parseLogicExpression(invariantSource);
        const initialized = paths.map((path): PathState => {
          const nextEnv = new Map(path.env);
          nextEnv.set(initializerName, substitute(logic(declaration.initializer!, pipeBindings, semanticGuards, semanticValues), nextEnv));
          return { ...path, env: nextEnv };
        });
        const exited: PathState[] = [];
        for (const path of initialized) {
          add("loop-init", statement, path.assumptions, substitute(invariant, path.env), invariantSource, path.env);
          const loopEnv: Environment = new Map();
          for (const name of path.env.keys()) {
            const fresh = `${fn}_${name}_loop_${loopTarget}`;
            displayNames[fresh] = `${name}@loop`;
            if (!variables.some((item) => item.name === fresh)) variables.push({ name: fresh, domain: "int", sort: "Int" });
            loopEnv.set(name, variable(fresh));
          }
          const inv = substitute(invariant, loopEnv);
          const condition = evaluateCondition(statement.condition, loopEnv);
          const bodyInput = [{ ...path, env: new Map(loopEnv), assumptions: [inv, condition] }];
          const loopContext = { breakTarget: loopTarget, continueTarget: loopTarget };
          const bodyPaths = ts.isBlock(statement.statement)
            ? executeScopedBlock(statement.statement, bodyInput, loopContext)
            : execute([statement.statement], bodyInput, loopContext);
          for (const bodyPath of bodyPaths) {
            if (bodyPath.completion === "normal" || (bodyPath.completion === "continue" && bodyPath.continueTarget === loopTarget)) {
              const updated = applyScalarUpdate(statement.incrementor, bodyPath);
              add("loop-preserve", statement, updated.assumptions, substitute(invariant, updated.env), invariantSource, updated.env);
            } else if (bodyPath.completion === "break" && bodyPath.breakTarget === loopTarget) {
              exited.push({ ...bodyPath, completion: "normal", breakTarget: undefined });
            } else exited.push(bodyPath);
          }
          exited.push({ ...path, env: loopEnv, assumptions: [inv, negate(condition)] });
        }
        paths = exited;
      } else if (ts.isDoStatement(statement)) {
        const loopTarget = statement.getStart(source);
        const invariantSource = extractAnnotations(source.text.slice(statement.getFullStart(), statement.getStart(source)), "invariant")[0];
        if (!invariantSource) throw new Error(`do-while requires /* uneffect:loop_invariant ... */ but ${statement.expression.getText(source)} has none`);
        const invariant = parseLogicExpression(invariantSource);
        const exited: PathState[] = [];
        for (const path of paths) {
          add("loop-init", statement, path.assumptions, substitute(invariant, path.env), invariantSource, path.env);
          const loopEnv: Environment = new Map();
          for (const name of path.env.keys()) {
            const fresh = `${fn}_${name}_loop_${loopTarget}`;
            displayNames[fresh] = `${name}@loop`;
            if (!variables.some((item) => item.name === fresh)) variables.push({ name: fresh, domain: "int", sort: "Int" });
            loopEnv.set(name, variable(fresh));
          }
          const inv = substitute(invariant, loopEnv);
          const bodyInput = [{ ...path, env: new Map(loopEnv), assumptions: [inv] }];
          const loopContext = { breakTarget: loopTarget, continueTarget: loopTarget };
          const bodyPaths = ts.isBlock(statement.statement)
            ? executeScopedBlock(statement.statement, bodyInput, loopContext)
            : execute([statement.statement], bodyInput, loopContext);
          for (const bodyPath of bodyPaths) {
            if (bodyPath.completion === "normal" || (bodyPath.completion === "continue" && bodyPath.continueTarget === loopTarget)) {
              const preserved = substitute(invariant, bodyPath.env);
              add("loop-preserve", statement, bodyPath.assumptions, preserved, invariantSource, bodyPath.env);
              const condition = evaluateCondition(statement.expression, bodyPath.env);
              exited.push({ ...bodyPath, completion: "normal", continueTarget: undefined, assumptions: [...bodyPath.assumptions, preserved, negate(condition)] });
            } else if (bodyPath.completion === "break" && bodyPath.breakTarget === loopTarget) {
              exited.push({ ...bodyPath, completion: "normal", breakTarget: undefined });
            } else exited.push(bodyPath);
          }
        }
        paths = exited;
      } else if (ts.isTryStatement(statement)) {
        const tryPaths = executeScopedBlock(statement.tryBlock, paths.map((path) => ({ ...path, env: new Map(path.env) })), context);
        const thrown = tryPaths.filter((path) => path.completion === "throw" || path.completion === "reject");
        const completed = tryPaths.filter((path) => path.completion !== "throw" && path.completion !== "reject");
        let handled: PathState[];
        if (!statement.catchClause) handled = tryPaths;
        else {
          const handlerSpan = { start: statement.catchClause.getStart(source), end: statement.catchClause.getEnd() };
          const caught = thrown.map((path): PathState => {
            const edge = { ...path.thrown!, handlerSpan };
            const caughtEnv = new Map(path.env);
            const binding = statement.catchClause?.variableDeclaration?.name;
            if (binding && !ts.isIdentifier(binding)) throw new Error("destructured catch bindings are unsupported by the contract CFG");
            if (binding && caughtEnv.has(binding.text)) throw new Error(`catch binding shadows a tracked scalar: ${binding.text}`);
            if (binding && edge.payload) caughtEnv.set(binding.text, edge.payload);
            return { ...path, env: caughtEnv, completion: "normal", thrown: undefined, returnEnv: undefined, returnStatement: undefined, dischargedThrows: [...path.dischargedThrows, edge] };
          });
          const caughtPaths = executeScopedBlock(statement.catchClause.block, caught, context);
          const binding = statement.catchClause.variableDeclaration?.name;
          handled = [...completed, ...caughtPaths.map((path): PathState => {
            if (!binding || !ts.isIdentifier(binding)) return path;
            const env = new Map(path.env); env.delete(binding.text);
            const returnEnv = path.returnEnv && new Map(path.returnEnv); returnEnv?.delete(binding.text);
            return { ...path, env, ...(returnEnv ? { returnEnv } : {}) };
          })];
        }
        if (!statement.finallyBlock) paths = handled;
        else {
          paths = handled.flatMap((prior): PathState[] => {
            const finalPaths = executeScopedBlock(statement.finallyBlock!, [{
              ...prior,
              env: new Map(prior.env),
              completion: "normal",
              thrown: undefined,
              returnEnv: undefined,
              returnStatement: undefined,
            }], context);
            return finalPaths.map((finalPath) => finalPath.completion === "normal" ? {
              ...finalPath,
              completion: prior.completion,
              thrown: prior.thrown,
              returnEnv: prior.returnEnv,
              returnStatement: prior.returnStatement,
            } : finalPath);
          });
        }
      } else if (ts.isBreakStatement(statement)) {
        if (statement.label || context.breakTarget === undefined) throw new Error("break requires the nearest supported switch/loop and cannot be labeled");
        paths = paths.map((path) => ({ ...path, completion: "break", breakTarget: context.breakTarget }));
      } else if (ts.isContinueStatement(statement)) {
        if (statement.label || context.continueTarget === undefined) throw new Error("continue requires the nearest supported loop and cannot be labeled");
        paths = paths.map((path) => ({ ...path, completion: "continue", continueTarget: context.continueTarget }));
      } else if (ts.isThrowStatement(statement)) {
        const originSpan = { start: statement.getStart(source), end: statement.getEnd() };
        const effect = throwEffects.get(`${originSpan.start}:${originSpan.end}`) ?? "Throw<unknown>";
        paths = paths.map((path) => {
          let payload: LogicExpression | undefined;
          try { if (statement.expression) payload = substitute(logic(statement.expression, pipeBindings, semanticGuards, semanticValues), path.env); } catch { /* non-scalar payload remains effect-only evidence */ }
          return { ...path, completion: "throw", thrown: { kind: "synchronous-throw", effect, originSpan, ...(payload ? { payload } : {}) } };
        });
      } else if (ts.isReturnStatement(statement) && statement.expression && ts.isAwaitExpression(statement.expression)) {
        paths = executeAwait(statement.expression, paths, { returnStatement: statement });
      } else if (ts.isReturnStatement(statement) && statement.expression) {
        const returnExpression = statement.expression;
        paths = paths.flatMap((path): PathState[] => evaluateScalar(returnExpression, path).map(({ path: branch, value }) => {
          const resultEnv = new Map(branch.env); resultEnv.set("result", value);
          return { ...branch, completion: "return", returnEnv: resultEnv, returnStatement: statement };
        }));
      } else if (ts.isExpressionStatement(statement) && ts.isAwaitExpression(statement.expression)) {
        paths = executeAwait(statement.expression, paths);
      } else if (ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)) {
        const call = statement.expression;
        const assertion = assertionCalls.get(`${call.getStart(source)}:${call.getEnd()}`);
        if (assertion) {
          const originSpan = { start: call.getStart(source), end: call.getEnd() };
          if (assertion.condition === "always-throw") {
            paths = paths.map((path): PathState => ({
              ...path,
              env: new Map(path.env),
              completion: "throw",
              thrown: { kind: "synchronous-throw", evidence: "trusted", effect: assertion.effect, originSpan },
            }));
            return paths;
          }
          paths = paths.flatMap((path): PathState[] => {
            const conditions: Array<{ path: PathState; condition: LogicExpression }> = assertion.condition === "truthy"
              ? [{ path, condition: evaluateCondition(call.arguments[0]!, path.env) }]
              : assertion.condition === "nullish"
                ? (() => {
                  let argument = call.arguments[0];
                  while (argument && (ts.isParenthesizedExpression(argument) || ts.isAsExpression(argument)
                    || ts.isTypeAssertionExpression(argument) || ts.isNonNullExpression(argument))) argument = argument.expression;
                  const guard = argument && ts.isIdentifier(argument)
                    ? semanticGuards.get(argument.text)?.find((candidate) => candidate.kind === "defined") : undefined;
                  if (!guard) throw new Error(`ifError assertion requires a tracked nullable scalar identifier: ${call.getText(source)}`);
                  return [{ path, condition: negate(substitute(variable(guard.variable), path.env)) }];
                })()
              : (() => {
                if (call.arguments.length < 2 || unsafeNullableScalarCopy(call.arguments[0]!)
                  || unsafeNullableScalarCopy(call.arguments[1]!)) {
                  throw new Error(`strict equality assertion requires two non-nullable scalar operands: ${call.getText(source)}`);
                }
                return evaluateScalar(call.arguments[0]!, path).flatMap(({ path: leftPath, value: left }) =>
                  evaluateScalar(call.arguments[1]!, leftPath).map(({ path: rightPath, value: right }) => {
                    if (scalarExpressionSort(left) !== scalarExpressionSort(right)) {
                      throw new Error(`strict equality assertion requires matching scalar operands: ${call.getText(source)}`);
                    }
                    const equal: LogicExpression = { kind: "binary", operator: "eq", left, right };
                    return { path: rightPath, condition: assertion.condition === "strict-not-equal" ? negate(equal) : equal };
                  }));
              })();
            return conditions.flatMap(({ path: branch, condition }): PathState[] => [
              { ...branch, env: new Map(branch.env), assumptions: [...branch.assumptions, condition] },
              { ...branch, env: new Map(branch.env), assumptions: [...branch.assumptions, negate(condition)], completion: "throw", thrown: { kind: "synchronous-throw", evidence: "trusted", effect: assertion.effect, originSpan } },
            ]);
          });
          return paths;
        }
        const fact = declaredThrowCalls.get(`${call.getStart(source)}:${call.getEnd()}`);
        if (!fact) throw new Error(`call requires a verified function summary: ${call.expression.getText(source)}`);
        const originSpan = { start: call.getStart(source), end: call.getEnd() };
        const thrown = paths.flatMap((path) => fact.effects.map((effect): PathState => ({ ...path, env: new Map(path.env), completion: "throw", thrown: { kind: "synchronous-throw", effect, originSpan } })));
        paths = [...(fact.definitelyThrows ? [] : paths), ...thrown];
      } else if (!ts.isEmptyStatement(statement)) {
        throw new Error(`unsupported invariant statement: ${statement.getText(source)}`);
      }
      return paths;
    };
    try {
      const exits = execute(node.body.statements, [{ env, pendingPromises: new Map(), assumptions: baseAssumptions, completion: "normal", dischargedThrows: [], relationalCalls: [] }]);
      if (exits.some((path) => path.completion === "break" || path.completion === "continue")) throw new Error("loop control escaped its supported owner");
      const unobserved = exits.flatMap((path) => [...path.pendingPromises].filter(([, pending]) => !pending.observed).map(([name]) => name));
      if (unobserved.length > 0) throw new Error(`unobserved Promise binding at function exit: ${[...new Set(unobserved)].sort().join(", ")}`);
      for (const path of exits.filter((item) => item.completion === "return" && item.returnEnv && item.returnStatement)) {
        for (const ensure of ensures) add("postcondition", path.returnStatement!, path.assumptions, substitute(ensure.expression, path.returnEnv!), ensure.source, path.returnEnv!, path.dischargedThrows, path.relationalCalls);
      }
      const escapes = exits.filter((path) => (path.completion === "throw" || path.completion === "reject") && path.thrown).map((path): ContractThrowEdge => {
        const edge = path.thrown!;
        if (!asyncBoundary || edge.kind !== "synchronous-throw") return edge;
        const match = /^Throw<(.*)>$/.exec(edge.effect);
        return { ...edge, kind: "promise-rejection", effect: `Reject<${match?.[1] ?? "unknown"}>` };
      });
      for (const obligation of obligations.slice(functionObligationStart)) obligation.controlFlow.exceptionFlow!.escapes = [...escapes];
    } catch (cause) {
      throw locatedLowering(cause, fn, { start: node.getStart(source), end: node.getEnd() });
    }
  }
  return obligations;
}

const smtOperators: Record<string, string> = { add: "+", sub: "-", mul: "*", "int-mod": "mod", lt: "<", lte: "<=", gt: ">", gte: ">=", eq: "=", and: "and", or: "or" };
export function logicToSmt(expression: LogicExpression): string {
  if (expression.kind === "variable") return expression.name;
  if (expression.kind === "integer") return expression.value;
  if (expression.kind === "real") return expression.value;
  if (expression.kind === "boolean") return String(expression.value);
  if (expression.kind === "unary") {
    if (expression.operator === "not") return `(not ${logicToSmt(expression.operand)})`;
    if (expression.operator === "floor") return `(to_int ${logicToSmt(expression.operand)})`;
    if (expression.operator === "ceil") return `(- (to_int (- ${logicToSmt(expression.operand)})))`;
    return `(- ${logicToSmt(expression.operand)})`;
  }
  if (expression.operator === "neq") return `(not (= ${logicToSmt(expression.left)} ${logicToSmt(expression.right)}))`;
  const operator = smtOperators[expression.operator];
  if (!operator) throw new Error(`unsupported SMT operator: ${expression.operator}`);
  return `(${operator} ${logicToSmt(expression.left)} ${logicToSmt(expression.right)})`;
}

export function generateObligationSmt(obligation: InvariantObligation, commands = true): string {
  const lines = ["(set-logic ALL)", ...obligation.variables.map((item) => `(declare-const ${item.name} ${item.sort})`),
    ...obligation.assumptions.map((item) => `(assert ${logicToSmt(item)})`), `(assert (not ${logicToSmt(obligation.goal)}))`];
  if (commands) lines.push("(check-sat)");
  return `${lines.join("\n")}\n`;
}

export function obligationFromSpec(spec: InvariantSpec): InvariantObligation {
  if (!spec.result || spec.ensures.length === 0) throw new Error(`${spec.functionName} has no supported postcondition`);
  const domains = spec.parameterDomains ?? Object.fromEntries(spec.parameters.map((name) => [name, "int"]));
  const variables: ObligationVariable[] = spec.parameters.map((name) => ({ name, domain: domains[name] ?? "int", sort: sort(domains[name] ?? "int") }));
  const resultDomain = spec.resultDomain ?? "int";
  variables.push({ name: "result", domain: resultDomain, sort: sort(resultDomain) });
  const assumptions = spec.requires.map(parseLogicExpression);
  for (const item of variables) if (item.domain === "nat") assumptions.push({ kind: "binary", operator: "gte", left: variable(item.name), right: { kind: "integer", value: "0" } });
  assumptions.push({ kind: "binary", operator: "eq", left: variable("result"), right: parseLogicExpression(spec.result) });
  const goals = spec.ensures.map(parseLogicExpression);
  const goal = goals.reduce((left, right): LogicExpression => ({ kind: "binary", operator: "and", left, right }));
  const fileName = spec.fileName ?? "<spec>";
  const span = spec.span ?? { start: 0, end: 0 };
  const value = { kind: "postcondition" as const, fileName, functionName: spec.functionName, span, variables, assumptions, goal, source: spec.ensures.join(" && "), bindings: [{ name: "result", expression: parseLogicExpression(spec.result) }], displayNames: {}, controlFlow: { schema: "uneffect-contract-control-flow/v1" as const, blockId: controlFlowBlockId(fileName, spec.functionName, span, "synthetic"), completion: "synthetic" as const, pathConditions: [...assumptions] } };
  return makeObligation(value);
}
