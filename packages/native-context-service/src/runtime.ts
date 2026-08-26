import type {
  MemoryCallMeta,
  MemoryData,
  MemoryPlugin,
  MemoryPluginContext,
  MemoryRetrieveRequest,
  MemoryUpdateRequest,
} from 'dsh-patchouli'
import type { JsonObject, JsonValue } from 'dsh-patchouli-protocol'

import type { RepairHistoryAlgorithm } from './algo/repair-history.js'
import type { GitIndexModule, GitIndexResult } from './index/git.js'
import {
  SESSION_INDEX_DEFAULT_LIMIT,
  type SessionIndex,
  type SessionIndexSearchHit,
} from './index/session.js'
import type {
  WorkspaceIndexModule,
  WorkspaceIndexResult,
} from './index/workspace.js'
import {
  FAST_RETRIEVE_SOURCE_IDS,
  type FastRetrieveModule,
  type FastRetrieveRequest,
  type FastRetrieveResult,
  type FastRetrieveSourceId,
} from './retrieve/fast.js'
import type {
  NativeContextDeepInput,
  NativeContextDeepRequest,
  NativeContextDeepResult,
} from './retrieve/deep.js'
import type { StandardRetrieveResult } from './retrieve/standard.js'
import type { NativeContextRetrieveModule } from './types.js'
import type { NativeContextService } from './service.js'
import {
  DEFAULT_NATIVE_CONTEXT_SETTINGS,
  type NativeContextSettings,
} from './settings.js'

export const NATIVE_CONTEXT_MEMORY_PLUGIN_ID = 'native-context'
export const NATIVE_CONTEXT_SESSION_CURSOR_LIMIT = 1_024
export const NATIVE_CONTEXT_WORKSPACE_FRESHNESS_MS = 5_000
export const NATIVE_CONTEXT_WORKSPACE_FRESHNESS_LIMIT = 64

const agentLoopSource = 'agent-loop'
const sessionTurnEnd = 'session/turn-end'
const toolMemoryRetrieve = 'tool/memory-retrieve'
const fastSourceIds = new Set<string>(FAST_RETRIEVE_SOURCE_IDS)

interface WorkspaceRuntimeSource {
  readonly index: WorkspaceIndexModule
  resolveId(path: string): Promise<string | undefined>
}

interface WorkspaceFreshness {
  readonly expiresAt: number
  readonly workspaceId: string
  readonly workspace?: WorkspaceIndexResult
  readonly git?: GitIndexResult
}

interface WorkspaceRuntimeSnapshot {
  readonly workspaceId: string
  readonly workspace?: WorkspaceIndexResult
  readonly git?: GitIndexResult
}

interface GitRuntimeSource {
  readonly index: GitIndexModule
}

export interface NativeContextRetrieveReference {
  readonly citation: number
  readonly source: unknown
  readonly sourceId?: FastRetrieveSourceId
  readonly score?: number
  readonly queryIndex?: number
}

export interface NativeContextRetrieveResult {
  readonly answer: string
  readonly references: readonly NativeContextRetrieveReference[]
  readonly truncated: boolean
  readonly effort: 'low' | 'medium' | 'high'
  readonly agent: boolean
  readonly rawHits?: readonly FastRetrieveResult['hits'][number][]
}

export interface NativeContextSessionSearchPage {
  readonly hits: readonly FastRetrieveResult['hits'][number][]
  readonly nextCursor?: number
  readonly complete: boolean
}

export interface NativeContextSessionCursorStore {
  load(sessionId: string): Promise<number | undefined>
  save(sessionId: string, cursor: number): Promise<void>
}

/** Coordinates only the live sources needed by the fast MemoryPlugin path. */
export class NativeContextRuntime {
  private sessionIndex?: SessionIndex
  private workspaceSource?: WorkspaceRuntimeSource
  private readonly sessionCursors = new Map<string, number>()
  private sessionCursorStore?: NativeContextSessionCursorStore
  private settings: NativeContextSettings = DEFAULT_NATIVE_CONTEXT_SETTINGS
  private readonly workspaceFreshness = new Map<string, WorkspaceFreshness>()
  private readonly workspaceRefreshes = new Map<string, Promise<WorkspaceRuntimeSnapshot | undefined>>()
  private gitSource?: GitRuntimeSource

