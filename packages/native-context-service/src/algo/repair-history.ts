import {
  PatchouliRpcError,
  type PatchouliStorageService,
} from 'dsh-patchouli/storage'
import type {
  FactMetadata,
  JsonObject,
  JsonValue,
  KnowledgeProfile,
  KnowledgeValue,
  Meta,
} from 'dsh-patchouli-protocol'

import type { SessionContextRecord, SessionIndexResult } from '../index/session.js'
import type { NativeContextAlgorithmModule, NativeContextModuleContext } from '../types.js'

export const REPAIR_HISTORY_BINDING = 'native-context/repair-history'
export const REPAIR_HISTORY_DEFAULT_LIMIT = 10
export const REPAIR_HISTORY_MAX_LIMIT = 50

export interface RepairHistorySource {
  readonly kind: 'repair-history'
  readonly sessionId: string
  readonly fromSeq: number
  readonly toSeq: number
  readonly time: number
  readonly cwd?: string
}

export interface RepairHistoryIngestRequest {
  readonly meta: Meta
  readonly index: SessionIndexResult
}

export interface RepairHistoryQuery {
  readonly meta: Meta
  readonly text: string
  readonly sessionId?: string
  readonly limit?: number
}

export interface RepairHistoryQueryHit {
  readonly score: number
  readonly text: string
  readonly source: RepairHistorySource
}

export interface RepairHistoryResult {
  readonly created: number
}

export interface RepairHistoryQueryResult {
  readonly hits: readonly RepairHistoryQueryHit[]
  readonly truncated: boolean
}

type Storage = Pick<PatchouliStorageService, 'create' | 'query' | 'read'>

const profile: KnowledgeProfile = {
  epistemic: 'observation',
  temporal: { kind: 'unknown' },
  ownership: 'agent',
  abstraction: 'pattern',
  persistence: 'long_term',
  retrieval: ['exact', 'contextual'],
  actionability: 'informational',
}

/** Extracts compact failure -> corrective action -> successful result episodes. */
export class RepairHistoryAlgorithm implements NativeContextAlgorithmModule<
  RepairHistoryIngestRequest,
  RepairHistoryResult,
  RepairHistoryQuery,
  RepairHistoryQueryResult
> {
  readonly id = 'repair-history'
  private readonly sessionStates = new Map<string, RepairScanState>()

  constructor(private readonly storage: Storage) {}

  async ingest(
    input: RepairHistoryIngestRequest,
    context: NativeContextModuleContext,
  ): Promise<RepairHistoryResult> {
    let created = 0
    const sessionId = input.index.session.id
    const state = this.sessionStates.get(sessionId) ?? { calls: new Map() }
    this.sessionStates.delete(sessionId)
    this.sessionStates.set(sessionId, state)
    if (this.sessionStates.size > 256) {
      const oldest = this.sessionStates.keys().next().value
      if (oldest !== undefined) this.sessionStates.delete(oldest)
    }
    for (const episode of repairEpisodes(input.index.records, state)) {
      context.signal?.throwIfAborted()
      const id = `repair:${encodeURIComponent(episode.source.sessionId)}:${episode.source.fromSeq}:${episode.source.toSeq}`
      try {
        await this.storage.read({ meta: input.meta, data: { ref: { type: 'knowledge', id } } })
        continue
      } catch (error: unknown) {
        if (!(error instanceof PatchouliRpcError) || error.reason !== 'NOT_FOUND') throw error
      }
      await this.storage.create({
        meta: input.meta,
        data: { type: 'knowledge', id, value: knowledgeValue(episode) },
      })
      created += 1
    }
    return { created }
  }

  async query(
    request: RepairHistoryQuery,
    context: NativeContextModuleContext,
  ): Promise<RepairHistoryQueryResult> {
    const text = request.text.trim()
    if (text === '') throw new TypeError('repair history query must be non-empty')
    const limit = boundedLimit(request.limit)
    const page = await this.storage.query(request.meta, {
      text,
      where: {
        '/metadata/core/origin/binding': REPAIR_HISTORY_BINDING,
        ...(request.sessionId === undefined
          ? {}
          : { '/content/value/source/sessionId': request.sessionId }),
      },
      order: 'relevance',
    }, { types: ['knowledge'], limit })
    context.signal?.throwIfAborted()
    const hits = page.data.hits.flatMap(hit => hit.variants.flatMap((variant) => {
      if (variant.state !== 'active') return []
      const payload = structuredPayload(variant.value)
      if (typeof payload.text !== 'string') return []
      const source = payload.source
      if (!isRepairSource(source)) return []
      return [{ score: hit.score, text: payload.text, source }]
    }))
    hits.sort((a, b) => b.score - a.score || b.source.time - a.source.time)
    return {
      hits: hits.slice(0, limit),
      truncated: typeof page.meta.next_cursor === 'string' || hits.length > limit,
    }
  }
}

