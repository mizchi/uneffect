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
  | { kind: "unary"; operator: "not" | "negate"; operand: LogicExpression }
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
interface PathState {
  env: Environment;
  assumptions: LogicExpression[];
  completion: "normal" | "return" | "throw" | "reject";
  thrown?: ContractThrowEdge;
  dischargedThrows: ContractThrowEdge[];
  relationalCalls: ContractRelationalCallEvidence[];
  returnEnv?: Environment;
  returnStatement?: ts.ReturnStatement;
}
type SemanticGuardKind = "defined" | "typeof-number";
interface SemanticGuardFact { kind: SemanticGuardKind; variable: string; label: string; nullish?: "undefined" | "null" | "nullish"; spans: string[] }
interface ParameterTypeFact { domain: NumericDomain; assumption?: LogicExpression; label?: string; guards?: SemanticGuardFact[]; programDigest: string }
interface DeclaredThrowCallFact { effects: string[]; definitelyThrows: boolean }
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
interface AwaitRejectionFact {
  effect?: string;
  definitelyRejects: boolean;
  synchronousThrows: string[];
  evidence: "verified" | "trusted";
  payloadFromFirstArgument: boolean;
  fulfillment?: AwaitFulfillmentFact;
}

function finiteUnion(values: LogicExpression[]): LogicExpression | undefined {
  return values.reduce<LogicExpression | undefined>((left, right) => left === undefined ? right : { kind: "binary", operator: "or", left, right }, undefined);
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
        const undefinedMembers = members.filter((member) => (member.flags & ts.TypeFlags.Undefined) !== 0);
        const nullMembers = members.filter((member) => (member.flags & ts.TypeFlags.Null) !== 0);
        const stringMembers = members.filter((member) => (member.flags & ts.TypeFlags.StringLike) !== 0);
        if (numberMembers.length > 0 && undefinedMembers.length + nullMembers.length > 0 && numberMembers.length + undefinedMembers.length + nullMembers.length === members.length) {
          const nullish = undefinedMembers.length > 0 && nullMembers.length > 0 ? "nullish" : undefinedMembers.length > 0 ? "undefined" : "null";
          const suffix = nullish === "nullish" ? "number | null | undefined" : `number | ${nullish}`;
          facts.set(key, { domain: "int", programDigest, guards: [{ kind: "defined", variable: `${parameterName}_uneffect_defined`, label: `${parameterName}: ${suffix} via nullish guard`, nullish, spans: [] }] });
        } else if (numberMembers.length > 0 && stringMembers.length > 0 && numberMembers.length + stringMembers.length === members.length) {
          facts.set(key, { domain: "int", programDigest, guards: [{ kind: "typeof-number", variable: `${parameterName}_uneffect_is_number`, label: `${parameterName}: number | string via typeof number guard`, spans: [] }] });
        }
      }
      const fact = facts.get(key);
      if (!fact?.guards) continue;
      const parameterSymbol = checker.getSymbolAtLocation(parameter.name);
      const sameParameter = (candidate: ts.Expression): candidate is ts.Identifier => ts.isIdentifier(candidate) && checker.getSymbolAtLocation(candidate) === parameterSymbol;
      const visitGuards = (current: ts.Node): void => {
        if (ts.isBinaryExpression(current)) {
          const span = `${current.getStart(source)}:${current.getEnd()}`;
          for (const guard of fact.guards!) {
            if (guard.kind === "typeof-number") {
              const matches = (left: ts.Expression, right: ts.Expression): boolean => ts.isTypeOfExpression(left) && sameParameter(left.expression) && ts.isStringLiteral(right) && right.text === "number";
              if (matches(current.left, current.right) || matches(current.right, current.left)) guard.spans.push(span);
            } else {
              const matches = (left: ts.Expression, right: ts.Expression): boolean => {
                if (!sameParameter(left)) return false;
                if (right.kind === ts.SyntaxKind.NullKeyword) return true;
                return ts.isIdentifier(right) && (checker.getTypeAtLocation(right).flags & ts.TypeFlags.Undefined) !== 0;
              };
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

function typeCheckerAwaitRejections(program: ts.Program | undefined, fileName: string, text: string): Map<string, AwaitRejectionFact> {
  const facts = new Map<string, AwaitRejectionFact>();
  if (!program) return facts;
  const source = program.getSourceFile(fileName);
  if (!source || source.text !== text) return facts;
  const errors = [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)]
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) return facts;
  const checker = program.getTypeChecker(), adapter = new TypeScriptFrontendAdapter(program);
  const visit = (node: ts.Node): void => {
    if (ts.isAwaitExpression(node) && ts.isCallExpression(node.expression)
      && ts.isPropertyAccessExpression(node.expression.expression)
      && node.expression.expression.name.text === "reject" && node.expression.arguments[0]) {
      const receiver = node.expression.expression.expression;
      const receiverSymbol = checker.getSymbolAtLocation(receiver);
      const memberSymbol = checker.getSymbolAtLocation(node.expression.expression.name);
      const fromStandardDeclarations = (symbol: ts.Symbol | undefined): boolean => Boolean(symbol?.declarations?.length)
        && symbol!.declarations!.every((declaration) => declaration.getSourceFile().isDeclarationFile)
        && symbol!.declarations!.some((declaration) => /(?:^|\/)lib\..*\.promise\.d\.ts$/.test(declaration.getSourceFile().fileName.replaceAll("\\", "/")));
      const builtin = ts.isIdentifier(receiver) && receiver.text === "Promise" && fromStandardDeclarations(receiverSymbol) && fromStandardDeclarations(memberSymbol);
      if (builtin) {
        const argument = node.expression.arguments[0]!;
        const errorType = adapter.thrownErrorType(argument);
        const rejectionType = errorType === "unknown" ? checker.typeToString(checker.getTypeAtLocation(argument)) : errorType;
        facts.set(`${node.getStart(source)}:${node.getEnd()}`, {
          effect: `Reject<${rejectionType}>`, definitelyRejects: true, synchronousThrows: [], evidence: "verified", payloadFromFirstArgument: true,
        });
      }
    } else if (ts.isAwaitExpression(node) && ts.isCallExpression(node.expression)) {
      const signature = checker.getResolvedSignature(node.expression);
      const declaration = signature?.declaration;
      if (signature && declaration && checker.getPropertyOfType(checker.getReturnTypeOfSignature(signature), "then")) {
        const declarationSource = declaration.getSourceFile();
        const comments = declarationSource.text.slice(declaration.getFullStart(), declaration.getStart(declarationSource));
        const rejected = extractAnnotations(comments, "temporal_rejects");
        const thrown = extractAnnotations(comments, "temporal_throws");
        const contractEnsures = extractAnnotations(comments, "ensures");
        const contractRequires = extractAnnotations(comments, "requires");
        const awaitedType = checker.getAwaitedType(checker.getReturnTypeOfSignature(signature));
        const awaitedDomain: NumericDomain | undefined = awaitedType && (awaitedType.flags & ts.TypeFlags.BooleanLike) !== 0 ? "bool"
          : awaitedType && (awaitedType.flags & ts.TypeFlags.NumberLike) !== 0 ? "int" : undefined;
        const declarationName = "name" in declaration ? declaration.name : undefined;
        const named = declarationName && ts.isIdentifier(declarationName) ? declarationName.text : undefined;
        const parameters = declaration.parameters.every((parameter) => ts.isIdentifier(parameter.name))
          ? declaration.parameters.map((parameter) => (parameter.name as ts.Identifier).text) : undefined;
        const fulfillment = contractEnsures.length > 0 && awaitedDomain && named && parameters ? {
          domain: awaitedDomain,
          functionName: named,
          parameters,
          clauses: contractEnsures.map((clause) => ({ source: clause, expression: parseLogicExpression(clause) })),
          preconditions: contractRequires.map((clause) => ({ source: clause, expression: parseLogicExpression(clause) })),
          declarationFileName: declarationSource.fileName,
          declarationDigest: createHash("sha256").update(declarationSource.text.slice(declaration.getStart(declarationSource), declaration.getEnd())).digest("hex"),
          declarationSpan: { start: declaration.getStart(declarationSource), end: declaration.getEnd() },
        } satisfies AwaitFulfillmentFact : undefined;
        if (rejected.length === 1 || fulfillment) facts.set(`${node.getStart(source)}:${node.getEnd()}`, {
          ...(rejected.length === 1 ? { effect: `Reject<${rejected[0]}>` } : {}), definitelyRejects: false,
          synchronousThrows: [...new Set(thrown.map((errorType) => `Throw<${errorType}>`))].sort(), evidence: "trusted",
          payloadFromFirstArgument: false, ...(fulfillment ? { fulfillment } : {}),
        });
      }
    }
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
  const typeofNumber = (left: ts.Expression, right: ts.Expression): LogicExpression | undefined =>
    ts.isTypeOfExpression(left) && ts.isIdentifier(left.expression) && ts.isStringLiteral(right) && right.text === "number"
      ? guarded(left.expression.text, "typeof-number", equality) : undefined;
  return typeofNumber(node.left, node.right) ?? typeofNumber(node.right, node.left);
}

function logic(node: ts.Expression, pipeBindings: ReadonlySet<string> = new Set(), semanticGuards: ReadonlyMap<string, readonly SemanticGuardFact[]> = new Map()): LogicExpression {
  if (ts.isParenthesizedExpression(node)) return logic(node.expression, pipeBindings, semanticGuards);
  if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node)) return logic(node.expression, pipeBindings, semanticGuards);
  const guard = semanticGuardExpression(node, semanticGuards);
  if (guard) return guard;
  if (ts.isIdentifier(node)) return { kind: "variable", name: node.text };
  if (ts.isNumericLiteral(node)) return node.text.includes(".") ? { kind: "real", value: node.text } : { kind: "integer", value: node.text };
  if (node.kind === ts.SyntaxKind.TrueKeyword) return { kind: "boolean", value: true };
  if (node.kind === ts.SyntaxKind.FalseKeyword) return { kind: "boolean", value: false };
  if (ts.isPrefixUnaryExpression(node)) {
    if (node.operator === ts.SyntaxKind.ExclamationToken) return { kind: "unary", operator: "not", operand: logic(node.operand, pipeBindings, semanticGuards) };
    if (node.operator === ts.SyntaxKind.MinusToken) return { kind: "unary", operator: "negate", operand: logic(node.operand, pipeBindings, semanticGuards) };
  }
  if (ts.isBinaryExpression(node)) {
    const operators = new Map<ts.SyntaxKind, string>([
      [ts.SyntaxKind.PlusToken, "add"], [ts.SyntaxKind.MinusToken, "sub"], [ts.SyntaxKind.AsteriskToken, "mul"],
      [ts.SyntaxKind.SlashToken, "div"], [ts.SyntaxKind.PercentToken, "mod"], [ts.SyntaxKind.LessThanToken, "lt"],
      [ts.SyntaxKind.LessThanEqualsToken, "lte"], [ts.SyntaxKind.GreaterThanToken, "gt"], [ts.SyntaxKind.GreaterThanEqualsToken, "gte"],
      [ts.SyntaxKind.EqualsEqualsToken, "eq"], [ts.SyntaxKind.EqualsEqualsEqualsToken, "eq"],
      [ts.SyntaxKind.ExclamationEqualsToken, "neq"], [ts.SyntaxKind.ExclamationEqualsEqualsToken, "neq"],
      [ts.SyntaxKind.AmpersandAmpersandToken, "and"], [ts.SyntaxKind.BarBarToken, "or"],
    ]);
    const operator = operators.get(node.operatorToken.kind);
    if (operator) return { kind: "binary", operator, left: logic(node.left, pipeBindings, semanticGuards), right: logic(node.right, pipeBindings, semanticGuards) };
  }
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && pipeBindings.has(node.expression.text) && node.arguments.length >= 2) {
    let value = logic(node.arguments[0]!, pipeBindings, semanticGuards);
    for (const stage of node.arguments.slice(1)) {
      if ((!ts.isArrowFunction(stage) && !ts.isFunctionExpression(stage)) || stage.parameters.length !== 1
        || !ts.isIdentifier(stage.parameters[0]!.name) || ts.isBlock(stage.body)) {
        throw new Error("verified effect/Function pipe requires inline unary expression callbacks");
      }
      value = substitute(logic(stage.body, pipeBindings, semanticGuards), new Map([[stage.parameters[0]!.name.text, value]]));
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
  if (message.startsWith("unsupported invariant statement")) return "the verified statement subset is: initialized let/const, plain assignment, if/else, while with /* uneffect:contract invariant ... */, and return";
  if (message.startsWith("while requires")) return "write /* uneffect:contract invariant ... */ directly above the while statement";
  if (message.startsWith("unsupported invariant expression") || message.startsWith("invalid invariant expression")) return "the expression language is integers, + - * / %, comparisons, && || !, and imported effect/Function pipe with inline unary callbacks";
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

export function lowerInvariantProgram(fileName: string, text: string, program?: ts.Program): InvariantObligation[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const checkerFacts = typeCheckerParameterFacts(program, fileName, text);
  const throwEffects = typeCheckerThrowEffects(program, fileName, text);
  const declaredThrowCalls = typeCheckerDeclaredThrowCalls(program, fileName, text);
  const awaitRejections = typeCheckerAwaitRejections(program, fileName, text);
  const pipeBindings = new Set(source.statements.flatMap((statement): string[] => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
      || statement.moduleSpecifier.text !== "effect/Function" || !statement.importClause?.namedBindings
      || !ts.isNamedImports(statement.importClause.namedBindings)) return [];
    return statement.importClause.namedBindings.elements
      .filter((element) => (element.propertyName ?? element.name).text === "pipe")
      .map((element) => element.name.text);
  }));
  const obligations: InvariantObligation[] = [];
  for (const node of source.statements) {
    if (!ts.isFunctionDeclaration(node) || !node.name || !node.body) continue;
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
      variables.push({ name: parameter.name.text, domain: parameterDomain, sort: sort(parameterDomain) });
      env.set(parameter.name.text, variable(parameter.name.text));
      if (checkerFact) checkerProgramDigest = checkerFact.programDigest;
      if (checkerFact?.assumption) baseAssumptions.push(checkerFact.assumption);
      if (checkerFact?.label) narrowingLabels.push(checkerFact.label);
      if (checkerFact?.guards?.length) {
        semanticGuards.set(parameter.name.text, checkerFact.guards);
        for (const guard of checkerFact.guards) {
          variables.push({ name: guard.variable, domain: "bool", sort: "Bool" });
          narrowingLabels.push(guard.label);
        }
      }
      if (parameterDomain === "nat") baseAssumptions.push({ kind: "binary", operator: "gte", left: variable(parameter.name.text), right: { kind: "integer", value: "0" } });
    }
    const fn = node.name.text;
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
    const execute = (statements: readonly ts.Statement[], initial: PathState[]): PathState[] => {
      let paths = initial;
      for (const statement of statements) {
        try {
          const abrupt = paths.filter((path) => path.completion !== "normal");
          const normal = paths.filter((path) => path.completion === "normal");
          paths = [...abrupt, ...step(statement, normal)];
        } catch (cause) {
          throw locatedLowering(cause, fn, { start: statement.getStart(source), end: statement.getEnd() });
        }
      }
      return paths;
    };
    const executeAwait = (awaited: ts.AwaitExpression, incoming: PathState[], target?: { binding?: string; returnStatement?: ts.ReturnStatement }): PathState[] => {
      const fact = awaitRejections.get(`${awaited.getStart(source)}:${awaited.getEnd()}`);
      if (!fact) throw new Error(`await requires a verified rejection or fulfillment summary: ${awaited.expression.getText(source)}`);
      const call = ts.isCallExpression(awaited.expression) ? awaited.expression : undefined;
      const originSpan = { start: awaited.getStart(source), end: awaited.getEnd() };
      let fulfilled = incoming.map((path): PathState => ({ ...path, env: new Map(path.env) }));
      if (target?.binding || target?.returnStatement) {
        if (!fact.fulfillment || !call) throw new Error(`awaited value requires a scalar contract ensures summary: ${awaited.expression.getText(source)}`);
        if (call.arguments.length !== fact.fulfillment.parameters.length) throw new Error(`awaited contract argument count does not match ${fact.fulfillment.functionName}`);
        const fresh = `${fn}_await_result_${awaited.getStart(source)}`;
        if (!variables.some(({ name }) => name === fresh)) variables.push({ name: fresh, domain: fact.fulfillment.domain, sort: sort(fact.fulfillment.domain) });
        fulfilled = fulfilled.map((path): PathState => {
          const summaryEnv: Environment = new Map([["result", variable(fresh)]]);
          for (let index = 0; index < fact.fulfillment!.parameters.length; index++) {
            summaryEnv.set(fact.fulfillment!.parameters[index]!, substitute(logic(call.arguments[index]!, pipeBindings, semanticGuards), path.env));
          }
          const nextEnv = new Map(path.env);
          if (target.binding) nextEnv.set(target.binding, variable(fresh));
          const evidence: ContractRelationalCallEvidence = {
            schema: "uneffect-contract-relational-call/v1", evidence: "trusted", typescriptVersion: ts.version,
            functionName: fact.fulfillment!.functionName,
            clauses: fact.fulfillment!.clauses.map(({ source: clause }) => clause), callSpan: originSpan,
            ...(fact.fulfillment!.preconditions.length === 0 ? {} : { preconditions: fact.fulfillment!.preconditions.map(({ source: clause }) => clause) }),
            declarationFileName: fact.fulfillment!.declarationFileName,
            declarationDigest: fact.fulfillment!.declarationDigest,
            declarationSpan: fact.fulfillment!.declarationSpan,
          };
          for (const precondition of fact.fulfillment!.preconditions) {
            add("call-precondition", awaited, path.assumptions, substitute(precondition.expression, summaryEnv), precondition.source, path.env, path.dischargedThrows, [...path.relationalCalls, evidence]);
          }
          const assumptions = [...path.assumptions, ...fact.fulfillment!.clauses.map(({ expression }) => substitute(expression, summaryEnv))];
          if (!target.returnStatement) return { ...path, env: nextEnv, assumptions, relationalCalls: [...path.relationalCalls, evidence] };
          const returnEnv = new Map(nextEnv); returnEnv.set("result", variable(fresh));
          return { ...path, env: nextEnv, assumptions, completion: "return", returnEnv, returnStatement: target.returnStatement, relationalCalls: [...path.relationalCalls, evidence] };
        });
      }
      const rejectionArgument = fact.payloadFromFirstArgument && call ? call.arguments[0] : undefined;
      const rejected = fact.effect ? incoming.map((path): PathState => {
        let payload: LogicExpression | undefined;
        try { if (rejectionArgument) payload = substitute(logic(rejectionArgument, pipeBindings, semanticGuards), path.env); } catch { /* opaque reasons remain effect-only evidence */ }
        return { ...path, env: new Map(path.env), completion: "reject", thrown: { kind: "promise-rejection", evidence: fact.evidence, effect: fact.effect!, originSpan, ...(payload ? { payload } : {}) } };
      }) : [];
      const synchronousThrows = incoming.flatMap((path) => fact.synchronousThrows.map((effect): PathState => ({
        ...path, env: new Map(path.env), completion: "throw",
        thrown: { kind: "synchronous-throw", evidence: fact.evidence, effect, originSpan },
      })));
      return [...(fact.definitelyRejects ? [] : fulfilled), ...rejected, ...synchronousThrows];
    };
    /** One statement of the verified subset; anything else is rejected with its own location. */
    const step = (statement: ts.Statement, incoming: PathState[]): PathState[] => {
      let paths = incoming;
      if (ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1
        && ts.isIdentifier(statement.declarationList.declarations[0]!.name)
        && statement.declarationList.declarations[0]!.initializer
        && ts.isAwaitExpression(statement.declarationList.declarations[0]!.initializer)) {
        const declaration = statement.declarationList.declarations[0]!;
        paths = executeAwait(declaration.initializer as ts.AwaitExpression, paths, { binding: (declaration.name as ts.Identifier).text });
      } else if (ts.isVariableStatement(statement)) {
        for (const path of paths) for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name) || !declaration.initializer) throw new Error(`only initialized identifier variables are supported: ${declaration.getText(source)}`);
          path.env.set(declaration.name.text, substitute(logic(declaration.initializer, pipeBindings, semanticGuards), path.env));
        }
      } else if (ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression) && statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(statement.expression.left)) {
        for (const path of paths) path.env.set(statement.expression.left.text, substitute(logic(statement.expression.right, pipeBindings, semanticGuards), path.env));
      } else if (ts.isIfStatement(statement)) {
        const forked: PathState[] = [];
        for (const path of paths) {
          const condition = substitute(logic(statement.expression, pipeBindings, semanticGuards), path.env);
          const thenStatements = ts.isBlock(statement.thenStatement) ? statement.thenStatement.statements : [statement.thenStatement];
          forked.push(...execute(thenStatements, [{ ...path, env: new Map(path.env), assumptions: [...path.assumptions, condition] }]));
          const elseStatements = statement.elseStatement ? (ts.isBlock(statement.elseStatement) ? statement.elseStatement.statements : [statement.elseStatement]) : [];
          forked.push(...execute(elseStatements, [{ ...path, env: new Map(path.env), assumptions: [...path.assumptions, negate(condition)] }]));
        }
        paths = forked;
      } else if (ts.isWhileStatement(statement)) {
        const invariantSource = extractAnnotations(source.text.slice(statement.getFullStart(), statement.getStart(source)), "invariant")[0];
        if (!invariantSource) throw new Error(`while requires /* uneffect:contract invariant ... */ but ${statement.expression.getText(source)} has none`);
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
          const inv = substitute(invariant, loopEnv), condition = substitute(logic(statement.expression, pipeBindings, semanticGuards), loopEnv);
          const bodyStatements = ts.isBlock(statement.statement) ? statement.statement.statements : [statement.statement];
          const bodyPaths = execute(bodyStatements, [{ ...path, env: new Map(loopEnv), assumptions: [inv, condition] }]);
          for (const bodyPath of bodyPaths.filter((item) => item.completion === "normal")) add("loop-preserve", statement, bodyPath.assumptions, substitute(invariant, bodyPath.env), invariantSource, bodyPath.env);
          exited.push(...bodyPaths.filter((item) => item.completion !== "normal"), { ...path, env: loopEnv, assumptions: [inv, negate(condition)] });
        }
        paths = exited;
      } else if (ts.isTryStatement(statement)) {
        const tryPaths = execute(statement.tryBlock.statements, paths.map((path) => ({ ...path, env: new Map(path.env) })));
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
            if (binding && edge.payload) caughtEnv.set(binding.text, edge.payload);
            return { ...path, env: caughtEnv, completion: "normal", thrown: undefined, returnEnv: undefined, returnStatement: undefined, dischargedThrows: [...path.dischargedThrows, edge] };
          });
          handled = [...completed, ...execute(statement.catchClause.block.statements, caught)];
        }
        if (!statement.finallyBlock) paths = handled;
        else {
          paths = handled.flatMap((prior): PathState[] => {
            const finalPaths = execute(statement.finallyBlock!.statements, [{
              ...prior,
              env: new Map(prior.env),
              completion: "normal",
              thrown: undefined,
              returnEnv: undefined,
              returnStatement: undefined,
            }]);
            return finalPaths.map((finalPath) => finalPath.completion === "normal" ? {
              ...finalPath,
              completion: prior.completion,
              thrown: prior.thrown,
              returnEnv: prior.returnEnv,
              returnStatement: prior.returnStatement,
            } : finalPath);
          });
        }
      } else if (ts.isThrowStatement(statement)) {
        const originSpan = { start: statement.getStart(source), end: statement.getEnd() };
        const effect = throwEffects.get(`${originSpan.start}:${originSpan.end}`) ?? "Throw<unknown>";
        paths = paths.map((path) => {
          let payload: LogicExpression | undefined;
          try { if (statement.expression) payload = substitute(logic(statement.expression, pipeBindings, semanticGuards), path.env); } catch { /* non-scalar payload remains effect-only evidence */ }
          return { ...path, completion: "throw", thrown: { kind: "synchronous-throw", effect, originSpan, ...(payload ? { payload } : {}) } };
        });
      } else if (ts.isReturnStatement(statement) && statement.expression && ts.isAwaitExpression(statement.expression)) {
        paths = executeAwait(statement.expression, paths, { returnStatement: statement });
      } else if (ts.isReturnStatement(statement) && statement.expression) {
        const returnExpression = statement.expression;
        paths = paths.map((path): PathState => {
          const resultEnv = new Map(path.env);
          resultEnv.set("result", substitute(logic(returnExpression, pipeBindings, semanticGuards), path.env));
          return { ...path, completion: "return", returnEnv: resultEnv, returnStatement: statement };
        });
      } else if (ts.isExpressionStatement(statement) && ts.isAwaitExpression(statement.expression)) {
        paths = executeAwait(statement.expression, paths);
      } else if (ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)) {
        const call = statement.expression;
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
      const exits = execute(node.body.statements, [{ env, assumptions: baseAssumptions, completion: "normal", dischargedThrows: [], relationalCalls: [] }]);
      for (const path of exits.filter((item) => item.completion === "return" && item.returnEnv && item.returnStatement)) {
        for (const ensure of ensures) add("postcondition", path.returnStatement!, path.assumptions, substitute(ensure.expression, path.returnEnv!), ensure.source, path.returnEnv!, path.dischargedThrows, path.relationalCalls);
      }
      const escapes = exits.filter((path) => (path.completion === "throw" || path.completion === "reject") && path.thrown).map((path) => path.thrown!);
      for (const obligation of obligations.slice(functionObligationStart)) obligation.controlFlow.exceptionFlow!.escapes = [...escapes];
    } catch (cause) {
      throw locatedLowering(cause, fn, { start: node.getStart(source), end: node.getEnd() });
    }
  }
  return obligations;
}

const smtOperators: Record<string, string> = { add: "+", sub: "-", mul: "*", div: "/", mod: "mod", lt: "<", lte: "<=", gt: ">", gte: ">=", eq: "=", and: "and", or: "or" };
export function logicToSmt(expression: LogicExpression): string {
  if (expression.kind === "variable") return expression.name;
  if (expression.kind === "integer") return expression.value;
  if (expression.kind === "real") return expression.value;
  if (expression.kind === "boolean") return String(expression.value);
  if (expression.kind === "unary") return expression.operator === "not" ? `(not ${logicToSmt(expression.operand)})` : `(- ${logicToSmt(expression.operand)})`;
  if (expression.operator === "neq") return `(not (= ${logicToSmt(expression.left)} ${logicToSmt(expression.right)}))`;
  return `(${smtOperators[expression.operator]} ${logicToSmt(expression.left)} ${logicToSmt(expression.right)})`;
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
