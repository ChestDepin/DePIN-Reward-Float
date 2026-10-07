import { z } from 'zod'
import { solanaAddressSchema } from '../schemas/primitives.ts'
import { MANUAL_REPAYMENT_REASONS } from './credit-limit.ts'
import { wholeNumberSchema } from './payout-history.ts'

const bpsSchema = z.number().int().nonnegative()
const momentSchema = z.iso.datetime({ offset: true })

// One Swept event: one loan's share of one sweep. Token amounts in the reward mint's base
// units, stablecoin amounts in its base units, the rate as signed (`stablePerTrillionReward`).
export const withheldEntrySchema = z.object({
  kind: z.literal('withheld'),
  signature: z.string(),
  blockTime: momentSchema,
  loan: solanaAddressSchema,
  rewardMint: solanaAddressSchema,
  withheld: wholeNumberSchema,
  paid: wholeNumberSchema,
  stablePerTrillionReward: wholeNumberSchema,
  // Of the whole sweep, not of this loan's share: the program checks it once.
  deviationBps: bpsSchema,
  remainingDebt: wholeNumberSchema,
})

// SweepSkipped events in a row on one mint, with no withholding between them, are one
// entry: the keeper sends one every two minutes while the market stays outside the
// tolerance, and each says the same thing. The rate and the deviation are the latest.
export const skippedEntrySchema = z.object({
  kind: z.literal('skipped'),
  signature: z.string(),
  rewardMint: solanaAddressSchema,
  attempts: z.number().int().positive(),
  firstAt: momentSchema,
  lastAt: momentSchema,
  attempted: wholeNumberSchema,
  stablePerTrillionReward: wholeNumberSchema,
  deviationBps: bpsSchema,
  worstDeviationBps: bpsSchema,
  maxSlippageBps: bpsSchema,
})

// One ManualRepaymentNeeded event: the sweep that stopped repaying the loan, and the
// reward tokens owed to it then, in the reward mint's base units.
export const manualRepaymentEntrySchema = z.object({
  kind: z.literal('manual-repayment'),
  signature: z.string(),
  blockTime: momentSchema,
  loan: solanaAddressSchema,
  rewardMint: solanaAddressSchema,
  reason: z.enum(MANUAL_REPAYMENT_REASONS),
  rewardDue: wholeNumberSchema,
})

export const withholdingEntrySchema = z.discriminatedUnion('kind', [
  withheldEntrySchema,
  skippedEntrySchema,
  manualRepaymentEntrySchema,
])

export type WithholdingEntry = z.infer<typeof withholdingEntrySchema>

export const withholdingsSchema = z.object({
  operator: solanaAddressSchema,
  // Newest first.
  entries: z.array(withholdingEntrySchema),
  // false: older events exist than were read, and the oldest skipped entry may count fewer
  // attempts than there were.
  complete: z.boolean(),
})

export type Withholdings = z.infer<typeof withholdingsSchema>
