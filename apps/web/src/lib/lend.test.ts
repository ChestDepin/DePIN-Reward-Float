import { describe, expect, it } from 'vitest'
import { lendFailureText, withdrawalText, withdrawnText } from './lend'

describe('withdrawalText', () => {
  it('says nothing when the amount asked is what will be paid', () => {
    expect(
      withdrawalText({ ok: true, paid: 125_000_000n, shares: 100n, limitedBy: null }, 1_000_000_000n),
    ).toBeNull()
  })

  it('says the rest is out in loans, and stays the lender’s, when the free liquidity limits it', () => {
    const text = withdrawalText(
      { ok: true, paid: 300_000_000n, shares: 240n, limitedBy: 'free-liquidity' },
      500_000_000n,
    )

    expect(text).toMatch(/\$300\.00/)
    expect(text).toMatch(/lent out/)
    expect(text).toMatch(/\$200\.00 stays in the pool/)
  })

  it('says the whole position is paid when more was asked', () => {
    const text = withdrawalText(
      { ok: true, paid: 500_000_000n, shares: 400n, limitedBy: 'position' },
      500_000_000n,
    )

    expect(text).toMatch(/all your position is worth/)
    expect(text).toMatch(/\$500\.00/)
  })

  it('explains a pool with nothing free instead of quoting nothing', () => {
    const text = withdrawalText({ ok: false, reason: 'no-free-liquidity' }, 500_000_000n)

    expect(text).toMatch(/lent out/)
    expect(text).toMatch(/keeps earning/)
  })

  it('says there is nothing to withdraw for a wallet without a position', () => {
    expect(withdrawalText({ ok: false, reason: 'nothing-to-withdraw' }, 0n)).toMatch(
      /nothing in this pool/,
    )
  })
})

describe('withdrawnText', () => {
  it('says what the program paid and why it was less than asked', () => {
    expect(withdrawnText({ paid: 300_000_000n, limitedBy: 'free-liquidity' })).toBe(
      'Withdrew $300.00, all that was free in the pool; the rest of your position stays in and keeps earning.',
    )
    expect(withdrawnText({ paid: 500_000_000n, limitedBy: 'position' })).toBe(
      'Withdrew $500.00, all your position was worth.',
    )
    expect(withdrawnText({ paid: 125_000_000n, limitedBy: null })).toBe('Withdrew $125.00.')
  })
})

describe('lendFailureText', () => {
  it('says the wallet declined and nothing was sent', () => {
    expect(lendFailureText('deposit', { kind: 'rejected' })).toBe(
      'The wallet declined. Nothing was sent.',
    )
  })

  it('names the action the program refused, in the program’s words', () => {
    expect(
      lendFailureText('withdrawal', {
        kind: 'program',
        name: 'noFreeLiquidity',
        message: 'Everything in the pool is lent out',
      }),
    ).toBe('The program refused the withdrawal: Everything in the pool is lent out.')
  })

  it('passes on what is known of a failure it cannot name', () => {
    expect(lendFailureText('deposit', { kind: 'unknown', message: 'blockhash not found' })).toBe(
      'The deposit did not go through: blockhash not found',
    )
  })
})
