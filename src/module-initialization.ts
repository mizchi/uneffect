import ts from "typescript";

/** Whether an import/export declaration can execute module initialization. */
export function isRuntimeModuleDependency(
  statement: ts.ImportDeclaration | ts.ExportDeclaration,
): boolean {
  if (ts.isImportDeclaration(statement)) {
    const clause = statement.importClause;
    if (!clause) return true;
    if (clause.isTypeOnly) return false;
    return !!clause.name || !clause.namedBindings || ts.isNamespaceImport(clause.namedBindings)
      || clause.namedBindings.elements.some((element) => !element.isTypeOnly);
  }
  if (statement.isTypeOnly) return false;
  return !statement.exportClause || !ts.isNamedExports(statement.exportClause)
    || statement.exportClause.elements.some((element) => !element.isTypeOnly);
}
