export function adaptLegacyFailure(): Promise<void> {
  const operation = new Promise<void>((_resolve, reject) => {
    reject(new Error("legacy operation failed"));
  });
  operation.then(() => undefined);

  const exposed = new Promise<void>((resolve) => resolve(operation));
  return exposed.catch(() => undefined);
}

export function adaptHostileLegacyThenable(): Promise<number> {
  const legacy = {
    then(resolve: (value: number) => void, reject: (error: Error) => void): void {
      resolve(200);
      reject(new Error("late legacy callback"));
    },
  };
  const exposed = new Promise<number>((resolve) => resolve(legacy));
  return exposed.then((status) => status);
}

// Broken legacy adapters can accidentally delegate resolution to each other.
// Native Promise assimilation never settles this cycle; it must not be
// approximated as a successful or rejected request.
export function adaptRecursiveLegacyThenables(): Promise<number> {
  const primary: PromiseLike<number> = {
    then(resolve): PromiseLike<number> { resolve(secondary); return this; },
  };
  const secondary: PromiseLike<number> = {
    then(resolve): PromiseLike<number> { resolve(primary); return this; },
  };
  const exposed = new Promise<number>((resolve) => resolve(primary));
  return exposed.catch(() => 0);
}
