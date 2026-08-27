import { describe, expect, it } from 'vitest'
import {
  baseUnitsSchema,
  blockTimeSchema,
  instantSchema,
  solanaAddressSchema,
} from './primitives.ts'

const ADDRESS_44 = '4vMsoUT2BWatFweudnQM1xedRLfJgJ7hswhcpz4xgBTy'
const ADDRESS_43 = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const ADDRESS_32 = '11111111111111111111111111111111'

describe('solanaAddressSchema', () => {
  it('accepts an address that decodes to 32 bytes', () => {
    expect(solanaAddressSchema.parse(ADDRESS_44)).toBe(ADDRESS_44)
  })

  it('accepts the shorter encodings of the same 32 bytes', () => {
    expect(solanaAddressSchema.parse(ADDRESS_43)).toBe(ADDRESS_43)
    expect(solanaAddressSchema.parse(ADDRESS_32)).toBe(ADDRESS_32)
  })

  it('rejects an address-looking string that decodes to 31 bytes', () => {
    expect(
      solanaAddressSchema.safeParse('HvmDemo7xK2qF4b9WgQn3sT8yLcRzA1eU6dJ5mNpVe').success,
    ).toBe(false)
  })

  it('rejects characters outside the base58 alphabet', () => {
    expect(
      solanaAddressSchema.safeParse('4vMsoUT2BWatFweudnQ0Ixedl1JgJ7hswhcpz4xgBTy').success,
    ).toBe(false)
  })

  it('rejects an empty string', () => {
    expect(solanaAddressSchema.safeParse('').success).toBe(false)
  })
})

describe('baseUnitsSchema', () => {
  it('reads a decimal string as bigint', () => {
    expect(baseUnitsSchema.parse('4090000000')).toBe(4_090_000_000n)
  })

  it('keeps u64 maximum exact, where a double would already have lost digits', () => {
    expect(baseUnitsSchema.parse('18446744073709551615')).toBe(18_446_744_073_709_551_615n)
  })

  it('passes a bigint through', () => {
    expect(baseUnitsSchema.parse(0n)).toBe(0n)
  })

  it('rejects a number, because a token amount does not survive a double', () => {
    expect(baseUnitsSchema.safeParse(4_090_000_000).success).toBe(false)
  })

  it('rejects a negative amount', () => {
    expect(baseUnitsSchema.safeParse('-1').success).toBe(false)
    expect(baseUnitsSchema.safeParse(-1n).success).toBe(false)
  })

  it('rejects more than u64 can hold', () => {
    expect(baseUnitsSchema.safeParse('18446744073709551616').success).toBe(false)
  })

  it('rejects a fractional amount: minimal units are whole by definition', () => {
    expect(baseUnitsSchema.safeParse('1.5').success).toBe(false)
  })
})

describe('instantSchema', () => {
  it('passes a Date through', () => {
    const date = new Date('2026-08-30T14:02:00.000Z')

    expect(instantSchema.parse(date).getTime()).toBe(date.getTime())
  })

  it('reads an ISO 8601 string', () => {
    expect(instantSchema.parse('2026-08-30T14:02:00.000Z').toISOString()).toBe(
      '2026-08-30T14:02:00.000Z',
    )
  })

  it('rejects a number: seconds and milliseconds are not distinguishable by sight', () => {
    expect(instantSchema.safeParse(1_787_000_000).success).toBe(false)
    expect(instantSchema.safeParse(1_787_000_000_000).success).toBe(false)
  })

  it('rejects a date-only string', () => {
    expect(instantSchema.safeParse('2026-08-30').success).toBe(false)
  })

  it('rejects an invalid Date', () => {
    expect(instantSchema.safeParse(new Date('nonsense')).success).toBe(false)
  })
})

describe('blockTimeSchema', () => {
  it('reads solana blockTime seconds as an instant', () => {
    expect(blockTimeSchema.parse(1_787_000_000).toISOString()).toBe(
      new Date(1_787_000_000_000).toISOString(),
    )
  })

  it('rejects milliseconds passed in by mistake', () => {
    expect(blockTimeSchema.safeParse(1_787_000_000_000).success).toBe(false)
  })

  it('rejects a fractional second', () => {
    expect(blockTimeSchema.safeParse(1_787_000_000.5).success).toBe(false)
  })

  it('rejects zero and negative time', () => {
    expect(blockTimeSchema.safeParse(0).success).toBe(false)
    expect(blockTimeSchema.safeParse(-1).success).toBe(false)
  })
})
