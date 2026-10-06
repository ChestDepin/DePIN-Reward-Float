import {
  associatedTokenAddress,
  conversionVaultAddress,
  decodeLoan,
  decodeOperatorAccount,
  decodeRewardWatch,
  operatorAccountAddress,
  poolAddress,
  rewardWatchAddress,
} from '@drf/anchor-client'
import {
  attestorKey,
  encodeConversionVault,
  encodeLoan,
  encodeOperatorAccount,
  encodePool,
  encodeRewardWatch,
  encodeTokenAccount,
  fakeChain,
  issuedRate,
  key,
  offlineProgram,
  type StoredAccount,
  storedAccount,
  sweepLogs,
} from '@drf/anchor-client/test-support'
import type { IssuedRateAttestation } from '@drf/shared/api'
import { Ed25519Program, PublicKey, type TransactionInstruction } from '@solana/web3.js'
import { pino } from 'pino'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createKeeper, type Pause, planSweeps, runKeeper, SKIP_PAUSE_MS } from './sweep.ts'

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
const H = 1_000_000_000n

const stableMint = key(2)
const vault = key(3)
const honey = key(4)
const hnt = key(5)
const pool = poolAddress(stableMint)
const alice = key(1)
const bob = key(6)

const silent = pino({ level: 'silent' })

async function watchOf(operator: PublicKey, mint: PublicKey, balance: bigint) {
  const address = rewardWatchAddress(operator, mint)
  return {
    address,
    account: decodeRewardWatch(await encodeRewardWatch({ operator, rewardMint: mint, balance })),
  }
}

async function loan(
  address: PublicKey,
  operator: PublicKey,
  rewardMint: PublicKey,
  nonce: bigint,
  inPool = pool,
) {
  return {
    address,
    account: decodeLoan(await encodeLoan({ operator, pool: inPool, nonce, rewardMint })),
  }
}

async function operatorAccount(owner: PublicKey, openLoans: number) {
  return decodeOperatorAccount(await encodeOperatorAccount(owner, openLoans))
}

describe('planSweeps', () => {
  async function plan(
    overrides: {
      balance?: bigint | null
      loans?: Awaited<ReturnType<typeof loan>>[]
      counted?: number
      pauses?: Map<string, Pause>
      now?: number
    } = {},
  ) {
    const watch = await watchOf(alice, honey, 5n * H)
    const loans = overrides.loans ?? [await loan(key(11), alice, honey, 1n)]
    const balance = overrides.balance === undefined ? 305n * H : overrides.balance
    return planSweeps({
      pool,
      watches: [watch],
      balances: new Map(balance === null ? [] : [[watch.address.toBase58(), balance]]),
      operatorAccounts: new Map([
        [alice.toBase58(), await operatorAccount(alice, overrides.counted ?? loans.length)],
      ]),
      openLoans: loans,
      pauses: overrides.pauses ?? new Map(),
      now: overrides.now ?? 1_000_000,
    })
  }

  it('sweeps a payout above the watch, with every open loan of the operator', async () => {
    const loans = [await loan(key(11), alice, honey, 1n), await loan(key(12), alice, hnt, 2n)]

    const { due, unsettled } = await plan({ loans })

    expect(unsettled).toEqual([])
    expect(due).toHaveLength(1)
    expect(due[0]?.operator.equals(alice)).toBe(true)
    expect(due[0]?.rewardMint.equals(honey)).toBe(true)
    expect(due[0]?.payout).toBe(300n * H)
    expect(due[0]?.openLoans.map((l) => l.toBase58())).toEqual([
      key(11).toBase58(),
      key(12).toBase58(),
    ])
  })

  it('leaves a watch alone when nothing arrived above it', async () => {
    expect((await plan({ balance: 5n * H })).due).toEqual([])
    expect((await plan({ balance: 2n * H })).due).toEqual([])
    expect((await plan({ balance: null })).due).toEqual([])
  })

  // The watch outlives the loans: after the last one is repaid, rewards are the
  // operator's alone, and a sweep would only cost a fee.
  it('leaves a payout alone when no open loan is repaid from this mint', async () => {
    const { due } = await plan({ loans: [await loan(key(12), alice, hnt, 2n)] })

    expect(due).toEqual([])
  })

  it('waits out a pause on the same balance, and not on a new payout', async () => {
    const paused = new Map([
      [rewardWatchAddress(alice, honey).toBase58(), { balance: 305n * H, until: 2_000 }],
    ])

    expect((await plan({ pauses: paused, now: 1_999 })).due).toEqual([])
    expect((await plan({ pauses: paused, now: 2_000 })).due).toHaveLength(1)
    expect((await plan({ pauses: paused, now: 1_999, balance: 306n * H })).due).toHaveLength(1)
  })

  // sweep wants exactly the open loans the program counts; a read that lands between
  // two slots would fail the transaction, so it waits for the next tick instead.
  it('reports an operator whose loans and count disagree, and sweeps nothing for them', async () => {
    const { due, unsettled } = await plan({ counted: 2 })

    expect(due).toEqual([])
    expect(unsettled).toHaveLength(1)
    expect(unsettled[0]?.operator.equals(alice)).toBe(true)
    expect(unsettled[0]?.reason).toMatch(/1 open loans.*counts 2/)
  })
})

