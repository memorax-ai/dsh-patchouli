import type { MemoryData, MemoryMetadata } from 'dsh-patchouli'
import type { PatchouliStorageService } from 'dsh-patchouli/storage'

import type { WorkspaceFileSource, WorkspaceIndexResult } from '../index/workspace.js'
import type {
  NativeContextAlgorithmModule,
  NativeContextModuleContext,
} from '../types.js'

export const WORKSPACE_CONTEXT_DEFAULT_LIMIT = 10
export const WORKSPACE_CONTEXT_MAX_LIMIT = 50

export interface WorkspaceContextIngestRequest {
  readonly meta: MemoryMetadata
  readonly index: WorkspaceIndexResult
}

export interface WorkspaceContextIngestedEntity {
  readonly id: string
  readonly version: string
  readonly operation: 'create' | 'update' | 'unchanged'
  readonly source: WorkspaceFileSource
}

export interface WorkspaceContextIngestResult {
  readonly entities: readonly WorkspaceContextIngestedEntity[]
  readonly deleted: number
}

export type NativeContextQueryOrder =
  | 'relevance'
  | 'newest'
  | 'oldest'
  | 'id_asc'
  | 'id_desc'

export interface WorkspaceContextQuery {
  readonly meta: MemoryMetadata
  readonly text?: string
  readonly workspaceId: string
  readonly kind?: 'workspace-file'
  readonly path?: string
  readonly order?: NativeContextQueryOrder
  readonly limit?: number
}

export interface WorkspaceContextQueryHit {
  readonly id: string
  readonly version: string
  readonly score: number
  readonly text: string | null
  readonly metadata: Readonly<Record<string, unknown>>
  readonly source: WorkspaceFileSource
}

export interface WorkspaceContextQueryResult {
  readonly hits: readonly WorkspaceContextQueryHit[]
}

type WorkspaceContextStorage = Pick<
  PatchouliStorageService,
  'create' | 'delete' | 'query' | 'queryPages' | 'read' | 'update'
>

interface StoredContextExtension {
  readonly context_kind: 'workspace-file'
  readonly workspace_id: string
  readonly path: string
  readonly name: string
  readonly size: number | null
  readonly version: string | null
  readonly text_truncated: boolean
  readonly source: WorkspaceFileSource
}

interface CurrentContextEntity {
  readonly exists: boolean
  readonly active: ReadonlyArray<{ readonly version: string; readonly value: unknown }>
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stableId(kind: string, workspaceId: string, path: string): string {
  return `native-context:${kind}:${workspaceId.length}:${workspaceId}:${path.length}:${path}`
}

function queryLimit(value: number | undefined): number {
  const limit = value ?? WORKSPACE_CONTEXT_DEFAULT_LIMIT
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > WORKSPACE_CONTEXT_MAX_LIMIT) {
    throw new RangeError(
      `workspace context limit must be an integer from 1 to ${WORKSPACE_CONTEXT_MAX_LIMIT}`,
    )
  }
  return limit
}

function queryText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const text = value.trim()
  if (text === '') throw new TypeError('workspace context query text must be non-empty')
  return text
}

function queryOrder(
  value: NativeContextQueryOrder | undefined,
  text: string | undefined,
): NativeContextQueryOrder {
  const order = value ?? (text === undefined ? 'newest' : 'relevance')
  if (order === 'relevance' && text === undefined) {
    throw new TypeError('workspace context relevance order requires query text')
  }
  return order
}

function isNotFound(error: unknown): boolean {
  return isObject(error) && error.reason === 'NOT_FOUND'
}

function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => sameJson(value, right[index]))
  }
  if (!isObject(left) || !isObject(right)) return false
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  return leftKeys.length === rightKeys.length
    && leftKeys.every(key => Object.hasOwn(right, key) && sameJson(left[key], right[key]))
}

function sameContextValue(left: unknown, right: unknown): boolean {
  if (!isObject(left) || !isObject(right)) return false
  const leftMetadata = left.metadata
  const rightMetadata = right.metadata
  if (!isObject(leftMetadata) || !isObject(rightMetadata)) return false
  return sameJson(left.content, right.content)
    && sameJson(leftMetadata.extensions, rightMetadata.extensions)
    && sameJson(left.artifact, right.artifact)
    && sameJson(left.profile, right.profile)
}

