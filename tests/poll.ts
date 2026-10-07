export type Poll<T> = {
  read(): Promise<T>
  done(value: T): boolean
  since: number
  intervalMs: number
  timeoutMs: number
  now(): number
  sleep(ms: number): Promise<void>
}

// `at` is when the reading that showed it came back, not when it was asked for: the
// measurement may only err on the late side.
export async function pollUntil<T>(poll: Poll<T>): Promise<{ value: T; at: number } | null> {
  for (;;) {
    const value = await poll.read()
    const at = poll.now()
    if (poll.done(value)) return { value, at }
    if (at - poll.since >= poll.timeoutMs) return null
    await poll.sleep(poll.intervalMs)
  }
}
