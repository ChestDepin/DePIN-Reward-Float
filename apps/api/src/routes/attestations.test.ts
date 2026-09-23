import { readFileSync } from 'node:fs'
import path from 'node:path'
import { attestations, createDatabase, type Database } from '@drf/db'
import { issuedAttestationSchema } from '@drf/shared/api'
import {
  limitAttestationSchema,
  type SignedLimitAttestation,
  serializeLimitAttestation,
} from '@drf/shared/attestation'
import {
  type RewardNetwork,
  rewardNetworkSchema,
  type SolanaAddress,
  solanaAddressSchema,
} from '@drf/shared/schemas'
import { dayRangeSchema, formatUsd, type MonthRange } from '@drf/shared/scoring'
import { verifyAsync } from '@noble/ed25519'
import { base58, hex } from '@scure/base'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ATTESTATION_TTL_MS,
  type AttestationDraft,
  type AttestationJournal,
  attestedLimit,
  createAttestationRoutes,
  createDbAttestationJournal,
  resolveAttestor,
} from './attestations.ts'
import type { StoredCreditProfile } from './limit.ts'
import type { StoredHistory } from './operators.ts'

const WALLET = solanaAddressSchema.parse('4vMsoUT2BWatFweudnQM1xedRLfJgJ7hswhcpz4xgBTy')

// RFC 8032, test 1: сід і виведений із нього публічний ключ.
const SECRET_KEY = hex.decode('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60')
const PUBLIC_KEY = hex.decode('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a')
const ATTESTOR = solanaAddressSchema.parse(base58.encode(PUBLIC_KEY))

const NOW = new Date('2026-09-23T12:00:00.000Z')

const network = (id: string, symbol: string, mint: string): RewardNetwork =>
  rewardNetworkSchema.parse({
    id,
    displayName: symbol,
    token: { mint, symbol, decimals: 9 },
    payoutSources: [{ kind: 'mint', address: mint }],
    payoutCadence: 'weekly',
  })

const HIVEMAPPER = network(
  'test-attest-hivemapper',
  'HONEY',
  '2RZMt9LwzUzSUNfprdLSUF33gS2Y3EJL3jqN6g6a9oP1',
)
const HELIUM = network('test-attest-helium', 'HNT', '3mqvZ478SVFftqm6Pmh14SdUhUHuaG7KkKqaBDqNZADs')

const WINDOW = dayRangeSchema.parse({ from: '2026-08-25', to: '2026-09-23' })

const profile = (input: {
  network?: RewardNetwork
  limitUsd?: bigint | null
  computedAt?: Date
  expiresAt?: Date
}): StoredCreditProfile => ({
  network: input.network ?? HIVEMAPPER,
  limitUsd: input.limitUsd === undefined ? 4_000_000n : input.limitUsd,
  factors: [],
  reason: input.limitUsd === null ? { kind: 'no-recent-price', window: WINDOW } : null,
  computedAt: input.computedAt ?? new Date(NOW.getTime() - 3_600_000),
  expiresAt: input.expiresAt ?? new Date(NOW.getTime() + 20 * 3_600_000),
})

describe('attestedLimit', () => {
  it('adds up the networks that have a limit, because one debt is repaid by both flows', () => {
    const attested = attestedLimit(
      [profile({}), profile({ network: HELIUM, limitUsd: 1_500_000n })],
      NOW,
    )

    expect(attested?.limitUsd).toBe(5_500_000n)
  })

  it('leaves out a network that was refused a limit', () => {
    const attested = attestedLimit([profile({}), profile({ network: HELIUM, limitUsd: null })], NOW)

    expect(attested?.limitUsd).toBe(4_000_000n)
  })

  // Сума свіжа рівно настільки, наскільки свіжа її найстаріша частина.
  it('reports the oldest moment any part of the sum was computed at', () => {
    const older = new Date(NOW.getTime() - 7_200_000)
    const attested = attestedLimit(
      [profile({}), profile({ network: HELIUM, computedAt: older })],
      NOW,
    )

    expect(attested?.computedAt).toEqual(older)
  })

  it('expires in five minutes, not when the limit behind it does', () => {
    const attested = attestedLimit([profile({})], NOW)

    expect(attested?.expiresAt).toEqual(new Date(NOW.getTime() + ATTESTATION_TTL_MS))
  })

  it('never outlives the limit it was built from', () => {
    const soon = new Date(NOW.getTime() + 60_000)
    const attested = attestedLimit([profile({ expiresAt: soon })], NOW)

    expect(attested?.expiresAt).toEqual(soon)
  })

  it('has nothing to attest when no network has a limit', () => {
    expect(attestedLimit([profile({ limitUsd: null })], NOW)).toBeNull()
    expect(attestedLimit([], NOW)).toBeNull()
  })

  // FR-025: нуль — це порахований ліміт, і атестувати його чесно.
  it('attests a computed zero instead of calling it nothing to attest', () => {
    expect(attestedLimit([profile({ limitUsd: 0n })], NOW)?.limitUsd).toBe(0n)
  })
})

