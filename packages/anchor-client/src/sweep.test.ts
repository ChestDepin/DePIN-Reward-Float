import { BN, utils } from '@coral-xyz/anchor'
import { Ed25519Program, PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY, Transaction } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { decodeConversionVault, decodePool } from './accounts.ts'
import { AttestationMismatch } from './borrow.ts'
import {
  conversionVaultAddress,
  operatorAccountAddress,
  poolAddress,
  rewardFloatProgramId,
  rewardWatchAddress,
} from './pda.ts'
import { sweepEvents, sweepInstructions } from './sweep.ts'
import {
  attestorKey,
  coder,
  encodeConversionVault,
  encodePool,
  issuedRate,
  key,
  offlineProgram,
  sweepLogs,
} from './test-support.ts'

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
const THIS_INSTRUCTION = 0xffff
// MAX_OPEN_LOANS in the program: sweep takes every open loan of the operator.
const MOST_OPEN_LOANS = 4
const MEASURED_WORST_CASE_BYTES = 851

const operator = key(1)
const stableMint = key(2)
const vault = key(3)
const rewardMint = key(4)
const pool = poolAddress(stableMint)
const conversion = conversionVaultAddress(pool, rewardMint)

async function request(openLoans: readonly PublicKey[] = [key(11)], trusted = attestorKey) {
  return {
    operator,
    pool: {
      address: pool,
      account: decodePool(await encodePool({ attestor: trusted, stableMint, vault })),
    },
    conversionVault: {
      address: conversion,
      account: decodeConversionVault(
        await encodeConversionVault({ pool, rewardMint, spreadBps: 30, maxSlippageBps: 100 }),
      ),
    },
    rate: await issuedRate(rewardMint),
    openLoans,
  }
}

function at<T>(items: readonly T[], index: number): T {
  const item = items[index]
  if (item === undefined) throw new Error(`no item at ${index}`)
  return item
}