type Sent = { instructions: TransactionInstruction[] }

async function world() {
  const accounts: StoredAccount[] = [
    storedAccount(pool, await encodePool({ attestor: attestorKey, stableMint, vault })),
  ]
  for (const rewardMint of [honey, hnt]) {
    accounts.push(
      storedAccount(
        conversionVaultAddress(pool, rewardMint),
        await encodeConversionVault({ pool, rewardMint, spreadBps: 30, maxSlippageBps: 100 }),
      ),
    )
  }
  const chain = fakeChain(accounts)

  async function operator(
    owner: PublicKey,
    mint: PublicKey,
    watch: bigint,
    held: bigint,
    loanKey: PublicKey,
  ) {
    accounts.push(
      storedAccount(
        rewardWatchAddress(owner, mint),
        await encodeRewardWatch({ operator: owner, rewardMint: mint, balance: watch }),
      ),
      storedAccount(operatorAccountAddress(owner), await encodeOperatorAccount(owner, 1)),
      storedAccount(
        loanKey,
        await encodeLoan({ operator: owner, pool, nonce: 1n, rewardMint: mint }),
      ),
    )
    setBalance(owner, mint, held)
  }

  function setBalance(owner: PublicKey, mint: PublicKey, amount: bigint) {
    const address = associatedTokenAddress(mint, owner)
    const index = accounts.findIndex((a) => a.pubkey.equals(address))
    const entry = storedAccount(address, encodeTokenAccount(mint, owner, amount), TOKEN_PROGRAM_ID)
    if (index === -1) accounts.push(entry)
    else accounts[index] = entry
  }

  const sent: Sent[] = []
  const rates: string[] = []
  let events: Parameters<typeof sweepLogs>[0] = []
  let clock = 1_000_000
  let rateFailure: string | null = null

  const keeper = createKeeper({
    chain,
    program: offlineProgram(),
    pool,
    issueRate: async (mint): Promise<IssuedRateAttestation> => {
      rates.push(mint)
      if (mint === rateFailure) throw new Error('rates are not set up')
      return issuedRate(new PublicKey(mint))
    },
    submit: async (instructions) => {
      sent.push({ instructions })
      return { signature: `sig${sent.length}`, logs: sweepLogs(events) }
    },
    logger: silent,
    now: () => clock,
  })

  return {
    keeper,
    operator,
    setBalance,
    sent,
    rates,
    accounts,
    emit(next: Parameters<typeof sweepLogs>[0]) {
      events = next
    },
    advance(ms: number) {
      clock += ms
    },
    failRatesFor(mint: PublicKey) {
      rateFailure = mint.toBase58()
    },
  }
}

const skipped = {
  name: 'sweepSkipped' as const,
  data: {
    operator: alice,
    rewardMint: honey,
    withheld: 0n,
    stablePerTrillionReward: 2_406_662n,
    deviationBps: 140,
    maxSlippageBps: 100,
  },
}