const memoryJournal = () => {
  const issued: { draft: AttestationDraft; nonce: bigint }[] = []

  const journal: AttestationJournal = {
    async issue(draft, sign) {
      const nonce = BigInt(issued.length + 1)
      issued.push({ draft, nonce })

      return { nonce, signed: await sign(nonce) }
    },
  }

  return { issued, journal }
}

const routes = (input: { profiles?: readonly StoredCreditProfile[]; now?: Date } = {}) => {
  const asked: MonthRange[] = []
  const written: (readonly StoredCreditProfile[])[] = []
  const { issued, journal } = memoryJournal()
  const stored = input.profiles ?? [profile({})]

  const app = createAttestationRoutes({
    payouts: {
      read: async (_wallet: SolanaAddress, period: MonthRange): Promise<StoredHistory> => {
        asked.push(period)
        return { payouts: [], networks: [], prices: new Map() }
      },
    },
    profiles: {
      read: async () => stored,
      write: async (_wallet: SolanaAddress, profiles: readonly StoredCreditProfile[]) => {
        written.push(profiles)
      },
    },
    journal,
    attestor: { secretKey: SECRET_KEY, address: ATTESTOR },
    now: () => input.now ?? NOW,
  })

  return { app, asked, issued, written }
}

const post = (app: ReturnType<typeof createAttestationRoutes>, wallet = WALLET) =>
  app.request(`/operators/${wallet}/attestations/limit`, { method: 'POST' })

describe('POST /operators/:address/attestations/limit', () => {
  it('serves an attestation the attestor key verifies', async () => {
    const { app } = routes()

    const response = await post(app)
    const body = issuedAttestationSchema.parse(await response.json())

    expect(response.status).toBe(201)
    expect(body).toMatchObject({
      wallet: WALLET,
      nonce: '1',
      limitBaseUnits: '4000000',
      attestor: ATTESTOR,
      expiresAt: new Date(NOW.getTime() + ATTESTATION_TTL_MS).toISOString(),
    })
    expect(
      await verifyAsync(base58.decode(body.signature), base58.decode(body.message), PUBLIC_KEY),
    ).toBe(true)
  })

  // Підписані байти і показані числа мають бути одним твердженням: інакше
  // програма прийме одне, а оператор побачить інше.
  it('serves the very bytes it signed', async () => {
    const { app } = routes()

    const body = issuedAttestationSchema.parse(await (await post(app)).json())

    expect(base58.decode(body.message)).toEqual(
      serializeLimitAttestation(
        limitAttestationSchema.parse({
          operator: body.wallet,
          limitBaseUnits: body.limitBaseUnits,
          computedAt: body.computedAt,
          expiresAt: body.expiresAt,
          nonce: body.nonce,
        }),
      ),
    )
  })

  it('records every issued attestation in the journal', async () => {
    const { app, issued } = routes()

    const body = issuedAttestationSchema.parse(await (await post(app)).json())

    expect(issued).toHaveLength(1)
    expect(issued[0]?.draft).toMatchObject({
      wallet: WALLET,
      limitUsd: 4_000_000n,
      attestor: ATTESTOR,
    })
    expect(issued[0]?.nonce.toString()).toBe(body.nonce)
  })

  it('gives a second attestation its own nonce', async () => {
    const { app } = routes()

    const first = issuedAttestationSchema.parse(await (await post(app)).json())
    const second = issuedAttestationSchema.parse(await (await post(app)).json())

    expect([first.nonce, second.nonce]).toEqual(['1', '2'])
    expect(second.signature).not.toBe(first.signature)
  })

  it('refuses a wallet that has no limit on any network', async () => {
    const { app, issued } = routes({ profiles: [profile({ limitUsd: null })] })

    const response = await post(app)

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({
      error: { code: 'NOT_FOUND', message: 'no credit limit to attest' },
    })
    expect(issued).toEqual([])
  })

  // Атестація не підписується з простроченого профілю: строк ліміту (FR-007) —
  // це і строк права його атестувати.
  it('recomputes an expired limit before signing it', async () => {
    const { app, asked, written } = routes({
      profiles: [profile({ expiresAt: new Date(NOW.getTime() - 1_000) })],
    })

    const response = await post(app)

    expect(asked).toHaveLength(1)
    expect(written).toHaveLength(1)
    // Перерахунок на порожній історії лишає гаманець без ліміту — і тоді
    // атестувати нема чого, а не «атестувати старе».
    expect(response.status).toBe(404)
  })

  it('rejects a path that is not a wallet address', async () => {
    const { app } = routes()

    expect((await post(app, 'not-a-wallet' as SolanaAddress)).status).toBe(400)
  })
})

