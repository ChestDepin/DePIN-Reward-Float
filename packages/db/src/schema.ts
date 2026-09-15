import { PAYOUT_CADENCES, type PayoutSource, type SolanaAddress } from '@drf/shared/schemas'
import { sql } from 'drizzle-orm'
import {
  bigint,
  check,
  date,
  index,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
} from 'drizzle-orm/pg-core'

const U64_DIGITS = 20
const USD_SCALE = 6
const PRICE_PRECISION = 38
const PRICE_SCALE = 18

const address = (name: string) => text(name).$type<SolanaAddress>()
const baseUnits = (name: string) =>
  numeric(name, { precision: U64_DIGITS, scale: 0, mode: 'bigint' })
const usd = (name: string) => numeric(name, { precision: U64_DIGITS, scale: USD_SCALE })
const moment = (name: string) => timestamp(name, { withTimezone: true })

export const payoutCadenceEnum = pgEnum('payout_cadence', PAYOUT_CADENCES)

// Стани, у яких профіль може лежати в базі, і тільки вони. «Дані недоступні» —
// стан відповіді, а не рядка: якщо історію не вдалося прочитати, зберігати
// нічого й нема про що. `incomplete_prices` описував стан, якого після T018b не
// існує — його заступив `no_recent_price` (FR-004a).
export const creditProfileStatusEnum = pgEnum('credit_profile_status', [
  'available',
  'ineligible',
  'no_recent_price',
])

export const networks = pgTable('networks', {
  id: text('id').primaryKey(),
  displayName: text('display_name').notNull(),
  tokenMint: address('token_mint').notNull(),
  tokenSymbol: text('token_symbol').notNull(),
  tokenDecimals: smallint('token_decimals').notNull(),
  // Не масив адрес: джерело виплати — пара «вид і адреса», бо винагорода
  // приходить або переказом від розподільника, або емісією авторитета мінта
  // (FR-002), і самої адреси замало, щоб їх розрізнити.
  payoutSources: jsonb('payout_sources').$type<PayoutSource[]>().notNull(),
  payoutCadence: payoutCadenceEnum('payout_cadence').notNull(),
})

export const payouts = pgTable(
  'payouts',
  {
    signature: text('signature').notNull(),
    wallet: address('wallet').notNull(),
    networkId: text('network_id')
      .notNull()
      .references(() => networks.id),
    source: address('source').notNull(),
    amount: baseUnits('amount').notNull(),
    slot: bigint('slot', { mode: 'bigint' }).notNull(),
    blockTime: moment('block_time').notNull(),
    // Null — «ціни за той день ще немає», і воно має лишатись відмінним від нуля:
    // FR-004a забороняє підставляти замість котирування нуль чи останню відому ціну.
    valueUsd: usd('value_usd'),
  },
  (table) => [
    // Сигнатура вже унікальна сама по собі, але ключ разом із гаманцем робить
    // повторний прохід індексатора ідемпотентним без окремої перевірки.
    primaryKey({ columns: [table.signature, table.wallet] }),
    index('payouts_wallet_block_time_idx').on(table.wallet, table.blockTime),
  ],
)

export const pricePoints = pgTable(
  'price_points',
  {
    mint: address('mint').notNull(),
    day: date('day').notNull(),
    priceUsd: numeric('price_usd', { precision: PRICE_PRECISION, scale: PRICE_SCALE }).notNull(),
    source: text('source').notNull(),
    fetchedAt: moment('fetched_at').notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.mint, table.day] })],
)

export const creditProfiles = pgTable(
  'credit_profiles',
  {
    wallet: address('wallet').notNull(),
    // Ліміт рахується на мережу: у HONEY і HNT різні знаки, ціни й волатильність,
    // і одне число на гаманець довелося б або складати з непорівнянних, або
    // мовчки рахувати на одній мережі.
    networkId: text('network_id')
      .notNull()
      .references(() => networks.id),
    status: creditProfileStatusEnum('status').notNull(),
    limitUsd: usd('limit_usd'),
    factors: jsonb('factors'),
    reason: text('reason'),
    eligibleAt: date('eligible_at'),
    computedAt: moment('computed_at').notNull(),
    expiresAt: moment('expires_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.wallet, table.networkId] }),
    // Найдешевший спосіб збрехати оператору — показати нуль там, де насправді
    // не вдалося прочитати дані. Обмеження не дає числу існувати поза станом,
    // у якому воно справді порахувалось (FR-025, FR-004a).
    check(
      'credit_profiles_limit_only_when_available',
      sql`(${table.status} = 'available') = (${table.limitUsd} is not null)`,
    ),
  ],
)

export const attestations = pgTable(
  'attestations',
  {
    wallet: address('wallet').notNull(),
    nonce: baseUnits('nonce').notNull(),
    limitUsd: usd('limit_usd').notNull(),
    // Ключ, яким підписано: після ротації (FR-012c) чинних атестацій від
    // попереднього ключа лишається повний строк дії, і їх треба вміти впізнати.
    attestor: address('attestor').notNull(),
    signature: text('signature').notNull(),
    computedAt: moment('computed_at').notNull(),
    expiresAt: moment('expires_at').notNull(),
    issuedAt: moment('issued_at').notNull().defaultNow(),
    consumedAt: moment('consumed_at'),
  },
  (table) => [primaryKey({ columns: [table.wallet, table.nonce] })],
)

export const indexerCursors = pgTable(
  'indexer_cursors',
  {
    wallet: address('wallet').notNull(),
    // Виплата приходить у токен-акаунт, і акаунти оператора перелічуються
    // різними списками підписів: сигнатура, на якій скінчився один, у списку
    // іншого не буває, тож курсор належить акаунту, а не мережі.
    tokenAccount: address('token_account').notNull(),
    lastSignature: text('last_signature').notNull(),
    lastSlot: bigint('last_slot', { mode: 'bigint' }).notNull(),
    updatedAt: moment('updated_at').notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.wallet, table.tokenAccount] })],
)
