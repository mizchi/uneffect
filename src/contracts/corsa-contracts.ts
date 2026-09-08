import { createHash } from "node:crypto";
import type { Expression } from "oxc-parser";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { openCorsaCallableFrontend, type CorsaCallableFrontend } from "../frontends/corsa/corsa-callable-frontend.js";
import type { CorsaApiFrontendOptions } from "../frontends/corsa/corsa-api-frontend.js";
import { parseOxcSource, topLevelOxcFunctions, type OxcFunctionSource, type OxcSource } from "../frontends/oxc/source.js";
import { extractLocatedAnnotations, validateUneffectAnnotations } from "../support/annotations.js";
import { hasNativeContractCandidates, nativeContractAnnotations } from "./contract-annotations.js";
import { parseLogicExpression } from "./logic.js";
import { makeObligation, controlFlowBlockId } from "./obligations.js";
import { solveContractObligations } from "./contract-solver.js";
import { lowerNativeReturnPaths } from "./corsa-contract-flow.js";
import { narrowNativeRanges } from "./native-ranges.js";
import { checkNativeScalar, nativeBodyExpression, nativeInteger, hasNumericExpression, type NativeScalar } from "./native-scalars.js";
import type { InvariantObligation, LogicExpression, ObligationVariable } from "./logic-contracts.js";
import type { ContractVerificationResult, VerificationArtifact } from "./verification-contracts.js";

