import type {
  NativeContextIndexModule,
  NativeContextModuleContext,
} from '../types.js'

export const SESSION_INDEX_DEFAULT_LIMIT = 100
export const SESSION_INDEX_MAX_LIMIT = 200

export type SessionContextRecordKind =
  | 'user-message'
  | 'assistant-message'
  | 'tool-call'
  | 'tool-result'

/** The subset of agent-loop metadata used to resolve the current session. */
export interface SessionIndexCallMeta {
  readonly attributes?: Readonly<Record<string, unknown>>
}

export interface SessionIndexRequest<TSessionId extends string = string> {
  /** Explicit target. Takes precedence over `meta.attributes.sessionId`. */
  readonly sessionId?: TSessionId
  /** Agent-loop call metadata used when indexing the current session. */
  readonly meta?: SessionIndexCallMeta
  /** Resume strictly after this event sequence number. Defaults to -1. */
  readonly afterSeq?: number
  /** Optional inclusive upper sequence boundary. */
  readonly throughSeq?: number
  /** Maximum normalized records returned in this batch. */
  readonly limit?: number
}

export interface SessionContextSource {
  readonly type: 'session-event'
  readonly sessionId: string
  readonly seq: number
  readonly time: number
  readonly eventType: string
  readonly surface: 'current' | 'shadowed' | 'log-only'
  readonly cwd?: string
  readonly turn?: number
  readonly step?: number
  readonly messageId?: string
  readonly callId?: string
}

/** One database-ready record with a stable id and exact raw-event location. */
export interface SessionContextRecord {
  readonly id: string
  readonly kind: SessionContextRecordKind
  readonly text: string
  readonly source: SessionContextSource
  readonly data: unknown
}

export interface SessionIndexResult {
  readonly session: SessionHeaderSnapshot
  readonly records: readonly SessionContextRecord[]
  /** Cursor to pass back as `afterSeq` for the next batch. */
  readonly nextAfterSeq: number
  readonly hasMore: boolean
}

export interface SessionHeaderSnapshot {
  readonly id: string
  readonly version: number
  readonly createdAt: number
  readonly cwd?: string
  readonly parentSession?: string
  readonly seedLength?: number
  readonly origin?: 'subagent'
  readonly delegationDepth?: number
  readonly agentPreset?: string
}

interface SessionEventRecordSnapshot {
  readonly seq: number
  readonly type: string
  readonly time: number
  readonly surface: 'current' | 'shadowed' | 'log-only'
}

interface SessionEventSnapshot {
  readonly seq: number
  readonly type: string
  readonly time: number
  readonly data: unknown
}

interface SessionEventWindowSnapshot {
  readonly session: SessionHeaderSnapshot
  readonly target: SessionEventSnapshot
  readonly events?: readonly SessionEventSnapshot[]
  readonly startSeq?: number
  readonly endSeq?: number
}

interface SessionLogSnapshot {
  readonly session: SessionHeaderSnapshot
  readonly events: readonly SessionEventSnapshot[]
}

/** Structural view of the concrete `@deepseek-ai/dsh-session-query` service. */
export interface SessionQueryReader<TSessionId extends string = string> {
  searchSessions(
    request: {
      readonly query: string
      readonly eventFilters?: readonly ({
        readonly kind: 'time'
        readonly from?: number
        readonly to?: number
      })[]
      readonly limit?: number
    },
    exec?: { readonly signal?: AbortSignal },
  ): Promise<{
    readonly items: readonly {
      readonly header: SessionHeaderSnapshot
      readonly bestMatch: {
        readonly seq: number
        readonly type: string
        readonly time: number
        readonly surface: SessionContextSource['surface']
        readonly snippet: string
      }
    }[]
    readonly nextCursor?: unknown
  }>
  searchEvents(
    request: {
      readonly sessionId: TSessionId
      readonly query: string
      readonly filters?: readonly ({
        readonly kind: 'time'
        readonly from?: number
        readonly to?: number
      })[]
      readonly limit?: number
    },
    exec?: { readonly signal?: AbortSignal },
  ): Promise<{
    readonly session: SessionHeaderSnapshot
    readonly items: readonly {
      readonly seq: number
      readonly type: string
      readonly time: number
      readonly surface: SessionContextSource['surface']
      readonly snippet: string
    }[]
    readonly nextCursor?: unknown
  }>
  filterEvents(
    sessionId: TSessionId,
    filters: readonly ({
      readonly kind: 'text'
      readonly text: string
    } | {
      readonly kind: 'time'
      readonly from?: number
      readonly to?: number
    })[],
  ): Promise<readonly {
    readonly sessionId: TSessionId
    readonly seq: number
    readonly type: string
    readonly time: number
    readonly surface: SessionContextSource['surface']
    readonly text: string
  }[]>
  listSessions(signal?: AbortSignal): Promise<readonly {
    readonly header: SessionHeaderSnapshot
  }[]>
  listEvents(sessionId: TSessionId): Promise<readonly SessionEventRecordSnapshot[]>
  readSession?(sessionId: TSessionId): Promise<SessionLogSnapshot>
  readEvent(
    request: {
      readonly sessionId: TSessionId
      readonly seq: number
      readonly before?: number
      readonly after?: number
    },
    signal?: AbortSignal,
  ): Promise<SessionEventWindowSnapshot>
}

