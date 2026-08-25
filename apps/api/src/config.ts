import { z } from 'zod'

const base58 = /^[1-9A-HJ-NP-Za-km-z]{32,128}$/

const apiEnvSchema = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  ATTESTOR_SECRET_KEY: z.string().regex(base58),
  ATTESTOR_PUBLIC_KEY: z.string().regex(base58),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
})

export type ApiConfig = {
  databaseUrl: string
  attestorSecretKey: string
  attestorPublicKey: string
  port: number
  logLevel: z.infer<typeof apiEnvSchema>['LOG_LEVEL']
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
    logLevel: parsed.data.LOG_LEVEL,
  }
}

export function loadApiConfig(): ApiConfig {
  return parseApiConfig(process.env)
}
