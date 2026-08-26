import type { FastRetrieveHit, FastRetrieveSource } from './fast.js'

export interface TemporalRecallWindow {
  readonly from?: number
  readonly to?: number
}

/** Local date parser and deterministic temporal filter for fast retrieval. */
export class TemporalRecallModule {
  readonly id = 'temporal-recall'

  resolve(query: string, explicit?: TemporalRecallWindow): TemporalRecallWindow | undefined {
    const parsed = parseQueryWindow(query)
    const from = explicit?.from ?? parsed?.from
    const to = explicit?.to ?? parsed?.to
    return from === undefined && to === undefined ? undefined : { from, to }
  }

  apply(
    hits: readonly FastRetrieveHit[],
    window: TemporalRecallWindow | undefined,
  ): FastRetrieveHit[] {
    if (window === undefined) return [...hits]
    const result = hits.flatMap((hit) => {
      const time = sourceTime(hit.source)
      if (time === undefined) return []
      if (window.from !== undefined && time < window.from) return []
      if (window.to !== undefined && time > window.to) return []
      const edge = window.to ?? Date.now()
      const span = Math.max(1, edge - (window.from ?? edge - 30 * day))
      const proximity = Math.max(0, Math.min(1, 1 - (edge - time) / span))
      return [{ ...hit, score: hit.score + proximity * 0.08 }]
    })
    result.sort((left, right) => right.score - left.score)
    return result
  }

  queryText(query: string, window: TemporalRecallWindow | undefined): string | undefined {
    if (window === undefined) return query
    const stripped = query
      .replace(/\b(?:today|yesterday)\b|今天|昨天/gi, ' ')
      .replace(/(?:last|past|recent|最近|过去)\s*\d{1,4}\s*(?:days?|天)/gi, ' ')
      .replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ')
      .replace(/[，。！？,.!?：:]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    return /^(?:做了什么|发生了什么|what happened|what did (?:we|i|you) do)$/i.test(stripped)
      || stripped === '' ? undefined : stripped
  }
}

const day = 24 * 60 * 60 * 1_000

function parseQueryWindow(query: string, now = new Date()): TemporalRecallWindow | undefined {
  const text = query.toLocaleLowerCase()
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  if (/\b(?:today)\b|今天/.test(text)) {
    return { from: startToday, to: startToday + day - 1 }
  }
  if (/\b(?:yesterday)\b|昨天/.test(text)) {
    return { from: startToday - day, to: startToday - 1 }
  }
  const recent = text.match(/(?:last|past|recent|最近|过去)\s*(\d{1,4})\s*(?:days?|天)/)
  if (recent?.[1] !== undefined) {
    const days = Number(recent[1])
    return { from: now.getTime() - days * day, to: now.getTime() }
  }
  const iso = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/)
  if (iso !== null) {
    const start = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])).getTime()
    if (Number.isFinite(start)) return { from: start, to: start + day - 1 }
  }
  return undefined
}

function sourceTime(source: FastRetrieveSource): number | undefined {
  if ('type' in source) return source.time
  if (source.kind === 'repair-history' || source.kind === 'context-catalog') return source.time
  if (source.kind === 'git') return source.time
  return undefined
}
