import { creditProfiles, type Database, networks as networksTable } from '@drf/db'
import {
  type CreditLimit,
  type LimitRefusal,
  limitFactorSchema,
  limitRefusalSchema,
} from '@drf/shared/api'
import { type RewardNetwork, rewardNetworkSchema, type SolanaAddress } from '@drf/shared/schemas'
import {
  aggregateMonthlyPayouts,
  assessEligibility,
  calendarMonthSchema,
  computeCreditLimit,
  explainLimit,
  formatUsd,
  type LimitFactor,
  type MonthRange,
  type PriceSeries,
  REQUIRED_PAID_MONTHS,
  recentPriceWindow,
  toCalendarMonth,
  usdAmountSchema,
} from '@drf/shared/scoring'
import { asc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { reading, walletParam } from './errors.ts'
import { historyPeriod, type PayoutHistorySource, type StoredHistory } from './operators.ts'

// FR-007: показане значення не старше за 24 години.
export const LIMIT_TTL_HOURS = 24

const TTL_MS = LIMIT_TTL_HOURS * 3_600_000

export type StoredCreditProfile = {
  network: RewardNetwork
  // Мікродолари. null — ліміт не порахований, і причина каже, чому саме.
  limitUsd: bigint | null
  factors: readonly LimitFactor[]
  reason: LimitRefusal | null
  computedAt: Date
  expiresAt: Date
}

export type CreditProfileStore = {
  read(wallet: SolanaAddress): Promise<readonly StoredCreditProfile[]>
  write(wallet: SolanaAddress, profiles: readonly StoredCreditProfile[]): Promise<void>
}

function refuse(reason: LimitRefusal, network: RewardNetwork, now: Date): StoredCreditProfile {
  return {
    network,
    limitUsd: null,
    factors: [],
    reason,
    computedAt: now,
    expiresAt: new Date(now.getTime() + TTL_MS),
  }
}

export function computeProfiles(input: {
  stored: StoredHistory
  period: MonthRange
  now: Date
}): StoredCreditProfile[] {
  const { stored, period, now } = input

  return [...stored.networks]
    .sort((left, right) => (left.id < right.id ? -1 : 1))
    .map((network) => {
      const prices: PriceSeries = stored.prices.get(network.token.mint) ?? new Map()
      const months = aggregateMonthlyPayouts({
        payouts: stored.payouts.filter((payout) => payout.networkId === network.id),
        network,
        prices,
        period,
      })

      const eligibility = assessEligibility({ months, cadence: network.payoutCadence })
      if (eligibility.kind === 'withdrawal-history') {
        return refuse({ kind: 'withdrawal-history', cadence: eligibility.cadence }, network, now)
      }

      if (eligibility.kind === 'short-history') {
        return refuse(
          {
            kind: 'short-history',
            requiredMonths: REQUIRED_PAID_MONTHS,
            thresholdReachedIn: eligibility.thresholdReachedIn,
          },
          network,
          now,
        )
      }

      const outcome = computeCreditLimit({ months, prices, decimals: network.token.decimals })
      if (outcome.kind === 'no-recent-price') {
        return refuse({ kind: 'no-recent-price', window: outcome.window }, network, now)
      }

      return {
        network,
        limitUsd: outcome.limitUsd,
        factors: explainLimit(outcome),
        reason: null,
        computedAt: now,
        expiresAt: new Date(now.getTime() + TTL_MS),
      }
    })
}

export function buildCreditLimit(input: {
  wallet: SolanaAddress
  profiles: readonly StoredCreditProfile[]
}): CreditLimit {
  return {
    wallet: input.wallet,
    networks: input.profiles.map((profile) => ({
      networkId: profile.network.id,
      displayName: profile.network.displayName,
      token: {
        symbol: profile.network.token.symbol,
        decimals: profile.network.token.decimals,
      },
      limitUsd: profile.limitUsd === null ? null : profile.limitUsd.toString(),
      factors: profile.factors.map((factor) => ({
        name: factor.name,
        deltaUsd: factor.deltaUsd.toString(),
      })),
      reason: profile.reason,
      computedAt: profile.computedAt.toISOString(),
      expiresAt: profile.expiresAt.toISOString(),
    })),
  }
}

const REFUSAL_KINDS = ['short-history', 'withdrawal-history', 'no-recent-price'] as const

const storedReasonSchema = z.enum(REFUSAL_KINDS).nullable()

const storedFactorsSchema = z.array(limitFactorSchema).nullable()

function statusOf(profile: StoredCreditProfile) {
  if (profile.limitUsd !== null) return 'available' as const

  return profile.reason?.kind === 'no-recent-price'
    ? ('no_recent_price' as const)
    : ('ineligible' as const)
}

// Причина зберігається видом, а решта її полів — колонками, які вже є: місяць
// порогу в `eligible_at`, каденція в самій мережі, вікно цін виводиться з
// моменту розрахунку. Тому назад вона збирається, а не читається одним полем.
function readRefusal(input: {
  reason: string | null
  eligibleAt: string | null
  computedAt: Date
  network: RewardNetwork
}): LimitRefusal | null {
  const kind = storedReasonSchema.parse(input.reason)
  if (kind === null) return null

  if (kind === 'short-history') {
    return limitRefusalSchema.parse({
      kind,
      requiredMonths: REQUIRED_PAID_MONTHS,
      thresholdReachedIn: calendarMonthSchema.parse(input.eligibleAt?.slice(0, 7)),
    })
  }

  if (kind === 'withdrawal-history') {
    return limitRefusalSchema.parse({ kind, cadence: input.network.payoutCadence })
  }

  return limitRefusalSchema.parse({
    kind,
    window: recentPriceWindow(toCalendarMonth(input.computedAt)),
  })
}

export function createDbCreditProfileStore(db: Database): CreditProfileStore {
  return {
    async read(wallet) {
      const rows = await reading(
        'the stored credit profiles',
        db
          .select({ profile: creditProfiles, network: networksTable })
          .from(creditProfiles)
          .innerJoin(networksTable, eq(creditProfiles.networkId, networksTable.id))
          .where(eq(creditProfiles.wallet, wallet))
          .orderBy(asc(creditProfiles.networkId)),
      )

      return rows.map(({ profile, network: row }) => {
        // Мережа приходить із таблиці як дані і перевіряється тією ж схемою, що
        // й конфіг — так само, як у `GET /payouts`.
        const network = rewardNetworkSchema.parse({
          id: row.id,
          displayName: row.displayName,
          token: { mint: row.tokenMint, symbol: row.tokenSymbol, decimals: row.tokenDecimals },
          payoutSources: row.payoutSources,
          payoutCadence: row.payoutCadence,
        })

        return {
          network,
          limitUsd: profile.limitUsd === null ? null : usdAmountSchema.parse(profile.limitUsd),
          factors: (storedFactorsSchema.parse(profile.factors) ?? []).map((factor) => ({
            name: factor.name,
            deltaUsd: BigInt(factor.deltaUsd),
          })),
          reason: readRefusal({
            reason: profile.reason,
            eligibleAt: profile.eligibleAt,
            computedAt: profile.computedAt,
            network,
          }),
          computedAt: profile.computedAt,
          expiresAt: profile.expiresAt,
        }
      })
    },

    async write(wallet, profiles) {
      await db.transaction(async (tx) => {
        for (const profile of profiles) {
          const values = {
            wallet,
            networkId: profile.network.id,
            status: statusOf(profile),
            limitUsd: profile.limitUsd === null ? null : formatUsd(profile.limitUsd),
            factors: profile.factors.map((factor) => ({
              name: factor.name,
              deltaUsd: factor.deltaUsd.toString(),
            })),
            reason: profile.reason?.kind ?? null,
            eligibleAt:
              profile.reason?.kind === 'short-history'
                ? `${profile.reason.thresholdReachedIn}-01`
                : null,
            computedAt: profile.computedAt,
            expiresAt: profile.expiresAt,
          }

          await tx
            .insert(creditProfiles)
            .values(values)
            .onConflictDoUpdate({
              target: [creditProfiles.wallet, creditProfiles.networkId],
              set: values,
            })
        }
      })
    },
  }
}

export type ProfileReader = (
  wallet: SolanaAddress,
  at: Date,
  refresh: boolean,
) => Promise<readonly StoredCreditProfile[]>

// Свіжість ліміту — те саме правило і для показу, і для атестації, тож воно
// живе в одному місці: підписувати прострочений профіль не можна так само,
// як і показувати його (FR-007).
export function createProfileReader(deps: {
  payouts: PayoutHistorySource
  profiles: CreditProfileStore
}): ProfileReader {
  const { payouts, profiles } = deps

  return async (wallet, at, refresh) => {
    if (!refresh) {
      const stored = await profiles.read(wallet)
      // Порожній набір — це не свіжий кеш: гаманець, якому ліміт ще не рахували,
      // інакше отримував би «мереж немає» назавжди.
      if (stored.length > 0 && stored.every((profile) => profile.expiresAt > at)) return stored
    }

    const computed = computeProfiles({
      stored: await payouts.read(wallet, historyPeriod(at)),
      period: historyPeriod(at),
      now: at,
    })
    await profiles.write(wallet, computed)

    return computed
  }
}

export type LimitRoutesDeps = {
  payouts: PayoutHistorySource
  profiles: CreditProfileStore
  now: () => Date
}

export function createLimitRoutes({ payouts, profiles, now }: LimitRoutesDeps): Hono {
  const routes = new Hono()
  const current = createProfileReader({ payouts, profiles })

  routes.get('/operators/:address/limit', walletParam, async (c) => {
    const { address } = c.req.valid('param')

    return c.json(
      buildCreditLimit({ wallet: address, profiles: await current(address, now(), false) }),
    )
  })

  // FR-007: перерахунок на вимогу оператора — той самий розрахунок, але без
  // огляду на строк придатності збереженого.
  routes.post('/operators/:address/limit/refresh', walletParam, async (c) => {
    const { address } = c.req.valid('param')

    return c.json(
      buildCreditLimit({ wallet: address, profiles: await current(address, now(), true) }),
    )
  })

  return routes
}
