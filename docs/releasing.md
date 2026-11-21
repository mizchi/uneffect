# Releasing

Pushing a `v<version>` tag publishes to npm. `.github/workflows/publish.yml`
verifies the package, runs `npm publish` through npm Trusted Publishing (OIDC,
with provenance), and creates the GitHub Release from `CHANGELOG.md`. No npm
token and no GitHub App are involved.

## One-time external setup

- On npm, register the trusted publisher for the workflow filename
  `publish.yml`. Renaming the workflow requires registering it again.

  ```sh
  npm trust github @mizchi/uneffect --repo mizchi/uneffect --file publish.yml --allow-publish -y
  npm trust list @mizchi/uneffect
  ```

- Restrict creating, moving, and deleting `v*` tags to repository admins with a
  tag ruleset. Whoever can push a `v*` tag can publish.
- Keep the npm account/package 2FA policy compatible with trusted publishing.
- Do not add `NPM_TOKEN` or `NODE_AUTH_TOKEN` to the repository or the
  workflow; a token takes precedence over OIDC.

## Release gate

```sh
just release-check
```

The checked-in npm, evidence, and effect-baseline versions must agree
(`node ci/bump-version.mjs --check`). The publish job additionally refuses a
tag that is not exactly `v<package.json version>`.

`just package-check` is part of this gate. It runs the npm lifecycle, installs
the actual tarball into fresh Node 24 consumers, and records
`.uneffect/package-evidence/npm-pack.json`. Before approving a release, require
all three verification fields to be `passed` and retain the CI artifact named
`package-contract-evidence-<run id>` with its exact file inventory and SHA-256.

The same gate compares runtime exports and resolved declaration signatures for
the durable entrypoints with `api/public-api-v0.3.json`. Do not update that
baseline to hide a removal or incompatible signature change. Run
`node ci/check-public-api.mjs --update` only after reviewing an intentional
compatible addition; experimental entrypoints are deliberately excluded.

## Normal release flow

Run these on an up-to-date `main`, replacing `0.6.0` with the new version.

```sh
# 1. Bump package.json and the stamped runtime versions together.
node ci/bump-version.mjs 0.6.0

# 2. Add the new section to CHANGELOG.md above the existing history.
GITHUB_TOKEN=$(gh auth token) npx -y git-cliff@2.14.2 --unreleased --tag v0.6.0 --prepend CHANGELOG.md

# 3. Run the gate, then commit.
just release-check
git commit -am "chore: release 0.6.0"

# 4. Tag and push. The tag push starts publish.yml.
git tag v0.6.0
git push origin main v0.6.0
gh run watch
```

- `ci/bump-version.mjs` rewrites `package.json` and the lines marked
  `// x-release-version` in `src/evidence/evidence.ts` and
  `src/effects/effect-baseline.ts`. Do not use `npm version`; it leaves the
  runtime constants behind and the release-readiness test fails.
- `cliff.toml` lists `feat`, `fix`, `perf`, `revert`, and `docs` commits and
  credits outside contributors with `by @login`. Commits without a Conventional
  Commits prefix are omitted, so compare the new section with
  `git log v<previous>..HEAD` and add anything user-visible that is missing
  before committing. `GITHUB_TOKEN` is only used to look up authors and pull
  requests; add `--offline` to skip that lookup.
- `--prepend` strips the header configured in `cliff.toml` from the existing
  file and writes the new section directly under it. Keep the first lines of
  `CHANGELOG.md` identical to that header and do not keep an `## Unreleased`
  heading in the file. Entries for 0.5.1 and earlier were not written by
  git-cliff and are left as they are.
- A version containing `-` (for example `0.6.0-rc.0`, tag `v0.6.0-rc.0`) is
  published with the npm dist-tag `next` and marked as a GitHub pre-release.
- The GitHub Release body is the `CHANGELOG.md` section for the version
  (`node ci/release-notes.mjs 0.6.0` prints it). Without a section the workflow
  falls back to GitHub's generated notes.
- The registry can lag about a minute behind a successful workflow. Confirm
  with `npm view @mizchi/uneffect version dist-tags --json`.

If the workflow fails before `npm publish`, fix the cause, delete the tag
(`git tag -d v0.6.0 && git push origin :v0.6.0`), and tag the fixed commit
again. A version that reached npm cannot be published again: publish a
corrective patch instead. Never move a tag for a published version.

## 0.5.0 reconciliation

At preparation time, npm `latest` was 0.4.0, published from commit
`26994e38` on 2026-09-17.
That commit changed `package.json` to 0.4.0 locally but was never merged into
GitHub `main`; the version manifest of the release tooling used at the time
(release-please) and the two runtime version constants still read 0.3.0. There
is no `v0.4.0` Git tag or GitHub Release. Do not push a retroactive `v0.4.0`
tag: the publish workflow would try to publish that already-used version again.

The 0.5.0 release PR synchronized the package, manifest, and runtime constants
and recorded the 0.4.0 release in the changelog. Its merged `main` commit is
`49ade21254b457f9ae33f4ebefd1f0a420d45151`; the PR CI and local
`just release-check` passed. That release was published from that exact commit
with the maintainer's npm login:

```sh
git fetch origin main
git switch --detach 49ade21254b457f9ae33f4ebefd1f0a420d45151
npm whoami
npm publish --dry-run --provenance=false --access public
npm publish --provenance=false --access public
npm view @mizchi/uneffect version dist-tags --json
git tag -a v0.5.0 49ade21254b457f9ae33f4ebefd1f0a420d45151 -m 'v0.5.0'
git push origin v0.5.0
```

The local publish had no GitHub Actions OIDC provenance, so it overrode the
package's `publishConfig.provenance`. The tag was pushed only after npm
confirmed 0.5.0. Version 0.5.1 was the last release prepared by release-please;
later releases use the tag flow above.

## 0.3.0 bootstrap record

Version 0.3.0 was prepared before any release automation was installed and was
published to npm on 2026-09-06. At reconciliation time npm marked it as
`latest`, but no matching `v0.3.0` Git tag or GitHub Release existed. Do not
push a backfilled `v0.3.0` tag: the tag push would attempt to publish the
already-used npm version.

Never reuse 0.3.0, run a second local publish for it, or move a shared tag.
Publish a corrective patch when package contents need correction.
