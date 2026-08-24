import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CliUsageError, exitCode, formatCommandHelp, parseCommandArgs, singleFileArgument, type CliCommand } from "./cli-support.js";
import { buildVerifiedOwnership, buildVerifiedOwnershipCached, instrumentOwnershipAssertions, instrumentRuntimeAssertions } from "./instrument.js";

export const instrumentCommand: CliCommand = {
  name: "instrument",
  summary: "Emit the source with runtime assertions inserted for contracts or ownership.",
  arguments: "<file.ts> [--ownership] [--verify-ownership] [--ownership-evidence <cache.json>]",
  details: [
    "--ownership                    insert ownership assertions instead of contract assertions",
    "--verify-ownership             prove ownership obligations first and elide the proved ones",
    "--ownership-evidence <file>    reuse and update a verification cache, implies --verify-ownership",
    "",
    "The instrumented source goes to stdout; diagnostics and cache statistics go to stderr.",
  ],
  async run(args, io) {
    const { values, positionals } = parseCommandArgs(args, {
      ownership: { type: "boolean" }, "verify-ownership": { type: "boolean" }, "ownership-evidence": { type: "string" },
    });
    if (values.help) { io.out(formatCommandHelp(instrumentCommand)); return exitCode.success; }
    const evidencePath = values["ownership-evidence"] as string | undefined;
    const verifyOwnership = Boolean(values["verify-ownership"]) || evidencePath !== undefined;
    const ownership = verifyOwnership || Boolean(values.ownership);
    if (evidencePath !== undefined && evidencePath.length === 0) throw new CliUsageError("--ownership-evidence needs a cache file path");
    const fileName = resolve(singleFileArgument(positionals, "instrument"));
    const text = await readFile(fileName, "utf8");
    const cached = verifyOwnership && evidencePath ? await buildVerifiedOwnershipCached(fileName, text, resolve(evidencePath)) : undefined;
    const verified = cached ?? (verifyOwnership ? await buildVerifiedOwnership(fileName, text) : undefined);
    const result = verified ?? (ownership ? instrumentOwnershipAssertions(fileName, text) : instrumentRuntimeAssertions(fileName, text));
    for (const diagnostic of result.diagnostics) io.err(`${diagnostic.fileName}:${diagnostic.line}: error: ${diagnostic.message}\n`);
    if (result.diagnostics.length > 0) return exitCode.failed;
    if (cached) io.err(`ownership evidence: ${cached.cache.reused} reused, ${cached.cache.verified} verified, ${cached.cache.stale.length} stale\n`);
    const unresolved = verified?.unresolved.length ?? 0;
    if (unresolved > 0) io.err(`${unresolved} ownership obligation(s) remain runtime-checked\n`);
    io.out(result.code);
    return exitCode.success;
  },
};
