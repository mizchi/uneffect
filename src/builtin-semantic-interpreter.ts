import ts from "@typescript/typescript6";
import type { SourceSpan } from "./annotations.js";
import type { BuiltinSymbolKey } from "./builtin-contracts.js";
import type {
  BuiltinSemantics,
  ScopeProjector,
  SemanticPrimitive,
  ValueProjector,
} from "./builtin-semantic-schema.js";

export interface BuiltinSemanticSource {
  symbol: BuiltinSymbolKey;
  span: SourceSpan;
}

export interface SemanticEventSource extends BuiltinSemanticSource {
  primitiveIndex: number;
  /** Directional/nested primitive path inside the top-level primitive. */
  primitivePath: readonly (string | number)[];
}

export type ProjectedValue =
  | { status: "resolved"; expression: ts.Expression; path: readonly string[] }
  | { status: "result"; path: readonly string[] }
  | { status: "absent"; path: readonly string[] }
  | { status: "unknown"; reason: string };

export type ProjectedScope =
  | { status: "resolved"; kind: ScopeProjector["kind"]; value?: string; target?: ProjectedValue; member?: string; methodArgument?: number; methodFrom?: "value" | "request-init"; defaultPort?: number; networkFormat?: "host" | "connect" | "http-request" | "websocket"; hostArgument?: number; keyFormat?: "cookie-assignment" }
  | { status: "unknown"; reason: string };

export type BuiltinSemanticEvent =
  | { kind: "effect"; capability: string; scope?: ProjectedScope; source: SemanticEventSource }
  | { kind: "mutate" | "clone" | "transfer"; target: ProjectedValue; source: SemanticEventSource }
  | { kind: "callback"; target: ProjectedValue; timing: Extract<SemanticPrimitive, { kind: "callback" }>["timing"]; queue: Extract<SemanticPrimitive, { kind: "callback" }>["queue"]; cardinality: Extract<SemanticPrimitive, { kind: "callback" }>["cardinality"]; completion?: Extract<SemanticPrimitive, { kind: "callback" }>["completion"]; callable?: "required" | "optional"; returnDepth?: number; abortSignal?: ProjectedValue; invocationArguments?: readonly ProjectedValue[]; thisArgument?: ProjectedValue; source: SemanticEventSource }
  | { kind: "invoke-user-code"; source: SemanticEventSource }
  | { kind: "result"; refinement: Extract<SemanticPrimitive, { kind: "result" }>["refinement"]; source: SemanticEventSource }
  | { kind: "acquire" | "use" | "release"; resource: string; target?: ProjectedValue; completion: "call" | "fulfillment"; source: SemanticEventSource }
  | { kind: "throw"; error: string; condition?: string; source: SemanticEventSource }
  | { kind: "reject"; error: string; source: SemanticEventSource }
  | { kind: "protocol"; name: string; transition: string; inputs: Readonly<Record<string, ProjectedValue>>; source: SemanticEventSource }
  | { kind: "unknown"; reason: string; primitive: SemanticPrimitive; source: SemanticEventSource };

function receiverOf(call: ts.CallExpression): ts.Expression | undefined {
  return ts.isPropertyAccessExpression(call.expression) || ts.isElementAccessExpression(call.expression)
    ? call.expression.expression : undefined;
}

interface ProjectionContext {
  readonly receiver?: ts.Expression;
  readonly arguments?: readonly ts.Expression[];
  readonly assignedValue?: ts.Expression;
  readonly resolveStaticString?: (expression: ts.Expression) => string | undefined;
}