const digest = (input: string | Uint8Array): string => createHash("sha256").update(input).digest("hex");
function substituteLogic(expression: LogicExpression, substitutions: ReadonlyMap<string, LogicExpression>): LogicExpression {
  if (expression.kind === "variable") return substitutions.get(expression.name) ?? expression;
  if (expression.kind === "unary") return { ...expression, operand: substituteLogic(expression.operand, substitutions) };
  if (expression.kind === "binary") return { ...expression, left: substituteLogic(expression.left, substitutions), right: substituteLogic(expression.right, substitutions) };
  return expression;
}
function lowerBody(frontend: CorsaCallableFrontend, source: OxcSource, fn: OxcFunctionSource,
  resolveCall?: (node: Extract<Expression, { type: "CallExpression" }>) => LogicExpression | undefined): InvariantObligation[] {
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
  const parameters = new Map<string, NativeScalar>();
  const variables: ObligationVariable[] = [];
  const typeAssumptions: LogicExpression[] = [];
  for (const [index, parameter] of node.params.entries()) {
    if (parameter.type !== "Identifier" || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(parameter.name)
      || parameter.name === "result" || parameters.has(parameter.name)) throw new Error("unsupported native contract parameter name");
    const native = signature.parameters[index]!;
    if (native.name !== parameter.name) throw new Error("native parameter identity does not match source");
    const expression: LogicExpression = { kind: "variable", name: parameter.name };
    if (frontend.getPrimitiveTypeKind(native.type) === "boolean") {
      parameters.set(parameter.name, { expression, kind: "boolean" });
      variables.push({ name: parameter.name, sort: "Bool", domain: "bool" });
      const literal = frontend.getBooleanLiteralValue(native.type);
      if (literal !== undefined) typeAssumptions.push({ kind: "binary", operator: "eq",
        left: expression, right: { kind: "boolean", value: literal } });
    } else {
      const values = frontend.getFiniteNumberValues(native.type);
      if (!values) throw new Error("native numeric parameters require finite safe integer literal types (at most 16 values)");
      const numeric = nativeInteger(expression, BigInt(values[0]!), BigInt(values[values.length - 1]!));
      parameters.set(parameter.name, numeric.kind === "number" ? { ...numeric, values: Object.freeze(values.map(BigInt)) } : numeric);
      variables.push({ name: parameter.name, sort: "Int", domain: "int" });
      typeAssumptions.push(values.map((value): LogicExpression => ({ kind: "binary", operator: "eq", left: expression,
        right: { kind: "integer", value: String(value) } })).reduce((left, right) => ({ kind: "binary", operator: "or", left, right })));
    }
  }
  const assumptions = [...typeAssumptions, ...extractLocatedAnnotations(fn.comments, "requires").map(({ value }) => parseLogicExpression(value))];
  // Requires must be safe over the declared type before any of them can narrow the body.
  for (const assumption of assumptions) if (checkNativeScalar(assumption, parameters).kind !== "boolean") throw new Error("requires must be Boolean");
  const requiredParameters = narrowNativeRanges(parameters, assumptions);
  const paths = lowerNativeReturnPaths(node.body, (expression, conditions) => checkNativeScalar(nativeBodyExpression(expression, resolveCall),
    conditions === null ? parameters : narrowNativeRanges(requiredParameters, conditions), conditions === null ? "structure" : "proof"));
  const resultKind = paths[0]!.result.kind;
  if (paths.some(path => path.result.kind !== resultKind) || frontend.getPrimitiveTypeKind(signature.returnType) !== resultKind) {
    throw new Error("native return type does not match the lowered scalar body");
  }
  const resultExpression: LogicExpression = { kind: "variable", name: "result" };
  variables.push({ name: "result", sort: resultKind === "boolean" ? "Bool" : "Int", domain: resultKind === "boolean" ? "bool" : "int" });
  return paths.flatMap(({ span, result, conditions }) => ensures.map(({ value }) => {
    const kinds = new Map(narrowNativeRanges(requiredParameters, conditions));
      kinds.set("result", result.kind === "number" ? { ...result, expression: resultExpression } : { kind: "boolean", expression: resultExpression });
    const goal = parseLogicExpression(value);
    if (checkNativeScalar(goal, kinds).kind !== "boolean") throw new Error("ensures must be Boolean");
    return makeObligation({ kind: "postcondition", fileName: source.fileName, functionName: node.id.name, span, variables,
      assumptions: [...assumptions, ...conditions, { kind: "binary", operator: "eq", left: { kind: "variable", name: "result" }, right: result.expression }],
      goal, source: value, bindings: [{ name: "result", expression: result.expression }], displayNames: {},
      controlFlow: { schema: "uneffect-contract-control-flow/v1", blockId: controlFlowBlockId(source.fileName, node.id.name, span, "return"), completion: "return", pathConditions: [...assumptions, ...conditions] } });
  }));
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
    const callableBodies = new Map<string, { source: OxcSource; fn: OxcFunctionSource }>();
    for (const candidateSource of sources) for (const candidate of topLevelOxcFunctions(candidateSource)) callableBodies.set(candidate.node.id.name, { source: candidateSource, fn: candidate });
    const resolveCall = (call: Extract<Expression, { type: "CallExpression" }>): LogicExpression | undefined => {
      if (call.callee.type !== "Identifier" || call.optional) return undefined;
      const target = callableBodies.get(call.callee.name);
      if (!target || target.fn.node.params.length > 8 || target.fn.node.body.body.length !== 1
        || target.fn.node.body.body[0]!.type !== "ReturnStatement" || !target.fn.node.body.body[0]!.argument
        || !extractLocatedAnnotations(target.fn.comments, "ensures").length) return undefined;
      if (!frontend.getSignatureFromDeclaration(target.source.fileName, target.fn, target.source.text)) return undefined;
      if (target.fn.node.params.length === 0 && call.arguments.length !== 0) return undefined;
      if (call.arguments.length !== target.fn.node.params.length || call.arguments.some(argument => argument.type === "SpreadElement")) return undefined;
      try {
        const body = nativeBodyExpression(target.fn.node.body.body[0]!.argument);
        if (target.fn.node.params.length === 0) return body;
        const arguments_ = call.arguments.map(argument => nativeBodyExpression(argument as Expression));
        const substitutions = new Map<string, LogicExpression>();
        target.fn.node.params.forEach((parameter, index) => { if (parameter.type === "Identifier") substitutions.set(parameter.name, arguments_[index]!); });
        const requires = extractLocatedAnnotations(target.fn.comments, "requires");
        if (requires.length) {
          const requirement = substituteLogic(parseLogicExpression(requires[0]!.value), substitutions);
          const checked = checkNativeScalar(requirement, new Map());
          const constantTrue = requirement.kind === "binary"
            && ["lt", "lte", "gt", "gte", "eq", "neq"].includes(requirement.operator)
            && requirement.left.kind === "integer" && requirement.right.kind === "integer"
            && ({ lt: BigInt(requirement.left.value) < BigInt(requirement.right.value), lte: BigInt(requirement.left.value) <= BigInt(requirement.right.value), gt: BigInt(requirement.left.value) > BigInt(requirement.right.value), gte: BigInt(requirement.left.value) >= BigInt(requirement.right.value), eq: requirement.left.value === requirement.right.value, neq: requirement.left.value !== requirement.right.value } as Record<string, boolean>)[requirement.operator];
          if (checked.kind !== "boolean" || !constantTrue) return undefined;
        }
        return substituteLogic(body, substitutions);
      } catch { return undefined; }
    };
    for (const source of sources) {
      const native: NonNullable<VerificationArtifact["native"]> = { coverage: "boolean-and-constant-return", compilerRevision: frontend.compilerRevision, compilerDigest, sourceDigest: digest(source.text) };
      const covered: Array<{ start: number; end: number }> = [];
      const unsupported = (functionName: string, span: { start: number; end: number }, message: string, coverage = native.coverage) => {
        const artifact: VerificationArtifact = { obligationId: `unsupported_${digest(JSON.stringify({ fileName: source.fileName, span, message })).slice(0, 20)}`,
          status: "unsupported", evidence: "unknown", source: { fileName: source.fileName, span }, message, native: { ...native, coverage } };
        result.artifacts.push(artifact);
        result.diagnostics.push({ fileName: source.fileName, functionName, clause: "unsupported", line: source.positionAt(span.start).line + 1, message, artifact });
      };
      for (const fn of topLevelOxcFunctions(source)) {
        if (!hasNativeContractCandidates(fn.comments)) continue;
        covered.push({ start: fn.leadingStart, end: fn.start });
        const coverage = fn.node.body.body.length === 1 && fn.node.body.body[0]!.type === "ReturnStatement"
          ? "boolean-and-constant-return" : "boolean-branching";
        let obligations: InvariantObligation[];
        try {
          obligations = lowerBody(frontend, source, fn, resolveCall);
        } catch (error) {
          unsupported(fn.node.id.name, { start: fn.start, end: fn.end }, error instanceof Error ? error.message : String(error), coverage);
          continue;
        }
        const proved = await solveContractObligations(source.fileName, obligations, position => source.positionAt(position).line + 1);
        const numeric = obligations.some(obligation => obligation.variables.some(variable => variable.sort === "Int")
          || obligation.assumptions.some(hasNumericExpression) || hasNumericExpression(obligation.goal));
        for (const artifact of proved.artifacts) artifact.native = { ...native, coverage: numeric ? "safe-integer-arithmetic" : coverage };
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
