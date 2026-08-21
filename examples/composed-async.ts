interface Session {
  [Symbol.asyncDispose](): Promise<void>
}

declare function openSession(): Promise<Session>
declare function recover(error: unknown): string

export async function run() {
  await using session = await openSession()
  try {
    return await new Promise<string>((resolve) => resolve("ok"))
      .then((value) => Promise.resolve(value))
  } catch (error) {
    return recover(error)
  }
}
