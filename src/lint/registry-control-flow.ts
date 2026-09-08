import type { Node } from "oxc-parser";

/** Syntax control flow only; identity, events, and abstract state belong to callers. */
interface RegistryFlowBuilder {
  block(successors: string[]): string;
  connect(from: string, to: string): void;
  expression(node: Node, next: string): string;
  condition(node: Node, whenTrue: string, whenFalse: string): string;
  invalidate(node: Node, next: string): string;
  unsupported(node: Node, message: string): never;
}

export function lowerRegistryStatements(body: Node, builder: RegistryFlowBuilder): string {
  const exit = builder.block([]);
  type Loop = { break: string; continue: string };
  const statement = (node: Node, next: string, loop?: Loop): string => {
    switch (node.type) {
      case "BlockStatement":
        for (const child of [...node.body].reverse()) next = statement(child, next, loop);
        return next;
      case "EmptyStatement": case "FunctionDeclaration": return next;
      case "ExpressionStatement": return builder.expression(node.expression, next);
      case "VariableDeclaration":
        if (node.kind === "using" || node.kind === "await using") return builder.unsupported(node, "resource disposal requires completion analysis");
        for (const declaration of [...node.declarations].reverse()) {
          if (declaration.id.type !== "Identifier") return builder.unsupported(declaration, "destructuring requires binding and implicit-call analysis");
          if (declaration.init) next = builder.expression(declaration.init, builder.invalidate(declaration, next));
        }
        return next;
      case "IfStatement":
        return builder.condition(node.test, statement(node.consequent, next, loop), node.alternate ? statement(node.alternate, next, loop) : next);
      case "ReturnStatement": case "ThrowStatement":
        return node.argument ? builder.expression(node.argument, exit) : exit;
      case "WhileStatement": case "DoWhileStatement": {
        const head = builder.block([]);
        const body = statement(node.body, head, { break: next, continue: head });
        builder.connect(head, builder.condition(node.test, body, next));
        return node.type === "WhileStatement" ? head : body;
      }
      case "BreakStatement": case "ContinueStatement":
        if (node.label || !loop) return builder.unsupported(node, "only unlabeled loop control is supported");
        return node.type === "BreakStatement" ? loop.break : loop.continue;
      default: return builder.unsupported(node, `statement flow does not support ${node.type}`);
    }
  };
  return statement(body, exit);
}