describe('resolveAttestor', () => {
  it('accepts the public key derived from the secret', async () => {
    const attestor = await resolveAttestor({
      secretKey: base58.encode(SECRET_KEY),
      publicKey: base58.encode(PUBLIC_KEY),
    })

    expect(attestor.address).toBe(ATTESTOR)
    expect(attestor.secretKey).toEqual(SECRET_KEY)
  })

  // Розходження пари видно лише в мить видачі кредиту, тобто найдорожче.
  it('refuses a public key that is not the one behind the secret', async () => {
    const other = base58.encode(hex.decode(`00${hex.encode(PUBLIC_KEY).slice(2)}`))

    await expect(
      resolveAttestor({ secretKey: base58.encode(SECRET_KEY), publicKey: other }),
    ).rejects.toThrow(/ATTESTOR_PUBLIC_KEY/)
  })

  it('names the variable, not the key, when the secret is the wrong length', async () => {
    const short = base58.encode(SECRET_KEY.slice(0, 31))

    await expect(
      resolveAttestor({ secretKey: short, publicKey: base58.encode(PUBLIC_KEY) }),
    ).rejects.toThrow(/^ATTESTOR_SECRET_KEY is not a 32-byte ed25519 seed$/)
  })
})

const databaseUrl = (): string | undefined => {
  try {
    const file = readFileSync(
      path.join(import.meta.dirname, '..', '..', '..', '..', '.env'),
      'utf8',
    )
    return file
      .split(/\r?\n/)
      .find((line) => line.startsWith('DATABASE_URL='))
      ?.slice('DATABASE_URL='.length)
  } catch {
    return undefined
  }
}

const url = databaseUrl()

describe.skipIf(url === undefined)('createDbAttestationJournal against a live postgres', () => {
  let db: Database
  let close: () => Promise<void>

  const draft: AttestationDraft = {
    wallet: WALLET,
    limitUsd: 4_000_000n,
    attestor: ATTESTOR,
    computedAt: new Date(NOW.getTime() - 3_600_000),
    expiresAt: new Date(NOW.getTime() + ATTESTATION_TTL_MS),
  }

  const sign = async (nonce: bigint): Promise<SignedLimitAttestation> => ({
    message: serializeLimitAttestation(
      limitAttestationSchema.parse({
        operator: draft.wallet,
        limitBaseUnits: draft.limitUsd,
        computedAt: draft.computedAt,
        expiresAt: draft.expiresAt,
        nonce,
      }),
    ),
    signature: new Uint8Array(64).fill(Number(nonce % 256n)),
  })

  const wipe = async () => {
    await db.delete(attestations).where(eq(attestations.wallet, WALLET))
  }

  beforeAll(async () => {
    const handle = createDatabase(url ?? '')
    db = handle.db
    close = handle.close
    await wipe()
  })

  afterAll(async () => {
    await wipe()
    await close()
  })

  it('numbers the first attestation of a wallet one', async () => {
    await wipe()

    expect((await createDbAttestationJournal(db).issue(draft, sign)).nonce).toBe(1n)
  })

  it('stores the attestation exactly as it was signed', async () => {
    await wipe()
    const { nonce, signed } = await createDbAttestationJournal(db).issue(draft, sign)

    const [row] = await db.select().from(attestations).where(eq(attestations.wallet, WALLET))

    expect(row).toMatchObject({
      wallet: WALLET,
      nonce,
      limitUsd: formatUsd(draft.limitUsd),
      attestor: ATTESTOR,
      signature: base58.encode(signed.signature),
      computedAt: draft.computedAt,
      expiresAt: draft.expiresAt,
      consumedAt: null,
    })
  })

  // Нонс ловиться ончейн бітовою маскою (T037), тож послідовність має бути
  // щільною, а два одночасні запити не сміють отримати той самий номер.
  it('gives two attestations asked for at once two different nonces', async () => {
    await wipe()
    const journal = createDbAttestationJournal(db)

    const issued = await Promise.all([journal.issue(draft, sign), journal.issue(draft, sign)])

    expect(issued.map(({ nonce }) => nonce).sort()).toEqual([1n, 2n])
  })
})
