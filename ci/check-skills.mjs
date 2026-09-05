import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, normalize, resolve } from "node:path";

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [normalize(path)];
  });
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

const skillFiles = walk("skills");
const manifests = skillFiles.filter((file) => basename(file) === "SKILL.md");
if (manifests.length === 0) fail("skills must contain at least one SKILL.md");

const removedCommands = ["async-quint", "promise-quint", "web-loop-quint", "node-loop-quint"];
for (const manifest of manifests) {
  const source = readFileSync(manifest, "utf8");
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/u.exec(source)?.[1];
  if (!frontmatter) {
    fail(`${manifest}: missing YAML frontmatter`);
    continue;
  }
  const name = /^name:\s*(\S+)\s*$/mu.exec(frontmatter)?.[1];
  const description = /^description:\s*(.+)$/mu.exec(frontmatter)?.[1]?.trim();
  if (name !== basename(dirname(manifest))) fail(`${manifest}: name must match its directory`);
  if (!description) fail(`${manifest}: description is required`);

  const agentMetadata = join(dirname(manifest), "agents/openai.yaml");
  if (!existsSync(agentMetadata)) {
    fail(`${manifest}: missing agents/openai.yaml`);
  } else {
    const metadata = readFileSync(agentMetadata, "utf8");
    for (const field of ["display_name", "short_description", "default_prompt"]) {
      if (!new RegExp(`^\\s*${field}:\\s*.+$`, "mu").test(metadata)) fail(`${agentMetadata}: missing ${field}`);
    }
    if (name && !metadata.includes(`$${name}`)) fail(`${agentMetadata}: default_prompt must invoke $${name}`);
  }
}

for (const file of skillFiles.filter((path) => path.endsWith(".md"))) {
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)) {
    const target = match[1];
    if (target.startsWith("http") || target.startsWith("#")) continue;
    const path = resolve(dirname(file), target.split("#", 1)[0]);
    if (!existsSync(path)) fail(`${file}: missing local link ${target}`);
  }
  for (const command of removedCommands) {
    if (source.includes(command)) fail(`${file}: references removed CLI command ${command}`);
  }
}

if (!readFileSync("README.md", "utf8").includes("./skills/uneffect/SKILL.md")) {
  fail("README.md must link to the Uneffect skill");
}

if (process.exitCode) process.exit(process.exitCode);
console.log(`skills: ${manifests.length} package(s), ${skillFiles.length} checked file(s)`);
