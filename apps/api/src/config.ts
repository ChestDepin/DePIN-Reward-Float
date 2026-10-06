import { rewardMintsSchema } from '@drf/anchor-client'
import { type SolanaAddress, solanaAddressSchema } from '@drf/shared/schemas'
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
  })
  .superRefine((env, ctx) => {
    if (env.REWARD_MINTS !== undefined) {
      const mints = rewardMintsSchema.safeParse(env.REWARD_MINTS)
      for (const issue of mints.error?.issues ?? []) {
        ctx.addIssue({ code: 'custom', path: ['REWARD_MINTS'], message: issue.message })
      }
    }
    const missing = RATE_VARIABLES.filter((name) => env[name] === undefined)
    if (missing.length === 0 || missing.length === RATE_VARIABLES.length) return
    for (const name of missing) {
      ctx.addIssue({
        code: 'custom',
        path: [name],
        message: 'needed with the other rate variables',
      })
    }
  })

export type RateConfig = {
  jupiterApiKey: string
  mainnetRpcUrl: string
  rewardMints: ReadonlyMap<string, SolanaAddress>
}

export type ApiConfig = {
  databaseUrl: string
  attestorSecretKey: string
  attestorPublicKey: string
  port: number
  webOrigins: readonly string[]
  logLevel: z.infer<typeof apiEnvSchema>['LOG_LEVEL']
  rates: RateConfig | null
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

export function loadApiConfig(): ApiConfig {
  return parseApiConfig(process.env)
}
