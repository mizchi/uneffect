import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Expression } from "oxc-parser";
import { openCorsaCallableFrontend, type CorsaCallableFrontend } from "../frontends/corsa/corsa-callable-frontend.js";
import type { CorsaApiFrontendOptions } from "../frontends/corsa/corsa-api-frontend.js";
import { parseOxcSource, topLevelOxcFunctions, type OxcFunctionSource, type OxcSource } from "../frontends/oxc/source.js";
import { extractLocatedAnnotations, validateUneffectAnnotations } from "../support/annotations.js";
import { hasNativeContractCandidates, nativeContractAnnotations } from "./contract-annotations.js";
import { parseLogicExpression } from "./logic.js";
import { makeObligation, controlFlowBlockId } from "./obligations.js";
import { solveContractObligations } from "./contract-solver.js";
import type { InvariantObligation, LogicExpression, ObligationVariable } from "./logic-contracts.js";
import type { ContractVerificationResult, VerificationArtifact } from "./verification-contracts.js";

const digest = (input: string | Uint8Array): string => createHash("sha256").update(input).digest("hex");
type ScalarKind = "boolean" | "number";
interface Scalar { expression: LogicExpression; kind: ScalarKind }

/** No arithmetic, coercion, type assertions, properties, or calls in this first body fragment. */
function bodyExpression(node: Expression, parameters: ReadonlySet<string>): Scalar {
  if (node.type === "ParenthesizedExpression") return bodyExpression(node.expression, parameters);
  if (node.type === "Identifier" && parameters.has(node.name)) return { expression: { kind: "variable", name: node.name }, kind: "boolean" };
  if (node.type === "Literal") {
    if (typeof node.value === "boolean") return { expression: { kind: "boolean", value: node.value }, kind: "boolean" };
    if (typeof node.value === "number" && Number.isSafeInteger(node.value)) return { expression: { kind: "integer", value: String(node.value) }, kind: "number" };
  }
  if (node.type === "UnaryExpression" && node.operator === "!") {
    const value = bodyExpression(node.argument, parameters);
    if (value.kind === "boolean") return { kind: "boolean", expression: { kind: "unary", operator: "not", operand: value.expression } };
  }
  if ((node.type === "BinaryExpression" || node.type === "LogicalExpression") && node.left.type !== "PrivateIdentifier") {
    const operator = ({ "===": "eq", "!==": "neq", "&&": "and", "||": "or" } as Record<string, string>)[node.operator];
    const left = bodyExpression(node.left, parameters), right = bodyExpression(node.right, parameters);
    if (operator && left.kind === right.kind && (left.kind === "boolean" || operator === "eq" || operator === "neq")) {
      return { kind: "boolean", expression: { kind: "binary", operator, left: left.expression, right: right.expression } };
    }
  }
  throw new Error(`native contract body does not support ${node.type}`);
}

/** Contract clauses have explicit sorts and cannot introduce undeclared SMT variables. */
function clauseKind(expression: LogicExpression, variables: ReadonlyMap<string, ScalarKind>): ScalarKind {
  if (expression.kind === "variable") {
    const kind = variables.get(expression.name);
    if (!kind) throw new Error(`unknown native contract variable ${expression.name}`);
    return kind;
  }
  if (expression.kind === "boolean") return "boolean";
  if (expression.kind === "integer" && /^\d+$/u.test(expression.value) && Number.isSafeInteger(Number(expression.value))) return "number";
  if (expression.kind === "unary" && expression.operator === "not" && clauseKind(expression.operand, variables) === "boolean") return "boolean";
  if (expression.kind === "binary") {
    const left = clauseKind(expression.left, variables), right = clauseKind(expression.right, variables);
    if (left === right && (expression.operator === "eq" || expression.operator === "neq")) return "boolean";
    if (left === "number" && right === "number" && ["lt", "lte", "gt", "gte"].includes(expression.operator)) return "boolean";
    if (left === "boolean" && right === "boolean" && ["and", "or"].includes(expression.operator)) return "boolean";
  }
  throw new Error("unsupported native contract clause; only scalar comparisons and Boolean operators are admitted");
}