  constructor(private readonly nativeContext: NativeContextService) {}

  configure(settings: NativeContextSettings): void {
    this.settings = settings
  }

  useSessionIndex(index: SessionIndex): () => void {
    this.sessionIndex = index
    return () => {
      if (this.sessionIndex === index) this.sessionIndex = undefined
    }
  }

  useSessionCursorStore(store: NativeContextSessionCursorStore): () => void {
    this.sessionCursorStore = store
    return () => {
      if (this.sessionCursorStore === store) this.sessionCursorStore = undefined
    }
  }

  useWorkspaceSource(source: WorkspaceRuntimeSource): () => void {
    this.workspaceFreshness.clear()
    this.workspaceSource = source
    return () => {
      if (this.workspaceSource === source) {
        this.workspaceSource = undefined
        this.workspaceFreshness.clear()
      }
    }
  }

  useGitSource(source: GitRuntimeSource): () => void {
    this.workspaceFreshness.clear()
    this.gitSource = source
    return () => {
      if (this.gitSource === source) {
        this.gitSource = undefined
        this.workspaceFreshness.clear()
      }
    }
  }

  async update(
    request: MemoryUpdateRequest,
    context: MemoryPluginContext,
  ): Promise<MemoryData> {
    if (stringAttribute(request.meta, 'point') !== sessionTurnEnd) {
      return { indexed: 0 }
    }
    const sessionId = requiredAttribute(request.meta, 'sessionId')
    const meta = databaseMeta(request.meta)
    const indexed = await this.refreshSession(
      sessionId,
      meta,
      sessionRange(request.data),
      context.signal,
    )
    return { sessionId, indexed }
  }

  async retrieve(
    request: MemoryRetrieveRequest,
    context: MemoryPluginContext,
  ): Promise<MemoryData> {
    const parsed = retrieveInput(request.data)
    const effort = parsed.effort ?? this.settings.effort
    const agent = parsed.agent ?? this.settings.agent
    if (!this.nativeContext.hasRetriever('fast')) {
      return memoryResult({
        answer: '',
        references: [],
        truncated: false,
        effort,
        agent,
      } satisfies NativeContextRetrieveResult)
    }
    const sessionId = stringAttribute(request.meta, 'sessionId')
    const meta = databaseMeta(request.meta)
    const workspaceRoot = stringAttribute(request.meta, 'workspaceRoot')
    const sourceIds = selectedRuntimeSources(parsed.sourceIds, this.settings.gitEnabled)
    const wantsWorkspace = sourceIds === undefined
      || sourceIds.includes('workspace-context')
      || sourceIds.includes('project-state')
      || sourceIds.includes('git-context')
    context.signal?.throwIfAborted()
    const native = !wantsWorkspace
      ? undefined
      : await this.refreshWorkspace(workspaceRoot, sourceIds, context.signal)
    context.signal?.throwIfAborted()

    const fast = this.nativeContext.getRetriever('fast') as FastRetrieveModule
    const fastRequest: FastRetrieveRequest = {
      meta,
      query: parsed.query,
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(native === undefined ? {} : {
        workspaceId: native.workspaceId,
        native: {
          ...(native.workspace === undefined ? {} : { workspace: native.workspace }),
          ...(native.git === undefined ? {} : { git: native.git }),
        },
      }),
      ...(sourceIds === undefined ? {} : { sourceIds }),
      ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
      maxCharacters: parsed.maxCharacters
        ?? maxCharactersForEffort(this.settings, effort),
      expandSources: effort !== 'low',
      ...(parsed.temporal === undefined ? {} : { temporal: parsed.temporal }),
    }
    const result = await this.retrieveForEffort(
      fast,
      fastRequest,
      effort,
      agent,
      parsed.includeRawHits,
      context,
    )
    return memoryResult({
      ...result,
      effort,
      agent,
    } satisfies NativeContextRetrieveResult)
  }