describe('sweep instructions', () => {
  const program = offlineProgram()

  // sweep reads the rate from the instruction right before it, and nothing else.
  it('is the signed rate, then sweep', async () => {
    const instructions = await sweepInstructions(program, await request())

    expect(instructions.map((ix) => ix.programId.toBase58())).toEqual([
      Ed25519Program.programId.toBase58(),
      rewardFloatProgramId.toBase58(),
    ])
  })

  it('carries the signed rate and the attestor key inside the ed25519 instruction', async () => {
    const rate = await issuedRate(rewardMint)
    const data = at(await sweepInstructions(program, await request()), 0).data
    const field = (n: number) => data.readUInt16LE(2 + 2 * n)

    expect([field(1), field(3), field(6)]).toEqual([
      THIS_INSTRUCTION,
      THIS_INSTRUCTION,
      THIS_INSTRUCTION,
    ])
    expect(data.subarray(field(2), field(2) + 32)).toEqual(attestorKey.toBuffer())
    expect(data.subarray(field(4), field(4) + field(5))).toEqual(
      Buffer.from(utils.bytes.bs58.decode(rate.message)),
    )
  })

  // Anyone may sweep: the only signer of the transaction is whoever pays its fee.
  it('passes the accounts the program expects, no signer, every open loan last', async () => {
    const sweep = at(await sweepInstructions(program, await request([key(11), key(12)])), 1)
    const stored = decodeConversionVault(
      await encodeConversionVault({ pool, rewardMint, spreadBps: 30, maxSlippageBps: 100 }),
    )

    expect(coder.instruction.decode(sweep.data)?.name).toBe('sweep')
    expect(sweep.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual([
      [pool.toBase58(), false, true],
      [operatorAccountAddress(operator).toBase58(), false, true],
      [
        utils.token.associatedAddress({ mint: rewardMint, owner: operator }).toBase58(),
        false,
        true,
      ],
      [rewardWatchAddress(operator, rewardMint).toBase58(), false, true],
      [conversion.toBase58(), false, false],
      [stored.stableVault.toBase58(), false, true],
      [stored.rewardVault.toBase58(), false, true],
      [vault.toBase58(), false, true],
      [SYSVAR_INSTRUCTIONS_PUBKEY.toBase58(), false, false],
      [TOKEN_PROGRAM_ID.toBase58(), false, false],
      [key(11).toBase58(), false, true],
      [key(12).toBase58(), false, true],
    ])
  })

  it('refuses a rate signed by a key the pool does not trust', async () => {
    await expect(sweepInstructions(program, await request([key(11)], key(50)))).rejects.toThrow(
      AttestationMismatch,
    )
  })

  it('refuses a rate for another token than the conversion vault buys', async () => {
    const mismatched = { ...(await request()), rate: await issuedRate(key(60)) }

    await expect(sweepInstructions(program, mismatched)).rejects.toThrow(AttestationMismatch)
  })

  it('fits every open loan the program allows into one legacy transaction', async () => {
    const openLoans = Array.from({ length: MOST_OPEN_LOANS }, (_, i) => key(40 + i))
    const transaction = new Transaction({
      feePayer: key(30),
      recentBlockhash: key(99).toBase58(),
    }).add(...(await sweepInstructions(program, await request(openLoans))))

    const bytes = transaction.serialize({ requireAllSignatures: false, verifySignatures: false })

    expect(bytes.length).toBe(MEASURED_WORST_CASE_BYTES)
    expect(bytes.length).toBeLessThanOrEqual(1232)
  })
})

describe('sweep events', () => {
  it('reads every withholding of a sweep, one per loan', () => {
    const logs = sweepLogs([
      {
        name: 'swept',
        data: {
          loan: key(11),
          operator,
          rewardMint,
          withheld: new BN('150000000000'),
          paid: new BN(396_662),
          stablePerTrillionReward: new BN(2_406_662),
          deviationBps: 31,
          remainingDebt: new BN(603_338),
        },
      },
    ])

    expect(sweepEvents(logs)).toEqual([
      {
        kind: 'swept',
        loan: key(11),
        operator,
        rewardMint,
        withheld: 150_000_000_000n,
        paid: 396_662n,
        stablePerTrillionReward: 2_406_662n,
        deviationBps: 31,
        remainingDebt: 603_338n,
      },
    ])
  })

  it('reads a sweep skipped outside the tolerance', () => {
    const logs = sweepLogs([
      {
        name: 'sweepSkipped',
        data: {
          operator,
          rewardMint,
          withheld: new BN(1_000),
          stablePerTrillionReward: new BN(2_406_662),
          deviationBps: 140,
          maxSlippageBps: 100,
        },
      },
    ])

    expect(sweepEvents(logs)).toEqual([
      {
        kind: 'skipped',
        operator,
        rewardMint,
        withheld: 1_000n,
        stablePerTrillionReward: 2_406_662n,
        deviationBps: 140,
        maxSlippageBps: 100,
      },
    ])
  })

  // The program emits the flag after every withholding of the same sweep.
  it('reads a loan flagged for a manual repayment, with its reason and what it is owed', () => {
    const logs = sweepLogs([
      {
        name: 'swept',
        data: {
          loan: key(11),
          operator,
          rewardMint,
          withheld: new BN(40),
          paid: new BN(96),
          stablePerTrillionReward: new BN(2_406_662),
          deviationBps: 31,
          remainingDebt: new BN(603_338),
        },
      },
      {
        name: 'manualRepaymentNeeded',
        data: {
          loan: key(11),
          operator,
          rewardMint,
          reason: { allowanceShort: {} },
          rewardDue: new BN(250_000_000_000),
        },
      },
    ])

    expect(sweepEvents(logs)).toEqual([
      expect.objectContaining({ kind: 'swept', loan: key(11) }),
      {
        kind: 'manual',
        loan: key(11),
        operator,
        rewardMint,
        reason: 'allowanceShort',
        rewardDue: 250_000_000_000n,
      },
    ])
  })

  it('reads each reason a loan is flagged for', () => {
    for (const reason of ['revoked', 'allowanceShort', 'withdrawnEarly'] as const) {
      const logs = sweepLogs([
        {
          name: 'manualRepaymentNeeded',
          data: { loan: key(11), operator, rewardMint, reason: { [reason]: {} }, rewardDue: 0n },
        },
      ])

      expect(sweepEvents(logs)).toEqual([expect.objectContaining({ kind: 'manual', reason })])
    }
  })

  // A sweep with no new payout moves nothing and says nothing.
  it('reads a sweep that emitted nothing as no events', () => {
    expect(sweepEvents(sweepLogs([]))).toEqual([])
  })
})
