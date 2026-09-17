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
