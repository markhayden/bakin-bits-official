/**
 * The question/reply fence (D25): posting a check-in question and admitting
 * a user message into the project conversation are ONE critical section per
 * project. A reply therefore either carries the open question in its
 * runtime context (and ends its gate) or was admitted before the question
 * existed (and leaves it open for the next message) — never a gate ended by
 * a reply the lead never saw paired with it.
 *
 * Lives on globalThis like the project lock, so a hot reload keeps it.
 */
function queues(): Map<string, Promise<unknown>> {
  const g = globalThis as Record<string, unknown>
  if (!g.__bakinProjectAdmissionFence) g.__bakinProjectAdmissionFence = new Map<string, Promise<unknown>>()
  return g.__bakinProjectAdmissionFence as Map<string, Promise<unknown>>
}

/** Run `fn` exclusively per key on a hot-reload-proof queue. */
export function serialized<T>(store: () => Map<string, Promise<unknown>>, key: string, fn: () => Promise<T>): Promise<T> {
  const map = store()
  const prior = map.get(key) ?? Promise.resolve()
  const next = prior.then(fn, fn)
  const tail = next.then(() => {}, () => {})
  map.set(key, tail)
  void tail.then(() => { if (map.get(key) === tail) map.delete(key) })
  return next
}

export function withAdmissionFence<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  return serialized(queues, projectId, fn)
}
