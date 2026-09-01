import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { CliUsageError, exitCode, formatCommandHelp, parseCommandArgs, type CliCommand } from "./cli-support.js";
import { generateQuint, generateSmtLib } from "./spec-backends.js";
import { parseSpec } from "./spec-ir.js";
import { lintSpecWithZ3 } from "./spec-lint.js";
import { generateComposedQuint, parseTemporalComposition } from "./temporal-compose.js";
import { generateTemporalModel } from "./temporal-model.js";

const backends = ["ir", "lint", "z3", "quint", "compose", "temporal"] as const;
type Backend = typeof backends[number];

function moduleNameOf(fileName: string): string {
  return basename(fileName).replace(/\.[^.]+$/u, "").replace(/[^A-Za-z0-9_]/gu, "_");
}

function boundedInteger(value: string | undefined, option: string, minimum: number, maximum: number): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new CliUsageError(`${option} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

export const specCommand: CliCommand = {
  name: "spec",
  summary: "Emit the specification IR, or the verifier program a backend consumes, for one file.",
  arguments: `<${backends.join("|")}> <file.ts> [function] [options]`,
  details: [
    "ir                 the parsed specification IR as JSON",
    "lint               Z3-backed specification lint; exits 1 when it reports a diagnostic",
    "z3                 SMT-LIB for one invariant, selected by the optional function argument",
    "quint              the temporal Quint module",
    "compose            the composed temporal Quint module rooted at the required function argument",
    "temporal           the unified user + JavaScript async temporal model",
    "",
    "--runtime=web|node                       host profile for the temporal backend",
    "--node-top-level=commonjs|esm            top-level scheduling mode for temporal --runtime=node",
    "--strengthening=<name,...>               strengthen the lint with these properties, repeatable",
    "--discover-strengthening                 discover strengthening properties from the specification",
    "--synthesize-strengthening               synthesize scalar strengthening properties",
    "--synthesize-relational-strengthening    synthesize relational strengthening properties",
    "--relational-max-arity=<3..6>            variables per synthesized relational property",
    "--relational-max-coefficient=<1..8>      coefficient bound for synthesized relational properties",
    "--relational-candidate-limit=<n>         candidate cap for relational synthesis",
    "--synthesize-collection-strengthening    synthesize collection strengthening properties",
  ],
  async run(args, io) {
    const { values, positionals } = parseCommandArgs(args, {
      "node-top-level": { type: "string" },
      runtime: { type: "string" },
      strengthening: { type: "string", multiple: true },
      "discover-strengthening": { type: "boolean" },
      "synthesize-strengthening": { type: "boolean" },
      "synthesize-relational-strengthening": { type: "boolean" },
      "relational-max-arity": { type: "string" },
      "relational-max-coefficient": { type: "string" },
      "relational-candidate-limit": { type: "string" },
      "synthesize-collection-strengthening": { type: "boolean" },
    });
    if (values.help) { io.out(formatCommandHelp(specCommand)); return exitCode.success; }
    const [backend, fileName, selectedFunction] = positionals;
    if (!backend) throw new CliUsageError(`spec needs a backend: ${backends.join(", ")}`);
    if (!backends.includes(backend as Backend)) throw new CliUsageError(`unknown spec backend: ${backend}`);
    if (!fileName) throw new CliUsageError(`spec ${backend} needs a file`);
    if (positionals.length > 3) throw new CliUsageError(`spec ${backend} takes a file and at most one function name`);

    const nodeTopLevel = values["node-top-level"] as string | undefined;
    if (nodeTopLevel !== undefined && nodeTopLevel !== "commonjs" && nodeTopLevel !== "esm") {
      throw new CliUsageError("--node-top-level must be commonjs or esm");
    }
    const runtime = values.runtime as string | undefined;
    if (runtime !== undefined && runtime !== "web" && runtime !== "node") {
      throw new CliUsageError("--runtime must be web or node");
    }
    const source = await readFile(fileName, "utf8");
    const moduleName = moduleNameOf(fileName);

    if (backend === "ir") {
      io.out(`${JSON.stringify(parseSpec(fileName, source), null, 2)}\n`);
      return exitCode.success;
    }
    if (backend === "lint") {
      const result = await lintSpecWithZ3(fileName, source, {
        strengtheningProperties: ((values.strengthening as string[] | undefined) ?? []).flatMap((item) => item.split(",").map((name) => name.trim()).filter(Boolean)),
        discoverStrengtheningProperties: Boolean(values["discover-strengthening"]),
        synthesizeStrengtheningProperties: Boolean(values["synthesize-strengthening"]),
        synthesizeRelationalStrengtheningProperties: Boolean(values["synthesize-relational-strengthening"]),
        relationalStrengtheningMaxArity: boundedInteger(values["relational-max-arity"] as string | undefined, "--relational-max-arity", 3, 6),
        relationalStrengtheningMaxCoefficient: boundedInteger(values["relational-max-coefficient"] as string | undefined, "--relational-max-coefficient", 1, 8),
        relationalStrengtheningCandidateLimit: boundedInteger(values["relational-candidate-limit"] as string | undefined, "--relational-candidate-limit", 0, Number.MAX_SAFE_INTEGER),
        synthesizeCollectionStrengtheningProperties: Boolean(values["synthesize-collection-strengthening"]),
      });
      io.out(`${JSON.stringify(result.diagnostics, null, 2)}\n`);
      return result.diagnostics.length > 0 ? exitCode.failed : exitCode.success;
    }
    if (backend === "z3") {
      const spec = parseSpec(fileName, source);
      const invariant = selectedFunction ? spec.invariants.find((item) => item.functionName === selectedFunction) : spec.invariants[0];
      if (!invariant) throw new CliUsageError(selectedFunction ? `unknown invariant function: ${selectedFunction}` : `no invariant specification found in ${fileName}`);
      io.out(generateSmtLib(invariant));
      return exitCode.success;
    }
    if (backend === "quint") {
      io.out(generateQuint(moduleName, parseSpec(fileName, source).temporal));
      return exitCode.success;
    }
    if (backend === "compose") {
      if (!selectedFunction) throw new CliUsageError("spec compose needs a root function");
      io.out(generateComposedQuint(moduleName, parseTemporalComposition(fileName, source, selectedFunction)));
      return exitCode.success;
    }
    if (backend === "temporal") {
      const selectedRuntime = runtime ?? "web";
      io.out(generateTemporalModel({
        fileName,
        source,
        runtime: selectedRuntime,
        root: selectedFunction ?? "main",
        nodeTopLevelMode: nodeTopLevel ?? "commonjs",
      }).quint);
      return exitCode.success;
    }
    throw new CliUsageError(`unknown spec backend: ${backend}`);
  },
};
