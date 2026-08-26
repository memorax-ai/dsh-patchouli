import type { MemoryData, MemoryMetadata } from 'dsh-patchouli'
import type { PatchouliStorageService } from 'dsh-patchouli/storage'

import type {
  ProjectDocumentKind,
  ProjectIndexResult,
} from '../index/project.js'
import type { WorkspaceFileSource } from '../index/workspace.js'
import type {
  NativeContextAlgorithmModule,
  NativeContextModuleContext,
} from '../types.js'
import type { NativeContextQueryOrder } from './workspace-context.js'

export const PROJECT_STATE_DEFAULT_LIMIT = 10
export const PROJECT_STATE_MAX_LIMIT = 50

export interface ProjectStateIngestRequest {
  readonly meta: MemoryMetadata
  readonly index: ProjectIndexResult
}

export interface ProjectStateIngestedEntity {
  readonly id: string
  readonly version: string
  readonly operation: 'create' | 'update' | 'unchanged'
  readonly documentKind: ProjectDocumentKind
  readonly source: WorkspaceFileSource
}

export interface ProjectStateIngestResult {
  readonly entities: readonly ProjectStateIngestedEntity[]
  readonly deleted: number
}

export interface ProjectStateQuery {
  readonly meta: MemoryMetadata
  readonly text?: string
  readonly workspaceId: string
  readonly kind?: ProjectDocumentKind
  readonly path?: string
  readonly order?: NativeContextQueryOrder
  readonly limit?: number
}

export interface ProjectStateQueryHit {
  readonly id: string
  readonly version: string
  readonly score: number
  readonly documentKind: ProjectDocumentKind
  readonly text: string | null
  readonly metadata: Readonly<Record<string, unknown>>
  readonly source: WorkspaceFileSource
}

export interface ProjectStateQueryResult {
  readonly hits: readonly ProjectStateQueryHit[]
}

type ProjectStateStorage = Pick<
  PatchouliStorageService,
  'create' | 'delete' | 'query' | 'queryPages' | 'read' | 'update'
>

interface StoredProjectExtension {
  readonly context_kind: 'project-document'
  readonly document_kind: ProjectDocumentKind
  readonly workspace_id: string
  readonly path: string
  readonly name: string
  readonly size: number | null
  readonly version: string | null
  readonly text_truncated: boolean
  readonly source: WorkspaceFileSource
}

interface CurrentProjectEntity {
  readonly exists: boolean
  readonly active: ReadonlyArray<{ readonly version: string; readonly value: unknown }>
}

const projectDocumentKinds = new Set<ProjectDocumentKind>([
  'readme',
  'plan',
  'roadmap',
  'checklist',
  'tasks',
  'contributing',
])

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stableId(workspaceId: string, kind: ProjectDocumentKind, path: string): string {
  return `native-context:project-document:${workspaceId.length}:${workspaceId}:${kind}:${path.length}:${path}`
}

function boundedLimit(value: number | undefined): number {
  const limit = value ?? PROJECT_STATE_DEFAULT_LIMIT
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > PROJECT_STATE_MAX_LIMIT) {
    throw new RangeError(`project state limit must be an integer from 1 to ${PROJECT_STATE_MAX_LIMIT}`)
  }
  return limit
}

function normalizedText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const text = value.trim()
  if (text === '') throw new TypeError('project state query text must be non-empty')
  return text
}

