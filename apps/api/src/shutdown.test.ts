import { createLogger } from '@drf/shared/log'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createShutdown } from './shutdown.ts'

const GRACE_MS = 10_000

function capture() {
  const lines: Record<string, unknown>[] = []

  return {
    lines,
    logger: createLogger({
      service: 'api-test',
      destination: {
        write(chunk: string) {
          lines.push(JSON.parse(chunk))
        },
      },
    }),
  }
}

type Step = 'server' | 'database'

function deps(overrides: { server?: () => Promise<void>; database?: () => Promise<void> } = {}) {
  const steps: Step[] = []
  const { lines, logger } = capture()

  return {
    steps,
    lines,
    deps: {
      logger,
      graceMs: GRACE_MS,
      closeServer:
        overrides.server ??
        (async () => {
          steps.push('server')
        }),
      closeDatabase:
        overrides.database ??
        (async () => {
          steps.push('database')
        }),
    },
  }
}

describe('createShutdown', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('stops accepting requests before it lets go of the database, then exits cleanly', async () => {
    const { steps, lines, deps: shutdownDeps } = deps()

    const code = await createShutdown(shutdownDeps)('SIGTERM')

    expect(code).toBe(0)
    expect(steps).toEqual(['server', 'database'])
    expect(lines.map((line) => line.msg)).toEqual(['shutting down', 'shut down'])
    expect(lines[0]).toMatchObject({ signal: 'SIGTERM' })
  })

  // Render надсилає сигнал один раз, але людина з клавіатури — скільки завгодно.
  // Другий сигнал не має закривати базу двічі і не має обривати перший прохід.
  it('answers a repeated signal with the shutdown already in flight', async () => {
    const { steps, deps: shutdownDeps } = deps()
    const shutdown = createShutdown(shutdownDeps)

    const [first, second] = await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT')])

    expect(first).toBe(0)
    expect(second).toBe(0)
    expect(steps).toEqual(['server', 'database'])
  })

  it('gives up on a server that never drains and exits with a failure', async () => {
    const { steps, lines, deps: shutdownDeps } = deps({ server: () => new Promise(() => {}) })

    const pending = createShutdown(shutdownDeps)('SIGTERM')
    await vi.advanceTimersByTimeAsync(GRACE_MS)

    expect(await pending).toBe(1)
    expect(steps).toEqual(['database'])
    expect(lines.map((line) => line.msg)).toContain('shutdown timed out')
  })

  it('still exits when the database refuses to close, and says so', async () => {
    const {
      steps,
      lines,
      deps: shutdownDeps,
    } = deps({
      database: async () => {
        throw new Error('pool already gone')
      },
    })

    const code = await createShutdown(shutdownDeps)('SIGTERM')

    expect(code).toBe(1)
    expect(steps).toEqual(['server'])
    expect(lines.map((line) => line.msg)).toContain('shutdown failed')
  })

  it('does not fire the timeout after a clean shutdown', async () => {
    const { lines, deps: shutdownDeps } = deps()

    await createShutdown(shutdownDeps)('SIGTERM')
    await vi.advanceTimersByTimeAsync(GRACE_MS * 2)

    expect(lines.map((line) => line.msg)).not.toContain('shutdown timed out')
  })
})
