# Releasing Uneffect

This repository currently uses an explicit maintainer-driven release. There is
no GitHub Actions publish workflow and no repository release secret. Do not
assume that creating a GitHub Release publishes npm.

The npm package and Rust crate share one version. A release changes all of:

- `package.json`
- `crates/uneffect-core/Cargo.toml`
- `Cargo.lock`
- `src/evidence.ts` (`uneffectVersion`)
- the release-boundary documentation and `CHANGELOG.md`

`test/release-readiness.test.ts` enforces the important metadata and version
links. Before publishing, work from a clean, up-to-date `main` checkout and run:

```sh
pnpm install --frozen-lockfile
CI=1 just ci-fast
just build
just package-check
npm pack --dry-run
```

Inspect the pack listing. It must contain `dist/src`, `README.md`, `LICENSE`,
`CHANGELOG.md`, `docs`, and `schemas`, and must not contain source fixtures,
tests, local evidence, credentials, or environment files. Smoke-test the packed
CLI and public entrypoints when the package surface changed.

Confirm npm identity and the existing release before the irreversible publish
step:

```sh
npm whoami
npm view @mizchi/uneffect version dist-tags --json
```

Publishing and remote tagging are separate, explicit maintainer actions:

```sh
npm publish --access public
git tag -a v0.3.0 -m "v0.3.0"
git push origin main v0.3.0
npm view @mizchi/uneffect@0.3.0 version dist.integrity dist.tarball --json
```

Do not reuse a version after npm accepts it. If publication succeeds but a
later validation fails, prefer a corrective patch or npm deprecation over
silently moving the Git tag.

OIDC Trusted Publishing and release-please are a future automation option, but
must be introduced only after the npm package has an exact Trusted Publisher
binding for this repository and workflow filename. A workflow committed before
that external setup would provide a misleading release path.
