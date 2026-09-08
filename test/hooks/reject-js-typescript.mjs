/**
 * Node --import hook: fail if the JavaScript `typescript` package is resolved.
 * Native `@typescript/typescript-*` (TS7) is allowed.
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "typescript" || specifier.startsWith("typescript/")
    || specifier === "@typescript/typescript6" || specifier.startsWith("@typescript/typescript6/")) {
    throw new Error(`javascript typescript must not load on default check: ${specifier}`);
  }
  const result = await nextResolve(specifier, context);
  const url = result.url ?? "";
  if (/[/\\]node_modules[/\\]typescript[/\\]/.test(url) && !/[/\\]node_modules[/\\]@typescript[/\\]/.test(url)) {
    throw new Error(`javascript typescript must not load on default check: ${url}`);
  }
  return result;
}
