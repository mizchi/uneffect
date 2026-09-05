import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

const root = process.cwd();
const sourcePattern = /\.(?:ts|tsx)$/u;

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [normalize(path)];
  });
}

function run(command, args, label) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  if (result.status === 0) return;
  process.stderr.write(`${label} failed\n${result.stdout}${result.stderr}`);
  process.exit(result.status ?? 1);
}

const exampleFiles = walk("examples").filter((file) => sourcePattern.test(file)).sort();
const topLevelExamples = exampleFiles.filter((file) => dirname(file) === "examples");
const dogfoodExamples = exampleFiles.filter((file) => file.startsWith("examples/dogfood/"));

run("pnpm", ["exec", "tsc", "-p", "examples/tsconfig.json"], "top-level example typecheck");

const smokeCommands = [
  ["check", "examples/demo.ts"],
  ["instrument", "examples/gradual.ts"],
  ["spec", "temporal", "examples/async-patterns.ts", "main", "--runtime", "web"],
  ["spec", "temporal", "examples/promise-chain.ts", "main", "--runtime", "web"],
  ["async-model", "examples/composed-async.ts", "run"],
  ["resource-model", "examples/resources.ts"],
  ["spec", "compose", "examples/temporal-compose.ts", "main"],
  ["check", "examples/dogfood/node-cli.ts"],
  ["check", "examples/dogfood/browser-app.ts"],
  ["check", "examples/dogfood/worker-app.ts"],
];
for (const args of smokeCommands) {
  run("pnpm", ["tsx", "src/cli.ts", ...args], `example command: uneffect ${args.join(" ")}`);
}

function resolveExample(reference, base = ".") {
  const path = normalize(join(base, reference.split("#", 1)[0]));
  return [
    path,
    path.replace(/\.js$/u, ".ts"),
    path.replace(/\.js$/u, ".tsx"),
    `${path}.ts`,
    `${path}.tsx`,
  ].find((candidate) => exampleFiles.includes(candidate));
}

const testText = walk("test")
  .filter((file) => file.endsWith(".test.ts"))
  .map((file) => readFileSync(file, "utf8"))
  .join("\n");
const roots = new Set(smokeCommands.flatMap((args) => args.filter((arg) => arg.startsWith("examples/"))));
for (const match of testText.matchAll(/examples\/[A-Za-z0-9_./-]+\.(?:tsx|ts|js)/gu)) {
  const resolved = resolveExample(match[0]);
  if (resolved) roots.add(resolved);
}

const reached = new Set(roots);
const pending = [...roots];
while (pending.length > 0) {
  const file = pending.pop();
  if (!file || !existsSync(file)) continue;
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(/["'](\.[^"']+)["']/gu)) {
    const resolved = resolveExample(match[1], dirname(file));
    if (!resolved || reached.has(resolved)) continue;
    reached.add(resolved);
    pending.push(resolved);
  }
}

const uncovered = exampleFiles.filter((file) => !reached.has(file));
if (uncovered.length > 0) {
  process.stderr.write(`examples not reachable from a test or smoke command:\n${uncovered.map((file) => `- ${file}`).join("\n")}\n`);
  process.exit(1);
}

console.log(`examples: ${topLevelExamples.length} top-level source(s) typechecked and smoke-covered`);
console.log(`dogfood: ${dogfoodExamples.length} source(s) reachable from CI tests or smoke commands`);