export interface SessionIndexSearchRequest<TSessionId extends string = string> {
  readonly sessionId: TSessionId
  readonly query: string
  readonly fromTime?: number
  readonly toTime?: number
  readonly limit?: number
}

export interface SessionIndexCrossSearchRequest<TSessionId extends string = string> {
  readonly query: string
  readonly excludeSessionId?: TSessionId
  readonly fromTime?: number
  readonly toTime?: number
  readonly limit?: number
}

export interface SessionIndexSearchHit {
  readonly text: string
  readonly score: number
  readonly source: SessionContextSource
}

export interface SessionIndexSearchResult {
  readonly hits: readonly SessionIndexSearchHit[]
  readonly truncated: boolean
}

export interface SessionIndexSearchPage extends SessionIndexSearchResult {
  readonly nextOffset?: number
}

export type SessionHeaderLister = (
  signal?: AbortSignal,
) => Promise<readonly SessionHeaderSnapshot[]>

const indexedEventKinds = new Map<string, SessionContextRecordKind>([
  ['user/message', 'user-message'],
  ['assistant/message', 'assistant-message'],
  ['tool/call', 'tool-call'],
  ['tool/result', 'tool-result'],
])

/** Reads bounded batches from the live-preferred DSH session-query corpus. */
export class SessionIndex<TSessionId extends string = string> implements NativeContextIndexModule<
  SessionIndexRequest<TSessionId>,
  SessionIndexResult