function contextValue(
  index: WorkspaceIndexResult,
  file: WorkspaceIndexResult['files'][number],
): MemoryData {
  const now = new Date().toISOString()
  const extension = {
    context_kind: 'workspace-file',
    workspace_id: index.workspace.id,
    path: file.path,
    name: file.name,
    size: file.size,
    version: file.version,
    text_truncated: file.textTruncated,
    source: { ...file.source },
  } satisfies StoredContextExtension
  const searchableText = [file.path, file.text]
    .filter((value): value is string => typeof value === 'string' && value !== '')
    .join('\n')
  return {
    content: { kind: 'text', text: searchableText },
    metadata: {
      core: {
        schema: 'patchouli.knowledge@1',
        scope: {
          tenant: null,
          workspace: index.workspace.id,
          user: null,
          session: null,
        },
        origin: {
          provider: 'deepseek-harness',
          binding: 'dsh-patchouli-native-context-service',
          native_type: 'workspace-file',
          native_id: `${index.workspace.id}:${file.path}`,
          native_revision: file.version,
        },
        time: {
          event_at: null,
          source_created_at: null,
          source_updated_at: null,
          observed_at: now,
          ingested_at: now,
        },
        lifecycle: { status: 'active', expires_at: null },
        provenance: [{
          kind: 'observed',
          actor: 'plugin:dsh-patchouli-native-context-service',
          source: file.source.uri,
          recorded_at: now,
        }],
      },
      extensions: { 'dsh.native_context': extension },
    },
    artifact: [],
    profile: {
      epistemic: 'observation',
      temporal: { kind: 'timeless' },
      ownership: 'shared',
      abstraction: 'instance',
      persistence: 'working',
      retrieval: ['exact', 'contextual'],
      actionability: 'informational',
    },
  }
}

function sourceFromValue(value: unknown): WorkspaceFileSource | undefined {
  if (!isObject(value)) return undefined
  const metadata = value.metadata
  if (!isObject(metadata) || !isObject(metadata.extensions)) return undefined
  const extension = metadata.extensions['dsh.native_context']
  if (!isObject(extension) || extension.context_kind !== 'workspace-file') return undefined
  const source = extension.source
  if (!isObject(source)
    || source.kind !== 'workspace-file'
    || typeof source.workspaceId !== 'string'
    || typeof source.workspacePath !== 'string'
    || typeof source.path !== 'string'
    || typeof source.uri !== 'string'
    || (source.version !== null && typeof source.version !== 'string')) return undefined
  return source as unknown as WorkspaceFileSource
}

function textFromValue(value: Record<string, unknown>): string | null {
  const content = value.content
  if (!isObject(content)) return null
  if (content.kind === 'text') return typeof content.text === 'string' ? content.text : null
  if (content.kind === 'structured' && isObject(content.value)) {
    return typeof content.value.text === 'string' ? content.value.text : null
  }
  return null
}

/** Persists and queries normalized workspace file context in Patchouli. */
export class WorkspaceContextAlgorithm implements NativeContextAlgorithmModule<
  WorkspaceContextIngestRequest,
  WorkspaceContextIngestResult,
  WorkspaceContextQuery,
  WorkspaceContextQueryResult
