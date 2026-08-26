import {
  PatchouliRpcError,
  type PatchouliStorageService,
} from 'dsh-patchouli/storage'
import { isDeepStrictEqual } from 'node:util'
import type {
  FactMetadata,
  JsonObject,
  JsonValue,
  KnowledgeProfile,
  KnowledgeValue,
  Meta,
} from 'dsh-patchouli-protocol'

import type {
  NativeContextAlgorithmModule,
  NativeContextModuleContext,
} from '../types.js'
import type {
  SessionContextRecord,
  SessionContextRecordKind,
  SessionContextSource,
  SessionIndexResult,
} from '../index/session.js'

export const SESSION_HISTORY_ENTITY_TYPE = 'knowledge'
export const SESSION_HISTORY_BINDING = 'native-context/session-history'
export const SESSION_HISTORY_DEFAULT_LIMIT = 20
export const SESSION_HISTORY_MAX_LIMIT = 100

export interface SessionHistoryIngestRequest {
  readonly meta: Meta
  readonly index: SessionIndexResult
}

export interface SessionHistoryEntityRef {
  readonly type: typeof SESSION_HISTORY_ENTITY_TYPE
  readonly id: string
  readonly version: string
}

export interface SessionHistoryIngestResult {
  readonly created: number
  readonly updated: number
  readonly refs: readonly SessionHistoryEntityRef[]
}

export interface SessionHistoryQuery {
  readonly meta: Meta
  readonly query?: string
  readonly sessionId?: string
  readonly kinds?: readonly SessionContextRecordKind[]
  readonly fromTime?: number
  readonly toTime?: number
  readonly limit?: number
}

export interface SessionHistoryQueryHit {
  readonly score: number
  readonly ref: SessionHistoryEntityRef
  readonly text: string
  readonly kind: SessionContextRecordKind
  readonly session: JsonObject & { readonly id: string }
  readonly source: SessionContextSource
  readonly data: JsonValue
}

export interface SessionHistoryQueryResult {
  readonly hits: readonly SessionHistoryQueryHit[]
  readonly truncated: boolean
}

type SessionHistoryStorage = Pick<
  PatchouliStorageService,
  'create' | 'query' | 'read' | 'update'
>

type SessionHistoryKnowledgeValue = KnowledgeValue & JsonObject

interface StoredRecord {
  readonly text: string
  readonly kind: SessionContextRecordKind
  readonly session: JsonObject & { readonly id: string }
  readonly source: SessionContextSource
  readonly data: JsonValue
}

const recordKinds = new Set<SessionContextRecordKind>([
  'user-message',
  'assistant-message',
  'tool-call',
  'tool-result',
])

const profile: KnowledgeProfile = {
  epistemic: 'observation',
  temporal: { kind: 'unknown' },
  ownership: 'agent',
  abstraction: 'instance',
  persistence: 'long_term',
  retrieval: ['exact', 'contextual'],
  actionability: 'informational',
}

/** Persists normalized Session records and performs bounded local DB retrieval. */
export class SessionHistoryAlgorithm implements NativeContextAlgorithmModule<
  SessionHistoryIngestRequest,
  SessionHistoryIngestResult,
  SessionHistoryQuery,
  SessionHistoryQueryResult