function projectValue(projector: ValueProjector, context: ProjectionContext, depth = 0): ProjectedValue {
  if (depth > 16) return { status: "unknown", reason: "projector nesting limit exceeded" };
  switch (projector.kind) {
    case "receiver": {
      const expression = context.receiver;
      return expression ? { status: "resolved", expression, path: [] } : { status: "unknown", reason: "call has no receiver" };
    }
    case "assigned-value": {
      const expression = context.assignedValue;
      return expression ? { status: "resolved", expression, path: [] } : { status: "unknown", reason: "property access has no assigned value" };
    }
    case "argument": {
      const expression = context.arguments?.[projector.index];
      if (!expression && projector.optional) return { status: "absent", path: [] };
      return expression && !ts.isSpreadElement(expression)
        ? { status: "resolved", expression, path: [] }
        : { status: "unknown", reason: `missing argument ${projector.index}` };
    }
    case "argument-from-end": {
      const arguments_ = context.arguments ?? [];
      if (projector.minimumArguments !== undefined && arguments_.length < projector.minimumArguments) {
        return { status: "unknown", reason: `call has fewer than ${projector.minimumArguments} arguments` };
      }
      const index = arguments_.length - projector.offset;
      const expression = index >= 0 ? arguments_[index] : undefined;
      return expression && !ts.isSpreadElement(expression)
        ? { status: "resolved", expression, path: [] }
        : { status: "unknown", reason: `missing argument ${projector.offset} from end` };
    }
    case "result": return { status: "result", path: [] };
    case "runtime-value": return { status: "unknown", reason: `runtime callback value: ${projector.role}` };
    case "array-elements": return { status: "unknown", reason: "array-elements projector requires a multi-value consumer" };
    case "property": {
      const target = projectValue(projector.target, context, depth + 1);
      return target.status === "unknown" ? target : { ...target, path: [...target.path, projector.key] };
    }
    case "region": {
      const target = projectValue(projector.target, context, depth + 1);
      return target.status === "unknown" ? target : { ...target, path: [...target.path, projector.region] };
    }
  }
}

function projectScope(projector: ScopeProjector, context: ProjectionContext): ProjectedScope {
  if (projector.kind === "literal") return { status: "resolved", kind: "literal", value: projector.value };
  const target = projectValue(projector.target, context);
  if (target.status === "unknown") return { status: "unknown", reason: target.reason };
  return {
    status: "resolved",
    kind: projector.kind,
    target,
    ...(projector.kind === "region" ? { member: projector.member } : {}),
    ...(projector.kind === "url" && projector.methodArgument !== undefined ? { methodArgument: projector.methodArgument } : {}),
    ...(projector.kind === "url" && projector.methodFrom !== undefined ? { methodFrom: projector.methodFrom } : {}),
    ...(projector.kind === "network" ? { networkFormat: projector.format } : {}),
    ...(projector.kind === "network" && projector.defaultPort !== undefined ? { defaultPort: projector.defaultPort } : {}),
    ...(projector.kind === "network" && projector.hostArgument !== undefined ? { hostArgument: projector.hostArgument } : {}),
    ...(projector.kind === "literal-key" && projector.format !== undefined ? { keyFormat: projector.format } : {}),
  };
}

