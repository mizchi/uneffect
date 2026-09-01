import { createHash } from "node:crypto";
import ts from "typescript";
import { extractAnnotations } from "./annotations.js";
import { builtinContractRegistry, findBuiltinContract, resolveModuleInitializationContract, type BuiltinContractRegistry } from "./builtin-contracts.js";
import { collectBuiltinCallRefinements } from "./frontend-adapter.js";
import { isRuntimeModuleDependency } from "./module-initialization.js";
import type { TypedArrayProgramSafetyResult } from "./typed-array-safety.js";

export type AssumptionDomain = "builtin" | "module-initialization" | "typed-array" | "temporal-contract" | "dispatch-sealing" | "resource-callable";

export interface AssumptionScope {
  fileName: string;
  functionName?: string;
  span: { start: number; end: number };
}

export interface AssumptionEntry {
  id: string;
  evidence: "trusted";
  domain: AssumptionDomain;
  reason: string;
  scope: AssumptionScope;
  owner?: string;
  expiresOn?: string;
  dependency?: {
    module: string;
    packageVersion?: string;
    nodeMajor?: number;
  };
}

export interface AssumptionPolicy {
  requireOwner?: boolean;
  requireExpiration?: boolean;
  denyExpired?: boolean;
  allowUnboundedDomains?: AssumptionDomain[];
  asOf?: string;
}

export interface AssumptionViolation {
  assumptionId: string;
  domain: AssumptionDomain;
  rule: "owner-required" | "expiration-required" | "invalid-expiration" | "expired";
  message: string;
  scope: AssumptionScope;
}

export interface AssumptionLedger {
  schema: "uneffect-assumptions/v1";
  entries: AssumptionEntry[];
  violations: AssumptionViolation[];
}

export interface AssumptionPolicyDiagnostic extends AssumptionViolation {
  fileName: string;
  functionName: string;
  line: number;
  kind: "assumption-policy";
  severity: "error";
}

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