> {
  readonly id = 'session-history'

  constructor(private readonly storage: SessionHistoryStorage) {}

  async ingest(
    input: SessionHistoryIngestRequest,
    context: NativeContextModuleContext,
  ): Promise<SessionHistoryIngestResult> {
    const refs: SessionHistoryEntityRef[] = []
    let created = 0
    let updated = 0

    for (const record of input.index.records) {
      context.signal?.throwIfAborted()
      const value = knowledgeValue(input.index, record)
      const ref = { type: SESSION_HISTORY_ENTITY_TYPE, id: record.id } as const
      let existing
      try {
        existing = await this.storage.read({ meta: input.meta, data: { ref } })
        context.signal?.throwIfAborted()
      } catch (error: unknown) {
        context.signal?.throwIfAborted()
        if (!(error instanceof PatchouliRpcError) || error.reason !== 'NOT_FOUND') throw error
      }

      if (existing === undefined) {
        const result = await this.storage.create({
          meta: input.meta,
          data: { type: ref.type, id: ref.id, value },
        })
        context.signal?.throwIfAborted()
        refs.push(activeRef(result.data.entity))
        created += 1
        continue
      }

      const unchanged = existing.data.variants.find(variant => (
        variant.state === 'active' && sameRecordContent(variant.value, value)
      ))
      if (unchanged !== undefined) {
        refs.push(activeRef(unchanged))
        continue
      }

      const baseVersions = existing.data.variants.map(variant => variant.version)
      if (baseVersions.length === 0) {
        throw new Error(`session history entity has no current version: ${record.id}`)
      }
      const result = await this.storage.update({
        meta: { ...input.meta, base_versions: baseVersions },
        data: { ref, value },
      })
      context.signal?.throwIfAborted()
      refs.push(activeRef(result.data.entity))
      updated += 1
    }

    return { created, updated, refs }
  }

  async query(
    request: SessionHistoryQuery,
    context: NativeContextModuleContext,
  ): Promise<SessionHistoryQueryResult> {
    const text = request.query?.trim()
    if (request.query !== undefined && text === '') {
      throw new TypeError('session history query must be non-empty')
    }
    const limit = boundedLimit(request.limit)
    const kinds = queryKinds(request.kinds)
    if (kinds.length === 0) return { hits: [], truncated: false }

    const hits: SessionHistoryQueryHit[] = []
    let truncated = false
    for (const kind of kinds) {
      context.signal?.throwIfAborted()
      const where: JsonObject = {
        '/metadata/core/origin/binding': SESSION_HISTORY_BINDING,
        ...request.sessionId === undefined
          ? {}
          : { '/content/value/session/id': request.sessionId },
        ...kind === undefined ? {} : { '/content/value/kind': kind },
      }
      let cursor: string | undefined
      let pages = 0
      do {
        const page = await this.storage.query(
          request.meta,
          {
            ...(text === undefined ? {} : { text }),
            where,
            order: text === undefined ? 'newest' : 'relevance',
            ...(cursor === undefined ? {} : { cursor }),
          },
          { types: [SESSION_HISTORY_ENTITY_TYPE], limit: text === undefined ? 100 : limit },
        )
        context.signal?.throwIfAborted()
        cursor = typeof page.meta.next_cursor === 'string' ? page.meta.next_cursor : undefined
        pages += 1
        let oldest = Number.POSITIVE_INFINITY
        for (const hit of page.data.hits) {
          for (const variant of hit.variants) {
            if (variant.state !== 'active') continue
            const stored = storedRecord(variant.value)
            oldest = Math.min(oldest, stored.source.time)
            if (request.fromTime !== undefined && stored.source.time < request.fromTime) continue
            if (request.toTime !== undefined && stored.source.time > request.toTime) continue
            hits.push({
              score: hit.score,
              ref: {
                type: SESSION_HISTORY_ENTITY_TYPE,
                id: variant.ref.id,
                version: variant.version,
              },
              ...stored,
            })
          }
        }
        if (hits.length >= limit) break
        if (request.fromTime !== undefined && oldest < request.fromTime) break
      } while (cursor !== undefined && pages < 5 && text === undefined)
      truncated ||= cursor !== undefined
    }

    hits.sort((left, right) => (
      (text === undefined ? right.source.time - left.source.time : right.score - left.score)
      || left.ref.id.localeCompare(right.ref.id)
      || left.ref.version.localeCompare(right.ref.version)
    ))
    if (hits.length > limit) truncated = true
    return { hits: hits.slice(0, limit), truncated }
  }
}

function sameRecordContent(existing: JsonValue, incoming: JsonValue): boolean {
  return isDeepStrictEqual(recordContent(existing), recordContent(incoming))
}

function recordContent(value: JsonValue): JsonValue | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const content = (value as JsonObject).content
  if (content === null || typeof content !== 'object' || Array.isArray(content)) return undefined
  const structured = content as JsonObject
  if (structured.kind !== 'structured') return undefined
  return structured.value
}

