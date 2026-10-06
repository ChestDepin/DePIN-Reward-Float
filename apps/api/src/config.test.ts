import { describe, expect, it } from 'vitest'
import { parseApiConfig } from './config.ts'

const SECRET =
  '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy5SMBHrfNPnRgFUJb1jGgWgWmqbUvJH2tGnzXLBRLQeVKcvS7yTdHzs'
const PUBLIC = '7ykbVJHDcHVzXXn9Bd5MNRLpqHt4gPvVsHkTBQMJqTL6'

const validEnv = {
  DATABASE_URL: 'postgres://user:password@db.example.com:5432/depin_reward_float',
  ATTESTOR_SECRET_KEY: SECRET,
  ATTESTOR_PUBLIC_KEY: PUBLIC,
  PORT: '9001',
  LOG_LEVEL: 'debug',
  WEB_ORIGIN: 'https://app.example.com',
}

describe('parseApiConfig', () => {
  it('reads a full environment', () => {
    expect(parseApiConfig(validEnv)).toEqual({
      port: 9001,
      logLevel: 'debug',
      databaseUrl: 'postgres://user:password@db.example.com:5432/depin_reward_float',
      attestorSecretKey: SECRET,
      attestorPublicKey: PUBLIC,
      webOrigins: ['https://app.example.com'],
      rates: null,
      keeper: null,
      sweepJournal: null,
    })
  })

  it('lets more than one page read the api, separated by commas', () => {
    const config = parseApiConfig({
      ...validEnv,
      WEB_ORIGIN: 'https://app.example.com, http://localhost:5173',
    })

    expect(config.webOrigins).toEqual(['https://app.example.com', 'http://localhost:5173'])
  })

  // Порожній перелік означав би «жодна сторінка не може читати», тобто api,
  // до якого не достукатись із браузера взагалі.
  it('refuses an empty list of web origins', () => {
    expect(() => parseApiConfig({ ...validEnv, WEB_ORIGIN: ' , ' })).toThrow(/WEB_ORIGIN/)
  })

  it('falls back to port 8787 and info logging', () => {
    const config = parseApiConfig({
      DATABASE_URL: validEnv.DATABASE_URL,
      ATTESTOR_SECRET_KEY: SECRET,
      ATTESTOR_PUBLIC_KEY: PUBLIC,
    })

    expect(config.port).toBe(8787)
    expect(config.logLevel).toBe('info')
    expect(config.webOrigins).toEqual(['http://localhost:5173'])
  })

  it('accepts the postgresql:// scheme', () => {
    const config = parseApiConfig({ ...validEnv, DATABASE_URL: 'postgresql://u:p@h:5432/d' })

    expect(config.databaseUrl).toBe('postgresql://u:p@h:5432/d')
  })

  it('names every missing variable at once', () => {
    expect(() => parseApiConfig({})).toThrow(
      /DATABASE_URL[\s\S]*ATTESTOR_SECRET_KEY[\s\S]*ATTESTOR_PUBLIC_KEY/,
    )
  })

  it('rejects the .env.example placeholder left in place', () => {
    expect(() => parseApiConfig({ ...validEnv, ATTESTOR_SECRET_KEY: 'REPLACE_ME' })).toThrow(
      /ATTESTOR_SECRET_KEY/,
    )
  })

  it('never puts a value into the error, so the attestor key cannot leak into logs', () => {
    const brokenSecret = `${SECRET}0`

    try {
      parseApiConfig({ ...validEnv, ATTESTOR_SECRET_KEY: brokenSecret })
      expect.unreachable('config with a malformed attestor key must throw')
    } catch (error) {
      expect(String(error)).not.toContain(SECRET)
      expect(String(error)).toContain('ATTESTOR_SECRET_KEY')
    }
  })

  it('rejects a non-postgres database url', () => {
    expect(() => parseApiConfig({ ...validEnv, DATABASE_URL: 'mysql://u:p@h:3306/d' })).toThrow(
      /DATABASE_URL/,
    )
  })

  it('rejects a port that is not a number', () => {
    expect(() => parseApiConfig({ ...validEnv, PORT: 'eight' })).toThrow(/PORT/)
  })

  it('rejects a port outside the tcp range', () => {
    expect(() => parseApiConfig({ ...validEnv, PORT: '70000' })).toThrow(/PORT/)
  })

  it('rejects an unknown log level', () => {
    expect(() => parseApiConfig({ ...validEnv, LOG_LEVEL: 'chatty' })).toThrow(/LOG_LEVEL/)
  })
})

