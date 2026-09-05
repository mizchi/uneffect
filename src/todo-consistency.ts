export interface TodoTask {
  line: number;
  indent: number;
  checked: boolean;
  text: string;
  children: TodoTask[];
}

/* uneffect:effect none */
export function parseTodoTasks(source: string): TodoTask[] {
  const roots: TodoTask[] = [];
  const stack: TodoTask[] = [];
  for (const [index, line] of source.split(/\r?\n/u).entries()) {
    const match = /^(\s*)- \[([ xX])\] (.+)$/u.exec(line);
    if (!match) continue;
    const task: TodoTask = {
      line: index + 1,
      indent: match[1]!.replace(/\t/gu, "  ").length,
      checked: match[2]!.toLowerCase() === "x",
      text: match[3]!,
      children: [],
    };
    while (stack.length > 0 && stack.at(-1)!.indent >= task.indent) stack.pop();
    const parent = stack.at(-1);
    (parent ? parent.children : roots).push(task);
    stack.push(task);
  }
  return roots;
}

/* uneffect:effect none */
export function findStaleUncheckedParents(source: string): TodoTask[] {
  const stale: TodoTask[] = [];
  const visit = (task: TodoTask): boolean => {
    const descendantsComplete = task.children.map(visit).every(Boolean);
    if (!task.checked && task.children.length > 0 && descendantsComplete) stale.push(task);
    return task.checked && descendantsComplete;
  };
  for (const task of parseTodoTasks(source)) visit(task);
  return stale.sort((left, right) => left.line - right.line);
}