function knowledgeValue(
  index: SessionIndexResult,
  record: SessionContextRecord,
): SessionHistoryKnowledgeValue {
  const now = new Date().toISOString()
  const eventAt = new Date(record.source.time).toISOString()
  const payload = jsonObject({
    text: record.text,
    kind: record.kind,
    session: index.session,
    source: record.source,
    data: record.data,
  })
  const metadata: FactMetadata<'patchouli.knowledge@1'> = {
    core: {
      schema: 'patchouli.knowledge@1',
      scope: {
        tenant: null,
        workspace: record.source.cwd ?? null,
        user: null,
        session: record.source.sessionId,
      },
      origin: {
        provider: 'deepseek-harness',
        binding: SESSION_HISTORY_BINDING,
        native_type: record.source.eventType,
        native_id: record.id,
        native_revision: String(record.source.seq),
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
        source: record.source.sessionId,
        recorded_at: now,
      }],
    },
    extensions: {},
  }
  const value: KnowledgeValue = {
    content: { kind: 'structured', value: payload },
    metadata,
    artifact: [],
    profile,
  }
  return jsonObject(value) as SessionHistoryKnowledgeValue
}

function activeRef(entity: {
  readonly ref: { readonly type: string; readonly id: string }
  readonly version: string
  readonly state: 'active' | 'deleted'
}): SessionHistoryEntityRef {
  if (entity.state !== 'active' || entity.ref.type !== SESSION_HISTORY_ENTITY_TYPE) {
    throw new Error('session history mutation did not return an active knowledge entity')
  }
  return { type: SESSION_HISTORY_ENTITY_TYPE, id: entity.ref.id, version: entity.version }
}

function boundedLimit(value: number | undefined): number {
  const limit = value ?? SESSION_HISTORY_DEFAULT_LIMIT
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > SESSION_HISTORY_MAX_LIMIT) {
    throw new RangeError(`session history limit must be an integer from 1 to ${SESSION_HISTORY_MAX_LIMIT}`)
  }
  return limit
}

function queryKinds(
  value: readonly SessionContextRecordKind[] | undefined,
): readonly (SessionContextRecordKind | undefined)[] {
  if (value === undefined) return [undefined]
  const unique = [...new Set(value)]
  for (const kind of unique) {
    if (!recordKinds.has(kind)) throw new TypeError(`unsupported session history kind: ${kind}`)
  }
  return unique
}

function storedRecord(value: JsonValue): StoredRecord {
  const root = object(value, 'knowledge value')
  const content = object(root.content, 'knowledge content')
  if (content.kind !== 'structured') throw new TypeError('session history content must be structured')
  const payload = object(content.value, 'session history payload')
  if (typeof payload.text !== 'string') throw new TypeError('session history text must be a string')
  if (typeof payload.kind !== 'string' || !recordKinds.has(payload.kind as SessionContextRecordKind)) {
    throw new TypeError('session history kind is unsupported')
  }
  const session = object(payload.session, 'session history session')
  if (typeof session.id !== 'string') throw new TypeError('session history session id must be a string')
  const source = object(payload.source, 'session history source')
  if (
    source.type !== 'session-event'
    || typeof source.sessionId !== 'string'
    || typeof source.seq !== 'number'
    || typeof source.time !== 'number'
    || typeof source.eventType !== 'string'
  ) throw new TypeError('session history source is invalid')
  const data = jsonValue(payload.data, 'session history data')
  return {
    text: payload.text,
    kind: payload.kind as SessionContextRecordKind,
    session: session as JsonObject & { readonly id: string },
    source: source as JsonObject as unknown as SessionContextSource,
    data,
  }
}

function jsonObject(value: unknown): JsonObject {
  return object(jsonValue(value, 'session history value'), 'session history value')
}

function jsonValue(value: unknown, path: string): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new TypeError(`${path} is not JSON`)
    return value
  }
  if (Array.isArray(value)) {
    const items: JsonValue[] = []
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) throw new TypeError(`${path} is not JSON`)
      items.push(jsonValue(value[index], `${path}[${index}]`))
    }
    return items
  }
  if (value !== null && typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${path} is not JSON`)
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, jsonValue(item, `${path}.${key}`)]),
    )
  }
  throw new TypeError(`${path} is not JSON`)
}

function object(value: JsonValue | undefined, path: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`)
  }
  return value as JsonObject
}
