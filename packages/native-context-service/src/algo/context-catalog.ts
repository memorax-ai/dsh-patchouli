import type { MemoryData, MemoryMetadata } from 'dsh-patchouli'
import { PatchouliRpcError, type PatchouliStorageService } from 'dsh-patchouli/storage'

import type { GitIndexResult } from '../index/git.js'
import type { SessionIndexResult } from '../index/session.js'
import type { WorkspaceIndexResult } from '../index/workspace.js'
import type { NativeContextAlgorithmModule, NativeContextModuleContext } from '../types.js'

export const CONTEXT_CATALOG_BINDING = 'native-context/context-catalog'

export interface ContextCatalogSource {
  readonly kind: 'context-catalog'
  readonly node: 'session' | 'workspace' | 'directory' | 'repository'
  readonly id: string
  readonly parentId?: string
  readonly workspaceId?: string
  readonly sessionId?: string
  readonly path?: string
  readonly time?: number
}

export type ContextCatalogIngestRequest =
  | { readonly kind: 'session'; readonly meta: MemoryMetadata; readonly index: SessionIndexResult }
  | { readonly kind: 'workspace'; readonly meta: MemoryMetadata; readonly index: WorkspaceIndexResult }
  | { readonly kind: 'git'; readonly meta: MemoryMetadata; readonly index: GitIndexResult }

export interface ContextCatalogQuery {
  readonly meta: MemoryMetadata
  readonly text: string
  readonly workspaceId?: string
  readonly limit?: number
}

export interface ContextCatalogQueryHit {
  readonly score: number
  readonly text: string
  readonly source: ContextCatalogSource
}

export interface ContextCatalogIngestResult { readonly stored: number }
export interface ContextCatalogQueryResult { readonly hits: readonly ContextCatalogQueryHit[] }

type Storage = Pick<PatchouliStorageService, 'create' | 'query' | 'read' | 'update'>

interface CatalogEntity {
  readonly id: string
  readonly text: string
  readonly source: ContextCatalogSource
}

/** Persists a small navigable catalog above detailed Session, file, and Git records. */
export class ContextCatalogAlgorithm implements NativeContextAlgorithmModule<
  ContextCatalogIngestRequest,
  ContextCatalogIngestResult,
  ContextCatalogQuery,
  ContextCatalogQueryResult
> {
  readonly id = 'context-catalog'

  constructor(private readonly storage: Storage) {}

  async ingest(
    request: ContextCatalogIngestRequest,
    context: NativeContextModuleContext,
  ): Promise<ContextCatalogIngestResult> {
    const entities = request.kind === 'session'
      ? sessionEntities(request.index)
      : request.kind === 'workspace'
        ? workspaceEntities(request.index)
        : gitEntities(request.index)
    let stored = 0
    for (const entity of entities) {
      context.signal?.throwIfAborted()
      const value = catalogValue(entity)
      let current
      try {
        current = await this.storage.read({
          meta: request.meta,
          data: { ref: { type: 'knowledge', id: entity.id } },
        })
      } catch (error: unknown) {
        if (!(error instanceof PatchouliRpcError) || error.reason !== 'NOT_FOUND') throw error
      }
      if (current === undefined) {
        await this.storage.create({
          meta: request.meta,
          data: { type: 'knowledge', id: entity.id, value },
        })
        stored += 1
        continue
      }
      const unchanged = current.data.variants.some(variant => (
        variant.state === 'active' && sameCatalogValue(variant.value, value)
      ))
      if (unchanged) continue
      await this.storage.update({
        meta: {
          ...request.meta,
          base_versions: current.data.variants.map(variant => variant.version),
        },
        data: { ref: { type: 'knowledge', id: entity.id }, value },
      })
      stored += 1
    }
    return { stored }
  }

  async query(
    request: ContextCatalogQuery,
    context: NativeContextModuleContext,
  ): Promise<ContextCatalogQueryResult> {
    const text = request.text.trim()
    if (text === '') throw new TypeError('context catalog query must be non-empty')
    const limit = request.limit ?? 20
    const page = await this.storage.query(request.meta, {
      text,
      where: {
        '/metadata/core/origin/binding': CONTEXT_CATALOG_BINDING,
        ...(request.workspaceId === undefined
          ? {}
          : { '/metadata/extensions/dsh.native_context/workspace_id': request.workspaceId }),
      },
      order: 'relevance',
    }, { types: ['knowledge'], limit })
    context.signal?.throwIfAborted()
    const hits = page.data.hits.flatMap(hit => hit.variants.flatMap((variant) => {
      if (variant.state !== 'active') return []
      const parsed = storedCatalog(variant.value)
      return parsed === undefined ? [] : [{ score: hit.score, ...parsed }]
    }))
    hits.sort((left, right) => right.score - left.score || left.source.id.localeCompare(right.source.id))
    return { hits: hits.slice(0, limit) }
  }
}