function interpretPrimitive(
  primitive: SemanticPrimitive,
  context: ProjectionContext,
  source: SemanticEventSource,
  access: "read" | "write" | undefined,
): BuiltinSemanticEvent[] {
  switch (primitive.kind) {
    case "effect": {
      if (primitive.when?.kind === "argument-literal-in") {
        const argument = context.arguments?.[primitive.when.index];
        const literal = argument && (ts.isStringLiteralLike(argument) ? argument.text : context.resolveStaticString?.(argument));
        if (literal !== undefined && !primitive.when.values.includes(literal)) return [];
      }
      return [{ kind: "effect", capability: primitive.capability, ...(primitive.scope ? { scope: projectScope(primitive.scope, context) } : {}), source }];
    }
    case "mutate": case "clone": case "transfer": {
      const target = projectValue(primitive.target, context);
      return target.status === "unknown"
        ? [{ kind: "unknown", reason: target.reason, primitive, source }]
        : [{ kind: primitive.kind, target, source }];
    }
    case "callback": {
      const targets = primitive.target.kind === "array-elements"
        ? (() => {
            const container = projectValue(primitive.target.target, context);
            if (container.status !== "resolved") return [container];
            const elements = projectedArrayElements(container);
            return elements ? elements.map((expression): ProjectedValue => ({ status: "resolved", expression, path: [] }))
              : [{ status: "unknown", reason: "projected callback collection is not a literal array" } as ProjectedValue];
          })()
        : [projectValue(primitive.target, context)];
      const once = primitive.once ? projectedStaticBoolean(projectValue(primitive.once, context)) : undefined;
      const cardinality = once === true ? "0..1" : primitive.cardinality;
      const abortSignal = primitive.abortSignal ? projectValue(primitive.abortSignal, context) : undefined;
      const fixedInvocationArguments = primitive.invocationArguments?.map((argument) => projectValue(argument, context));
      const restInvocationArguments = primitive.invocationRestArguments
        ? (context.arguments ?? []).slice(primitive.invocationRestArguments.from).map((argument, offset) =>
          ts.isSpreadElement(argument)
            ? { status: "unknown" as const, reason: `spread callback argument ${primitive.invocationRestArguments!.from + offset}` }
            : { status: "resolved" as const, expression: argument, path: [] })
        : undefined;
      const invocationArguments = fixedInvocationArguments || restInvocationArguments
        ? [...(fixedInvocationArguments ?? []), ...(restInvocationArguments ?? [])] : undefined;
      const thisArgument = primitive.thisArgument ? projectValue(primitive.thisArgument, context) : undefined;
      return targets.map((target) => target.status === "unknown"
        ? { kind: "unknown", reason: target.reason, primitive, source } as const
        : { kind: "callback", target, timing: primitive.timing, queue: primitive.queue, cardinality,
            ...(primitive.completion ? { completion: primitive.completion } : {}),
            ...(primitive.callable ? { callable: primitive.callable } : {}), ...(primitive.returnDepth === undefined ? {} : { returnDepth: primitive.returnDepth }),
            ...(abortSignal && abortSignal.status !== "absent" ? { abortSignal } : {}),
            ...(invocationArguments ? { invocationArguments } : {}),
            ...(thisArgument && thisArgument.status !== "absent" ? { thisArgument } : {}), source } as const);
    }
    case "invoke-user-code": return [{ kind: "invoke-user-code", source }];
    case "result": return [{ kind: "result", refinement: primitive.refinement, source }];
    case "acquire": case "use": case "release": {
      const target = primitive.target ? projectValue(primitive.target, context) : undefined;
      return target?.status === "unknown"
        ? [{ kind: "unknown", reason: target.reason, primitive, source }]
        : [{ kind: primitive.kind, resource: primitive.resource, ...(target ? { target } : {}), completion: primitive.completion ?? "call", source }];
    }
    case "throw": return [{ kind: "throw", error: primitive.error, ...(primitive.condition ? { condition: primitive.condition } : {}), source }];
    case "reject": return [{ kind: "reject", error: primitive.error, source }];
    case "property": {
      if (!access) return [{ kind: "unknown", reason: "property primitive requires an access direction", primitive, source }];
      return primitive[access].flatMap((nested, index) => interpretPrimitive(nested, context, {
        ...source, primitivePath: [...source.primitivePath, access, index],
      }, access));
    }
    case "protocol": {
      const inputs = Object.fromEntries(Object.entries(primitive.inputs ?? {}).map(([name, target]) => [name, projectValue(target, context)]));
      const unknown = Object.entries(inputs).find(([, target]) => target.status === "unknown");
      return unknown
        ? [{ kind: "unknown", reason: `${unknown[0]}: ${(unknown[1] as Extract<ProjectedValue, { status: "unknown" }>).reason}`, primitive, source }]
        : [{ kind: "protocol", name: primitive.name, transition: primitive.transition, inputs, source }];
    }
  }
}

/**
 * Interpret reviewed data once into source-attributed, domain-neutral events.
 * Domain analyzers consume these events; they do not reinterpret projectors.
 */
