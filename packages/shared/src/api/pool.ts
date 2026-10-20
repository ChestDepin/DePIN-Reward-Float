import { z } from 'zod'
import { solanaAddressSchema } from '../schemas/primitives.ts'
import { wholeNumberSchema } from './payout-history.ts'

const bpsSchema = z.number().int().nonnegative()

// Stablecoin amounts in its base units. Rates are what the loans already out are fixed
// at, weighted by what each still owes (FR-019), not what the curve would quote today.
export const poolStateSchema = z.object({
  pool: solanaAddressSchema,
  stableMint: solanaAddressSchema,
  // Lenders' money, wherever it sits: in the vault or out in loans.
  totalDeposits: wholeNumberSchema,
  borrowed: wholeNumberSchema,
  free: wholeNumberSchema,
  utilisationBps: bpsSchema,
  // null: no loan is out, so there is no rate to weight.
  loanAprBps: bpsSchema.nullable(),
  // What the open loans earn in a year over the lenders' money: the loan rate times the
  // utilisation.
  lenderAprBps: bpsSchema,
})

export type PoolState = z.infer<typeof poolStateSchema>
