import type { Node } from "oxc-parser";

/** Native 7.0.2/protocol-5 kinds. Unsupported expressions yield no semantic fact. */
export function nativeExpressionKind(node: Node): number | undefined {
  switch (node.type) {
    case "Identifier": return 79;
    case "Literal": return typeof node.value === "boolean" ? node.value ? 111 : 96
      : typeof node.value === "number" ? 8 : typeof node.value === "string" ? 10 : node.value === null && !("regex" in node) ? 105 : undefined;
    case "MemberExpression": return node.computed ? 213 : 212;
    case "CallExpression": return 214;
    case "NewExpression": return 215;
    case "TaggedTemplateExpression": return 216;
    case "TSTypeAssertion": return 217;
    case "ParenthesizedExpression": return 218;
    case "AwaitExpression": return 224;
    case "UnaryExpression": return node.operator === "delete" ? 221 : node.operator === "typeof" ? 222 : node.operator === "void" ? 223 : 225;
    case "UpdateExpression": return node.prefix ? 225 : 226;
    case "BinaryExpression": case "LogicalExpression": case "AssignmentExpression": case "SequenceExpression": return 227;
    case "ConditionalExpression": return 228;
    case "TSAsExpression": return 235;
    case "TSNonNullExpression": return 236;
    case "TSSatisfiesExpression": return 239;
    case "ChainExpression": return nativeExpressionKind(node.expression);
    default: return undefined;
  }
}