export function interpretBuiltinCallSemantics(
  semantics: BuiltinSemantics,
  call: ts.CallExpression | ts.NewExpression,
  source: BuiltinSemanticSource,
  access?: "read" | "write",
  options: { readonly resolveStaticString?: (expression: ts.Expression) => string | undefined } = {},
): BuiltinSemanticEvent[] {
  const context = { receiver: ts.isCallExpression(call) ? receiverOf(call) : undefined,
    arguments: [...(call.arguments ?? [])], resolveStaticString: options.resolveStaticString };
  return semantics.primitives.flatMap((primitive, primitiveIndex) => interpretPrimitive(primitive, context, {
    ...source, primitiveIndex, primitivePath: [],
  }, access));
}

/** Interpret the same primitives for a TypeChecker-resolved property access. */
export function interpretBuiltinPropertySemantics(
  semantics: BuiltinSemantics,
  access: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  source: BuiltinSemanticSource,
  direction: "read" | "write",
): BuiltinSemanticEvent[] {
  const parent = access.parent;
  const assignedValue = direction === "write" && ts.isBinaryExpression(parent) && parent.left === access
    && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken ? parent.right : undefined;
  const context = { receiver: access.expression, assignedValue };
  return semantics.primitives.flatMap((primitive, primitiveIndex) => interpretPrimitive(primitive, context, {
    ...source, primitiveIndex, primitivePath: [],
  }, direction));
}

export type BuiltinCallbackEvent = Extract<BuiltinSemanticEvent, { kind: "callback" }>;

/** Resolve a projected literal array, including property paths such as options.transfer. */
export function projectedArrayElements(target: ProjectedValue): readonly ts.Expression[] | undefined {
  const expression = projectedExpression(target);
  if (!expression) return undefined;
  return ts.isArrayLiteralExpression(expression) ? expression.elements.filter(ts.isExpression) : undefined;
}

/** Materialize an object-literal property projection without evaluating user code. */
export function projectedExpression(target: ProjectedValue): ts.Expression | undefined {
  if (target.status !== "resolved") return undefined;
  let expression = target.expression;
  for (const key of target.path) {
    if (!ts.isObjectLiteralExpression(expression)) return undefined;
    const property = expression.properties.find((candidate) =>
      (ts.isPropertyAssignment(candidate) || ts.isShorthandPropertyAssignment(candidate))
      && !ts.isComputedPropertyName(candidate.name)
      && candidate.name.getText().replace(/^['"]|['"]$/g, "") === key);
    if (!property) return undefined;
    if (ts.isPropertyAssignment(property)) expression = property.initializer;
    else if (ts.isShorthandPropertyAssignment(property)) expression = property.name;
    else return undefined;
  }
  return expression;
}

function projectedStaticBoolean(target: ProjectedValue): boolean | undefined {
  const expression = projectedExpression(target);
  if (!expression) return undefined;
  return expression.kind === ts.SyntaxKind.TrueKeyword ? true
    : expression.kind === ts.SyntaxKind.FalseKeyword ? false : undefined;
}

/** Shared callback selection used by call-graph and async consumers. */
export function projectBuiltinCallbacks(
  resolved: { semantics?: BuiltinSemantics; symbol: BuiltinSymbolKey; span: SourceSpan } | undefined,
  call: ts.CallExpression,
  checker?: ts.TypeChecker,
): BuiltinCallbackEvent[] {
  if (!resolved?.semantics) return [];
  return interpretBuiltinCallSemantics(resolved.semantics, call, { symbol: resolved.symbol, span: resolved.span })
    .filter((event): event is BuiltinCallbackEvent => {
      if (event.kind !== "callback") return false;
      // `required` describes a contract position, even when the inferred value is a
      // callable/undefined union. Only overload-selecting `optional` positions need
      // a TypeChecker guard to avoid treating options or data arguments as callbacks.
      if (!checker || event.callable !== "optional" || event.target.status !== "resolved") return true;
      const type = checker.getTypeAtLocation(event.target.expression);
      return type.getCallSignatures().length > 0 || Boolean(type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown));
    });
}
