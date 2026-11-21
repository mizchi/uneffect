// Sets the release version in package.json and in the runtime constants that
// must equal it, or checks that they already agree.
//
//   node ci/bump-version.mjs <version>   write <version> everywhere
//   node ci/bump-version.mjs --check     exit 1 when a stamped version drifts
//
// A stamped constant is a line ending in `"<version>"; // x-release-version`.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const stampedFiles = ["src/evidence/evidence.ts", "src/effects/effect-baseline.ts"];
const stamp = /"([^"\n]*)"; \/\/ x-release-version$/gmu;
const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

const args = process.argv.slice(2);
const rootFlag = args.indexOf("--root");
const root = rootFlag === -1
  ? fileURLToPath(new URL("..", import.meta.url))
  : resolve(args.splice(rootFlag, 2)[1] ?? "");
const check = args.includes("--check");
const version = args.find((arg) => !arg.startsWith("--"));

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const manifestPath = resolve(root, "package.json");
const manifestText = readFileSync(manifestPath, "utf8");
const current = JSON.parse(manifestText).version;
const stamped = stampedFiles.map((file) => {
  const text = readFileSync(resolve(root, file), "utf8");
  const found = [...text.matchAll(stamp)].map((match) => match[1]);
  if (found.length !== 1) fail(`${file}: expected exactly one x-release-version line, found ${found.length}`);
  return { file, text, found: found[0] };
});

if (check && version === undefined) {
  const drift = stamped.filter(({ found }) => found !== current);
  for (const { file, found } of drift) console.error(`${file}: stamped ${found}, package.json is ${current}`);
  if (drift.length > 0) process.exit(1);
  console.log(`package.json and ${stamped.length} stamped versions agree on ${current}`);
} else if (check || version === undefined || !semver.test(version)) {
  fail("usage: node ci/bump-version.mjs <major.minor.patch[-prerelease]> | --check");
} else {
  const versionField = /^(\s*"version":\s*")[^"]*(")/mu;
  if (!versionField.test(manifestText)) fail("package.json: no version field");
  writeFileSync(manifestPath, manifestText.replace(versionField, `$1${version}$2`));
  for (const { file, text } of stamped) {
    writeFileSync(resolve(root, file), text.replace(stamp, `"${version}"; // x-release-version`));
  }
  console.log(`${current} -> ${version}: package.json, ${stampedFiles.join(", ")}`);
}