function sessionEntities(index: SessionIndexResult): CatalogEntity[] {
  const source: ContextCatalogSource = {
    kind: 'context-catalog',
    node: 'session',
    id: `session:${index.session.id}`,
    sessionId: index.session.id,
    ...(index.session.cwd === undefined ? {} : {
      workspaceId: index.session.cwd,
      parentId: `workspace-path:${index.session.cwd}`,
      path: index.session.cwd,
    }),
    time: index.session.createdAt,
  }
  return [{
    id: stableId('session', index.session.id),
    text: [
      `Session ${index.session.id}`,
      index.session.cwd === undefined ? undefined : `workspace ${index.session.cwd}`,
      index.session.agentPreset === undefined ? undefined : `agent ${index.session.agentPreset}`,
    ].filter(Boolean).join(' · '),
    source,
  }]
}

function workspaceEntities(index: WorkspaceIndexResult): CatalogEntity[] {
  const time = Date.parse(index.workspace.updatedAt)
  const rootId = `workspace:${index.workspace.id}`
  const directories = new Map<string, number>()
  for (const file of index.files) {
    const parts = file.path.split('/').slice(0, -1)
    for (let depth = 1; depth <= parts.length; depth += 1) {
      const path = parts.slice(0, depth).join('/')
      directories.set(path, (directories.get(path) ?? 0) + 1)
    }
  }
  const tree = [...directories]
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, 128)
    .map(([path, files]) => `${'  '.repeat(Math.min(6, path.split('/').length - 1))}${path}/ (${files})`)
    .join('\n')
  return [{
    id: stableId('workspace', index.workspace.id),
    text: [
      `Workspace ${index.workspace.title} · ${index.workspace.path} · ${index.files.length} indexed files`,
      tree,
    ].filter(Boolean).join('\n'),
    source: {
      kind: 'context-catalog', node: 'workspace', id: rootId,
      workspaceId: index.workspace.id, path: index.workspace.path,
      ...(Number.isFinite(time) ? { time } : {}),
    },
  }]
}

function gitEntities(index: GitIndexResult): CatalogEntity[] {
  if (index.repository === null) return []
  const rootId = `workspace:${index.workspace.id}`
  return [{
    id: stableId('repository', index.workspace.id, index.repository.root),
    text: [
      `Git repository ${index.repository.root}`,
      index.repository.branch === null ? 'detached' : `branch ${index.repository.branch}`,
      `${index.commits.length} recent commits`,
      `${index.paths.length} changed paths`,
    ].join(' · '),
    source: {
      kind: 'context-catalog', node: 'repository',
      id: `${rootId}/repository:${index.repository.root}`,
      parentId: rootId,
      workspaceId: index.workspace.id,
      path: index.repository.root,
    },
  }]
}

function catalogValue(entity: CatalogEntity): MemoryData {
  const now = new Date().toISOString()
  return {
    content: { kind: 'text', text: entity.text },
    metadata: {
      core: {
        schema: 'patchouli.knowledge@1',
        scope: {
          tenant: null,
          workspace: entity.source.workspaceId ?? null,
          user: null,
          session: entity.source.sessionId ?? null,
        },
        origin: {
          provider: 'deepseek-harness', binding: CONTEXT_CATALOG_BINDING,
          native_type: entity.source.node, native_id: entity.source.id, native_revision: null,
        },
        time: {
          event_at: entity.source.time === undefined ? null : new Date(entity.source.time).toISOString(),
          source_created_at: null, source_updated_at: null, observed_at: now, ingested_at: now,
        },
        lifecycle: { status: 'active', expires_at: null },
        provenance: [{ kind: 'observed', actor: 'native-context-service', source: entity.source.path ?? null, recorded_at: now }],
      },
      extensions: {
        'dsh.native_context': {
          context_kind: 'context-catalog',
          workspace_id: entity.source.workspaceId ?? null,
          source: entity.source,
        },
      },
    },
    artifact: [],
    profile: {
      epistemic: 'observation', temporal: { kind: 'unknown' }, ownership: 'shared',
      abstraction: 'instance', persistence: 'long_term', retrieval: ['exact', 'contextual'],
      actionability: 'informational',
    },
  } as unknown as MemoryData
}

function storedCatalog(value: unknown): { readonly text: string; readonly source: ContextCatalogSource } | undefined {
  if (!object(value) || !object(value.content) || value.content.kind !== 'text'
    || typeof value.content.text !== 'string' || !object(value.metadata)
    || !object(value.metadata.extensions) || !object(value.metadata.extensions['dsh.native_context'])) return undefined
  const source = value.metadata.extensions['dsh.native_context'].source
  if (!isCatalogSource(source)) return undefined
  return { text: value.content.text, source }
}

function isCatalogSource(value: unknown): value is ContextCatalogSource {
  return object(value) && value.kind === 'context-catalog' && typeof value.id === 'string'
    && (value.node === 'session' || value.node === 'workspace' || value.node === 'directory' || value.node === 'repository')
}

function sameCatalogValue(left: unknown, right: unknown): boolean {
  if (!object(left) || !object(right) || !object(left.metadata) || !object(right.metadata)) return false
  return JSON.stringify(left.content) === JSON.stringify(right.content)
    && JSON.stringify(left.metadata.extensions) === JSON.stringify(right.metadata.extensions)
}

function stableId(kind: string, ...parts: readonly string[]): string {
  return `native-context:catalog:${kind}:${parts.map(part => `${part.length}:${part}`).join(':')}`
}

function object(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