  /** One native Session search page for latency-sensitive interactive surfaces. */
  async searchSessionsPage(
    request: {
      readonly sessionId: string
      readonly query: string
      readonly cursor?: number
      readonly limit?: number
    },
    context: MemoryPluginContext,
  ): Promise<NativeContextSessionSearchPage> {
    if (this.sessionIndex === undefined) return { hits: [], complete: true }
    const limit = Math.max(1, Math.min(request.limit ?? 8, 20))
    const cursor = request.cursor ?? 0
    context.signal?.throwIfAborted()
    const [current, historical] = await Promise.all([
      request.cursor === undefined
        ? this.sessionIndex.search({
            sessionId: request.sessionId,
            query: request.query,
            limit,
          }, context)
        : Promise.resolve({ hits: [], truncated: false }),
      this.sessionIndex.searchAllPage({
        query: request.query,
        excludeSessionId: request.sessionId,
        limit,
      }, cursor, context),
    ])
    const merged: SessionIndexSearchHit[] = []
    for (let index = 0; merged.length < limit; index += 1) {
      const currentHit = current.hits[index]
      const historicalHit = historical.hits[index]
      if (currentHit === undefined && historicalHit === undefined) break
      if (currentHit !== undefined) merged.push(currentHit)
      if (historicalHit !== undefined && merged.length < limit) merged.push(historicalHit)
    }
    return {
      hits: merged.map(hit => ({
        sourceId: 'session-history',
        score: hit.score,
        text: hit.text,
        source: hit.source,
      })),
      ...(historical.nextOffset === undefined ? {} : { nextCursor: historical.nextOffset }),
      complete: historical.nextOffset === undefined,
    }
  }

  private async retrieveForEffort(
    fast: FastRetrieveModule,
    request: FastRetrieveRequest,
    effort: 'low' | 'medium' | 'high',
    agent: boolean,
    includeRawHits: boolean,
    context: MemoryPluginContext,
  ): Promise<Omit<NativeContextRetrieveResult, 'effort' | 'agent'>> {
    if (effort === 'low') {
      return presentFastResult(await fast.retrieve(request, context), includeRawHits)
    }
    if (effort === 'medium') {
      if (agent && standardConfigured(this.settings) && this.nativeContext.hasRetriever('standard')) {
        return presentStandardResult(await this.standardRetriever().retrieve(request, context))
      }
      return presentFastResult(await fast.retrieve(request, context), includeRawHits)
    }
    if (this.nativeContext.hasRetriever('deep')) {
      const evidence = await fast.retrieve(request, context)
      if (evidence.hits.length === 0) return presentFastResult(evidence, includeRawHits)
      const result = await this.deepRetriever().retrieve({
        query: request.query,
        agent,
        inputs: evidence.hits.map(deepInput),
      }, context)
      return presentDeepResult(result)
    }
    if (agent && standardConfigured(this.settings) && this.nativeContext.hasRetriever('standard')) {
      return presentStandardResult(await this.standardRetriever().retrieve(request, context))
    }
    return presentFastResult(await fast.retrieve(request, context), includeRawHits)
  }

  private standardRetriever(): NativeContextRetrieveModule<
    FastRetrieveRequest,
    StandardRetrieveResult
  > {
    return this.nativeContext.getRetriever('standard') as NativeContextRetrieveModule<
      FastRetrieveRequest,
      StandardRetrieveResult
    >
  }

  private deepRetriever(): NativeContextRetrieveModule<
    NativeContextDeepRequest,
    NativeContextDeepResult
  > {
    return this.nativeContext.getRetriever('deep') as NativeContextRetrieveModule<
      NativeContextDeepRequest,
      NativeContextDeepResult
    >
  }

  private async refreshSession(
    sessionId: string,
    meta: JsonObject,
    range: { readonly throughSeq?: number },
    signal?: AbortSignal,
  ): Promise<number> {
    if (
      this.sessionIndex === undefined
      || !this.nativeContext.hasAlgorithm('repair-history')
    ) return 0
    let afterSeq = this.sessionCursors.get(sessionId)
    if (afterSeq === undefined && this.sessionCursorStore !== undefined) {
      afterSeq = await this.sessionCursorStore.load(sessionId)
      signal?.throwIfAborted()
      if (afterSeq !== undefined) this.rememberSessionCursor(sessionId, afterSeq)
    }
    afterSeq ??= -1
    if (range.throughSeq !== undefined && range.throughSeq <= afterSeq) return 0
    const repair = this.nativeContext.getAlgorithm('repair-history') as RepairHistoryAlgorithm
    let indexedRecords = 0
    for (;;) {
      signal?.throwIfAborted()
      const indexed = await this.sessionIndex.index({
        sessionId,
        afterSeq,
        ...(range.throughSeq === undefined ? {} : { throughSeq: range.throughSeq }),
        limit: SESSION_INDEX_DEFAULT_LIMIT,
      }, { signal })
      signal?.throwIfAborted()
      await repair.ingest({ meta, index: indexed }, { signal })
      signal?.throwIfAborted()
      indexedRecords += indexed.records.length
      if (!indexed.hasMore) {
        const cursor = range.throughSeq ?? indexed.nextAfterSeq
        this.rememberSessionCursor(sessionId, cursor)
        await this.sessionCursorStore?.save(sessionId, cursor)
        signal?.throwIfAborted()
        return indexedRecords
      }
      if (indexed.nextAfterSeq <= afterSeq) {
        throw new Error(`session index cursor did not advance for ${JSON.stringify(sessionId)}`)
      }
      afterSeq = indexed.nextAfterSeq
    }
  }

