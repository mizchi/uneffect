export interface ClockObservation {
  monotonic: number;
  wall: number;
}

export interface ClockRateRange {
  minimum: number;
  maximum: number;
}

export interface ClockConformancePolicy {
  monotonicRate: ClockRateRange;
  wallRate: ClockRateRange;
  wallBackwardJump: ClockRateRange;
  maximumSkew: number;
}

export interface ClockConformanceDiagnostic {
  kind: "invalid-observation" | "monotonic-rate" | "wall-rate" | "wall-backward-jump" | "clock-skew";
  sample: number;
  actual: number;
  expected: ClockRateRange;
  message: string;
}

export interface ClockConformanceResult {
  status: "conformant" | "nonconformant";
  diagnostics: ClockConformanceDiagnostic[];
}

export interface HostClockSources {
  monotonicNow?: () => number;
  wallNow?: () => number;
  quantize?: (elapsed: number) => number;
}

export type HostClockObserver = () => ClockObservation;

function validateRange(name: string, range: ClockRateRange): void {
  if (!Number.isFinite(range.minimum) || !Number.isFinite(range.maximum) || range.minimum < 0 || range.maximum < range.minimum) {
    throw new Error(`${name} must be a finite ascending non-negative range`);
  }
}

/** Checks a finite host trace against the same rate, rollback, and skew assumptions used by the physical-clock domain. */
export function checkClockConformance(observations: readonly ClockObservation[], policy: ClockConformancePolicy): ClockConformanceResult {
  validateRange("monotonicRate", policy.monotonicRate);
  validateRange("wallRate", policy.wallRate);
  validateRange("wallBackwardJump", policy.wallBackwardJump);
  if (!Number.isFinite(policy.maximumSkew) || policy.maximumSkew < 0) throw new Error("maximumSkew must be finite and non-negative");
  const diagnostics: ClockConformanceDiagnostic[] = [];
  const add = (kind: ClockConformanceDiagnostic["kind"], sample: number, actual: number, expected: ClockRateRange, message: string): void => {
    diagnostics.push({ kind, sample, actual, expected, message });
  };
  for (let index = 0; index < observations.length; index++) {
    const current = observations[index]!;
    if (!Number.isFinite(current.monotonic) || !Number.isFinite(current.wall)) {
      add("invalid-observation", index, Number.NaN, { minimum: 0, maximum: Number.MAX_VALUE }, "clock samples must be finite numbers");
      continue;
    }
    const skew = Math.abs(current.wall - current.monotonic);
    if (skew > policy.maximumSkew) add("clock-skew", index, skew, { minimum: 0, maximum: policy.maximumSkew }, `absolute wall/monotonic skew ${skew} exceeds ${policy.maximumSkew}`);
    if (index === 0) continue;
    const previous = observations[index - 1]!;
    if (!Number.isFinite(previous.monotonic) || !Number.isFinite(previous.wall)) continue;
    const monotonicDelta = current.monotonic - previous.monotonic;
    if (monotonicDelta < policy.monotonicRate.minimum || monotonicDelta > policy.monotonicRate.maximum) {
      add("monotonic-rate", index, monotonicDelta, policy.monotonicRate, `monotonic delta ${monotonicDelta} is outside the modeled rate range`);
    }
    const wallDelta = current.wall - previous.wall;
    if (wallDelta >= 0) {
      if (wallDelta < policy.wallRate.minimum || wallDelta > policy.wallRate.maximum) add("wall-rate", index, wallDelta, policy.wallRate, `wall-clock delta ${wallDelta} is outside the modeled forward-rate range`);
    } else {
      const magnitude = -wallDelta;
      if (magnitude < policy.wallBackwardJump.minimum || magnitude > policy.wallBackwardJump.maximum) {
        add("wall-backward-jump", index, magnitude, policy.wallBackwardJump, `wall-clock rollback magnitude ${magnitude} is outside the modeled jump range`);
      }
    }
  }
  return { status: diagnostics.length === 0 ? "conformant" : "nonconformant", diagnostics };
}

function createObserver(sources: HostClockSources = {}): HostClockObserver {
  const monotonicNow = sources.monotonicNow ?? (() => performance.now());
  const wallNow = sources.wallNow ?? (() => Date.now());
  const quantize = sources.quantize ?? Math.trunc;
  const monotonicOrigin = monotonicNow(), wallOrigin = wallNow();
  return () => ({
    monotonic: quantize(monotonicNow() - monotonicOrigin),
    wall: quantize(wallNow() - wallOrigin),
  });
}

export function createNodeClockObserver(sources: HostClockSources = {}): HostClockObserver { return createObserver(sources); }
export function createBrowserClockObserver(sources: HostClockSources = {}): HostClockObserver { return createObserver(sources); }
export function createDenoClockObserver(sources: HostClockSources = {}): HostClockObserver { return createObserver(sources); }
