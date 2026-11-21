// Prints the CHANGELOG.md section for one version, without its heading, as the
// GitHub Release body. Prints nothing when the section is missing, so the
// publish workflow can fall back to generated notes.
//
//   node ci/release-notes.mjs [version] [--changelog <path>]
//
// The version defaults to GITHUB_REF_NAME without its leading "v". Accepted
// headings: "## 0.6.0", "## 0.6.0 (date)", "## 0.4.0 - date" and
// "## [0.5.1](compare-url) (date)".
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const pathFlag = args.indexOf("--changelog");
const changelog = pathFlag === -1
  ? fileURLToPath(new URL("../CHANGELOG.md", import.meta.url))
  : args.splice(pathFlag, 2)[1] ?? "";
const version = args[0] ?? (process.env.GITHUB_REF_NAME ?? "").replace(/^v/u, "");

const headingVersion = (line) => /^## \[?([^\]\s(]+)\]?(?:[\s(]|$)/u.exec(line)?.[1];

if (version !== "" && existsSync(changelog)) {
  const section = [];
  let inside = false;
  for (const line of readFileSync(changelog, "utf8").split("\n")) {
    if (line.startsWith("## ")) {
      if (inside) break;
      inside = headingVersion(line) === version;
    } else if (inside) {
      section.push(line);
    }
  }
  const notes = section.join("\n").trim();
  if (notes !== "") process.stdout.write(`${notes}\n`);
}
