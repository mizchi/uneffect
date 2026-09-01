import ts from "typescript";
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
  | { status: "resolved"; kind: ScopeProjector["kind"]; value?: string; target?: ProjectedValue; member?: string; methodArgument?: number; methodFrom?: "value" | "request-init"; defaultPort?: number; networkFormat?: "host" | "connect" | "http-request"; hostArgument?: number }
  | { status: "unknown"; reason: string };

export type BuiltinSemanticEvent =
  | { kind: "effect"; capability: string; scope?: ProjectedScope; source: SemanticEventSource }
  | { kind: "mutate" | "clone" | "transfer"; target: ProjectedValue; source: SemanticEventSource }
  | { kind: "callback"; target: ProjectedValue; timing: Extract<SemanticPrimitive, { kind: "callback" }>["timing"]; queue: Extract<SemanticPrimitive, { kind: "callback" }>["queue"]; cardinality: Extract<SemanticPrimitive, { kind: "callback" }>["cardinality"]; callable?: "required" | "optional"; returnDepth?: number; source: SemanticEventSource }
  | { kind: "invoke-user-code"; source: SemanticEventSource }
  | { kind: "result"; refinement: Extract<SemanticPrimitive, { kind: "result" }>["refinement"]; source: SemanticEventSource }
  | { kind: "acquire" | "release"; resource: string; target?: ProjectedValue; source: SemanticEventSource }
  | { kind: "throw"; error: string; condition?: string; source: SemanticEventSource }
  | { kind: "protocol"; name: string; transition: string; inputs: Readonly<Record<string, ProjectedValue>>; source: SemanticEventSource }
  | { kind: "unknown"; reason: string; primitive: SemanticPrimitive; source: SemanticEventSource };

function receiverOf(call: ts.CallExpression): ts.Expression | undefined {
  return ts.isPropertyAccessExpression(call.expression) || ts.isElementAccessExpression(call.expression)
    ? call.expression.expression : undefined;
}

interface ProjectionContext {
  receiver?: ts.Expression;
  arguments?: readonly ts.Expression[];
}

function projectValue(projector: ValueProjector, context: ProjectionContext, depth = 0): ProjectedValue {
  if (depth > 16) return { status: "unknown", reason: "projector nesting limit exceeded" };
  switch (projector.kind) {
    case "receiver": {
      const expression = context.receiver;
      return expression ? { status: "resolved", expression, path: [] } : { status: "unknown", reason: "call has no receiver" };
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
  };
}

function interpretPrimitive(
  primitive: SemanticPrimitive,
  context: ProjectionContext,
  source: SemanticEventSource,
  access: "read" | "write" | undefined,
): BuiltinSemanticEvent[] {
  switch (primitive.kind) {
    case "effect": return [{ kind: "effect", capability: primitive.capability, ...(primitive.scope ? { scope: projectScope(primitive.scope, context) } : {}), source }];
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
      return targets.map((target) => target.status === "unknown"
        ? { kind: "unknown", reason: target.reason, primitive, source } as const
        : { kind: "callback", target, timing: primitive.timing, queue: primitive.queue, cardinality: primitive.cardinality,
            ...(primitive.callable ? { callable: primitive.callable } : {}), ...(primitive.returnDepth === undefined ? {} : { returnDepth: primitive.returnDepth }), source } as const);
    }
    case "invoke-user-code": return [{ kind: "invoke-user-code", source }];
    case "result": return [{ kind: "result", refinement: primitive.refinement, source }];
    case "acquire": case "release": {
      const target = primitive.target ? projectValue(primitive.target, context) : undefined;
      return target?.status === "unknown"
        ? [{ kind: "unknown", reason: target.reason, primitive, source }]
        : [{ kind: primitive.kind, resource: primitive.resource, ...(target ? { target } : {}), source }];
    }
    case "throw": return [{ kind: "throw", error: primitive.error, ...(primitive.condition ? { condition: primitive.condition } : {}), source }];
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
  call: ts.CallExpression,
  source: BuiltinSemanticSource,
  access?: "read" | "write",
): BuiltinSemanticEvent[] {
  const context = { receiver: receiverOf(call), arguments: [...call.arguments] };
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
  const context = { receiver: access.expression };
  return semantics.primitives.flatMap((primitive, primitiveIndex) => interpretPrimitive(primitive, context, {
    ...source, primitiveIndex, primitivePath: [],
  }, direction));
}

export type BuiltinCallbackEvent = Extract<BuiltinSemanticEvent, { kind: "callback" }>;

/** Resolve a projected literal array, including property paths such as options.transfer. */
export function projectedArrayElements(target: ProjectedValue): readonly ts.Expression[] | undefined {
  if (target.status !== "resolved") return undefined;
  let expression = target.expression;
  for (const key of target.path) {
    if (!ts.isObjectLiteralExpression(expression)) return undefined;
    const property = expression.properties.find((candidate) => ts.isPropertyAssignment(candidate)
      && !ts.isComputedPropertyName(candidate.name)
      && candidate.name.getText().replace(/^['"]|['"]$/g, "") === key);
    if (!property || !ts.isPropertyAssignment(property)) return undefined;
    expression = property.initializer;
  }
  return ts.isArrayLiteralExpression(expression) ? expression.elements.filter(ts.isExpression) : undefined;
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
