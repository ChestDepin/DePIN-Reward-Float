import { solanaAddressSchema } from '@drf/shared/schemas'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'

export const API_ERROR_CODES = [
  'INVALID_INPUT',
  // FR-025: історію не вдалося прочитати. Стан свідомо окремий від «ліміт 0»:
  // нуль — це порахований ліміт, а незнання — не нуль.
  'DATA_UNAVAILABLE',
  'NOT_FOUND',
  'INTERNAL',
] as const

export type ApiErrorCode = (typeof API_ERROR_CODES)[number]

export function errorBody(code: ApiErrorCode, message: string) {
  return { error: { code, message } }
}

// Кидається там, де читання джерела не вдалося — і тільки там. Помилка розбору
// власної відповіді — це наша вада, а не недоступність даних, і вона має
// лишитись п'ятисоткою.
export class DataUnavailable extends Error {
  constructor(source: string, options?: ErrorOptions) {
    super(`could not read ${source}`, options)
    this.name = 'DataUnavailable'
  }
}

// Межа, за якою запит до бази перестає бути нашим кодом. Обгортається саме
// запит, а не розбір його результату.
export async function reading<T>(source: string, query: PromiseLike<T>): Promise<T> {
  try {
    return await query
  } catch (cause) {
    throw new DataUnavailable(source, { cause })
  }
}

const paramsSchema = z.object({ address: solanaAddressSchema })

export const walletParam = zValidator('param', paramsSchema, (result, c) => {
  if (result.success) return

  return c.json(errorBody('INVALID_INPUT', 'not a Solana wallet address'), 400)
})
