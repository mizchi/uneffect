export interface ExternalCheckerTestTimeoutEnvironment {
  readonly ci: boolean;
}

/**
 * The workspace CLI acceptance runs multiple independent project checks and
 * retained fail-closed mutations. A finite two-minute budget leaves nearly
 * 50% headroom over the observed 60.561-second native-Z3 release-gate run.
 */
export const workspaceCliAcceptanceTimeoutMs = 120_000;

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
