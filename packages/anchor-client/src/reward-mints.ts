import { solanaAddressSchema } from '@drf/shared/schemas'
import { PublicKey } from '@solana/web3.js'
import { z } from 'zod'

// HONEY and HNT do not exist on devnet: a loan is tied to a devnet stand-in for the
// network's token, listed as network:mint pairs. The seeding script writes this list and
// the web build reads it, so both go through the one format below.
export const rewardMintsSchema = z
  .string()
  .default('')
  .transform((raw, ctx) => {
    const mints = new Map<string, PublicKey>()
    for (const entry of raw.split(',').map((part) => part.trim())) {
      if (entry === '') continue
      const [networkId, mint, ...rest] = entry.split(':')
      const address = solanaAddressSchema.safeParse(mint)
      if (networkId === undefined || networkId === '' || rest.length > 0 || !address.success) {
        ctx.addIssue({ code: 'custom', message: `expected network:mint, got "${entry}"` })
        return z.NEVER
      }
      if (mints.has(networkId)) {
        ctx.addIssue({ code: 'custom', message: `${networkId} has two reward mints` })
        return z.NEVER
      }
      mints.set(networkId, new PublicKey(address.data))
    }
    return mints
  })

export function formatRewardMints(mints: ReadonlyMap<string, PublicKey>): string {
  return [...mints].map(([networkId, mint]) => `${networkId}:${mint.toBase58()}`).join(',')
}
