import pino, { type DestinationStream, type Logger } from 'pino'

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const

export type LogLevel = (typeof LOG_LEVELS)[number]

export type LoggerOptions = {
  service: string
  level?: LogLevel
  destination?: DestinationStream
}

// Секрети губляться саме так: не окремим `log.info(secretKey)`, а полем усередині
// об'єкта, який хтось залогував цілком — конфіг на старті, тіло запиту, `cause`
// помилки. Тому список імен, а не дисципліна на місці виклику.
const REDACTED_KEYS = [
  'attestorSecretKey',
  'ATTESTOR_SECRET_KEY',
  'keeperSecretKey',
  'KEEPER_SECRET_KEY',
  'secretKey',
  'privateKey',
  'databaseUrl',
  'DATABASE_URL',
  'priceApiKey',
  'PRICE_API_KEY',
  'mainnetRpcUrl',
  'MAINNET_RPC_URL',
  'devnetRpcUrl',
  'DEVNET_RPC_URL',
  'authorization',
]

const redactPaths = REDACTED_KEYS.flatMap((key) => [key, `*.${key}`])

export function createLogger({ service, level = 'info', destination }: LoggerOptions): Logger {
  const options = {
    level,
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label: string) => ({ level: label }) },
    redact: { paths: redactPaths, censor: '[redacted]' },
  }

  return destination === undefined ? pino(options) : pino(options, destination)
}