function lowerBody(frontend: CorsaCallableFrontend, source: OxcSource, fn: OxcFunctionSource): InvariantObligation[] {
  const { node } = fn;
  if (validateUneffectAnnotations(fn.comments).length) throw new Error("invalid native contract annotation");
  if (node.async || node.generator || node.typeParameters || node.params.some(parameter => parameter.type !== "Identifier" || parameter.optional)) {
    throw new Error("native contracts require a synchronous non-generic function with simple required parameters");
  }
  if (extractLocatedAnnotations(fn.comments, "contract_from").length) throw new Error("native contract_from body verification is not migrated");
  if (extractLocatedAnnotations(fn.comments, "loop_invariant").length) throw new Error("loop_invariant is not supported on a native function declaration");
  const ensures = extractLocatedAnnotations(fn.comments, "ensures");
  if (!ensures.length) throw new Error("native contracts require an explicit ensures clause");
  const signature = frontend.getSignatureFromDeclaration(source.fileName, fn, source.text);
  if (!signature || signature.parameters.length !== node.params.length
    || frontend.getSignaturesOfTypeAtPosition(source.fileName, node.id.start).length !== 1) {
    throw new Error("native contracts require one authenticated implementation signature");
  }
  const parameters = new Set<string>();
  const variables: ObligationVariable[] = [];
  const typeAssumptions: LogicExpression[] = [];
  for (const [index, parameter] of node.params.entries()) {
    if (parameter.type !== "Identifier" || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(parameter.name)
      || parameter.name === "result" || parameters.has(parameter.name)) throw new Error("unsupported native contract parameter name");
    const native = signature.parameters[index]!;
    if (native.name !== parameter.name || frontend.getPrimitiveTypeKind(native.type) !== "boolean") {
      throw new Error("native contract parameters currently require authenticated Boolean types");
    }
    parameters.add(parameter.name);
    variables.push({ name: parameter.name, sort: "Bool", domain: "bool" });
    const literal = frontend.getBooleanLiteralValue(native.type);
    if (literal !== undefined) typeAssumptions.push({ kind: "binary", operator: "eq",
      left: { kind: "variable", name: parameter.name }, right: { kind: "boolean", value: literal } });
  }
  if (node.body.body.length !== 1) throw new Error("native contracts currently require exactly one return statement");
  const statement = node.body.body[0]!;
  if (statement.type !== "ReturnStatement" || !statement.argument) throw new Error("native contract body must return a scalar expression");
  const result = bodyExpression(statement.argument, parameters);
  if (frontend.getPrimitiveTypeKind(signature.returnType) !== result.kind) throw new Error("native return type does not match the lowered scalar body");
  const kinds = new Map<string, ScalarKind>([...parameters].map(name => [name, "boolean"]));
  const assumptions = [...typeAssumptions, ...extractLocatedAnnotations(fn.comments, "requires").map(({ value }) => parseLogicExpression(value))];
  for (const assumption of assumptions) if (clauseKind(assumption, kinds) !== "boolean") throw new Error("requires must be Boolean");
  kinds.set("result", result.kind);
  variables.push({ name: "result", sort: result.kind === "boolean" ? "Bool" : "Int", domain: result.kind === "boolean" ? "bool" : "int" });
  const span = { start: statement.start, end: statement.end };
  return ensures.map(({ value }) => {
    const goal = parseLogicExpression(value);
    if (clauseKind(goal, kinds) !== "boolean") throw new Error("ensures must be Boolean");
    return makeObligation({ kind: "postcondition", fileName: source.fileName, functionName: node.id.name, span, variables,
      assumptions: [...assumptions, { kind: "binary", operator: "eq", left: { kind: "variable", name: "result" }, right: result.expression }],
      goal, source: value, bindings: [{ name: "result", expression: result.expression }], displayNames: {},
      controlFlow: { schema: "uneffect-contract-control-flow/v1", blockId: controlFlowBlockId(source.fileName, node.id.name, span, "return"), completion: "return", pathConditions: [...assumptions] } });
  });
}

/** Prove only admitted bodies; unsupported annotations always produce non-proof artifacts. */
export async function verifyCorsaContracts(options: CorsaApiFrontendOptions & { files: ReadonlyMap<string, string> }): Promise<ContractVerificationResult> {
  const sources = [...options.files].filter(([, text]) => hasNativeContractCandidates(text))
    .map(([file, text]) => parseOxcSource(resolve(file), text))
    .filter(source => source.comments.some(comment => hasNativeContractCandidates(source.textOf(comment))));
  if (!sources.length) return { diagnostics: [], artifacts: [] };
  const frontend = await openCorsaCallableFrontend(options);
  try {
    for (const source of sources) frontend.assertSource(source.fileName, source.text);
    const errors = frontend.getProjectDiagnostics().filter(diagnostic => diagnostic.category === "error");
    if (errors.length) throw new Error(errors.map(error => `${error.fileName ?? options.configFile}: TS${error.code}: ${error.message}`).join("\n"));
    const compilerDigest = digest(readFileSync(frontend.compilerExecutable));
    const result: ContractVerificationResult = { diagnostics: [], artifacts: [] };
    for (const source of sources) {
      const native: NonNullable<VerificationArtifact["native"]> = { coverage: "boolean-and-constant-return", compilerRevision: frontend.compilerRevision, compilerDigest, sourceDigest: digest(source.text) };
      const covered: Array<{ start: number; end: number }> = [];
      const unsupported = (functionName: string, span: { start: number; end: number }, message: string) => {
        const artifact: VerificationArtifact = { obligationId: `unsupported_${digest(JSON.stringify({ fileName: source.fileName, span, message })).slice(0, 20)}`,
          status: "unsupported", evidence: "unknown", source: { fileName: source.fileName, span }, message, native };
        result.artifacts.push(artifact);
        result.diagnostics.push({ fileName: source.fileName, functionName, clause: "unsupported", line: source.positionAt(span.start).line + 1, message, artifact });
      };
      for (const fn of topLevelOxcFunctions(source)) {
        if (!hasNativeContractCandidates(fn.comments)) continue;
        covered.push({ start: fn.leadingStart, end: fn.start });
        let obligations: InvariantObligation[];
        try {
          obligations = lowerBody(frontend, source, fn);
        } catch (error) {
          unsupported(fn.node.id.name, { start: fn.start, end: fn.end }, error instanceof Error ? error.message : String(error));
          continue;
        }
        const proved = await solveContractObligations(source.fileName, obligations, position => source.positionAt(position).line + 1);
        for (const artifact of proved.artifacts) artifact.native = native;
        result.artifacts.push(...proved.artifacts);
        result.diagnostics.push(...proved.diagnostics);
      }
      for (const annotation of source.comments.flatMap(comment => nativeContractAnnotations(source.textOf(comment), comment.start))) {
        if (!covered.some(span => span.start <= annotation.span.start && annotation.span.end <= span.end)) {
          unsupported("<contract>", annotation.span, "native contract annotation is outside the supported top-level function attachment");
        }
      }
    }
    return result;
  } finally { frontend.close(); }
}