function validDate(value: string): boolean {
  if (!datePattern.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function metadata(source: ts.SourceFile, node: ts.Node): { owner?: string; expiresOn?: string } {
  const leading = source.text.slice(node.getFullStart(), node.getStart(source));
  const owner = extractAnnotations(leading, "trust_owner")[0]?.trim();
  const expiresOn = extractAnnotations(leading, "trust_expires")[0]?.trim();
  return { ...(owner ? { owner } : {}), ...(expiresOn ? { expiresOn } : {}) };
}

function entry(input: Omit<AssumptionEntry, "id" | "evidence">): AssumptionEntry {
  return { ...input, id: digest(JSON.stringify(input)), evidence: "trusted" };
}

function temporalSummary(node: ts.FunctionDeclaration, source: ts.SourceFile): boolean {
  const leading = source.text.slice(node.getFullStart(), node.getStart(source));
  const summaryDirectives = [
    "temporal_requires", "temporal_ensures", "temporal_modifies", "temporal_throws",
    "temporal_rejects", "temporal_suspends", "temporal_cancellable", "temporal_eventually",
    "temporal_repeatedly", "temporal_stabilizes", "temporal_response", "temporal_fair",
  ] as const;
  return summaryDirectives
    .some((name) => extractAnnotations(leading, name).length > 0);
}

export function evaluateAssumptionPolicy(entries: readonly AssumptionEntry[], policy: AssumptionPolicy = {}): AssumptionViolation[] {
  const violations: AssumptionViolation[] = [];
  const asOf = policy.asOf ?? new Date().toISOString().slice(0, 10);
  if (!validDate(asOf)) throw new Error(`assumption policy asOf must be a valid YYYY-MM-DD date: ${asOf}`);
  for (const assumption of entries) {
    const unboundedAllowed = policy.allowUnboundedDomains?.includes(assumption.domain) ?? false;
    const report = (rule: AssumptionViolation["rule"], message: string): void => {
      violations.push({ assumptionId: assumption.id, domain: assumption.domain, rule, message, scope: assumption.scope });
    };
    if (policy.requireOwner && !assumption.owner) report("owner-required", `${assumption.domain} assumption requires an owner`);
    if (assumption.expiresOn && !validDate(assumption.expiresOn)) report("invalid-expiration", `${assumption.domain} assumption has invalid expiration ${assumption.expiresOn}`);
    else if (policy.requireExpiration && !unboundedAllowed && !assumption.expiresOn) report("expiration-required", `${assumption.domain} assumption requires an expiration date`);
    else if (policy.denyExpired && assumption.expiresOn && assumption.expiresOn < asOf) report("expired", `${assumption.domain} assumption expired on ${assumption.expiresOn}`);
  }
  return violations;
}

export function collectAssumptionLedger(
  program: ts.Program,
  files: Readonly<Record<string, string>>,
  typedArrays: TypedArrayProgramSafetyResult | undefined,
  policy: AssumptionPolicy = {},
  registry: BuiltinContractRegistry = builtinContractRegistry,
): { ledger: AssumptionLedger; diagnostics: AssumptionPolicyDiagnostic[] } {
  const entries: AssumptionEntry[] = [];
  for (const fileName of Object.keys(files)) {
    const source = program.getSourceFile(fileName);
    if (!source) continue;
    for (const statement of source.statements) {
      if ((!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement))
        || !statement.moduleSpecifier || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
      if (!isRuntimeModuleDependency(statement)) continue;
      const contract = resolveModuleInitializationContract(program, source.fileName, statement.moduleSpecifier.text, registry);
      if (!contract) continue;
      entries.push(entry({
        domain: "module-initialization",
        reason: contract.trustReason,
        owner: contract.trustOwner,
        ...(contract.trustExpiresOn ? { expiresOn: contract.trustExpiresOn } : {}),
        dependency: {
          module: statement.moduleSpecifier.text,
          ...(contract.runtime.kind === "package" ? { packageVersion: contract.runtime.version } : {}),
          ...(contract.runtime.kind === "node" ? { nodeMajor: contract.runtime.major } : {}),
        },
        scope: {
          fileName,
          functionName: "<module>",
          span: { start: statement.moduleSpecifier.getStart(source), end: statement.moduleSpecifier.getEnd() },
        },
      }));
    }
    for (const call of collectBuiltinCallRefinements(program, source)) {
      const contract = findBuiltinContract(registry, call.symbol);
      if (!contract || contract.evidence !== "trusted") continue;
      entries.push(entry({
        domain: "builtin",
        reason: contract.trustReason ?? "reviewed builtin semantic overlay",
        owner: contract.trustOwner ?? "@mizchi/uneffect",
        ...(contract.trustExpiresOn ? { expiresOn: contract.trustExpiresOn } : {}),
        ...(contract.runtime ? { dependency: {
          module: contract.symbol.module,
          ...(contract.runtime.kind === "package" ? { packageVersion: contract.runtime.version } : { nodeMajor: contract.runtime.major }),
        } } : {}),
        scope: { fileName, span: call.span },
      }));
    }
    const functions = new Map(source.statements.flatMap((statement) =>
      ts.isFunctionDeclaration(statement) && statement.name ? [[statement.name.text, statement] as const] : []));
    for (const declaration of source.statements.filter(ts.isClassDeclaration)) {
      const leading = source.text.slice(declaration.getFullStart(), declaration.getStart(source));
      const trusted = extractAnnotations(leading, "trust")
        .map((value) => /^dispatch-sealing\s+(.+)$/.exec(value.trim()))
        .find((match) => !!match);
      if (!trusted?.[1]) continue;
      entries.push(entry({
        domain: "dispatch-sealing",
        reason: trusted[1].trim(),
        ...metadata(source, declaration),
        scope: { fileName, span: { start: declaration.getStart(source), end: declaration.getEnd() } },
      }));
    }
    for (const obligation of typedArrays?.files[fileName]?.obligations ?? []) {
      if (obligation.result !== "trusted") continue;
      const declaration = functions.get(obligation.functionName);
      entries.push(entry({
        domain: "typed-array",
        reason: obligation.trustReason ?? "explicit typed-array trust escape hatch",
        ...(obligation.trustOwner ? { owner: obligation.trustOwner } : {}),
        ...(obligation.trustExpiresOn ? { expiresOn: obligation.trustExpiresOn } : {}),
        ...(!obligation.trustOwner && !obligation.trustExpiresOn && declaration ? metadata(source, declaration) : {}),
        scope: { fileName, functionName: obligation.functionName, span: obligation.span },
      }));
    }
    for (const declaration of functions.values()) if (temporalSummary(declaration, source)) {
      entries.push(entry({
        domain: "temporal-contract",
        reason: "user-supplied temporal function summary",
        ...metadata(source, declaration),
        scope: { fileName, functionName: declaration.name!.text, span: { start: declaration.getStart(source), end: declaration.getEnd() } },
      }));
    }
  }
  entries.sort((left, right) => left.scope.fileName.localeCompare(right.scope.fileName) || left.scope.span.start - right.scope.span.start || left.domain.localeCompare(right.domain));
  const violations = evaluateAssumptionPolicy(entries, policy);
  const diagnostics = violations.map((violation): AssumptionPolicyDiagnostic => {
    const source = program.getSourceFile(violation.scope.fileName);
    return {
      ...violation,
      fileName: violation.scope.fileName,
      functionName: violation.scope.functionName ?? "<module>",
      line: source ? source.getLineAndCharacterOfPosition(violation.scope.span.start).line + 1 : 1,
      kind: "assumption-policy",
      severity: "error",
    };
  });
  return { ledger: { schema: "uneffect-assumptions/v1", entries, violations }, diagnostics };
}
