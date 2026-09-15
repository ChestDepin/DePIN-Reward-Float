import { describe, expect, it } from 'vitest'
import { DataUnavailable, errorBody, reading } from './errors.ts'

describe('errorBody', () => {
  it('answers in one shape, whatever went wrong', () => {
    expect(errorBody('DATA_UNAVAILABLE', 'the payout history could not be read')).toEqual({
      error: { code: 'DATA_UNAVAILABLE', message: 'the payout history could not be read' },
    })
  })
})

describe('reading', () => {
  it('hands back what the query returned', async () => {
    expect(await reading('a query', Promise.resolve([1, 2]))).toEqual([1, 2])
  })

  it('turns a failed read into the state the operator is shown', async () => {
    const failure = new Error('connection to 10.0.0.4 refused')

    await expect(reading('the payout history', Promise.reject(failure))).rejects.toBeInstanceOf(
      DataUnavailable,
    )
  })

  it('names the source and keeps the cause for the log', async () => {
    const failure = new Error('connection to 10.0.0.4 refused')

    const thrown = await reading('the payout history', Promise.reject(failure)).catch(
      (error: unknown) => error,
    )

    expect(thrown).toMatchObject({
      message: 'could not read the payout history',
      cause: failure,
    })
  })

  // Помилка розбору власної відповіді — наша вада, а не недоступність даних,
  // і мовчки стати 503 вона не має.
  it('leaves a failure that is not a read alone', async () => {
    const thrown = await reading('a query', Promise.resolve(1))
      .then(() => {
        throw new Error('parsing the answer is not reading it')
      })
      .catch((error: unknown) => error)

    expect(thrown).not.toBeInstanceOf(DataUnavailable)
  })
})