> {
  readonly id = 'session'

  constructor(
    private readonly sessionQuery: SessionQueryReader<TSessionId>,
    private readonly listSessionHeaders?: SessionHeaderLister,
  ) {}

  /** Search the native Session corpus directly; Patchouli does not duplicate Session text. */
  async search(
    request: SessionIndexSearchRequest<TSessionId>,
    context: NativeContextModuleContext,
  ): Promise<SessionIndexSearchResult> {
    const query = request.query.trim()
    if (query === '') throw new TypeError('session search query must be non-empty')
    const limit = readLimit(request.limit)
    context.signal?.throwIfAborted()
    let page: Awaited<ReturnType<SessionQueryReader<TSessionId>['searchEvents']>>
    try {
      page = await this.sessionQuery.searchEvents({
        sessionId: request.sessionId,
        query,
        ...(request.fromTime === undefined && request.toTime === undefined ? {} : {
          filters: [{
            kind: 'time' as const,
            ...(request.fromTime === undefined ? {} : { from: request.fromTime }),
            ...(request.toTime === undefined ? {} : { to: request.toTime }),
          }],
        }),
        limit,
      }, { signal: context.signal })
    } catch {
      context.signal?.throwIfAborted()
      const documents = await this.sessionQuery.filterEvents(request.sessionId, [
        { kind: 'text', text: query },
        ...(request.fromTime === undefined && request.toTime === undefined ? [] : [{
          kind: 'time' as const,
          ...(request.fromTime === undefined ? {} : { from: request.fromTime }),
          ...(request.toTime === undefined ? {} : { to: request.toTime }),
        }]),
      ])
      const selected = documents.slice(-limit).reverse()
      return {
        hits: selected.map((hit, index) => ({
          text: hit.text,
          score: 1 / (index + 1),
          source: {
            type: 'session-event',
            sessionId: String(hit.sessionId),
            seq: hit.seq,
            time: hit.time,
            eventType: hit.type,
            surface: hit.surface,
          },
        })),
        truncated: documents.length > limit,
      }
    }
    context.signal?.throwIfAborted()
    return {
      hits: page.items.map((hit, index) => ({
        text: hit.snippet,
        score: 1 / (index + 1),
        source: {
          type: 'session-event',
          sessionId: page.session.id,
          seq: hit.seq,
          time: hit.time,
          eventType: hit.type,
          surface: hit.surface,
          ...(page.session.cwd === undefined ? {} : { cwd: page.session.cwd }),
        },
      })),
      truncated: page.nextCursor !== undefined,
    }
  }

  /** Search all native Sessions without copying their content into Patchouli storage. */
  async searchAll(
    request: SessionIndexCrossSearchRequest<TSessionId>,
    context: NativeContextModuleContext,
  ): Promise<SessionIndexSearchResult> {
    const limit = readLimit(request.limit)
    const hits: SessionIndexSearchHit[] = []
    let offset = 0
    let truncated = false
    do {
      const page = await this.searchAllPage({ ...request, limit }, offset, context)
      hits.push(...page.hits)
      truncated ||= page.truncated
      if (page.nextOffset === undefined) break
      offset = page.nextOffset
    } while (hits.length < limit)
    hits.sort((left, right) => right.source.time - left.source.time)
    return {
      hits: hits.slice(0, limit).map((hit, index) => ({ ...hit, score: 1 / (index + 1) })),
      truncated: truncated || hits.length > limit,
    }
  }

  /** Search one bounded batch so interactive consumers can display results incrementally. */
  async searchAllPage(
    request: SessionIndexCrossSearchRequest<TSessionId>,
    offset: number,
    context: NativeContextModuleContext,
  ): Promise<SessionIndexSearchPage> {
    const query = request.query.trim()
    if (query === '') throw new TypeError('session search query must be non-empty')
    const limit = readLimit(request.limit)
    const timeFilter = request.fromTime === undefined && request.toTime === undefined
      ? undefined
      : {
          kind: 'time' as const,
          ...(request.fromTime === undefined ? {} : { from: request.fromTime }),
          ...(request.toTime === undefined ? {} : { to: request.toTime }),
        }
    context.signal?.throwIfAborted()
    try {
      if (offset > 0) throw new Error('continue fallback scan')
      const page = await this.sessionQuery.searchSessions({
        query,
        ...(timeFilter === undefined ? {} : { eventFilters: [timeFilter] }),
        limit: request.excludeSessionId === undefined ? limit : Math.min(limit + 1, SESSION_INDEX_MAX_LIMIT),
      }, { signal: context.signal })
      const items = page.items.filter(item => item.header.id !== request.excludeSessionId).slice(0, limit)
      return {
        hits: items.map((item, index) => ({
          text: item.bestMatch.snippet,
          score: 1 / (index + 1),
          source: {
            type: 'session-event',
            sessionId: item.header.id,
            seq: item.bestMatch.seq,
            time: item.bestMatch.time,
            eventType: item.bestMatch.type,
            surface: item.bestMatch.surface,
            ...(item.header.cwd === undefined ? {} : { cwd: item.header.cwd }),
          },
        })),
        truncated: page.nextCursor !== undefined || items.length < page.items.length,
      }
    } catch {
      context.signal?.throwIfAborted()
      const sessions = this.listSessionHeaders === undefined
        ? await this.sessionQuery.listSessions(context.signal)
        : (await this.listSessionHeaders(context.signal)).map(header => ({ header }))
      const candidates = sessions.filter(session => session.header.id !== request.excludeSessionId)
      const batch = candidates.slice(offset, offset + 8)
      const hits: SessionIndexSearchHit[] = []
      const filters = [
        { kind: 'text' as const, text: query },
        ...(timeFilter === undefined ? [] : [timeFilter]),
      ]
      context.signal?.throwIfAborted()
      const documents = await Promise.all(batch.map(async (session) => {
        try {
          return await this.sessionQuery.filterEvents(session.header.id as TSessionId, filters)
        } catch {
          context.signal?.throwIfAborted()
          return []
        }
      }))
      for (let index = 0; index < batch.length; index += 1) {
        const session = batch[index]
        if (session === undefined) continue
        for (const hit of documents[index] ?? []) hits.push({
          text: hit.text,
          score: 0,
          source: {
            type: 'session-event',
            sessionId: String(hit.sessionId),
            seq: hit.seq,
            time: hit.time,
            eventType: hit.type,
            surface: hit.surface,
            ...(session.header.cwd === undefined ? {} : { cwd: session.header.cwd }),
          },
        })
      }
      hits.sort((left, right) => right.source.time - left.source.time)
      return {
        hits: hits.slice(0, limit).map((hit, index) => ({ ...hit, score: 1 / (index + 1) })),
        truncated: hits.length > limit || offset + batch.length < candidates.length,
        ...(offset + batch.length < candidates.length ? { nextOffset: offset + batch.length } : {}),
      }
    }
  }

  async expand(
    source: SessionContextSource,
    context: NativeContextModuleContext,
    radius = 3,
  ): Promise<readonly SessionContextRecord[]> {
    context.signal?.throwIfAborted()
    const window = await this.sessionQuery.readEvent({
      sessionId: source.sessionId as TSessionId,
      seq: source.seq,
      before: radius,
      after: radius,
    }, context.signal)
    context.signal?.throwIfAborted()
    return (window.events ?? [window.target]).flatMap((event) => {
      const kind = indexedEventKinds.get(event.type)
      return kind === undefined ? [] : [normalizeEvent(window.session, source.surface, event)]
    })
  }

  async index(
    request: SessionIndexRequest<TSessionId>,
    context: NativeContextModuleContext,
  ): Promise<SessionIndexResult> {
    const sessionId = resolveSessionId(request)
    const afterSeq = readAfterSeq(request.afterSeq)
    const throughSeq = readThroughSeq(request.throughSeq, afterSeq)
    const limit = readLimit(request.limit)

    context.signal?.throwIfAborted()
    const eventRecords = await abortable(
      this.sessionQuery.listEvents(sessionId),
      context.signal,
    )
    context.signal?.throwIfAborted()

    const candidates: SessionEventRecordSnapshot[] = []
    for (const record of eventRecords) {
      if (
        indexedEventKinds.has(record.type)
        && record.seq > afterSeq
        && (throughSeq === undefined || record.seq <= throughSeq)
      ) {
        candidates.push(record)
        if (candidates.length > limit) break
      }
    }
    const selected = candidates.slice(0, limit)
    const records: SessionContextRecord[] = []
    let session: SessionHeaderSnapshot | undefined

    if (this.sessionQuery.readSession !== undefined) {
      const snapshot = await abortable(this.sessionQuery.readSession(sessionId), context.signal)
      context.signal?.throwIfAborted()
      session = snapshot.session
      const eventsBySeq = new Map(snapshot.events.map(event => [event.seq, event]))
      for (const record of selected) {
        const event = eventsBySeq.get(record.seq)
        if (event === undefined) {
          throw new Error(`session ${JSON.stringify(String(sessionId))} event ${record.seq} disappeared while indexing`)
        }
        records.push(normalizeEvent(snapshot.session, record.surface, event))
      }
    } else {
      for (const record of selected) {
        context.signal?.throwIfAborted()
        const window = await this.sessionQuery.readEvent({
          sessionId,
          seq: record.seq,
          before: 0,
          after: 0,
        }, context.signal)
        context.signal?.throwIfAborted()
        session ??= window.session
        records.push(normalizeEvent(window.session, record.surface, window.target))
      }
    }

    if (session === undefined) {
      const anchor = eventRecords.find(record => record.seq > afterSeq && (
        throughSeq === undefined || record.seq <= throughSeq
      )) ?? eventRecords.at(-1)
      if (anchor === undefined) {
        throw new Error(`session ${JSON.stringify(String(sessionId))} has no readable event in the requested range`)
      }
      const window = await this.sessionQuery.readEvent({
        sessionId,
        seq: anchor.seq,
        before: 0,
        after: 0,
      }, context.signal)
      context.signal?.throwIfAborted()
      session = window.session
    }

    return {
      session,
      records,
      nextAfterSeq: selected.at(-1)?.seq ?? afterSeq,
      hasMore: candidates.length > selected.length,
    }
  }
}

