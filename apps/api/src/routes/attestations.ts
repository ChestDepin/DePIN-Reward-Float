import { attestations, type Database } from '@drf/db'
import type { IssuedAttestation } from '@drf/shared/api'
import {
  limitAttestationSchema,
  type SignedLimitAttestation,
  signLimitAttestation,
} from '@drf/shared/attestation'
import { type SolanaAddress, solanaAddressSchema } from '@drf/shared/schemas'
import { formatUsd } from '@drf/shared/scoring'
import { getPublicKeyAsync } from '@noble/ed25519'
import { base58 } from '@scure/base'
import { desc, eq, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { errorBody, walletParam } from './errors.ts'
import { type CreditProfileStore, createProfileReader, type StoredCreditProfile } from './limit.ts'
import type { PayoutHistorySource } from './operators.ts'

// Атестація живе рівно стільки, скільки треба, щоб підписати нею одну видачу:
// вкрадений підпис лишається зброєю весь свій строк, а SC-004 дає на видачу 5 с.
export const ATTESTATION_TTL_MS = 5 * 60_000

const SECRET_KEY_BYTES = 32

export type Attestor = {
  secretKey: Uint8Array
  address: SolanaAddress
}

export type AttestedLimit = {
  // Мікродолари, як `credit_profiles.limit_usd`. Стейблкоїн протоколу має ті самі
  // 6 знаків, тож у мінімальні одиниці це число переходить один до одного.
  limitUsd: bigint
  computedAt: Date
  expiresAt: Date
}

export type AttestationDraft = AttestedLimit & {
  wallet: SolanaAddress
  attestor: SolanaAddress
}

export type AttestationJournal = {
  // Підпис береться callback'ом, бо нонс входить у підписані байти, а видати
  // його може тільки той, хто в ту саму мить записує рядок у журнал.
  issue(
    draft: AttestationDraft,
    sign: (nonce: bigint) => Promise<SignedLimitAttestation>,
  ): Promise<{ nonce: bigint; signed: SignedLimitAttestation }>
}

function earliest(moments: readonly Date[]): Date {
  return moments.reduce((left, right) => (left < right ? left : right))
}

export function attestedLimit(
  profiles: readonly StoredCreditProfile[],
  now: Date,
): AttestedLimit | null {
  // Мережі складаються, бо борг в оператора один і гаситься обома потоками
  // (FR-012). Мережа без ліміту не вносить нуль — вона не вносить нічого.
  const counted = profiles.flatMap((profile) =>
    profile.limitUsd === null
      ? []
      : [
          {
            limitUsd: profile.limitUsd,
            computedAt: profile.computedAt,
            expiresAt: profile.expiresAt,
          },
        ],
  )

  if (counted.length === 0) return null

  return {
    limitUsd: counted.reduce((sum, profile) => sum + profile.limitUsd, 0n),
    computedAt: earliest(counted.map((profile) => profile.computedAt)),
    expiresAt: earliest([
      new Date(now.getTime() + ATTESTATION_TTL_MS),
      ...counted.map((profile) => profile.expiresAt),
    ]),
  }
}

export async function resolveAttestor(input: {
  secretKey: string
  publicKey: string
}): Promise<Attestor> {
  const secretKey = base58.decode(input.secretKey)
  if (secretKey.length !== SECRET_KEY_BYTES) {
    throw new Error('ATTESTOR_SECRET_KEY is not a 32-byte ed25519 seed')
  }

  const address = solanaAddressSchema.parse(input.publicKey)
  // Розходження пари інакше виявилося б аж ончейн, у мить видачі кредиту:
  // програма звіряє підпис із ключем зі свого стану, а не з нашим конфігом.
  if (base58.encode(await getPublicKeyAsync(secretKey)) !== address) {
    throw new Error('ATTESTOR_PUBLIC_KEY is not the key derived from ATTESTOR_SECRET_KEY')
  }

  return { secretKey, address }
}

export function createDbAttestationJournal(db: Database): AttestationJournal {
  return {
    issue(draft, sign) {
      return db.transaction(async (tx) => {
        // Нонс щільний і на гаманець, бо ончейн повтор ловиться бітовою маскою
        // (T037). Без блокування два одночасні запити прочитали б той самий
        // максимум і пішли б підписувати однаковий номер.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${draft.wallet}::text, 0))`,
        )

        const [last] = await tx
          .select({ nonce: attestations.nonce })
          .from(attestations)
          .where(eq(attestations.wallet, draft.wallet))
          .orderBy(desc(attestations.nonce))
          .limit(1)

        const nonce = (last?.nonce ?? 0n) + 1n
        const signed = await sign(nonce)

        await tx.insert(attestations).values({
          wallet: draft.wallet,
          nonce,
          limitUsd: formatUsd(draft.limitUsd),
          attestor: draft.attestor,
          signature: base58.encode(signed.signature),
          computedAt: draft.computedAt,
          expiresAt: draft.expiresAt,
        })

        return { nonce, signed }
      })
    },
  }
}

export type AttestationRoutesDeps = {
  payouts: PayoutHistorySource
  profiles: CreditProfileStore
  journal: AttestationJournal
  attestor: Attestor
  now: () => Date
}

export function createAttestationRoutes({
  payouts,
  profiles,
  journal,
  attestor,
  now,
}: AttestationRoutesDeps): Hono {
  const routes = new Hono()
  const readProfiles = createProfileReader({ payouts, profiles })

  routes.post('/operators/:address/attestations/limit', walletParam, async (c) => {
    const { address } = c.req.valid('param')
    const at = now()

    // Строк ліміту — це і строк права його атестувати: прострочений профіль
    // перераховується, а не підписується таким, як лежав.
    const attested = attestedLimit(await readProfiles(address, at, false), at)
    if (attested === null) {
      return c.json(errorBody('NOT_FOUND', 'no credit limit to attest'), 404)
    }

    const { nonce, signed } = await journal.issue(
      { wallet: address, attestor: attestor.address, ...attested },
      (issuedNonce) =>
        signLimitAttestation(
          limitAttestationSchema.parse({
            operator: address,
            limitBaseUnits: attested.limitUsd,
            computedAt: attested.computedAt,
            expiresAt: attested.expiresAt,
            nonce: issuedNonce,
          }),
          attestor.secretKey,
        ),
    )

    const body: IssuedAttestation = {
      wallet: address,
      nonce: nonce.toString(),
      limitBaseUnits: attested.limitUsd.toString(),
      attestor: attestor.address,
      message: base58.encode(signed.message),
      signature: base58.encode(signed.signature),
      computedAt: attested.computedAt.toISOString(),
      expiresAt: attested.expiresAt.toISOString(),
    }

    return c.json(body, 201)
  })

  return routes
}
