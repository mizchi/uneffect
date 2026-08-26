# Application dogfood

Uneffect is periodically run against unmodified application code outside this
repository. These observations are compatibility probes, not claims that the
whole application was verified. Each entry records the source revision, chosen
boundary, command, machine result, and the regression it locked.

## vlmkit image-generation client

Observed on 2026-08-26 against `mizchi/vlmkit` revision
`bae6db2e85ad16b2e6bdcfc72d592798b691ac4b`, using the unmodified file
`packages/vlmkit-ai/src/image-gen-client.ts` and the repository root
`tsconfig.json`.

```sh
uneffect check \
  --project /path/to/vlmkit/tsconfig.json \
  --infer --evidence --assurance no-unknown \
  /path/to/vlmkit/packages/vlmkit-ai/src/image-gen-client.ts
```

The first observation found two checker defects:

1. the CLI could not consume the application's TypeScript configuration;
2. Program-wide effect analysis omitted `process.env` even though the
   single-file analyzer recognized it.

After the fixes, the client reports:

- `createImageGenClient`: `Env<"OPENAI_API_KEY"> | Throw<VrtConfigError>`;
- `generate`: `Fetch<POST, Unknown<dynamic-url>> |
  Net<Unknown<dynamic-origin>>`.

The default gradual check therefore remains useful and exits successfully. The
`no-unknown` profile now fails with two blockers for the dynamic URL and
origin. Before this dogfood pass it incorrectly returned `passed (verified)`
because it inspected only the summary evidence tag and not unknown sets nested
inside a capability. Unit and CLI regression tests retain both fixes.

The same boundary is also exercised through `check --json`. Its
`uneffect-check/v1` report returns `outcome: "failed"`, zero ordinary
diagnostic errors, `assurance.status: "unknown"`, and the two source-attributed
capability blockers. This distinction is intentional: the analyzed program is
well typed, while the requested assurance claim is not established.

This result does not prove the OpenAI request succeeds, that the response parser
is complete, that every rejection is handled by callers, or that the dynamic
base URL is safe. A consumer can make the network authority finite by proving
or asserting a bounded configuration value at its own boundary; declaring a
broad `Fetch` effect alone must not erase the unknown origin.

## mnemo D1 telemetry wrapper

An observation of `mizchi/mnemo`'s unmodified
`mnemo-server/src/telemetry/d1-wrap.ts` exposed a compiler-version boundary.
The project configuration intentionally relied on TypeScript 5.x defaults,
while Uneffect currently declares a TypeScript 6 peer whose strict-family
defaults differ. `--project` loaded the configuration, but the run correctly
remained non-proof-grade due to TS7006 diagnostics and a missing local
Cloudflare type installation. Uneffect did not reinterpret those errors or
claim Proxy/Reflect semantics.

This is a compatibility finding, not an application defect. Reliable assurance
requires the consumer and Uneffect to agree on the TypeScript version and to
make version-sensitive compiler defaults explicit.