function resolveSessionId<TSessionId extends string>(
  request: SessionIndexRequest<TSessionId>,
): TSessionId {
  if (request.sessionId !== undefined) {
    if (request.sessionId.trim() === '') throw new Error('session index sessionId must be non-empty')
    return request.sessionId
  }
  const current = request.meta?.attributes?.sessionId
  if (typeof current !== 'string' || current.trim() === '') {
    throw new Error('session index requires sessionId or meta.attributes.sessionId')
  }
  return current as TSessionId
}

function readLimit(value: number | undefined): number {
  const limit = value ?? SESSION_INDEX_DEFAULT_LIMIT
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > SESSION_INDEX_MAX_LIMIT) {
    throw new RangeError(`session index limit must be an integer from 1 to ${SESSION_INDEX_MAX_LIMIT}`)
  }
  return limit
}

function readAfterSeq(value: number | undefined): number {
  const seq = value ?? -1
  if (!Number.isSafeInteger(seq) || seq < -1) {
    throw new RangeError('session index afterSeq must be an integer greater than or equal to -1')
  }
  return seq
}

function readThroughSeq(value: number | undefined, afterSeq: number): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('session index throughSeq must be a non-negative integer')
  }
  if (value <= afterSeq) {
    throw new RangeError('session index throughSeq must be greater than afterSeq')
  }
  return value
}

