interface FileResource {
  [Symbol.dispose](): void
}

interface SessionResource {
  [Symbol.asyncDispose](): Promise<void>
}

declare function openFile(): FileResource
declare function openSession(): Promise<SessionResource>
declare function use(session: SessionResource): Promise<void>

export async function work() {
  using file = openFile()
  await using session = await openSession()
  try {
    await use(session)
  } catch (error) {
    console.error(error)
  }
  void file
}
