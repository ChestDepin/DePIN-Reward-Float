import { type IssuedRateAttestation, issuedRateAttestationSchema } from '@drf/shared/api'
import type { Hono } from 'hono'

// The keeper lives in this process and takes its rates through the same route a page
// does: same validation, same staleness rule, and the attestor key stays behind it.
export function rateFromApp(app: Hono): (rewardMint: string) => Promise<IssuedRateAttestation> {
  return async (rewardMint) => {
    const response = await app.request('/v1/attestations/rate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rewardMint }),
    })
    if (response.status !== 201) {
      throw new Error(`the rate route answered ${response.status}: ${await response.text()}`)
    }
    return issuedRateAttestationSchema.parse(await response.json())
  }
}