interface Episode {
  readonly text: string
  readonly source: RepairHistorySource
}

interface RepairScanState {
  readonly calls: Map<string, SessionContextRecord>
  pending?: SessionContextRecord
}

function repairEpisodes(
  records: readonly SessionContextRecord[],
  state: RepairScanState,
): Episode[] {
  const episodes: Episode[] = []
  for (const record of records) {
    if (record.kind === 'tool-call' && record.source.callId !== undefined) {
      state.calls.set(record.source.callId, record)
      continue
    }
    if (record.kind !== 'tool-result') continue
    if (failed(record)) {
      state.pending = record
      continue
    }
    const pending = state.pending
    if (pending === undefined) continue
    if (
      record.source.seq - pending.source.seq > 100
      || record.source.time - pending.source.time > 30 * 60_000
    ) {
      state.pending = undefined
      continue
    }
    const failedCall = pending.source.callId === undefined
      ? undefined
      : state.calls.get(pending.source.callId)
    const successfulCall = record.source.callId === undefined
      ? undefined
      : state.calls.get(record.source.callId)
    const parts = [
      'Failure:',
      failedCall?.text,
      pending.text,
      'Repair:',
      successfulCall?.text,
      'Successful result:',
      record.text,
    ].filter((part): part is string => typeof part === 'string' && part.trim() !== '')
    episodes.push({
      text: parts.join('\n'),
      source: {
        kind: 'repair-history',
        sessionId: record.source.sessionId,
        fromSeq: pending.source.seq,
        toSeq: record.source.seq,
        time: record.source.time,
        ...(record.source.cwd === undefined ? {} : { cwd: record.source.cwd }),
      },
    })
    state.pending = undefined
  }
  const newestSeq = records.at(-1)?.source.seq
  if (newestSeq !== undefined) {
    for (const [callId, call] of state.calls) {
      if (newestSeq - call.source.seq > 100) state.calls.delete(callId)
    }
  }
  return episodes
}

function failed(record: SessionContextRecord): boolean {
  const data = object(record.data)
  if (data?.error !== undefined) return true
  const message = object(data?.message)
  if (message?.error !== undefined || message?.isError === true) return true
  return /(?:^|\n)(?:error|failed|failure|exception|exit code [1-9]\d*)\b/i.test(record.text)
}

function knowledgeValue(episode: Episode): KnowledgeValue & JsonObject {
  const now = new Date().toISOString()
  const eventAt = new Date(episode.source.time).toISOString()
  const metadata: FactMetadata<'patchouli.knowledge@1'> = {
    core: {
      schema: 'patchouli.knowledge@1',
      scope: {
        tenant: null,
        workspace: episode.source.cwd ?? null,
        user: null,
        session: episode.source.sessionId,
      },
      origin: {
        provider: 'deepseek-harness',
        binding: REPAIR_HISTORY_BINDING,
        native_type: 'repair-episode',
        native_id: `${episode.source.sessionId}:${episode.source.fromSeq}:${episode.source.toSeq}`,
        native_revision: String(episode.source.toSeq),
      },
      time: {
        event_at: eventAt,
        source_created_at: null,
        source_updated_at: null,
        observed_at: now,
        ingested_at: now,
      },
      lifecycle: { status: 'active', expires_at: null },
      provenance: [{
        kind: 'observed',
        actor: 'native-context-service',
        source: episode.source.sessionId,
        recorded_at: now,
      }],
    },
    extensions: {},
  }
  return {
    content: { kind: 'structured', value: jsonObject({ text: episode.text, source: episode.source }) },
    metadata,
    artifact: [],
    profile,
  } as unknown as KnowledgeValue & JsonObject
}

function structuredPayload(value: JsonValue): JsonObject {
  const root = object(value)
  const content = object(root?.content)
  return content?.kind === 'structured' ? object(content.value) ?? {} : {}
}

function isRepairSource(value: JsonValue | undefined): value is JsonObject & RepairHistorySource {
  const source = object(value)
  return source?.kind === 'repair-history'
    && typeof source.sessionId === 'string'
    && typeof source.fromSeq === 'number'
    && typeof source.toSeq === 'number'
    && typeof source.time === 'number'
}

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : undefined
}

function jsonObject(value: unknown): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject
}

function boundedLimit(value: number | undefined): number {
  const limit = value ?? REPAIR_HISTORY_DEFAULT_LIMIT
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > REPAIR_HISTORY_MAX_LIMIT) {
    throw new RangeError(`repair history limit must be an integer from 1 to ${REPAIR_HISTORY_MAX_LIMIT}`)
  }
  return limit
}
