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