describe('parseApiConfig: rates', () => {
  const DEVNET_HONEY = '5pbCV2sjzLPiYoY48ic1kmS5juTpjeN27ProW6v3QFS'
  const MAINNET_RPC_URL = 'https://mainnet.helius-rpc.com/?api-key=live-key'
  const rateEnv = {
    JUPITER_API_KEY: 'jup-key',
    MAINNET_RPC_URL,
    REWARD_MINTS: `hivemapper:${DEVNET_HONEY}`,
  }

  it('reads the price source and the devnet stand-ins it prices', () => {
    const { rates } = parseApiConfig({ ...validEnv, ...rateEnv })

    expect(rates?.jupiterApiKey).toBe('jup-key')
    expect(rates?.mainnetRpcUrl).toBe(MAINNET_RPC_URL)
    expect(rates?.rewardMints.get('hivemapper')).toBe(DEVNET_HONEY)
  })

  // Render hands a variable that was never set as nothing, an .env line left as
  // `NAME=` as "": both mean the api runs without rates, as the web runs without lending.
  it('runs without rates when none of their variables is set', () => {
    expect(parseApiConfig(validEnv).rates).toBeNull()
    expect(
      parseApiConfig({ ...validEnv, JUPITER_API_KEY: '', MAINNET_RPC_URL: '', REWARD_MINTS: '' })
        .rates,
    ).toBeNull()
  })

  it('refuses half a rate config and names what is missing', () => {
    expect(() => parseApiConfig({ ...validEnv, JUPITER_API_KEY: 'jup-key' })).toThrow(
      /MAINNET_RPC_URL[\s\S]*REWARD_MINTS/,
    )
  })

  it('refuses a malformed list of stand-ins', () => {
    expect(() =>
      parseApiConfig({ ...validEnv, ...rateEnv, REWARD_MINTS: `hivemapper=${DEVNET_HONEY}` }),
    ).toThrow(/REWARD_MINTS/)
  })

  it('never puts the key-bearing RPC url into the error', () => {
    try {
      parseApiConfig({ ...validEnv, ...rateEnv, MAINNET_RPC_URL: 'ftp://live-key@host' })
      expect.unreachable('a non-http RPC url must throw')
    } catch (error) {
      expect(String(error)).not.toContain('live-key')
      expect(String(error)).toContain('MAINNET_RPC_URL')
    }
  })
})

describe('parseApiConfig: sweep journal', () => {
  const DEVNET_RPC_URL = 'https://devnet.helius-rpc.com/?api-key=live-key'

  // The journal only reads the chain: it needs no key and no rates, and a sweep sent by
  // anyone, keeper or not, belongs in it.
  it('reads devnet whenever the devnet RPC is set, with or without a keeper', () => {
    expect(parseApiConfig({ ...validEnv, DEVNET_RPC_URL }).sweepJournal).toEqual({
      devnetRpcUrl: DEVNET_RPC_URL,
    })
  })

  it('runs no journal without the devnet RPC', () => {
    expect(parseApiConfig({ ...validEnv, DEVNET_RPC_URL: '' }).sweepJournal).toBeNull()
  })
})

describe('parseApiConfig: keeper', () => {
  // A 32-byte ed25519 seed, the same form as the attestor's.
  const KEEPER_SEED = 'US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx'
  const DEVNET_RPC_URL = 'https://devnet.helius-rpc.com/?api-key=live-key'
  const STABLE_MINT = '9nScQZ7Jq3jvTDNhmS8hJ9ZpCXDQjwW4NHo3x6dU6uZs'
  const rateEnv = {
    JUPITER_API_KEY: 'jup-key',
    MAINNET_RPC_URL: 'https://mainnet.helius-rpc.com/?api-key=other-key',
    REWARD_MINTS: 'hivemapper:5pbCV2sjzLPiYoY48ic1kmS5juTpjeN27ProW6v3QFS',
  }
  const keeperEnv = { KEEPER_SECRET_KEY: KEEPER_SEED, DEVNET_RPC_URL, STABLE_MINT }

  it('reads the fee payer seed, the devnet RPC and the pool’s stablecoin', () => {
    const { keeper } = parseApiConfig({ ...validEnv, ...rateEnv, ...keeperEnv })

    expect(keeper?.secretKey).toEqual(new Uint8Array(32).fill(7))
    expect(keeper?.devnetRpcUrl).toBe(DEVNET_RPC_URL)
    expect(keeper?.stableMint).toBe(STABLE_MINT)
  })

  // The seed scripts read DEVNET_RPC_URL and STABLE_MINT from the same .env: their
  // presence alone must not start a keeper, only its key does.
  it('runs no keeper without its key, whatever else is set', () => {
    expect(parseApiConfig({ ...validEnv, DEVNET_RPC_URL, STABLE_MINT }).keeper).toBeNull()
    expect(parseApiConfig({ ...validEnv, ...keeperEnv, KEEPER_SECRET_KEY: '' }).keeper).toBeNull()
  })

  it('refuses a keeper key without the devnet RPC and the stablecoin, naming both', () => {
    expect(() =>
      parseApiConfig({ ...validEnv, ...rateEnv, KEEPER_SECRET_KEY: KEEPER_SEED }),
    ).toThrow(/DEVNET_RPC_URL[\s\S]*STABLE_MINT/)
  })

  // Every sweep needs a signed rate, and the rate route is what signs it.
  it('refuses a keeper without rates', () => {
    expect(() => parseApiConfig({ ...validEnv, ...keeperEnv })).toThrow(/KEEPER_SECRET_KEY/)
  })

  it('refuses a key that is not a 32-byte seed, and never prints it', () => {
    const short = '7DUeBUtEcb7nujVZRJmeBju3X1mo6PpnWNtJ9EBhdY'
    try {
      parseApiConfig({ ...validEnv, ...rateEnv, ...keeperEnv, KEEPER_SECRET_KEY: short })
      expect.unreachable('a 31-byte key must throw')
    } catch (error) {
      expect(String(error)).toContain('KEEPER_SECRET_KEY')
      expect(String(error)).not.toContain(short)
    }
  })

  it('never puts the key-bearing devnet RPC url into the error', () => {
    try {
      parseApiConfig({
        ...validEnv,
        ...rateEnv,
        ...keeperEnv,
        DEVNET_RPC_URL: 'ftp://live-key@host',
      })
      expect.unreachable('a non-http RPC url must throw')
    } catch (error) {
      expect(String(error)).not.toContain('live-key')
      expect(String(error)).toContain('DEVNET_RPC_URL')
    }
  })
})
