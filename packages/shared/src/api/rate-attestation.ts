import { z } from 'zod'
import { solanaAddressSchema } from '../schemas/primitives.ts'
import { wholeNumberSchema } from './payout-history.ts'

const base58Schema = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]+$/, 'expected base58')

export const issuedRateAttestationSchema = z.object({
  rewardMint: solanaAddressSchema,
  // The number signed in `message`: stablecoin base units per 10^12 reward base units.
  stablePerTrillionReward: wholeNumberSchema,
  attestor: solanaAddressSchema,
  // The signed bytes themselves, as with the limit: the Ed25519 instruction carries
  // exactly what was signed, and rebuilding them in the page would be a second
  // description of the layout that nothing checks against the first.
  message: base58Schema,
  signature: base58Schema,
  pricedAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }),
})

export type IssuedRateAttestation = z.infer<typeof issuedRateAttestationSchema>
