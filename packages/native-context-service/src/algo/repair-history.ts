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
export const REPAIR_HISTORY_TEXT_LIMIT = 1_200
const EVIDENCE_EXCERPT_LIMIT = 320
const CALL_HISTORY_LIMIT = 256

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
  readonly truncated?: boolean
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
  abstraction: 'instance',
  persistence: 'long_term',
  retrieval: ['exact', 'contextual'],
  actionability: 'informational',
}

/** Records related retry observations, without claiming that a repair caused success. */
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
      const projection = recallText(payload)
      return [{ score: hit.score, ...projection, source }]
    }))
    hits.sort((a, b) => b.score - a.score || b.source.time - a.source.time)
    return {
      hits: hits.slice(0, limit),
      truncated: typeof page.meta.next_cursor === 'string' || hits.length > limit
        || hits.slice(0, limit).some(hit => hit.truncated),
    }
  }
}

interface Episode {
  readonly text: string
  readonly source: RepairHistorySource
  readonly observation: {
    readonly policy: 'related-recovery-v2'
    readonly status: 'observed-unverified'
    readonly tool: string
    readonly target: string
    readonly failureExcerpt: string
    readonly laterResultExcerpt: string
    readonly evidenceTruncated: boolean
  }
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
      while (state.calls.size > CALL_HISTORY_LIMIT) state.calls.delete(state.calls.keys().next().value!)
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
      record.source.sessionId !== pending.source.sessionId
      || record.source.cwd !== pending.source.cwd
      || record.source.seq <= pending.source.seq
      || record.source.time < pending.source.time
      || record.source.seq - pending.source.seq > 100
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
    const before = callIdentity(failedCall)
    const after = callIdentity(successfulCall)
    if (before === undefined || after === undefined || before.key !== after.key
      || !substantiveResult(record.text)) continue
    const observation: Episode['observation'] = {
      policy: 'related-recovery-v2',
      status: 'observed-unverified',
      tool: before.tool,
      target: excerpt(before.target, 160),
      failureExcerpt: excerpt(pending.text, EVIDENCE_EXCERPT_LIMIT),
      laterResultExcerpt: excerpt(record.text, EVIDENCE_EXCERPT_LIMIT),
      evidenceTruncated: pending.text.length > EVIDENCE_EXCERPT_LIMIT
        || record.text.length > EVIDENCE_EXCERPT_LIMIT || before.target.length > 160,
    }
    episodes.push({
      text: observationText(observation),
      observation,
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

function callIdentity(record: SessionContextRecord | undefined): {
  readonly key: string
  readonly tool: string
  readonly target: string
} | undefined {
  if (record === undefined) return undefined
  const data = object(record.data)
  const line = record.text.indexOf('\n')
  const tool = typeof data?.name === 'string' ? data.name : record.text.slice(0, line)
  if (!tool || tool.length > 120) return undefined
  let args: JsonObject | undefined
  const raw = data?.arguments ?? (line < 0 ? undefined : record.text.slice(line + 1))
  if (typeof raw === 'string') {
    if (raw.length > 65_536) return undefined
    try { args = object(JSON.parse(raw)) } catch { return undefined }
  } else args = object(raw)
  if (args === undefined) return undefined
  // Compare full identifiers before shortening their display. Shell commands are
  // eligible only for an exact retry; parsing shell text cannot prove a target.
  const fields = ['file_path', 'path', 'id', 'task_id', 'taskId', 'goal_id', 'goalId',
    'resourceId', 'documentId', 'teamId', 'run_id', 'runId', 'target', 'pattern', 'query', 'url', 'uri'] as const
  const target = fields.flatMap(key => {
    const value = args[key]
    return (typeof value === 'string' && value.trim() !== '') || typeof value === 'number'
      ? [[key, value] as const] : []
  })
  const command = typeof args.command === 'string' && args.command.trim() !== ''
  if (target.length === 0 && !command) return undefined
  // Match every parameter, including action and working directory. Relaxing this
  // for arbitrary tools would mistake status/list calls for successful mutations.
  let canonical: string
  try {
    const serialized = JSON.stringify(args)
    if (serialized.length > 65_536) return undefined
    canonical = JSON.stringify(JSON.parse(serialized, (_key, value: unknown) => {
      const item = object(value)
      return item === undefined ? value : Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
    }))
  } catch { return undefined }
  return {
    key: JSON.stringify([tool, canonical]), tool,
    target: command ? 'same exact command and parameters (see source events)' : JSON.stringify(Object.fromEntries(target)),
  }
}

function substantiveResult(text: string): boolean {
  const value = text.trim()
  return value !== '' && !/^(?:\[\]|\{\}|null)$/i.test(value)
    && !/(?:^|\n)\s*(?:no (?:files?|matches|results)(?: found| matched)?\b|0 (?:files?|matches|results)\b)/i.test(value)
}

function excerpt(text: string, limit: number): string {
  if (text.length <= limit) return text
  // Preserve both ends so a trailing qualification is not silently dropped.
  const marker = '\n[… excerpt truncated; consult source …]\n'
  const remaining = limit - marker.length
  return text.slice(0, Math.ceil(remaining / 2)) + marker + text.slice(-Math.floor(remaining / 2))
}

function observationText(value: Episode['observation']): string {
  return excerpt([
    'Observed recovery (unverified): a related tool retry later returned a non-error result.',
    'This does not establish a causal repair or task completion; inspect source events before reuse.',
    `Tool: ${value.tool}; target: ${value.target}`,
    `Failure excerpt: ${value.failureExcerpt}`,
    `Later result excerpt: ${value.laterResultExcerpt}`,
  ].join('\n'), REPAIR_HISTORY_TEXT_LIMIT)
}

function recallText(payload: JsonObject): { readonly text: string; readonly truncated: boolean } {
  const observation = object(payload.observation)
  if (observation?.policy === 'related-recovery-v2'
    && observation.status === 'observed-unverified'
    && ['tool', 'target', 'failureExcerpt', 'laterResultExcerpt'].every(key => typeof observation[key] === 'string')) {
    const bounded = {
      policy: 'related-recovery-v2', status: 'observed-unverified',
      tool: excerpt(observation.tool as string, 120),
      target: excerpt(observation.target as string, 160),
      failureExcerpt: excerpt(observation.failureExcerpt as string, EVIDENCE_EXCERPT_LIMIT),
      laterResultExcerpt: excerpt(observation.laterResultExcerpt as string, EVIDENCE_EXCERPT_LIMIT),
      evidenceTruncated: observation.evidenceTruncated === true,
    } as const
    return { text: observationText(bounded), truncated: bounded.evidenceTruncated
      || ['tool', 'target', 'failureExcerpt', 'laterResultExcerpt'].some(key => observation[key] !== bounded[key as keyof typeof bounded]) }
  }
  // Old records remain immutable. Their original "Repair/Successful result"
  // labels came from temporal adjacency and are not evidence of causality.
  const raw = typeof payload.text === 'string' ? payload.text : ''
  const failure = raw.startsWith('Failure:\n') ? raw.slice('Failure:\n'.length).split('\nRepair:\n')[0]! : raw
  const resultAt = raw.lastIndexOf('\nSuccessful result:\n')
  const later = resultAt < 0 ? '' : raw.slice(resultAt + '\nSuccessful result:\n'.length)
  return { text: [
    'Legacy recovery observation (unverified). Tool/target relation and causality were not checked.',
    `Earlier failure excerpt: ${excerpt(failure, EVIDENCE_EXCERPT_LIMIT)}`,
    `Later output excerpt (not proof of repair): ${excerpt(later, EVIDENCE_EXCERPT_LIMIT)}`,
    'Read the source events to check applicability; this is a bounded projection of an unchanged legacy record.',
  ].join('\n'), truncated: raw !== '' }
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
    extensions: { 'dsh.repair-history': { policy: episode.observation.policy, status: episode.observation.status } },
  }
  return {
    content: { kind: 'structured', value: jsonObject({ text: episode.text, observation: episode.observation, source: episode.source }) },
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
