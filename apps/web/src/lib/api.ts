import {
  type CreditLimit,
  creditLimitSchema,
  type PayoutHistory,
  payoutHistorySchema,
} from '@drf/shared/api'
import type { SolanaAddress } from '@drf/shared/schemas'
import { useEffect, useState } from 'react'
import { z } from 'zod'

// «Дані недоступні» і «не змогли зрозуміти відповідь» лишаються різними
// станами (FR-025), а от `INTERNAL` зливається з нерозбірливою відповіддю:
// обидва означають нашу ваду, з якою оператор нічого зробити не може.
export type ApiFailure =
  | { kind: 'invalid-address' }
  | { kind: 'not-found' }
  | { kind: 'data-unavailable' }
  | { kind: 'unreachable' }
  | { kind: 'broken' }

export type ApiResult<T> = { ok: true; value: T } | { ok: false; failure: ApiFailure }

const BROKEN: ApiResult<never> = { ok: false, failure: { kind: 'broken' } }

const errorBodySchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
})

const FAILURE_BY_CODE = new Map<string, ApiFailure>([
  ['INVALID_INPUT', { kind: 'invalid-address' }],
  ['NOT_FOUND', { kind: 'not-found' }],
  ['DATA_UNAVAILABLE', { kind: 'data-unavailable' }],
])

export function readAnswer<T>(schema: z.ZodType<T>, status: number, body: unknown): ApiResult<T> {
  if (status === 200) {
    const parsed = schema.safeParse(body)

    return parsed.success ? { ok: true, value: parsed.data } : BROKEN
  }

  const error = errorBodySchema.safeParse(body)
  if (!error.success) return BROKEN

  const failure = FAILURE_BY_CODE.get(error.data.error.code)

  return failure === undefined ? BROKEN : { ok: false, failure }
}

const envSchema = z.object({
  VITE_API_URL: z.url({ protocol: /^https?$/ }).default('http://localhost:8787'),
})

export function apiBaseUrl(env: unknown): string {
  const parsed = envSchema.safeParse(env)

  if (!parsed.success) throw new Error('VITE_API_URL is not an http(s) url')

  return parsed.data.VITE_API_URL.replace(/\/$/, '')
}

export type ApiClient = {
  payoutHistory(address: SolanaAddress): Promise<ApiResult<PayoutHistory>>
  creditLimit(address: SolanaAddress): Promise<ApiResult<CreditLimit>>
  refreshCreditLimit(address: SolanaAddress): Promise<ApiResult<CreditLimit>>
}

export type ApiClientOptions = {
  baseUrl: string
  fetch?: typeof globalThis.fetch
}

export function createApiClient({ baseUrl, fetch = globalThis.fetch }: ApiClientOptions): ApiClient {
  const call = async <T>(
    schema: z.ZodType<T>,
    path: string,
    method: 'GET' | 'POST',
  ): Promise<ApiResult<T>> => {
    let response: Response
    try {
      response = await fetch(`${baseUrl}${path}`, { method })
    } catch {
      return { ok: false, failure: { kind: 'unreachable' } }
    }

    let body: unknown
    try {
      body = await response.json()
    } catch {
      return BROKEN
    }

    return readAnswer(schema, response.status, body)
  }

  return {
    payoutHistory: (address) =>
      call(payoutHistorySchema, `/v1/operators/${address}/payouts`, 'GET'),
    creditLimit: (address) => call(creditLimitSchema, `/v1/operators/${address}/limit`, 'GET'),
    refreshCreditLimit: (address) =>
      call(creditLimitSchema, `/v1/operators/${address}/limit/refresh`, 'POST'),
  }
}

export const api = createApiClient({ baseUrl: apiBaseUrl(import.meta.env) })

export type Resource<T> = { status: 'loading' } | { status: 'done'; result: ApiResult<T> }

// Одне джерело завантаження на обидві сторінки: інакше кожна вигадувала б свій
// порядок «показати старе / показати помилку», і вони б розійшлися.
// `load` має бути стабільним (`useCallback`) — інакше кожен рендер починав би
// новий запит.
export function useResource<T>(load: () => Promise<ApiResult<T>>): Resource<T> {
  const [resource, setResource] = useState<Resource<T>>({ status: 'loading' })

  useEffect(() => {
    let live = true
    setResource({ status: 'loading' })

    load().then((result) => {
      if (live) setResource({ status: 'done', result })
    })

    // Відповідь на адресу, з якої вже пішли, не має права перезаписати ту,
    // що показується зараз.
    return () => {
      live = false
    }
  }, [load])

  return resource
}
