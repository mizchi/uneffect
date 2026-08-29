export interface ExternalCheckerTestTimeoutEnvironment {
  readonly ci: boolean;
}

/**
 * External checker startup is bounded separately from ordinary unit tests.
 * Shared CI runners need enough headroom for cold TypeScript-Go startup, while
 * local runs retain a shorter feedback loop.
 */
export function externalCheckerTestTimeoutMs(
  environment: ExternalCheckerTestTimeoutEnvironment = { ci: Boolean(process.env.CI) },
): number {
  return environment.ci ? 60_000 : 20_000;
}
