declare function sendAuditEvent(message: string): Promise<void>;

/* uneffect: effect Throw<Error> */
function fatal(message: string): never {
  throw new Error(message);
}

export async function auditInvalidRequest(message: string): Promise<void> {
  let delivery: Promise<void>;
  try {
    delivery = sendAuditEvent(message);
    return fatal(`invalid request: ${message}`);
  } catch {
    await delivery;
  }
}
