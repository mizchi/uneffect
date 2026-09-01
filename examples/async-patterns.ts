/* uneffect:effect Timer */
export function poll(): void {
  setTimeout(poll, 5)
}

/* uneffect:effect Timer */
export function scheduleThenCancel(callback: () => void): void {
  const handle = setTimeout(callback, 0)
  queueMicrotask(callback)
  clearTimeout(handle)
  setTimeout(callback, 0)
}

async function readUsers(): Promise<string[]> {
  return ["alice"]
}

async function readPosts(): Promise<string[]> {
  return ["hello"]
}

export async function loadAll(): Promise<[string[], string[]]> {
  return Promise.all([readUsers(), readPosts()])
}

export async function observeAll(): Promise<PromiseSettledResult<string[]>[]> {
  return Promise.allSettled([readUsers(), readPosts()])
}

export async function firstSettled(): Promise<string[]> {
  return Promise.race([readUsers(), readPosts()])
}

export async function firstFulfilled(): Promise<string[]> {
  return Promise.any([readUsers(), readPosts()])
}
