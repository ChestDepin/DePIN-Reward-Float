import { BorshCoder, type Idl, utils } from '@coral-xyz/anchor'
import { issuedAttestationSchema, issuedRateAttestationSchema } from '@drf/shared/api'
import { signLimitAttestation, signRateAttestation } from '@drf/shared/attestation'
import { solanaAddressSchema } from '@drf/shared/schemas'
import {
  Ed25519Program,
  Keypair,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram,
  Transaction,
} from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { decodePool } from './accounts.ts'
import { AttestationMismatch, borrowInstructions } from './borrow.ts'
import rawIdl from './idl/reward_float.json' with { type: 'json' }
import {
  loanAddress,
  operatorAccountAddress,
  poolAddress,
  rewardFloatProgramId,
  rewardWatchAddress,
} from './pda.ts'
import { coder, encodePool, key, offlineProgram } from './test-support.ts'

const ASSOCIATED_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
// u16::MAX in the ed25519 offsets: "this instruction", the only form borrow accepts.
const THIS_INSTRUCTION = 0xffff
// The most loans an operator can hold while still being allowed one more.
const WORST_CASE_OPEN_LOANS = 3
const MEASURED_WORST_CASE_BYTES = 1145

const attestorSecret = new Uint8Array(32).fill(21)
const attestor = Keypair.fromSeed(attestorSecret).publicKey
const operator = key(1)
const stableMint = key(2)
const vault = key(3)
const rewardMint = key(4)
const pool = poolAddress(stableMint)

async function issued(overrides: { wallet?: PublicKey; nonce?: bigint } = {}) {
  const wallet = overrides.wallet ?? operator
  const nonce = overrides.nonce ?? 7n
  const computedAt = new Date('2026-10-03T10:00:00Z')
  const expiresAt = new Date('2026-10-03T10:05:00Z')
  const { message, signature } = await signLimitAttestation(
    {
      operator: solanaAddressSchema.parse(wallet.toBase58()),
      limitBaseUnits: 250_000_000n,
      computedAt,
      expiresAt,
      nonce,
    },
    attestorSecret,
  )
  return issuedAttestationSchema.parse({
    wallet: wallet.toBase58(),
    nonce: nonce.toString(),
    limitBaseUnits: '250000000',
    attestor: attestor.toBase58(),
    message: utils.bytes.bs58.encode(message),
    signature: utils.bytes.bs58.encode(signature),
    computedAt: computedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  })
}

async function issuedRate(overrides: { mint?: PublicKey; signer?: Uint8Array } = {}) {
  const mint = overrides.mint ?? rewardMint
  const secret = overrides.signer ?? attestorSecret
  const pricedAt = new Date('2026-10-03T10:00:00Z')
  const expiresAt = new Date('2026-10-03T10:02:00Z')
  const { message, signature } = await signRateAttestation(
    {
      rewardMint: solanaAddressSchema.parse(mint.toBase58()),
      stablePerTrillionReward: 2_406_662n,
      pricedAt,
      expiresAt,
    },
    secret,
  )
  return issuedRateAttestationSchema.parse({
    rewardMint: mint.toBase58(),
    stablePerTrillionReward: '2406662',
    attestor: Keypair.fromSeed(secret).publicKey.toBase58(),
    message: utils.bytes.bs58.encode(message),
    signature: utils.bytes.bs58.encode(signature),
    pricedAt: pricedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  })
}

async function poolOnChain(trusted = attestor) {
  return {
    address: pool,
    account: decodePool(await encodePool({ attestor: trusted, stableMint, vault })),
  }
}

async function request(openLoans: readonly PublicKey[] = []) {
  return {
    operator,
    pool: await poolOnChain(),
    attestation: await issued(),
    rate: await issuedRate(),
    openLoans,
    rewardMint,
    amount: 100_000_000n,
    termPeriods: 3,
    sweepBps: 5000,
    maxAprBps: 1500,
  }
}

function at<T>(items: readonly T[], index: number): T {
  const item = items[index]
  if (item === undefined) throw new Error(`no item at ${index}`)
  return item
}

