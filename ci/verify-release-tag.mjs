import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const expected = `v${manifest.version}`;
const actual = process.env.GITHUB_REF_NAME;

if (actual !== expected) {
  console.error(`refusing to publish: release tag ${actual ?? "<missing>"} does not match ${expected}`);
  process.exitCode = 1;
} else {
  console.log(`release tag ${actual} matches ${manifest.name}@${manifest.version}`);
}
