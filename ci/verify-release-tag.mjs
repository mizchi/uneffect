// Refuses to publish unless the pushed tag is exactly v<package.json version>.
// GitHub Actions sets GITHUB_REF_NAME to the tag name on a tag push; anything
// else (a branch run, a manual run) must not publish.
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const expected = `v${manifest.version}`;
const actual = process.env.GITHUB_REF_NAME;
const refType = process.env.GITHUB_REF_TYPE;

if (refType !== undefined && refType !== "tag") {
  console.error(`refusing to publish: ${actual ?? "<missing>"} is a ${refType}, not a tag`);
  process.exitCode = 1;
} else if (actual !== expected) {
  console.error(`refusing to publish: release tag ${actual ?? "<missing>"} does not match ${expected}`);
  process.exitCode = 1;
} else {
  console.log(`release tag ${actual} matches ${manifest.name}@${manifest.version}`);
}