  private rememberSessionCursor(sessionId: string, cursor: number): void {
    if (
      !this.sessionCursors.has(sessionId)
      && this.sessionCursors.size >= NATIVE_CONTEXT_SESSION_CURSOR_LIMIT
    ) {
      const oldest = this.sessionCursors.keys().next().value
      if (oldest !== undefined) this.sessionCursors.delete(oldest)
    }
    this.sessionCursors.set(sessionId, cursor)
  }

  private async refreshWorkspace(
    workspaceRoot: string | undefined,
    sourceIds: readonly FastRetrieveSourceId[] | undefined,
    signal?: AbortSignal,
  ): Promise<WorkspaceRuntimeSnapshot | undefined> {
    if (this.workspaceSource === undefined || workspaceRoot === undefined) return undefined
    const key = JSON.stringify([workspaceRoot, sourceIds === undefined ? '*' : [...sourceIds].sort()])
    const active = this.workspaceRefreshes.get(key)
    if (active !== undefined) return active
    const task = this.performWorkspaceRefresh(workspaceRoot, sourceIds, signal)
    this.workspaceRefreshes.set(key, task)
    try {
      return await task
    } finally {
      if (this.workspaceRefreshes.get(key) === task) this.workspaceRefreshes.delete(key)
    }
  }

  private async performWorkspaceRefresh(
    workspaceRoot: string,
    sourceIds: readonly FastRetrieveSourceId[] | undefined,
    signal?: AbortSignal,
  ): Promise<WorkspaceRuntimeSnapshot | undefined> {
    const source = this.workspaceSource
    if (source === undefined) return undefined
    const wantsWorkspace = (
      sourceIds === undefined || sourceIds.includes('workspace-context')
        || sourceIds?.includes('project-state') === true
        || sourceIds?.includes('context-catalog') === true
    ) && this.nativeContext.hasIndex('workspace')
    const wantsGit = this.settings.gitEnabled
      && (sourceIds === undefined
        || sourceIds.includes('git-context')
        || sourceIds.includes('context-catalog'))
      && this.gitSource !== undefined
      && this.nativeContext.hasIndex('git')
    if (!wantsWorkspace && !wantsGit) return undefined
    signal?.throwIfAborted()
    const workspaceId = await source.resolveId(workspaceRoot)
    signal?.throwIfAborted()
    if (workspaceId === undefined) return undefined
    const fresh = this.workspaceFreshness.get(workspaceId)
    if (
      fresh !== undefined
      && fresh.expiresAt > Date.now()
      && (!wantsWorkspace || fresh.workspace !== undefined)
      && (!wantsGit || fresh.git !== undefined)
    ) return fresh
    if (fresh !== undefined && fresh.expiresAt <= Date.now()) {
      this.workspaceFreshness.delete(workspaceId)
    }
    const workspaceTask = wantsWorkspace
      ? source.index.index({ workspaceId }, { signal })
      : undefined
    const gitTask = wantsGit
      ? this.gitSource?.index.index({
          workspaceId,
          fetchRemote: this.settings.gitFetchRemote,
          fetchIntervalMinutes: this.settings.gitFetchIntervalMinutes,
          commitLimit: this.settings.gitCommitLimit,
          pathLimit: this.settings.gitPathLimit,
        }, { signal })
      : undefined
    const [indexed, gitIndexed] = await Promise.all([workspaceTask, gitTask])
    signal?.throwIfAborted()
    const workspace = indexed ?? fresh?.workspace
    const git = gitIndexed ?? fresh?.git
    const snapshot: WorkspaceFreshness = {
      workspaceId,
      expiresAt: Date.now() + NATIVE_CONTEXT_WORKSPACE_FRESHNESS_MS,
      ...(workspace === undefined ? {} : { workspace }),
      ...(git === undefined ? {} : { git }),
    }
    this.rememberWorkspaceFreshness(snapshot)
    return snapshot
  }

