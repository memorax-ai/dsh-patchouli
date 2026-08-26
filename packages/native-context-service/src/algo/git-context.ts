import type { MemoryData, MemoryMetadata } from 'dsh-patchouli'
import {
  PatchouliRpcError,
  type PatchouliStorageService,
} from 'dsh-patchouli/storage'

import type { GitIndexCommit, GitIndexPath, GitIndexResult } from '../index/git.js'
import type {
  NativeContextAlgorithmModule,
  NativeContextModuleContext,
} from '../types.js'

const entityType = 'knowledge' as const
const gitContextKinds = ['git-repository', 'git-commit', 'git-path'] as const
const defaultQueryLimit = 10
const maximumQueryLimit = 50

type GitContextStorage = Pick<
  PatchouliStorageService,
  'create' | 'delete' | 'query' | 'queryPages' | 'read' | 'update'
>

export interface GitContextSource {
  readonly kind: 'git'
  readonly workspace_id: string
  readonly workspace_path: string
  readonly repository_root: string
  readonly entity: 'repository' | 'commit' | 'path'
  readonly commit?: string
  readonly path?: string
  readonly time?: number
}

export interface GitContextIngestInput {
  readonly meta: MemoryMetadata
  readonly index: GitIndexResult
}

export interface GitContextIngestResult {
  readonly stored: number
}

export interface GitContextQuery {
  readonly meta: MemoryMetadata
  readonly text: string
  readonly workspaceId: string
  readonly limit?: number
}

export interface GitContextQueryHit {
  readonly score: number
  readonly text: string
  readonly source: GitContextSource
}

export interface GitContextQueryResult {
  readonly hits: readonly GitContextQueryHit[]
}

/** Persist normalized Git snapshots supplied by the policy-aware Git index reader. */
export class GitContextAlgorithm implements NativeContextAlgorithmModule<
  GitContextIngestInput,
  GitContextIngestResult,
  GitContextQuery,
  GitContextQueryResult
> {
  readonly id = 'git-context'

  constructor(private readonly storage: GitContextStorage) {}

  async ingest(
    input: GitContextIngestInput,
    context: NativeContextModuleContext,
  ): Promise<GitContextIngestResult> {
    const repository = input.index.repository
    if (repository === null) return { stored: 0 }
    const entities = [
      repositoryEntity(input.index),
      ...input.index.commits.map(commit => commitEntity(input.index, commit)),
      ...input.index.paths.map(path => pathEntity(input.index, path)),
    ]
    let stored = 0
    const expectedPathIds = new Set<string>()
    for (const entity of entities) {
      context.signal?.throwIfAborted()
      if (entity.contextKind === 'git-path') expectedPathIds.add(entity.id)
      const changed = await createOrUpdate(
        this.storage,
        input.meta,
        entity.contextKind,
        entity.id,
        entity.value,
        context.signal,
      )
      if (changed) stored += 1
    }
    if (!input.index.pathsTruncated) {
      await deleteStalePaths(
        this.storage,
        input.meta,
        input.index.workspace.id,
        expectedPathIds,
        context.signal,
      )
    }
    return { stored }
  }

  async query(
    request: GitContextQuery,
    context: NativeContextModuleContext,
  ): Promise<GitContextQueryResult> {
    const text = requiredText(request.text)
    const workspaceId = requiredText(request.workspaceId)
    const limit = queryLimit(request.limit)
    context.signal?.throwIfAborted()
    const hits: GitContextQueryHit[] = []
    for (const contextKind of gitContextKinds) {
      context.signal?.throwIfAborted()
      const result = await this.storage.query(
        request.meta,
        {
          text,
          where: {
            '/metadata/extensions/dsh.native_context/context_kind': contextKind,
            '/metadata/extensions/dsh.native_context/workspace_id': workspaceId,
          },
          order: 'relevance',
        },
        { types: [entityType], limit },
      )
      context.signal?.throwIfAborted()
      for (const hit of result.data.hits) {
        const variant = hit.variants.find(candidate => candidate.state === 'active')
        if (variant?.state !== 'active') continue
        const stored = storedGit(variant.value, contextKind)
        if (stored === undefined) continue
        hits.push({ score: hit.score, text: stored.text, source: stored.source })
      }
    }
    hits.sort((left, right) => right.score - left.score)
    return { hits: hits.slice(0, limit) }
  }
}

function repositoryEntity(index: GitIndexResult): StoredGitEntity {
  const repository = index.repository!
  const source = gitSource(index, 'repository')
  return {
    contextKind: 'git-repository',
    id: stableId('git-repository', repository.root),
    value: gitKnowledgeValue(
      index,
      'git-repository',
      [
        `Repository ${repository.root}`,
        repository.branch === null ? 'detached branch' : `branch ${repository.branch}`,
        repository.head === null ? 'no HEAD' : `HEAD ${repository.head}`,
        index.clean === null ? 'status unavailable' : index.clean ? 'clean' : 'has changes',
      ].join(' · '),
      source,
    ),
  }
}

function commitEntity(index: GitIndexResult, commit: GitIndexCommit): StoredGitEntity {
  const repository = index.repository!
  return {
    contextKind: 'git-commit',
    id: stableId('git-commit', repository.root, commit.hash),
    value: gitKnowledgeValue(
      index,
      'git-commit',
      `${commit.hash} ${commit.subject} · ${commit.author} · ${commit.authoredAt}`,
      gitSource(index, 'commit', {
        commit: commit.hash,
        time: Date.parse(commit.authoredAt),
      }),
    ),
  }
}