function normalizeEvent(
  session: SessionHeaderSnapshot,
  surface: SessionContextSource['surface'],
  event: SessionEventSnapshot,
): SessionContextRecord {
  const kind = indexedEventKinds.get(event.type)
  if (kind === undefined) throw new Error(`unsupported session event ${JSON.stringify(event.type)}`)
  const data = asObject(event.data)
  const message = event.type === 'user/message' ? data : asObject(data?.message)
  const source = asObject(message?.source)
  const messageId = readString(message?.id)
  const turn = readNumber(data?.turn)
  const step = readNumber(data?.step)
  const callId = event.type === 'tool/call'
    ? readString(data?.callId)
    : readString(source?.callId)

  return {
    id: `session:${encodeURIComponent(session.id)}:event:${event.seq}`,
    kind,
    text: eventText(event),
    source: {
      type: 'session-event',
      sessionId: session.id,
      seq: event.seq,
      time: event.time,
      eventType: event.type,
      surface,
      ...session.cwd === undefined ? {} : { cwd: session.cwd },
      ...turn === undefined ? {} : { turn },
      ...step === undefined ? {} : { step },
      ...messageId === undefined ? {} : { messageId },
      ...callId === undefined ? {} : { callId },
    },
    data: event.data,
  }
}

function eventText(event: SessionEventSnapshot): string {
  const data = asObject(event.data)
  switch (event.type) {
    case 'user/message':
      return contentText(data?.content)
    case 'assistant/message':
      return contentText(asObject(data?.message)?.content)
    case 'tool/call':
      return joinText([readString(data?.name), readString(data?.arguments)])
    case 'tool/result':
      return joinText([
        contentText(asObject(data?.message)?.content),
        readString(asObject(data?.error)?.name),
        readString(asObject(data?.error)?.code),
      ])
    default:
      return ''
  }
}

function contentText(value: unknown): string {
  if (!Array.isArray(value)) return ''
  return joinText(value.flatMap(blockText))
}

function blockText(value: unknown): string[] {
  const block = asObject(value)
  switch (block?.type) {
    case 'text':
      return [readString(block.text) ?? '']
    case 'tool-call':
      return [readString(block.name) ?? '', readString(block.arguments) ?? '']
    case 'tool-result':
      return [contentText(block.content)]
    default:
      return []
  }
}

function joinText(parts: readonly (string | undefined)[]): string {
  return parts.flatMap(part => part?.trim() ? [part.trim()] : []).join('\n')
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

function abortable<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return work
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    void work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}
