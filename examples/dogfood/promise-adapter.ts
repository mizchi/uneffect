export function adaptLegacyFailure(): Promise<void> {
  const operation = new Promise<void>((_resolve, reject) => {
    reject(new Error("legacy operation failed"));
  });
  operation.then(() => undefined);

  const exposed = new Promise<void>((resolve) => resolve(operation));
  return exposed.catch(() => undefined);
}