describe('borrow instructions', () => {
  const program = offlineProgram()

  // borrow reads the limit right before it and the rate right before that; it approves
  // the reward account itself, so no approve of the client's is in the transaction.
  it('opens both accounts, then the signed rate, the signed limit and borrow', async () => {
    const instructions = await borrowInstructions(program, await request())

    expect(instructions.map((ix) => ix.programId.toBase58())).toEqual([
      ASSOCIATED_PROGRAM_ID.toBase58(),
      ASSOCIATED_PROGRAM_ID.toBase58(),
      Ed25519Program.programId.toBase58(),
      Ed25519Program.programId.toBase58(),
      rewardFloatProgramId.toBase58(),
    ])
  })

  // On devnet the stand-in reward token reaches an operator's wallet only once rewards
  // arrive, and borrow needs the account to approve it.
  it('creates the reward account idempotently', async () => {
    const create = at(await borrowInstructions(program, await request()), 1)
    const rewardAccount = utils.token.associatedAddress({ mint: rewardMint, owner: operator })

    expect(create.data).toEqual(Buffer.from([1]))
    expect(create.keys.map((k) => k.pubkey.toBase58())).toEqual(
      [
        operator,
        rewardAccount,
        operator,
        rewardMint,
        SystemProgram.programId,
        TOKEN_PROGRAM_ID,
      ].map((k) => k.toBase58()),
    )
  })

  it('carries the signed rate and the attestor key inside its own ed25519 instruction', async () => {
    const rate = await issuedRate()
    const ed25519 = at(await borrowInstructions(program, await request()), 2)
    const data = ed25519.data
    const field = (n: number) => data.readUInt16LE(2 + 2 * n)

    expect([field(1), field(3), field(6)]).toEqual([
      THIS_INSTRUCTION,
      THIS_INSTRUCTION,
      THIS_INSTRUCTION,
    ])
    expect(data.subarray(field(2), field(2) + 32)).toEqual(attestor.toBuffer())
    expect(data.subarray(field(4), field(4) + field(5))).toEqual(
      Buffer.from(utils.bytes.bs58.decode(rate.message)),
    )
  })

  it('creates the destination idempotently, so a second loan does not fail on it', async () => {
    const [create] = await borrowInstructions(program, await request())
    const destination = utils.token.associatedAddress({ mint: stableMint, owner: operator })

    expect(create?.data).toEqual(Buffer.from([1]))
    expect(create?.keys.map((k) => k.pubkey.toBase58())).toEqual(
      [operator, destination, operator, stableMint, SystemProgram.programId, TOKEN_PROGRAM_ID].map(
        (k) => k.toBase58(),
      ),
    )
  })

  it('carries the signed bytes and the attestor key inside the ed25519 instruction itself', async () => {
    const attestation = await issued()
    const ed25519 = at(await borrowInstructions(program, await request()), 3)
    const data = ed25519.data
    const field = (n: number) => data.readUInt16LE(2 + 2 * n)
    const message = utils.bytes.bs58.decode(attestation.message)

    expect(data[0]).toBe(1)
    expect([field(1), field(3), field(6)]).toEqual([
      THIS_INSTRUCTION,
      THIS_INSTRUCTION,
      THIS_INSTRUCTION,
    ])
    expect(data.subarray(field(2), field(2) + 32)).toEqual(attestor.toBuffer())
    expect(data.subarray(field(4), field(4) + field(5))).toEqual(Buffer.from(message))
  })

  it('passes the arguments and accounts the program expects, open loans last', async () => {
    const openLoans = [key(11), key(12)]
    const borrow = at(await borrowInstructions(program, await request(openLoans)), 4)

    expect(coder.instruction.decode(borrow.data)).toMatchObject({
      name: 'borrow',
      data: { termPeriods: 3, sweepBps: 5000, maxAprBps: 1500 },
    })
    expect(borrow.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual([
      [operator.toBase58(), true, true],
      [pool.toBase58(), false, true],
      [operatorAccountAddress(operator).toBase58(), false, true],
      [loanAddress(operator, 7n).toBase58(), false, true],
      [vault.toBase58(), false, true],
      [
        utils.token.associatedAddress({ mint: stableMint, owner: operator }).toBase58(),
        false,
        true,
      ],
      [rewardMint.toBase58(), false, false],
      [
        utils.token.associatedAddress({ mint: rewardMint, owner: operator }).toBase58(),
        false,
        true,
      ],
      [rewardWatchAddress(operator, rewardMint).toBase58(), false, true],
      [SYSVAR_INSTRUCTIONS_PUBKEY.toBase58(), false, false],
      [TOKEN_PROGRAM_ID.toBase58(), false, false],
      [SystemProgram.programId.toBase58(), false, false],
      [key(11).toBase58(), false, true],
      [key(12).toBase58(), false, true],
    ])
  })

  // The client encodes through the camelCase IDL; the program was built from the raw
  // snake_case one. A field that one of them misses is encoded as zero, without an error.
  it('encodes the same bytes as a coder built from the raw IDL', async () => {
    const borrow = at(await borrowInstructions(program, await request()), 4)
    const raw = new BorshCoder(rawIdl as Idl).instruction.decode(borrow.data)

    expect(raw?.name).toBe('borrow')
    expect(JSON.stringify(raw?.data)).toBe(
      JSON.stringify({
        nonce: '07',
        amount: '05f5e100',
        term_periods: 3,
        sweep_bps: 5000,
        max_apr_bps: 1500,
      }),
    )
  })

  it('refuses an attestation signed by a key the pool no longer trusts', async () => {
    const rotated = { ...(await request()), pool: await poolOnChain(key(30)) }

    await expect(borrowInstructions(program, rotated)).rejects.toThrow(AttestationMismatch)
  })

  it('refuses an attestation issued to another wallet', async () => {
    const foreign = { ...(await request()), attestation: await issued({ wallet: key(31) }) }

    await expect(borrowInstructions(program, foreign)).rejects.toThrow(AttestationMismatch)
  })

  it('refuses a rate signed by a key the pool does not trust', async () => {
    const stranger = {
      ...(await request()),
      rate: await issuedRate({ signer: new Uint8Array(32).fill(22) }),
    }

    await expect(borrowInstructions(program, stranger)).rejects.toThrow(AttestationMismatch)
  })

  it('refuses a rate for another reward token than the loan is repaid from', async () => {
    const other = { ...(await request()), rate: await issuedRate({ mint: key(32) }) }

    await expect(borrowInstructions(program, other)).rejects.toThrow(AttestationMismatch)
  })

  it('refuses an amount outside u64', async () => {
    const tooMuch = { ...(await request()), amount: 2n ** 64n }

    await expect(borrowInstructions(program, tooMuch)).rejects.toThrow(RangeError)
  })

  it('fits the worst case into one legacy transaction', async () => {
    const openLoans = Array.from({ length: WORST_CASE_OPEN_LOANS }, (_, i) => key(40 + i))
    const transaction = new Transaction({
      feePayer: operator,
      recentBlockhash: key(99).toBase58(),
    }).add(...(await borrowInstructions(program, await request(openLoans))))

    const bytes = transaction.serialize({ requireAllSignatures: false, verifySignatures: false })

    expect(bytes.length).toBe(MEASURED_WORST_CASE_BYTES)
    expect(bytes.length).toBeLessThanOrEqual(1232)
  })
})