  private rememberWorkspaceFreshness(snapshot: WorkspaceFreshness): void {
    if (
      !this.workspaceFreshness.has(snapshot.workspaceId)
      && this.workspaceFreshness.size >= NATIVE_CONTEXT_WORKSPACE_FRESHNESS_LIMIT
    ) {
      const oldest = this.workspaceFreshness.keys().next().value
      if (oldest !== undefined) this.workspaceFreshness.delete(oldest)
    }
    this.workspaceFreshness.delete(snapshot.workspaceId)
    this.workspaceFreshness.set(snapshot.workspaceId, snapshot)
  }
}

function deepInput(hit: FastRetrieveResult['hits'][number]): NativeContextDeepInput {
  return {
    text: hit.text,
    source: {
      kind: hit.sourceId,
      source: hit.source,
      score: hit.score,
    },
  }
}

function presentFastResult(
  result: FastRetrieveResult,
  includeRawHits: boolean,
): Omit<NativeContextRetrieveResult, 'effort' | 'agent'> {
  return {
    answer: result.hits.map((hit, index) => `[${index + 1}] ${hit.text}`).join('\n\n'),
    references: result.hits.map((hit, index) => ({
      citation: index + 1,
      sourceId: hit.sourceId,
      score: hit.score,
      source: hit.source,
    })),
    truncated: result.truncated,
    ...(includeRawHits ? { rawHits: result.hits } : {}),
  }
}

function presentStandardResult(
  result: StandardRetrieveResult,
): Omit<NativeContextRetrieveResult, 'effort' | 'agent'> {
  return {
    answer: result.answer,
    references: result.references.map((reference, index) => ({
      citation: index + 1,
      queryIndex: reference.queryIndex,
      source: reference.source,
    })),
    truncated: false,
  }
}

function presentDeepResult(
  result: NativeContextDeepResult,
): Omit<NativeContextRetrieveResult, 'effort' | 'agent'> {
  return {
    answer: result.text,
    references: result.sources.map((source, index) => ({
      citation: index + 1,
      source,
    })),
    truncated: result.truncated,
  }
}

function selectedRuntimeSources(
  sourceIds: readonly FastRetrieveSourceId[] | undefined,
  gitEnabled: boolean,
): readonly FastRetrieveSourceId[] | undefined {
  if (gitEnabled) return sourceIds
  return (sourceIds ?? FAST_RETRIEVE_SOURCE_IDS).filter(sourceId => sourceId !== 'git-context')
}

function standardConfigured(settings: NativeContextSettings): boolean {
  return settings.standardProvider.trim() !== '' && settings.standardModel.trim() !== ''
}

export function createNativeContextMemoryPlugin(
  runtime: NativeContextRuntime,
): MemoryPlugin {
  return {
    id: NATIVE_CONTEXT_MEMORY_PLUGIN_ID,
    filter(call) {
      if (call.meta.source.type !== agentLoopSource) return false
      const point = stringAttribute(call.meta, 'point')
      return call.operation === 'retrieve'
        ? point === toolMemoryRetrieve
        : call.operation === 'update' && point === sessionTurnEnd
    },
    update: (request, context) => runtime.update(request, context),
    retrieve: (request, context) => runtime.retrieve(request, context),
  }
}