function selectedOrder(
  value: NativeContextQueryOrder | undefined,
  text: string | undefined,
): NativeContextQueryOrder {
  const order = value ?? (text === undefined ? 'newest' : 'relevance')
  if (order === 'relevance' && text === undefined) {
    throw new TypeError('project state relevance order requires query text')
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

function sameProjectValue(left: unknown, right: unknown): boolean {
  if (!isObject(left) || !isObject(right)) return false
  const leftMetadata = left.metadata
  const rightMetadata = right.metadata
  if (!isObject(leftMetadata) || !isObject(rightMetadata)) return false
  return sameJson(left.content, right.content)
    && sameJson(leftMetadata.extensions, rightMetadata.extensions)
    && sameJson(left.artifact, right.artifact)
    && sameJson(left.profile, right.profile)
}

function projectValue(
  index: ProjectIndexResult,
  document: ProjectIndexResult['documents'][number],
): MemoryData {
  const now = new Date().toISOString()
  const extension = {
    context_kind: 'project-document',
    document_kind: document.kind,
    workspace_id: index.workspace.id,
    path: document.path,
    name: document.name,
    size: document.size,
    version: document.version,
    text_truncated: document.textTruncated,
    source: { ...document.source },
  } satisfies StoredProjectExtension
  const searchableText = [document.kind, document.path, document.text]
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
          native_type: 'project-document',
          native_id: `${index.workspace.id}:${document.kind}:${document.path}`,
          native_revision: document.version,
        },
        time: {
          event_at: null,
          source_created_at: null,
          source_updated_at: index.workspace.updatedAt,
          observed_at: now,
          ingested_at: now,
        },
        lifecycle: { status: 'active', expires_at: null },
        provenance: [{
          kind: 'observed',
          actor: 'plugin:dsh-patchouli-native-context-service',
          source: document.source.uri,
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
      persistence: 'long_term',
      retrieval: ['exact', 'contextual'],
      actionability: 'informational',
    },
  }
}

function projectExtension(value: unknown): StoredProjectExtension | undefined {
  if (!isObject(value)) return undefined
  const metadata = value.metadata
  if (!isObject(metadata) || !isObject(metadata.extensions)) return undefined
  const extension = metadata.extensions['dsh.native_context']
  if (!isObject(extension)
    || extension.context_kind !== 'project-document'
    || typeof extension.document_kind !== 'string'
    || !projectDocumentKinds.has(extension.document_kind as ProjectDocumentKind)
    || typeof extension.workspace_id !== 'string'
    || typeof extension.path !== 'string') return undefined
  const source = extension.source
  if (!isObject(source)
    || source.kind !== 'workspace-file'
    || typeof source.workspaceId !== 'string'
    || typeof source.workspacePath !== 'string'
    || typeof source.path !== 'string'
    || typeof source.uri !== 'string'
    || (source.version !== null && typeof source.version !== 'string')) return undefined
  return extension as unknown as StoredProjectExtension
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

/** Stores explicit project documents separately from the general workspace corpus. */
export class ProjectStateAlgorithm implements NativeContextAlgorithmModule<
  ProjectStateIngestRequest,
  ProjectStateIngestResult,
  ProjectStateQuery,
  ProjectStateQueryResult
> {
  readonly id = 'project-state'

  constructor(private readonly storage: ProjectStateStorage) {}

  async ingest(
    request: ProjectStateIngestRequest,
    context: NativeContextModuleContext,
  ): Promise<ProjectStateIngestResult> {
    const entities: ProjectStateIngestedEntity[] = []
    const expectedIds = new Set<string>()
    for (const document of request.index.documents) {
      context.signal?.throwIfAborted()
      const id = stableId(request.index.workspace.id, document.kind, document.path)
      expectedIds.add(id)
      const value = projectValue(request.index, document)
      const current = await this.readCurrent(request.meta, id, context.signal)
      context.signal?.throwIfAborted()
      const unchanged = current.active.find(variant => sameProjectValue(variant.value, value))
      if (unchanged !== undefined) {
        entities.push({
          id,
          version: unchanged.version,
          operation: 'unchanged',
          documentKind: document.kind,
          source: document.source,
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
        throw new Error(`project state ingestion did not produce an active entity: ${id}`)
      }
      entities.push({
        id,
        version: result.data.entity.version,
        operation,
        documentKind: document.kind,
        source: document.source,
      })
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
    request: ProjectStateQuery,
    context: NativeContextModuleContext,
  ): Promise<ProjectStateQueryResult> {
    if (request.workspaceId.trim() === '') {
      throw new TypeError('project state query workspaceId must be non-empty')
    }
    if (request.path !== undefined && request.path.trim() === '') {
      throw new TypeError('project state query path must be non-empty')
    }
    const text = normalizedText(request.text)
    const order = selectedOrder(request.order, text)
    const limit = boundedLimit(request.limit)
    const where: Record<string, string> = {
      '/metadata/extensions/dsh.native_context/context_kind': 'project-document',
      '/metadata/extensions/dsh.native_context/workspace_id': request.workspaceId,
    }
    if (request.kind !== undefined) {
      where['/metadata/extensions/dsh.native_context/document_kind'] = request.kind
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

    const hits: ProjectStateQueryHit[] = []
    for (const hit of response.data.hits) {
      for (const variant of hit.variants) {
        if (variant.state !== 'active' || !isObject(variant.value)) continue
        const extension = projectExtension(variant.value)
        const metadata = variant.value.metadata
        if (extension === undefined || !isObject(metadata)) continue
        hits.push({
          id: variant.ref.id,
          version: variant.version,
          score: hit.score,
          documentKind: extension.document_kind,
          text: textFromValue(variant.value),
          metadata,
          source: extension.source,
        })
      }
    }
    return { hits }
  }

  private async readCurrent(
    meta: MemoryMetadata,
    id: string,
    signal?: AbortSignal,
  ): Promise<CurrentProjectEntity> {
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
          '/metadata/extensions/dsh.native_context/context_kind': 'project-document',
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
