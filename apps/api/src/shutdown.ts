import type { Logger } from 'pino'

export type ShutdownDeps = {
  logger: Logger
  closeServer: () => Promise<void>
  closeDatabase: () => Promise<void>
  // Скільки чекати на запити в польоті. Платформа після сигналу вбиває процес
  // сама, тож чекати довше за її терпіння немає сенсу.
  graceMs: number
}

export type ExitCode = 0 | 1

export type Shutdown = (signal: string) => Promise<ExitCode>

class ShutdownTimedOut extends Error {
  constructor(graceMs: number) {
    super(`the server did not drain within ${graceMs} ms`)
    this.name = 'ShutdownTimedOut'
  }
}

function withDeadline(work: Promise<void>, graceMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined

  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ShutdownTimedOut(graceMs)), graceMs)
  })

  return Promise.race([work, deadline]).finally(() => clearTimeout(timer))
}

export function createShutdown({
  logger,
  closeServer,
  closeDatabase,
  graceMs,
}: ShutdownDeps): Shutdown {
  let inFlight: Promise<ExitCode> | undefined

  const run = async (signal: string): Promise<ExitCode> => {
    logger.info({ signal }, 'shutting down')

    let code: ExitCode = 0

    try {
      await withDeadline(closeServer(), graceMs)
    } catch (error) {
      code = 1
      if (error instanceof ShutdownTimedOut) {
        logger.warn({ graceMs }, 'shutdown timed out')
      } else {
        logger.error({ err: error }, 'shutdown failed')
      }
    }

    // База закривається за будь-якого результату вище: з'єднання, що лишились
    // після процесу, пул Supabase тримає до власного таймауту.
    try {
      await closeDatabase()
    } catch (error) {
      code = 1
      logger.error({ err: error }, 'shutdown failed')
    }

    if (code === 0) {
      logger.info('shut down')
    }

    return code
  }

  return (signal) => {
    inFlight ??= run(signal)

    return inFlight
  }
}