describe('a keeper tick', () => {
  it('sweeps a payout with the attested rate of its mint, right before sweep', async () => {
    const w = await world()
    await w.operator(alice, honey, 5n * H, 305n * H, key(11))

    const outcomes = await w.keeper.tick()

    expect(w.rates).toEqual([honey.toBase58()])
    expect(w.sent).toHaveLength(1)
    const [ed25519, sweep] = w.sent[0]?.instructions ?? []
    expect(ed25519?.programId.equals(Ed25519Program.programId)).toBe(true)
    expect(sweep?.keys.at(-1)?.pubkey.equals(key(11))).toBe(true)
    expect(outcomes).toEqual([
      { watch: rewardWatchAddress(alice, honey).toBase58(), outcome: 'nothing', signature: 'sig1' },
    ])
  })

  it('asks for no rate and sends nothing when no payout arrived', async () => {
    const w = await world()
    await w.operator(alice, honey, 5n * H, 5n * H, key(11))

    expect(await w.keeper.tick()).toEqual([])
    expect(w.rates).toEqual([])
    expect(w.sent).toEqual([])
  })

  // The skip is sent so its reason lands on chain; sending it again every tick while the
  // market stays outside would only add fees and duplicate the reason.
  it('pauses a payout skipped outside the tolerance until the pause runs out', async () => {
    const w = await world()
    await w.operator(alice, honey, 5n * H, 305n * H, key(11))
    w.emit([skipped])

    expect((await w.keeper.tick())[0]?.outcome).toBe('skipped')
    w.advance(SKIP_PAUSE_MS - 1)
    expect(await w.keeper.tick()).toEqual([])
    w.advance(1)
    expect(await w.keeper.tick()).toHaveLength(1)
    expect(w.sent).toHaveLength(2)
  })

  it('does not pause a payout that grew while it was skipped', async () => {
    const w = await world()
    await w.operator(alice, honey, 5n * H, 305n * H, key(11))
    w.emit([skipped])
    await w.keeper.tick()

    w.setBalance(alice, honey, 405n * H)

    expect(await w.keeper.tick()).toHaveLength(1)
  })

  it('still sweeps for others when one sweep fails', async () => {
    const w = await world()
    await w.operator(alice, hnt, 5n * H, 305n * H, key(11))
    await w.operator(bob, honey, 5n * H, 305n * H, key(12))
    w.failRatesFor(hnt)

    const outcomes = await w.keeper.tick()

    expect(outcomes.map((o) => o.outcome).sort()).toEqual(['failed', 'nothing'])
    expect(outcomes.find((o) => o.outcome === 'failed')).toMatchObject({
      watch: rewardWatchAddress(alice, hnt).toBase58(),
      error: expect.stringMatching(/rates are not set up/),
    })
    expect(w.sent).toHaveLength(1)
  })

  it('fails a payout of a mint the pool has no conversion vault for, before sending', async () => {
    const w = await world()
    await w.operator(alice, key(70), 5n * H, 305n * H, key(11))

    const [outcome] = await w.keeper.tick()

    expect(outcome).toMatchObject({
      outcome: 'failed',
      error: expect.stringMatching(/conversion vault/),
    })
    expect(w.sent).toEqual([])
  })

  it('reports a sweep that withheld as swept', async () => {
    const w = await world()
    await w.operator(alice, honey, 5n * H, 305n * H, key(11))
    w.emit([
      {
        name: 'swept',
        data: {
          loan: key(11),
          operator: alice,
          rewardMint: honey,
          withheld: 150n * H,
          paid: 396_662n,
          stablePerTrillionReward: 2_406_662n,
          deviationBps: 31,
          remainingDebt: 603_338n,
        },
      },
    ])

    expect((await w.keeper.tick())[0]?.outcome).toBe('swept')
  })
})

describe('runKeeper', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('ticks again after a tick throws, and stops when told', async () => {
    vi.useFakeTimers()
    const tick = vi
      .fn<() => Promise<[]>>()
      .mockRejectedValueOnce(new Error('429 Too Many Requests'))
      .mockResolvedValue([])

    const running = runKeeper({ tick }, { intervalMs: 15_000, logger: silent })
    await vi.advanceTimersByTimeAsync(0)
    expect(tick).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(tick).toHaveBeenCalledTimes(2)

    running.stop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(tick).toHaveBeenCalledTimes(2)
  })
})
