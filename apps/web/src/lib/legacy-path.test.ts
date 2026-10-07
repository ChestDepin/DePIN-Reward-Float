import { describe, expect, it } from 'vitest'
import { legacyAppPath } from './legacy-path'

const base = '/DePIN-Reward-Float/app/'

describe('legacyAppPath', () => {
  it('moves a link shared before the terminal moved under /app/', () => {
    expect(
      legacyAppPath('/DePIN-Reward-Float/limit/CrWs8KVNWeFNuGwXmtbukEFJSAKg19gBpwYgjLrfpzET', base),
    ).toBe('/DePIN-Reward-Float/app/limit/CrWs8KVNWeFNuGwXmtbukEFJSAKg19gBpwYgjLrfpzET')
    expect(legacyAppPath('/DePIN-Reward-Float/lookup', base)).toBe('/DePIN-Reward-Float/app/lookup')
  })

  it('leaves a path already inside the app alone', () => {
    expect(legacyAppPath('/DePIN-Reward-Float/app/', base)).toBeNull()
    expect(legacyAppPath('/DePIN-Reward-Float/app', base)).toBeNull()
    expect(legacyAppPath('/DePIN-Reward-Float/app/position/x', base)).toBeNull()
  })

  it('does not mistake a route that only starts with "app" for the app itself', () => {
    expect(legacyAppPath('/DePIN-Reward-Float/apple', base)).toBe('/DePIN-Reward-Float/app/apple')
  })

  it('does nothing when the app is not under /app/, as in dev', () => {
    expect(legacyAppPath('/limit/x', '/')).toBeNull()
    expect(legacyAppPath('/DePIN-Reward-Float/limit/x', '/DePIN-Reward-Float/')).toBeNull()
  })

  it('does nothing for a path outside the site', () => {
    expect(legacyAppPath('/other-repo/limit/x', base)).toBeNull()
  })
})
