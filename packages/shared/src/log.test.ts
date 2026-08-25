import { describe, expect, it } from 'vitest'
import { createLogger } from './log.ts'

function capture() {
  const lines: Record<string, unknown>[] = []
  return {
    lines,
    destination: {
      write(chunk: string) {
        lines.push(JSON.parse(chunk))
      },
    },
  }
}

describe('createLogger', () => {
  it('stamps every line with the service and an ISO time', () => {
    const { lines, destination } = capture()
    const log = createLogger({ service: 'indexer', destination })

    log.info({ wallet: 'HvmDemo7xK2qF4b9WgQn3sT8yLcRzA1eU6dJ5mNpVe' }, 'payout indexed')

    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({
      service: 'indexer',
      level: 'info',
      msg: 'payout indexed',
      wallet: 'HvmDemo7xK2qF4b9WgQn3sT8yLcRzA1eU6dJ5mNpVe',
    })
    expect(lines[0]?.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  it('redacts secrets both at the top level and one level deep', () => {
    const { lines, destination } = capture()
    const log = createLogger({ service: 'api', destination })

    log.info(
      {
        attestorSecretKey: 'do-not-print-me',
        config: { DATABASE_URL: 'postgres://user:password@host:5432/db' },
      },
      'boot',
    )

    expect(JSON.stringify(lines[0])).not.toContain('do-not-print-me')
    expect(JSON.stringify(lines[0])).not.toContain('password')
    expect(lines[0]?.attestorSecretKey).toBe('[redacted]')
    expect(lines[0]?.config).toEqual({ DATABASE_URL: '[redacted]' })
  })

  it('redacts the rpc endpoints, because the api key travels inside the url', () => {
    const { lines, destination } = capture()
    const log = createLogger({ service: 'worker', destination })

    log.info({ MAINNET_RPC_URL: 'https://mainnet.helius-rpc.com/?api-key=live-key' }, 'connecting')

    expect(JSON.stringify(lines[0])).not.toContain('live-key')
  })

  it('drops lines below the configured level', () => {
    const { lines, destination } = capture()
    const log = createLogger({ service: 'api', level: 'warn', destination })

    log.debug('noise')
    log.info('also noise')
    log.warn('kept')

    expect(lines).toHaveLength(1)
    expect(lines[0]?.msg).toBe('kept')
  })

  it('serialises an Error with its type, message and stack', () => {
    const { lines, destination } = capture()
    const log = createLogger({ service: 'worker', destination })

    log.error({ err: new TypeError('rpc returned html') }, 'indexing failed')

    expect(lines[0]?.err).toMatchObject({
      type: 'TypeError',
      message: 'rpc returned html',
    })
    expect(JSON.stringify(lines[0]?.err)).toContain('log.test.ts')
  })

  it('keeps service and redaction in a child logger', () => {
    const { lines, destination } = capture()
    const log = createLogger({ service: 'worker', destination }).child({ network: 'hivemapper' })

    log.info({ keeperSecretKey: 'do-not-print-me' }, 'sweeping')

    expect(lines[0]).toMatchObject({
      service: 'worker',
      network: 'hivemapper',
      keeperSecretKey: '[redacted]',
    })
  })
})
