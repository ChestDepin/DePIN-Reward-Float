import { creditLimitSchema, payoutHistorySchema } from '@drf/shared/api'
import { solanaAddressSchema } from '@drf/shared/schemas'
import { describe, expect, it } from 'vitest'
import { apiBaseUrl, createApiClient, readAnswer } from './api'

const WALLET = solanaAddressSchema.parse('4vMsoUT2BWatFweudnQM1xedRLfJgJ7hswhcpz4xgBTy')

const LIMIT = {
  wallet: WALLET,
  networks: [
    {
      networkId: 'hivemapper',
      displayName: 'Hivemapper',
      token: { symbol: 'HONEY', decimals: 9 },
      limitUsd: '555000000',
      factors: [{ name: 'median-flow', deltaUsd: '710240000' }],
      reason: null,
      computedAt: '2026-08-31T12:00:00.000Z',
      expiresAt: '2026-09-01T12:00:00.000Z',
    },
  ],
}

const answered = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

describe('readAnswer', () => {
  it('hands back the parsed payload of a good answer', () => {
    const result = readAnswer(creditLimitSchema, 200, LIMIT)

    expect(result).toEqual({ ok: true, value: LIMIT })
  })

  it('turns each error code the api can send into its own failure', () => {
    const failureOf = (status: number, code: string) =>
      readAnswer(creditLimitSchema, status, { error: { code, message: 'nope' } })

    expect(failureOf(400, 'INVALID_INPUT')).toEqual({
      ok: false,
      failure: { kind: 'invalid-address' },
    })
    expect(failureOf(404, 'NOT_FOUND')).toEqual({ ok: false, failure: { kind: 'not-found' } })
    expect(failureOf(503, 'DATA_UNAVAILABLE')).toEqual({
      ok: false,
      failure: { kind: 'data-unavailable' },
    })
  })

  // FR-025: «дані недоступні» не має права стати нулем на екрані, і саме тут
  // це рішення ухвалюється — далі по коду відмова вже неотличима від числа.
  it('never turns a failure into a payload', () => {
    const result = readAnswer(creditLimitSchema, 503, {
      error: { code: 'DATA_UNAVAILABLE', message: 'the payout history could not be read' },
    })

    expect(result.ok).toBe(false)
  })

  it('calls an answer that does not match the contract broken, not empty', () => {
    const result = readAnswer(payoutHistorySchema, 200, { wallet: WALLET })

    expect(result).toEqual({ ok: false, failure: { kind: 'broken' } })
  })

  it('calls a failure it cannot read broken as well', () => {
    expect(readAnswer(creditLimitSchema, 500, 'boom')).toEqual({
      ok: false,
      failure: { kind: 'broken' },
    })
  })

  it('treats an unknown error code as broken rather than guessing its meaning', () => {
    const result = readAnswer(creditLimitSchema, 418, {
      error: { code: 'TEAPOT', message: 'short and stout' },
    })

    expect(result).toEqual({ ok: false, failure: { kind: 'broken' } })
  })
})

describe('apiBaseUrl', () => {
  it('takes the url the build was given', () => {
    expect(apiBaseUrl({ VITE_API_URL: 'https://api.example.com' })).toBe('https://api.example.com')
  })

  it('drops a trailing slash so paths do not double it', () => {
    expect(apiBaseUrl({ VITE_API_URL: 'https://api.example.com/' })).toBe('https://api.example.com')
  })

  it('falls back to the local api when the build was given nothing', () => {
    expect(apiBaseUrl({})).toBe('http://localhost:8787')
  })

  it('refuses a url that is not http', () => {
    expect(() => apiBaseUrl({ VITE_API_URL: 'ws://api.example.com' })).toThrow(/VITE_API_URL/)
  })
})

describe('createApiClient', () => {
  const clientOver = (fetch: typeof globalThis.fetch) =>
    createApiClient({ baseUrl: 'https://api.example.com', fetch })

  it('asks the api for the limit of the address it was given', async () => {
    const seen: string[] = []
    const client = clientOver(async (input) => {
      seen.push(String(input))
      return answered(200, LIMIT)
    })

    const result = await client.creditLimit(WALLET)

    expect(seen).toEqual([`https://api.example.com/v1/operators/${WALLET}/limit`])
    expect(result).toEqual({ ok: true, value: LIMIT })
  })

  it('asks for a recalculation with a POST, not a second GET', async () => {
    const methods: (string | undefined)[] = []
    const client = clientOver(async (_input, init) => {
      methods.push(init?.method)
      return answered(200, LIMIT)
    })

    await client.refreshCreditLimit(WALLET)

    expect(methods).toEqual(['POST'])
  })

  // Сервера може не бути взагалі — це стан оператора, а не наш виняток, і
  // сторінка мусить сказати про нього, а не впасти.
  it('reports an api it could not reach instead of throwing', async () => {
    const client = clientOver(async () => {
      throw new TypeError('failed to fetch')
    })

    expect(await client.creditLimit(WALLET)).toEqual({
      ok: false,
      failure: { kind: 'unreachable' },
    })
  })

  it('reports an answer that is not json as broken', async () => {
    const client = clientOver(async () => new Response('<html>502</html>', { status: 502 }))

    expect(await client.creditLimit(WALLET)).toEqual({ ok: false, failure: { kind: 'broken' } })
  })
})
