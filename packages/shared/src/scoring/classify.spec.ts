import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { parseRewardNetworks } from '../schemas/network.ts'
import { solanaAddressSchema } from '../schemas/primitives.ts'
import { SUPPORTED_NETWORKS } from '../schemas/supported.ts'
import { classifyTransfer, tokenTransferSchema } from './classify.ts'

const IGNORED_REASONS = [
  'not-to-operator',
  'unknown-source',
  'mint-mismatch',
  'zero-amount',
] as const

const verdictSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('payout'), networkId: z.string() }),
  z.object({ kind: z.literal('ignored'), reason: z.enum(IGNORED_REASONS) }),
])

// Записане надходження проходить рівно ту саму схему, що й надходження з вузла:
// фікстура — це відповідь мейннету, а не окремий формат для тестів.
const recordedTransferSchema = tokenTransferSchema.extend({ expected: verdictSchema })

const walletSchema = z.object({
  wallet: solanaAddressSchema,
  networkId: z.string(),
  scannedSignatures: z.number().int().positive(),
  scannedFrom: z.iso.datetime({ offset: true }),
  scannedTo: z.iso.datetime({ offset: true }),
  transfers: z.array(recordedTransferSchema).min(1),
})

const fixtureSchema = z.object({
  capturedAt: z.iso.datetime({ offset: true }),
  wallets: z.array(walletSchema).length(20),
})

const fixturePath = path.join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  'fixtures',
  'wallets.json',
)

const fixture = fixtureSchema.parse(JSON.parse(readFileSync(fixturePath, 'utf8')))

const NEVER_A_SOURCE = [
  '4vMsoUT2BWatFweudnQM1xedRLfJgJ7hswhcpz4xgBTy',
  'BDs6RPnpJNzmuMNv1z8cDh9cxKFgCxEVDaCfoHZWyvqJ',
]

describe('fixtures/wallets.json', () => {
  it('holds ten real wallets for each supported network', () => {
    const byNetwork = new Map<string, number>()
    for (const entry of fixture.wallets) {
      expect(SUPPORTED_NETWORKS.has(entry.networkId)).toBe(true)
      byNetwork.set(entry.networkId, (byNetwork.get(entry.networkId) ?? 0) + 1)
    }

    expect(byNetwork.get('hivemapper')).toBe(10)
    expect(byNetwork.get('helium')).toBe(10)
    expect(new Set(fixture.wallets.map((entry) => entry.wallet)).size).toBe(20)
  })

  // Гаманець без жодної впізнаної виплати оператором не є, і `SC-003` на ньому
  // проходив би порожнім: нуль помилок з нуля рішень.
  it('recognises at least one payout for every wallet', () => {
    for (const entry of fixture.wallets) {
      const payouts = entry.transfers.filter((transfer) => transfer.expected.kind === 'payout')
      expect(payouts.length, entry.wallet).toBeGreaterThan(0)
    }
  })

  // Набір лише з виплат довів би, що класифікатор уміє казати «так», і нічого
  // не сказав би про те, чи вміє він казати «ні».
  it('keeps the incoming transfers the classifier has to reject', () => {
    const reasons = new Set(
      fixture.wallets
        .flatMap((entry) => entry.transfers)
        .flatMap((transfer) =>
          transfer.expected.kind === 'ignored' ? [transfer.expected.reason] : [],
        ),
    )

    expect(reasons.has('unknown-source')).toBe(true)
  })
})

describe('classifyTransfer against mainnet history (SC-003)', () => {
  it('returns the recorded verdict for every transfer, on every wallet', () => {
    const errors: string[] = []

    for (const entry of fixture.wallets) {
      for (const transfer of entry.transfers) {
        const { expected, ...onChain } = transfer
        const verdict = classifyTransfer(onChain, entry.wallet, SUPPORTED_NETWORKS)

        const got =
          verdict.kind === 'payout'
            ? { kind: 'payout', networkId: verdict.payout.networkId }
            : { kind: 'ignored', reason: verdict.reason }

        if (JSON.stringify(got) !== JSON.stringify(expected)) {
          errors.push(
            `${entry.wallet} ${transfer.signature}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`,
          )
        }
      }
    }

    expect(errors).toEqual([])
  })

  it('credits every recognised payout to the network the wallet earns on', () => {
    for (const entry of fixture.wallets) {
      for (const transfer of entry.transfers) {
        const { expected, ...onChain } = transfer
        const verdict = classifyTransfer(onChain, entry.wallet, SUPPORTED_NETWORKS)
        if (verdict.kind !== 'payout') continue

        expect(verdict.payout.networkId, transfer.signature).toBe(entry.networkId)
        expect(verdict.payout.wallet).toBe(entry.wallet)
        expect(verdict.payout.amount).toBeGreaterThan(0n)
      }
    }
  })

  // Тест на реальних даних лишився б зеленим і на підміненій адресі, якби читав
  // її з тієї самої фікстури. Джерело тут одне — сід, і ось доказ, що вирішує
  // саме воно: з чужими адресами той самий набір не впізнається взагалі.
  it('stops recognising the same history when the payout sources are not the seeded ones', () => {
    // Обидві адреси справжні й валідні, але власником токен-акаунта не буває
    // жодна: це мінт HONEY і токен-акаунт розподільника Helium. Класифікатор
    // звіряє власника, тож джерелом надходження вони стати не можуть.
    const strangers = parseRewardNetworks(
      [...SUPPORTED_NETWORKS.values()].map((network, index) => ({
        ...network,
        payoutSources: network.payoutSources.map((source) => ({
          kind: source.kind,
          address: NEVER_A_SOURCE[index],
        })),
      })),
    )

    for (const entry of fixture.wallets) {
      for (const transfer of entry.transfers) {
        if (transfer.expected.kind !== 'payout') continue
        const { expected: _verdict, ...onChain } = transfer

        expect(classifyTransfer(onChain, entry.wallet, strangers)).toEqual({
          kind: 'ignored',
          reason: 'unknown-source',
        })
      }
    }
  })
})
