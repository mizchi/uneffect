/** Own-entry lookup is required for action names from a trace. */
export function unsafe(table: Record<string, () => void>, key: string): void {
  const action = table[key];
  if (action) action();
}

export function guarded(table: Record<string, () => void>, key: string): void {
  const action = Object.hasOwn(table, key) ? table[key] : undefined;
  if (action) action();
}

/** Run with --flow statement to carry the early-return guard to the read. */
export function statementGuard(table: Record<string, () => void>, key: string): void {
  if (!Object.hasOwn(table, key)) return;
  table[key]();
}

export function capturedAlias(table: Record<string, () => void>, key: string) {
  const alias = table;
  return Object.hasOwn(alias, key) ? alias[key] : undefined;
}

const names: Readonly<Record<string, string>> = Object.freeze({ read: "read", write: "write" });
export function frozenLoop(prefix: string): string[] {
  const result: string[] = [];
  for (const name of Object.keys(names)) result.push(`${prefix}:${names[name]}`);
  return result;
}
