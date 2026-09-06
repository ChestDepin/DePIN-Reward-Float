import { BASIS_POINTS, type LimitOutcome, MONTHS_OF_FLOW } from './limit.ts'

export type ScoredLimit = Extract<LimitOutcome, { kind: 'limit' }>

export type LimitFactorName = 'median-flow' | 'stability' | 'volatility'

export type LimitFactor = {
  name: LimitFactorName
  // Мікродолари зі знаком: наскільки цей фактор зрушив ліміт від того, що
  // лишалося після попереднього.
  deltaUsd: bigint
}

// Розклад мультиплікативний, тому залежить від порядку: стабільність
// застосовується першою, і волатильність рахується вже на зменшеній сумі.
// Приписати їй ту саму частку від повної бази означало б, що внески в сумі
// перестануть дорівнювати ліміту.
export function explainLimit(limit: ScoredLimit): readonly LimitFactor[] {
  const base = limit.medianMonthlyUsd * MONTHS_OF_FLOW

  // Кожен щабель ділиться один раз від повного чисельника — тим самим виразом,
  // що й сам ліміт. Ділити після кожного множника означало б розійтися з ним
  // на одиницю там, де обрізання лягло інакше.
  const afterStability = (base * limit.stabilityBp * BASIS_POINTS) / (BASIS_POINTS * BASIS_POINTS)
  const afterVolatility =
    (base * limit.stabilityBp * (BASIS_POINTS - limit.volatilityBp)) / (BASIS_POINTS * BASIS_POINTS)

  return [
    { name: 'median-flow', deltaUsd: base },
    { name: 'stability', deltaUsd: afterStability - base },
    { name: 'volatility', deltaUsd: afterVolatility - afterStability },
  ]
}