function retrieveInput(data: JsonValue): {
  readonly query: string
  readonly limit?: number
  readonly sourceIds?: readonly FastRetrieveSourceId[]
  readonly maxCharacters?: number
  readonly effort?: 'low' | 'medium' | 'high'
  readonly agent?: boolean
  readonly includeRawHits: boolean
  readonly temporal?: { readonly from?: number; readonly to?: number }
} {
  if (!isObject(data)) throw new TypeError('native context retrieval data must be an object')
  const query = requiredString(data.query, 'native context query')
  const limit = optionalPositiveInteger(data.limit, 'native context limit')
  const metadata = data.metadata
  if (metadata !== undefined && !isObject(metadata)) {
    throw new TypeError('native context metadata must be an object')
  }
  const sourceIds = metadata === undefined
    ? undefined
    : optionalSourceIds(metadata.sourceIds)
  const maxCharacters = metadata === undefined
    ? undefined
    : optionalPositiveInteger(metadata.maxCharacters, 'native context maxCharacters')
  const effort = metadata === undefined ? undefined : optionalEffort(metadata.effort)
  const agent = metadata === undefined ? undefined : optionalBoolean(metadata.agent, 'native context agent')
  const includeRawHits = metadata === undefined
    ? false
    : optionalBoolean(metadata.includeRawHits, 'native context includeRawHits') ?? false
  const temporal = metadata === undefined ? undefined : optionalTemporal(metadata.temporal)
  return { query, limit, sourceIds, maxCharacters, effort, agent, includeRawHits, temporal }
}

function optionalTemporal(
  value: unknown,
): { readonly from?: number; readonly to?: number } | undefined {
  if (value === undefined) return undefined
  if (!isObject(value)) throw new TypeError('native context temporal must be an object')
  const from = optionalTimestamp(value.from, 'native context temporal.from')
  const to = optionalTimestamp(value.to, 'native context temporal.to')
  if (from === undefined && to === undefined) return undefined
  if (from !== undefined && to !== undefined && from > to) {
    throw new RangeError('native context temporal.from must not exceed temporal.to')
  }
  return { from, to }
}

function optionalTimestamp(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const time = Date.parse(value)
    if (Number.isFinite(time)) return time
  }
  throw new TypeError(`${name} must be an epoch millisecond number or ISO date`)
}

function optionalEffort(value: unknown): 'low' | 'medium' | 'high' | undefined {
  if (value === undefined) return undefined
  if (value === 'low' || value === 'medium' || value === 'high') return value
  throw new TypeError('native context effort must be low, medium, or high')
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new TypeError(`${name} must be a boolean`)
  return value
}

function maxCharactersForEffort(
  settings: NativeContextSettings,
  effort: 'low' | 'medium' | 'high',
): number {
  if (effort === 'low') return settings.lowMaxCharacters
  if (effort === 'medium') return settings.mediumMaxCharacters
  return settings.highMaxCharacters
}

function optionalSourceIds(value: unknown): readonly FastRetrieveSourceId[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new TypeError('native context sourceIds must be an array')
  return value.map((sourceId) => {
    if (typeof sourceId !== 'string' || !fastSourceIds.has(sourceId)) {
      throw new TypeError(`unknown native context source id: ${String(sourceId)}`)
    }
    return sourceId as FastRetrieveSourceId
  })
}

function optionalPositiveInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new TypeError(`${name} must be a positive safe integer`)
  }
  return Number(value)
}

function sessionRange(data: JsonValue): { readonly throughSeq?: number } {
  if (!isObject(data)) return {}
  const seqs = Array.isArray(data.events)
    ? data.events.flatMap(event => isObject(event) && isSequence(event.seq) ? [event.seq] : [])
    : []
  const event = data.event
  const throughSeq = isObject(event) && isSequence(event.seq)
    ? event.seq
    : seqs.length === 0 ? undefined : Math.max(...seqs)
  return throughSeq === undefined ? {} : { throughSeq }
}

function databaseMeta(meta: MemoryCallMeta): JsonObject {
  return {
    workspace_id: meta.scope,
    user_id: `${meta.source.type}:${meta.source.id}`,
    channel_id: stringAttribute(meta, 'sessionId') ?? meta.source.type,
  }
}

function memoryResult(result: unknown): MemoryData {
  return result as MemoryData
}

function stringAttribute(meta: MemoryCallMeta, name: string): string | undefined {
  const value = meta.attributes?.[name]
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function requiredAttribute(meta: MemoryCallMeta, name: string): string {
  const value = stringAttribute(meta, name)
  if (value === undefined) throw new TypeError(`native context requires meta.attributes.${name}`)
  return value
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${name} must be non-empty`)
  }
  return value.trim()
}

function isSequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