> {
  readonly id = 'workspace-context'

  constructor(private readonly storage: WorkspaceContextStorage) {}

  async ingest(
    request: WorkspaceContextIngestRequest,
    context: NativeContextModuleContext,
  ): Promise<WorkspaceContextIngestResult> {
    const entities: WorkspaceContextIngestedEntity[] = []
    const expectedIds = new Set<string>()
    for (const file of request.index.files) {
      context.signal?.throwIfAborted()
      const id = stableId('workspace-file', request.index.workspace.id, file.path)
      expectedIds.add(id)
      const value = contextValue(request.index, file)
      const current = await this.readCurrent(request.meta, id, context.signal)
      context.signal?.throwIfAborted()
      const unchanged = current.active.find(variant => sameContextValue(variant.value, value))
      if (unchanged !== undefined) {
        entities.push({
          id,
          version: unchanged.version,
          operation: 'unchanged',
          source: file.source,
        })
        continue
      }
      const operation = current.exists ? 'update' : 'create'
      const result = operation === 'update'
        ? await this.storage.update({
            meta: { ...request.meta, base_versions: current.active.map(variant => variant.version) },
            data: { ref: { type: 'knowledge', id }, value },
          })
        : await this.storage.create({
            meta: request.meta,
            data: { type: 'knowledge', id, value },
          })
      context.signal?.throwIfAborted()
      if (result.data.entity.state !== 'active') {
        throw new Error(`workspace context ingestion did not produce an active entity: ${id}`)
      }
      entities.push({ id, version: result.data.entity.version, operation, source: file.source })
    }
    const deleted = request.index.truncated
      ? 0
      : await this.deleteStale(
          request.meta,
          request.index.workspace.id,
          expectedIds,
          context.signal,
        )
    return { entities, deleted }
  }

  async query(
    request: WorkspaceContextQuery,
    context: NativeContextModuleContext,
  ): Promise<WorkspaceContextQueryResult> {
    if (request.workspaceId.trim() === '') {
      throw new TypeError('workspace context query workspaceId must be non-empty')
    }
    if (request.path !== undefined && request.path.trim() === '') {
      throw new TypeError('workspace context query path must be non-empty')
    }
    const text = queryText(request.text)
    const order = queryOrder(request.order, text)
    const limit = queryLimit(request.limit)
    const where: Record<string, string> = {
      '/metadata/extensions/dsh.native_context/context_kind': request.kind ?? 'workspace-file',
      '/metadata/extensions/dsh.native_context/workspace_id': request.workspaceId,
    }
    if (request.path !== undefined) {
      where['/metadata/extensions/dsh.native_context/path'] = request.path
    }
    context.signal?.throwIfAborted()
    const response = await this.storage.query(
      request.meta,
      { ...(text === undefined ? {} : { text }), where, order },
      { types: ['knowledge'], limit },
    )
    context.signal?.throwIfAborted()

    const hits: WorkspaceContextQueryHit[] = []
    for (const hit of response.data.hits) {
      for (const variant of hit.variants) {
        if (variant.state !== 'active' || !isObject(variant.value)) continue
        const source = sourceFromValue(variant.value)
        const metadata = variant.value.metadata
        if (source === undefined || !isObject(metadata)) continue
        hits.push({
          id: variant.ref.id,
          version: variant.version,
          score: hit.score,
          text: textFromValue(variant.value),
          metadata,
          source,
        })
      }
    }
    return { hits }
  }

  private async readCurrent(
    meta: MemoryMetadata,
    id: string,
    signal?: AbortSignal,
  ): Promise<CurrentContextEntity> {
    try {
      const result = await this.storage.read({
        meta,
        data: { ref: { type: 'knowledge', id } },
      })
      signal?.throwIfAborted()
      return {
        exists: true,
        active: result.data.variants.flatMap(variant => variant.state === 'active'
          ? [{ version: variant.version, value: variant.value }]
          : []),
      }
    } catch (error: unknown) {
      signal?.throwIfAborted()
      if (isNotFound(error)) return { exists: false, active: [] }
      throw error
    }
  }

  private async deleteStale(
    meta: MemoryMetadata,
    workspaceId: string,
    expectedIds: ReadonlySet<string>,
    signal?: AbortSignal,
  ): Promise<number> {
    const stale: Array<{ readonly id: string; readonly versions: readonly string[] }> = []
    const pages = this.storage.queryPages(
      meta,
      {
        where: {
          '/metadata/extensions/dsh.native_context/context_kind': 'workspace-file',
          '/metadata/extensions/dsh.native_context/workspace_id': workspaceId,
        },
        order: 'id_asc',
      },
      { types: ['knowledge'], limit: 100 },
    )
    for await (const page of pages) {
      signal?.throwIfAborted()
      for (const hit of page.data.hits) {
        const active = hit.variants.filter(variant => variant.state === 'active')
        const id = active[0]?.ref.id
        if (id === undefined || expectedIds.has(id)) continue
        stale.push({ id, versions: hit.variants.map(variant => variant.version) })
      }
    }
    for (const entity of stale) {
      signal?.throwIfAborted()
      await this.storage.delete({
        meta: { ...meta, base_versions: entity.versions },
        data: { ref: { type: 'knowledge', id: entity.id } },
      })
    }
    signal?.throwIfAborted()
    return stale.length
  }
}