function pathEntity(index: GitIndexResult, path: GitIndexPath): StoredGitEntity {
  const repository = index.repository!
  return {
    contextKind: 'git-path',
    id: stableId('git-path', repository.root, path.path),
    value: gitKnowledgeValue(
      index,
      'git-path',
      `${path.path} · ${path.status}${path.staged ? ' · staged' : ''}`,
      gitSource(index, 'path', { path: path.path }),
    ),
  }
}

interface StoredGitEntity {
  readonly contextKind: (typeof gitContextKinds)[number]
  readonly id: string
  readonly value: MemoryData
}

function gitSource(
  index: GitIndexResult,
  entity: GitContextSource['entity'],
  detail: { readonly commit?: string; readonly path?: string; readonly time?: number } = {},
): GitContextSource {
  return {
    kind: 'git',
    workspace_id: index.workspace.id,
    workspace_path: index.workspace.path,
    repository_root: index.repository!.root,
    entity,
    ...detail,
  }
}

function gitKnowledgeValue(
  index: GitIndexResult,
  contextKind: (typeof gitContextKinds)[number],
  text: string,
  source: GitContextSource,
): MemoryData {
  const now = new Date().toISOString()
  const nativeId = source.commit ?? source.path ?? source.repository_root
  return {
    content: { kind: 'text', text },
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
          native_type: contextKind,
          native_id: nativeId,
          native_revision: index.repository?.head ?? null,
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
          actor: 'native-context-service',
          source: source.repository_root,
          recorded_at: now,
        }],
      },
      extensions: {
        'dsh.native_context': {
          context_kind: contextKind,
          workspace_id: index.workspace.id,
          source: { ...source },
        },
      },
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

function storedGit(
  value: unknown,
  expectedKind: (typeof gitContextKinds)[number],
): { readonly text: string; readonly source: GitContextSource } | undefined {
  if (!isObject(value)
    || !isObject(value.content)
    || value.content.kind !== 'text'
    || typeof value.content.text !== 'string'
    || !isObject(value.metadata)
    || !isObject(value.metadata.extensions)
    || !isObject(value.metadata.extensions['dsh.native_context'])) return undefined
  const extension = value.metadata.extensions['dsh.native_context']
  if (extension.context_kind !== expectedKind || !isGitSource(extension.source)) return undefined
  return { text: value.content.text, source: extension.source }
}

function isGitSource(value: unknown): value is GitContextSource {
  if (!isObject(value)
    || value.kind !== 'git'
    || typeof value.workspace_id !== 'string'
    || typeof value.workspace_path !== 'string'
    || typeof value.repository_root !== 'string'
    || (value.entity !== 'repository' && value.entity !== 'commit' && value.entity !== 'path')) {
    return false
  }
  return (value.commit === undefined || typeof value.commit === 'string')
    && (value.path === undefined || typeof value.path === 'string')
    && (value.time === undefined || typeof value.time === 'number')
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function createOrUpdate(
  storage: GitContextStorage,
  meta: MemoryMetadata,
  contextKind: (typeof gitContextKinds)[number],
  id: string,
  value: MemoryData,
  signal?: AbortSignal,
): Promise<boolean> {
  let current
  try {
    current = await storage.read({ meta, data: { ref: { type: entityType, id } } })
    signal?.throwIfAborted()
  } catch (error: unknown) {
    signal?.throwIfAborted()
    if (!(error instanceof PatchouliRpcError) || error.reason !== 'NOT_FOUND') throw error
  }
  if (current === undefined) {
    await storage.create({ meta, data: { type: entityType, id, value } })
  } else {
    const unchanged = current.data.variants.some(variant => (
      variant.state === 'active' && sameGitValue(variant.value, value)
    ))
    if (unchanged) return false
    const baseVersions = current.data.variants.map(variant => variant.version)
    if (baseVersions.length === 0) {
      throw new Error(`git context entity has no version: ${contextKind}:${id}`)
    }
    await storage.update({
      meta: { ...meta, base_versions: baseVersions },
      data: { ref: { type: entityType, id }, value },
    })
  }
  signal?.throwIfAborted()
  return true
}

async function deleteStalePaths(
  storage: GitContextStorage,
  meta: MemoryMetadata,
  workspaceId: string,
  expectedIds: ReadonlySet<string>,
  signal?: AbortSignal,
): Promise<void> {
  const stale: Array<{ readonly id: string; readonly versions: readonly string[] }> = []
  const pages = storage.queryPages(meta, {
    where: {
      '/metadata/extensions/dsh.native_context/context_kind': 'git-path',
      '/metadata/extensions/dsh.native_context/workspace_id': workspaceId,
    },
    order: 'id_asc',
  }, { types: [entityType], limit: 100 })
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
    await storage.delete({
      meta: { ...meta, base_versions: entity.versions },
      data: { ref: { type: entityType, id: entity.id } },
    })
  }
  signal?.throwIfAborted()
}

function sameGitValue(left: unknown, right: unknown): boolean {
  if (!isObject(left) || !isObject(right)) return false
  const leftMetadata = left.metadata
  const rightMetadata = right.metadata
  if (!isObject(leftMetadata) || !isObject(rightMetadata)) return false
  return sameJson(left.content, right.content)
    && sameJson(leftMetadata.extensions, rightMetadata.extensions)
    && sameJson(left.artifact, right.artifact)
    && sameJson(left.profile, right.profile)
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function stableId(kind: string, ...parts: readonly string[]): string {
  return `native-context:${kind}:${parts.map(part => `${part.length}:${part}`).join(':')}`
}

function requiredText(value: string): string {
  const text = value.trim()
  if (text.length === 0) throw new TypeError('git context query text must be non-empty')
  return text
}

function queryLimit(value: number | undefined): number {
  const limit = value ?? defaultQueryLimit
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximumQueryLimit) {
    throw new RangeError(`limit must be an integer from 1 to ${maximumQueryLimit}`)
  }
  return limit
}
