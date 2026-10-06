import { rewardMintsSchema } from '@drf/anchor-client'
import { type SolanaAddress, solanaAddressSchema } from '@drf/shared/schemas'
import { base58 as base58Codec } from '@scure/base'
import { z } from 'zod'

const base58 = /^[1-9A-HJ-NP-Za-km-z]{32,128}$/

// Сторінка і api живуть на різних походженнях і в розробці, і на проді, тож
// перелік дозволених — конфіг, а не константа. Кома розділяє, бо змінна
// середовища не вміє масивів.
const webOriginsSchema = z
  .string()
  .default('http://localhost:5173')
  .transform((raw) =>
    raw
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin !== ''),
  )
  .pipe(z.array(z.url({ protocol: /^https?$/ })).min(1))

// Render hands a variable that was never set as nothing, an .env line left as `NAME=`
// as "": both mean "not set".
function unsetWhenEmpty<T extends z.ZodType>(schema: T) {
  return z.preprocess((value) => (value === '' ? undefined : value), schema)
}

const RATE_VARIABLES = ['JUPITER_API_KEY', 'MAINNET_RPC_URL', 'REWARD_MINTS'] as const
const KEEPER_SEED_BYTES = 32

function isKeeperSeed(value: string): boolean {
  try {
    return base58Codec.decode(value).length === KEEPER_SEED_BYTES
  } catch {
    return false
  }
}

const apiEnvSchema = z
  .object({
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    ATTESTOR_SECRET_KEY: z.string().regex(base58),
    ATTESTOR_PUBLIC_KEY: z.string().regex(base58),
    PORT: z.coerce.number().int().min(1).max(65535).default(8787),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    WEB_ORIGIN: webOriginsSchema,
    // Rates (FR-015b) are optional as a whole: without them the api still serves history
    // and limits, and the rate endpoint says it is not set up.
    JUPITER_API_KEY: unsetWhenEmpty(z.string().optional()),
    MAINNET_RPC_URL: unsetWhenEmpty(z.url({ protocol: /^https?$/ }).optional()),
    REWARD_MINTS: unsetWhenEmpty(z.string().optional()),
    // The keeper (FR-015) starts with its key and only then needs the rest: the seed
    // scripts read DEVNET_RPC_URL and STABLE_MINT from the same .env.
    KEEPER_SECRET_KEY: unsetWhenEmpty(
      z.string().refine(isKeeperSeed, 'expected a base58 32-byte ed25519 seed').optional(),
    ),
    DEVNET_RPC_URL: unsetWhenEmpty(z.url({ protocol: /^https?$/ }).optional()),
    STABLE_MINT: unsetWhenEmpty(solanaAddressSchema.optional()),
  })
  .superRefine((env, ctx) => {
    if (env.REWARD_MINTS !== undefined) {
      const mints = rewardMintsSchema.safeParse(env.REWARD_MINTS)
      for (const issue of mints.error?.issues ?? []) {
        ctx.addIssue({ code: 'custom', path: ['REWARD_MINTS'], message: issue.message })
      }
    }
    const missing = RATE_VARIABLES.filter((name) => env[name] === undefined)
    if (missing.length !== 0 && missing.length !== RATE_VARIABLES.length) {
      for (const name of missing) {
        ctx.addIssue({
          code: 'custom',
          path: [name],
          message: 'needed with the other rate variables',
        })
      }
    }
    if (env.KEEPER_SECRET_KEY === undefined) return
    for (const name of ['DEVNET_RPC_URL', 'STABLE_MINT'] as const) {
      if (env[name] === undefined) {
        ctx.addIssue({ code: 'custom', path: [name], message: 'needed by the keeper' })
      }
    }
    if (missing.length !== 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['KEEPER_SECRET_KEY'],
        message: 'the keeper needs the rate variables: every sweep carries a signed rate',
      })
    }
  })

export type RateConfig = {
  jupiterApiKey: string
  mainnetRpcUrl: string
  rewardMints: ReadonlyMap<string, SolanaAddress>
}

export type KeeperConfig = {
  secretKey: Uint8Array
  devnetRpcUrl: string
  stableMint: SolanaAddress
}

export type ApiConfig = {
  databaseUrl: string
  attestorSecretKey: string
  attestorPublicKey: string
  port: number
  webOrigins: readonly string[]
  logLevel: z.infer<typeof apiEnvSchema>['LOG_LEVEL']
  rates: RateConfig | null
  keeper: KeeperConfig | null
}

export function parseApiConfig(env: unknown): ApiConfig {
  const parsed = apiEnvSchema.safeParse(env)

  if (!parsed.success) {
    // Тільки імена змінних і причина: значення сюди потрапити не може,
    // інакше приватний ключ атестатора опиниться в логах падіння.
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(корінь)'} — ${issue.message}`)
      .join('; ')
    throw new Error(`неправильний конфіг api: ${problems}`)
  }

  return {
    databaseUrl: parsed.data.DATABASE_URL,
    attestorSecretKey: parsed.data.ATTESTOR_SECRET_KEY,
    attestorPublicKey: parsed.data.ATTESTOR_PUBLIC_KEY,
    port: parsed.data.PORT,
    webOrigins: parsed.data.WEB_ORIGIN,
    logLevel: parsed.data.LOG_LEVEL,
    rates: rateConfig(parsed.data),
    keeper: keeperConfig(parsed.data),
  }
}

function rateConfig(env: z.infer<typeof apiEnvSchema>): RateConfig | null {
  const { JUPITER_API_KEY, MAINNET_RPC_URL, REWARD_MINTS } = env
  if (
    JUPITER_API_KEY === undefined ||
    MAINNET_RPC_URL === undefined ||
    REWARD_MINTS === undefined
  ) {
    return null
  }
  const rewardMints = new Map<string, SolanaAddress>()
  for (const [networkId, mint] of rewardMintsSchema.parse(REWARD_MINTS)) {
    rewardMints.set(networkId, solanaAddressSchema.parse(mint.toBase58()))
  }
  return { jupiterApiKey: JUPITER_API_KEY, mainnetRpcUrl: MAINNET_RPC_URL, rewardMints }
}

function keeperConfig(env: z.infer<typeof apiEnvSchema>): KeeperConfig | null {
  const { KEEPER_SECRET_KEY, DEVNET_RPC_URL, STABLE_MINT } = env
  if (
    KEEPER_SECRET_KEY === undefined ||
    DEVNET_RPC_URL === undefined ||
    STABLE_MINT === undefined
  ) {
    return null
  }
  return {
    secretKey: base58Codec.decode(KEEPER_SECRET_KEY),
    devnetRpcUrl: DEVNET_RPC_URL,
    stableMint: STABLE_MINT,
  }
}

export function loadApiConfig(): ApiConfig {
  return parseApiConfig(process.env)
}
