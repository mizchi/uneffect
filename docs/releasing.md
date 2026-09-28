# Releasing

The npm package is released from GitHub Actions through npm Trusted Publishing.
No npm token is stored in this repository.

## One-time external setup

- Install the `mizchi-release-please` GitHub App for this repository and store
  its private key as `RELEASE_PLEASE_APP_PRIVATE_KEY`.
- On npm, configure `@mizchi/uneffect` Trusted Publisher for owner `mizchi`,
  repository `uneffect`, and workflow filename `publish.yml`.
- Keep the npm account/package 2FA policy compatible with trusted publishing.

## Release gate

```sh
just release-check
```

The checked-in npm, evidence, and effect-baseline versions must agree.
The publish job additionally refuses a GitHub Release whose tag is not exactly
`v<package.json version>`.

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

After conventional `feat:`/`fix:` commits have landed on `main`, explicitly
start the release workflow:

```sh
gh workflow run release-please.yml --repo mizchi/uneffect
```

Review and merge the generated release PR. That workflow creates the tag and
GitHub Release; the published release event then runs `publish.yml`, verifies
the package, and executes `npm publish` with OIDC provenance.

Version synchronization is configured in `release-please-config.json` and
`.release-please-manifest.json`. After the 0.5.0 reconciliation below, let
release-please update versions for subsequent releases.

## 0.5.0 reconciliation

At preparation time, npm `latest` was 0.4.0, published from commit
`26994e38` on 2026-09-17.
That commit changed `package.json` to 0.4.0 locally but was never merged into
GitHub `main`; the release-please manifest and the two runtime version constants
still read 0.3.0. There is no `v0.4.0` Git tag or GitHub Release. Do not create
a retroactive GitHub Release for 0.4.0, because the publish workflow would try
to publish that already-used version again.

The 0.5.0 release PR synchronizes the package, manifest, and runtime constants,
and records the 0.4.0 release in the changelog. For this release only, after
merging that PR and verifying CI on its exact `main` commit, publish a GitHub
Release tagged `v0.5.0` at that commit with notes from the 0.5.0 changelog
section. The `release: published` event runs `publish.yml`, whose tag guard
must pass before `npm publish`. Confirm that npm `latest` becomes 0.5.0 and
retain the package evidence artifact. Do not dispatch `release-please.yml` for
0.5.0: the version files are already prepared in the release PR.

The resulting `v0.5.0` tag and manifest establish the baseline for the normal
release-please flow above. `include-component-in-tag: false` keeps future tags
in the `v<version>` format required by the publish guard.

## 0.3.0 bootstrap record

Version 0.3.0 was prepared before release-please was installed and was published
to npm on 2026-09-06. At reconciliation time npm marked it as `latest`, but no
matching `v0.3.0` Git tag or GitHub Release existed. Do not create a backfilled
GitHub Release while the `release` event still invokes `publish.yml`: that would
attempt to publish the already-used npm version. Any provenance repair must
first make that workflow path non-publishing and must not move a tag after it is
shared.

Later releases use the normal release-please flow above. Never reuse 0.3.0,
run a second local publish for it, or move a shared tag. Publish a corrective
patch when package contents need correction.
