import type { MemoryMetadata } from 'dsh-patchouli'

import type {
  ArtifactContextQuery,
  ArtifactContextQueryResult,
} from '../algo/artifact-context.js'
import type {
  ContextCatalogQuery,
  ContextCatalogQueryResult,
  ContextCatalogSource,
} from '../algo/context-catalog.js'
import type {
  GitContextQuery,
  GitContextQueryResult,
  GitContextSource,
} from '../algo/git-context.js'
import type {
  ProjectStateQuery,
  ProjectStateQueryResult,
} from '../algo/project-state.js'
import type {
  RepairHistoryQuery,
  RepairHistoryQueryResult,
  RepairHistorySource,
} from '../algo/repair-history.js'
import type {
  SessionHistoryQuery,
  SessionHistoryQueryResult,
} from '../algo/session-history.js'
import type {
  WorkspaceContextQuery,
  WorkspaceContextQueryResult,
} from '../algo/workspace-context.js'
import type { ArtifactSource } from '../index/artifact.js'
import type { GitIndexResult } from '../index/git.js'
import { projectIndexFromWorkspace } from '../index/project.js'
import { SessionIndex, type SessionContextSource } from '../index/session.js'
import type { WorkspaceFileIndexEntry, WorkspaceFileSource, WorkspaceIndexResult } from '../index/workspace.js'
import type { NativeContextService } from '../service.js'
import type {
  NativeContextAlgorithmModule,
  NativeContextModuleContext,
  NativeContextRetrieveModule,
} from '../types.js'
import { SourceExpander } from './source-expander.js'
import { TemporalRecallModule, type TemporalRecallWindow } from './temporal.js'

export const FAST_RETRIEVE_DEFAULT_LIMIT = 20
export const FAST_RETRIEVE_MAX_LIMIT = 100
export const FAST_RETRIEVE_PER_SOURCE_LIMIT = 20
export const FAST_RETRIEVE_DEFAULT_MAX_CHARACTERS = 16_000
export const FAST_RETRIEVE_MAX_CHARACTERS = 100_000

export const FAST_RETRIEVE_SOURCE_IDS = [
  'session-history',
  'workspace-context',
  'project-state',
  'artifact-context',
  'git-context',
  'repair-history',
  'context-catalog',
] as const

export type FastRetrieveSourceId = typeof FAST_RETRIEVE_SOURCE_IDS[number]

export type FastRetrieveSource =
  | SessionContextSource
  | WorkspaceFileSource
  | ArtifactSource
  | GitContextSource
  | RepairHistorySource
  | ContextCatalogSource

export interface FastRetrieveRequest {
  readonly meta: MemoryMetadata
  readonly query: string
  readonly sessionId?: string
  readonly workspaceId?: string
  /** Fresh native snapshots acquired by the runtime; these bypass Patchouli storage. */
  readonly native?: {
    readonly workspace?: WorkspaceIndexResult
    readonly git?: GitIndexResult
  }
  /** Restrict retrieval to these registered algorithm blocks. Defaults to all. */
  readonly sourceIds?: readonly FastRetrieveSourceId[]
  /** Maximum number of merged hits. */
  readonly limit?: number
  /** Maximum total UTF-16 characters across returned hit text. */
  readonly maxCharacters?: number
  /** Resolve top hits back to bounded native source windows. */
  readonly expandSources?: boolean
  readonly temporal?: TemporalRecallWindow
}

export interface FastRetrieveHit {
  readonly sourceId: FastRetrieveSourceId
  readonly score: number
  readonly text: string
  readonly source: FastRetrieveSource
  readonly ranking?: {
    readonly sourceRank: number
    readonly sourceScore: number
    readonly reciprocalRank: number
    readonly exactMatch: number
    readonly recency: number
  }
}

export interface FastRetrieveResult {
  readonly hits: readonly FastRetrieveHit[]
  readonly truncated: boolean
}

interface SourceResult {
  readonly hits: readonly FastRetrieveHit[]
  readonly truncated: boolean
}

type QueryAlgorithm<TRequest, TResult> = Pick<
  NativeContextAlgorithmModule<unknown, unknown, TRequest, TResult>,
  'query'
>

const sourceIdSet: ReadonlySet<string> = new Set(FAST_RETRIEVE_SOURCE_IDS)

/** Queries native sources directly and merges the few blocks that genuinely live in Patchouli. */
export class FastRetrieveModule implements NativeContextRetrieveModule<
  FastRetrieveRequest,
  FastRetrieveResult
> {
  readonly id = 'fast'
  readonly level = 'low' as const

  private readonly sourceExpander: SourceExpander
  private readonly temporalRecall = new TemporalRecallModule()

  constructor(private readonly nativeContext: NativeContextService) {
    this.sourceExpander = new SourceExpander(nativeContext)
  }

  async retrieve(
    request: FastRetrieveRequest,
    context: NativeContextModuleContext,
  ): Promise<FastRetrieveResult> {
    const query = requiredText(request.query, 'fast retrieval query')
    const limit = boundedInteger(
      request.limit,
      FAST_RETRIEVE_DEFAULT_LIMIT,
      FAST_RETRIEVE_MAX_LIMIT,
      'fast retrieval limit',
    )
    const maxCharacters = boundedInteger(
      request.maxCharacters,
      FAST_RETRIEVE_DEFAULT_MAX_CHARACTERS,
      FAST_RETRIEVE_MAX_CHARACTERS,
      'fast retrieval maxCharacters',
    )
    const sourceIds = selectedSourceIds(request.sourceIds)
    const temporal = this.temporalRecall.resolve(query, request.temporal)
    const sourceRequest = temporal === undefined
      ? request
      : { ...request, sessionId: undefined, temporal }
    if (request.sessionId !== undefined) requiredText(request.sessionId, 'sessionId')
    if (request.workspaceId !== undefined) requiredText(request.workspaceId, 'workspaceId')

    context.signal?.throwIfAborted()
    const perSourceLimit = Math.min(limit, FAST_RETRIEVE_PER_SOURCE_LIMIT)
    const tasks: Promise<SourceResult>[] = []
    for (const sourceId of sourceIds) {
      if (!this.hasSource(sourceId, request)) continue
      if (
        (sourceId === 'workspace-context' || sourceId === 'project-state')
        && request.workspaceId === undefined
      ) continue
      tasks.push(this.querySource(sourceId, sourceRequest, query, perSourceLimit, context))
    }

    const sourceResults = await Promise.all(tasks)
    context.signal?.throwIfAborted()
    const candidates = this.temporalRecall.apply(mergeDuplicateHits(sourceResults.flatMap(result => (
      fuseSourceRanking(result.hits, query)
    ))), temporal)
    candidates.sort((left, right) => (
      right.score - left.score
      || left.sourceId.localeCompare(right.sourceId)
      || left.text.localeCompare(right.text)
    ))

    if (request.expandSources === true) {
      const expanded = await Promise.all(candidates.slice(0, Math.min(limit, 5)).map(
        hit => this.sourceExpander.expand(hit, context),
      ))
      candidates.splice(0, expanded.length, ...expanded)
    }

    const hits: FastRetrieveHit[] = []
    let remainingCharacters = maxCharacters
    let truncated = sourceResults.some(result => result.truncated)
      || candidates.length > limit
    for (const candidate of candidates.slice(0, limit)) {
      if (remainingCharacters === 0) {
        truncated = true
        break
      }
      const text = candidate.text.slice(0, remainingCharacters)
      hits.push({ ...candidate, text })
      remainingCharacters -= text.length
      if (text.length < candidate.text.length) {
        truncated = true
        break
      }
    }
    if (hits.length < Math.min(candidates.length, limit)) truncated = true
    return { hits, truncated }
  }

  private hasSource(sourceId: FastRetrieveSourceId, request: FastRetrieveRequest): boolean {
    if (sourceId === 'session-history' && this.sessionIndex() !== undefined) return true
    if ((sourceId === 'workspace-context' || sourceId === 'project-state')
      && request.native?.workspace !== undefined) return true
    if (sourceId === 'git-context' && request.native?.git !== undefined) return true
    if (sourceId === 'context-catalog' && (
      request.native?.workspace !== undefined || request.native?.git !== undefined
    )) return true
    return this.nativeContext.hasAlgorithm(sourceId)
  }

  private sessionIndex(): SessionIndex | undefined {
    if (!this.nativeContext.hasIndex('session')) return undefined
    const index = this.nativeContext.getIndex('session') as Partial<SessionIndex>
    return typeof index.search === 'function' && typeof index.searchAll === 'function'
      ? index as SessionIndex
      : undefined
  }

  private querySource(
    sourceId: FastRetrieveSourceId,
    request: FastRetrieveRequest,
    query: string,
    limit: number,
    context: NativeContextModuleContext,
  ): Promise<SourceResult> {
    switch (sourceId) {
      case 'session-history':
        return this.querySession(request, query, limit, context)
      case 'workspace-context':
        return this.queryWorkspace(request, query, limit, context)
      case 'project-state':
        return this.queryProject(request, query, limit, context)
      case 'artifact-context':
        return this.queryArtifact(request, query, limit, context)
      case 'git-context':
        return this.queryGit(request, query, limit, context)
      case 'repair-history':
        return this.queryRepair(request, query, limit, context)
      case 'context-catalog':
        return this.queryCatalog(request, query, limit, context)
    }
  }

  private async querySession(
    request: FastRetrieveRequest,
    query: string,
    limit: number,
    context: NativeContextModuleContext,
  ): Promise<SourceResult> {
    const sessionIndex = this.sessionIndex()
    if (sessionIndex !== undefined) {
      const time = {
        ...(request.temporal?.from === undefined ? {} : { fromTime: request.temporal.from }),
        ...(request.temporal?.to === undefined ? {} : { toTime: request.temporal.to }),
      }
      const [current, historical] = await Promise.all([
        request.sessionId === undefined
          ? Promise.resolve({ hits: [], truncated: false })
          : sessionIndex.search({ sessionId: request.sessionId, query, ...time, limit }, context),
        sessionIndex.searchAll({
          query,
          ...(request.sessionId === undefined ? {} : { excludeSessionId: request.sessionId }),
          ...time,
          limit,
        }, context),
      ])
      const merged: typeof current.hits[number][] = []
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
        truncated: current.truncated || historical.truncated
          || current.hits.length + historical.hits.length > merged.length,
      }
    }
    const result = await this.algorithm<SessionHistoryQuery, SessionHistoryQueryResult>(
      'session-history',
    ).query({
      meta: request.meta,
      ...(this.temporalRecall.queryText(query, request.temporal) === undefined
        ? {}
        : { query: this.temporalRecall.queryText(query, request.temporal) }),
      ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
      ...(request.temporal?.from === undefined ? {} : { fromTime: request.temporal.from }),
      ...(request.temporal?.to === undefined ? {} : { toTime: request.temporal.to }),
      limit,
    }, context)
    return {
      hits: result.hits.slice(0, limit).map(hit => ({
        sourceId: 'session-history',
        score: hit.score,
        text: hit.text,
        source: hit.source,
      })),
      truncated: result.truncated || result.hits.length > limit,
    }
  }

  private async queryWorkspace(
    request: FastRetrieveRequest,
    query: string,
    limit: number,
    context: NativeContextModuleContext,
  ): Promise<SourceResult> {
    const workspaceId = request.workspaceId
    if (workspaceId === undefined) return { hits: [], truncated: false }
    if (request.native?.workspace !== undefined) {
      return directWorkspace(request.native.workspace, query, limit)
    }
    const result = await this.algorithm<WorkspaceContextQuery, WorkspaceContextQueryResult>(
      'workspace-context',
    ).query({ meta: request.meta, text: query, workspaceId, limit }, context)
    const hits = result.hits.flatMap(hit => {
      const text = usefulText(hit.text)
      return text === undefined ? [] : [{
        sourceId: 'workspace-context' as const,
        score: hit.score,
        text,
        source: hit.source,
      }]
    })
    return { hits: hits.slice(0, limit), truncated: result.hits.length > limit }
  }

  private async queryProject(
    request: FastRetrieveRequest,
    query: string,
    limit: number,
    context: NativeContextModuleContext,
  ): Promise<SourceResult> {
    const workspaceId = request.workspaceId
    if (workspaceId === undefined) return { hits: [], truncated: false }
    if (request.native?.workspace !== undefined) {
      return directProject(request.native.workspace, query, limit)
    }
    const result = await this.algorithm<ProjectStateQuery, ProjectStateQueryResult>(
      'project-state',
    ).query({ meta: request.meta, text: query, workspaceId, limit }, context)
    const hits = result.hits.flatMap(hit => {
      const text = usefulText(hit.text)
      return text === undefined ? [] : [{
        sourceId: 'project-state' as const,
        score: hit.score,
        text,
        source: hit.source,
      }]
    })
    return { hits: hits.slice(0, limit), truncated: result.hits.length > limit }
  }

  private async queryArtifact(
    request: FastRetrieveRequest,
    query: string,
    limit: number,
    context: NativeContextModuleContext,
  ): Promise<SourceResult> {
    const result = await this.algorithm<ArtifactContextQuery, ArtifactContextQueryResult>(
      'artifact-context',
    ).query({ meta: request.meta, text: query, limit }, context)
    const hits = result.hits.map(hit => ({
      sourceId: 'artifact-context' as const,
      score: hit.score,
      text: artifactText(hit.description, hit.text),
      source: hit.source,
    })).filter(hit => hit.text !== '')
    return { hits: hits.slice(0, limit), truncated: result.hits.length > limit }
  }

  private async queryGit(
    request: FastRetrieveRequest,
    query: string,
    limit: number,
    context: NativeContextModuleContext,
  ): Promise<SourceResult> {
    const workspaceId = request.workspaceId
    if (workspaceId === undefined) return { hits: [], truncated: false }
    if (request.native?.git !== undefined) {
      return directGit(request.native.git, query, limit)
    }
    const result = await this.algorithm<GitContextQuery, GitContextQueryResult>(
      'git-context',
    ).query({ meta: request.meta, text: query, workspaceId, limit }, context)
    const hits = result.hits.flatMap(hit => {
      const text = usefulText(hit.text)
      return text === undefined ? [] : [{
        sourceId: 'git-context' as const,
        score: hit.score,
        text,
        source: hit.source,
      }]
    })
    return { hits: hits.slice(0, limit), truncated: result.hits.length > limit }
  }

  private async queryRepair(
    request: FastRetrieveRequest,
    query: string,
    limit: number,
    context: NativeContextModuleContext,
  ): Promise<SourceResult> {
    const result = await this.algorithm<RepairHistoryQuery, RepairHistoryQueryResult>(
      'repair-history',
    ).query({
      meta: request.meta,
      text: query,
      limit,
    }, context)
    return {
      hits: result.hits.map(hit => ({
        sourceId: 'repair-history',
        score: hit.score,
        text: hit.text,
        source: hit.source,
      })),
      truncated: result.truncated,
    }
  }

  private async queryCatalog(
    request: FastRetrieveRequest,
    query: string,
    limit: number,
    context: NativeContextModuleContext,
  ): Promise<SourceResult> {
    if (request.native?.workspace !== undefined || request.native?.git !== undefined) {
      return directCatalog(request.native, query, limit)
    }
    const result = await this.algorithm<ContextCatalogQuery, ContextCatalogQueryResult>(
      'context-catalog',
    ).query({
      meta: request.meta,
      text: query,
      limit,
    }, context)
    return {
      hits: result.hits.map(hit => ({
        sourceId: 'context-catalog',
        score: hit.score,
        text: hit.text,
        source: hit.source,
      })),
      truncated: result.hits.length > limit,
    }
  }

  private algorithm<TRequest, TResult>(
    id: FastRetrieveSourceId,
  ): QueryAlgorithm<TRequest, TResult> {
    return this.nativeContext.getAlgorithm(id) as QueryAlgorithm<TRequest, TResult>
  }
}

function directWorkspace(
  indexed: WorkspaceIndexResult,
  query: string,
  limit: number,
): SourceResult {
  const candidates = indexed.files.flatMap((file) => {
    const text = workspaceFileText(file)
    const score = literalScore(query, text, file.path)
    return score === undefined ? [] : [{
      sourceId: 'workspace-context' as const,
      score,
      text,
      source: file.source,
    }]
  })
  candidates.sort((left, right) => right.score - left.score || left.source.path.localeCompare(right.source.path))
  return {
    hits: candidates.slice(0, limit),
    truncated: indexed.truncated || candidates.length > limit,
  }
}

function directProject(
  indexed: WorkspaceIndexResult,
  query: string,
  limit: number,
): SourceResult {
  const project = projectIndexFromWorkspace(indexed)
  const candidates = project.documents.flatMap((document) => {
    const text = [document.kind, workspaceFileText(document)].join('\n')
    const score = literalScore(query, text, document.path)
    return score === undefined ? [] : [{
      sourceId: 'project-state' as const,
      score: score + 0.1,
      text,
      source: document.source,
    }]
  })
  candidates.sort((left, right) => right.score - left.score || left.source.path.localeCompare(right.source.path))
  return {
    hits: candidates.slice(0, limit),
    truncated: project.truncated || candidates.length > limit,
  }
}

function directGit(indexed: GitIndexResult, query: string, limit: number): SourceResult {
  const repository = indexed.repository
  if (repository === null) return { hits: [], truncated: false }
  const entries: Array<{ readonly text: string; readonly source: GitContextSource }> = [{
    text: [
      `Repository ${repository.root}`,
      repository.branch === null ? 'detached branch' : `branch ${repository.branch}`,
      repository.head === null ? 'no HEAD' : `HEAD ${repository.head}`,
      indexed.clean === null ? 'status unavailable' : indexed.clean ? 'clean' : 'has changes',
    ].join(' · '),
    source: {
      kind: 'git',
      workspace_id: indexed.workspace.id,
      workspace_path: indexed.workspace.path,
      repository_root: repository.root,
      entity: 'repository',
    },
  }]
  for (const commit of indexed.commits) entries.push({
    text: `${commit.hash} ${commit.subject} · ${commit.author} · ${commit.authoredAt}`,
    source: {
      kind: 'git',
      workspace_id: indexed.workspace.id,
      workspace_path: indexed.workspace.path,
      repository_root: repository.root,
      entity: 'commit',
      commit: commit.hash,
      time: Date.parse(commit.authoredAt),
    },
  })
  for (const path of indexed.paths) entries.push({
    text: `${path.path} · ${path.status}${path.staged ? ' · staged' : ''}`,
    source: {
      kind: 'git',
      workspace_id: indexed.workspace.id,
      workspace_path: indexed.workspace.path,
      repository_root: repository.root,
      entity: 'path',
      path: path.path,
    },
  })
  const candidates = entries.flatMap((entry) => {
    const locator = entry.source.path ?? entry.source.commit ?? entry.source.repository_root
    const score = literalScore(query, entry.text, locator)
    return score === undefined ? [] : [{
      sourceId: 'git-context' as const,
      score,
      text: entry.text,
      source: entry.source,
    }]
  })
  candidates.sort((left, right) => right.score - left.score || left.text.localeCompare(right.text))
  return {
    hits: candidates.slice(0, limit),
    truncated: indexed.truncated || candidates.length > limit,
  }
}

function directCatalog(
  native: NonNullable<FastRetrieveRequest['native']>,
  query: string,
  limit: number,
): SourceResult {
  const entries: Array<{ readonly text: string; readonly source: ContextCatalogSource }> = []
  const workspace = native.workspace
  if (workspace !== undefined) entries.push({
    text: `Workspace ${workspace.workspace.title} · ${workspace.workspace.path} · ${workspace.files.length} files`,
    source: {
      kind: 'context-catalog',
      node: 'workspace',
      id: `workspace:${workspace.workspace.id}`,
      workspaceId: workspace.workspace.id,
      path: workspace.workspace.path,
      time: Date.parse(workspace.workspace.updatedAt),
    },
  })
  const git = native.git
  if (git?.repository !== null && git?.repository !== undefined) entries.push({
    text: [
      `Git repository ${git.repository.root}`,
      git.repository.branch === null ? 'detached' : `branch ${git.repository.branch}`,
      `${git.commits.length} recent commits`,
      `${git.paths.length} changed paths`,
    ].join(' · '),
    source: {
      kind: 'context-catalog',
      node: 'repository',
      id: `workspace:${git.workspace.id}/repository:${git.repository.root}`,
      parentId: `workspace:${git.workspace.id}`,
      workspaceId: git.workspace.id,
      path: git.repository.root,
    },
  })
  const candidates = entries.flatMap((entry) => {
    const score = literalScore(query, entry.text, entry.source.path)
    return score === undefined ? [] : [{
      sourceId: 'context-catalog' as const,
      score,
      text: entry.text,
      source: entry.source,
    }]
  })
  candidates.sort((left, right) => right.score - left.score || left.source.id.localeCompare(right.source.id))
  return { hits: candidates.slice(0, limit), truncated: candidates.length > limit }
}

function workspaceFileText(file: WorkspaceFileIndexEntry): string {
  return file.text === null || file.text === '' ? file.path : `${file.path}\n${file.text}`
}

function literalScore(query: string, text: string, locator?: string): number | undefined {
  const needle = query.trim().toLocaleLowerCase()
  if (needle === '') return undefined
  const haystack = text.toLocaleLowerCase()
  const location = locator?.toLocaleLowerCase() ?? ''
  if (location === needle) return 1
  if (location.includes(needle)) return 0.95
  if (haystack.includes(needle)) return 0.8
  const terms = needle.split(/\s+/u).filter(Boolean)
  return terms.length > 1 && terms.every(term => haystack.includes(term)) ? 0.6 : undefined
}

function mergeDuplicateHits(hits: readonly FastRetrieveHit[]): FastRetrieveHit[] {
  const merged = new Map<string, FastRetrieveHit>()
  for (const hit of hits) {
    const key = sourceKey(hit.source)
    const current = merged.get(key)
    if (current === undefined) {
      merged.set(key, hit)
      continue
    }

    const preferred = hit.sourceId === 'project-state'
      && current.sourceId === 'workspace-context'
      ? hit
      : current.sourceId === 'project-state'
        && hit.sourceId === 'workspace-context'
        ? current
        : hit.score > current.score ? hit : current
    merged.set(key, {
      ...preferred,
      score: Math.max(current.score, hit.score),
    })
  }
  return [...merged.values()]
}

/** Deterministic local RRF with small exact-match and recency signals. */
function fuseSourceRanking(
  hits: readonly FastRetrieveHit[],
  query: string,
): FastRetrieveHit[] {
  if (hits.length === 0) return []
  const now = Date.now()
  return hits.map((hit, index) => {
    const sourceRank = index + 1
    const rawScore = Math.max(0, hit.score)
    const sourceScore = rawScore <= 1 ? rawScore : rawScore / (rawScore + 1)
    const reciprocalRank = 60 / (60 + sourceRank)
    const exactMatch = exactMatchScore(hit, query)
    const time = sourceTime(hit.source)
    const recency = time === undefined
      ? 0
      : Math.min(1, Math.max(0, 1 - (now - time) / (180 * 24 * 60 * 60 * 1_000)))
    return {
      ...hit,
      score: sourceScore * 0.55 + reciprocalRank * 0.30 + exactMatch * 0.10 + recency * 0.05,
      ranking: { sourceRank, sourceScore, reciprocalRank, exactMatch, recency },
    }
  })
}

function exactMatchScore(hit: FastRetrieveHit, query: string): number {
  const needle = query.trim().toLocaleLowerCase()
  if (needle === '') return 0
  const text = hit.text.toLocaleLowerCase()
  if (text === needle) return 1
  if (text.includes(needle)) return 0.75
  const source = hit.source
  const locator = 'type' in source
    ? ''
    : source.kind === 'workspace-file'
      ? source.path
      : source.kind === 'git'
        ? source.path ?? source.commit ?? source.repository_root
        : source.kind === 'patchouli-artifact'
          ? source.id
          : source.kind === 'repair-history'
            ? `${source.sessionId}:${source.fromSeq}-${source.toSeq}`
            : `${source.node}:${source.path ?? source.sessionId ?? source.id}`
  return locator.toLocaleLowerCase().includes(needle) ? 0.9 : 0
}

function sourceTime(source: FastRetrieveSource): number | undefined {
  if ('type' in source || source.kind === 'repair-history') return source.time
  return undefined
}

function sourceKey(source: FastRetrieveSource): string {
  if ('type' in source) {
    return JSON.stringify(['session-event', source.sessionId, source.seq])
  }
  switch (source.kind) {
    case 'workspace-file':
      return JSON.stringify(['workspace-file', source.workspaceId, source.path])
    case 'patchouli-artifact':
      return JSON.stringify(['patchouli-artifact', source.id, source.version, source.role])
    case 'git':
      return JSON.stringify([
        'git',
        source.workspace_id,
        source.repository_root,
        source.entity,
        source.commit ?? null,
        source.path ?? null,
      ])
    case 'repair-history':
      return JSON.stringify([
        'repair-history', source.sessionId, source.fromSeq, source.toSeq,
      ])
    case 'context-catalog':
      return JSON.stringify(['context-catalog', source.id])
  }
}

function selectedSourceIds(
  value: readonly FastRetrieveSourceId[] | undefined,
): readonly FastRetrieveSourceId[] {
  if (value === undefined) return FAST_RETRIEVE_SOURCE_IDS
  const result: FastRetrieveSourceId[] = []
  const seen = new Set<FastRetrieveSourceId>()
  for (const sourceId of value) {
    if (!sourceIdSet.has(sourceId)) {
      throw new TypeError(`unknown fast retrieval source id: ${String(sourceId)}`)
    }
    if (!seen.has(sourceId)) {
      seen.add(sourceId)
      result.push(sourceId)
    }
  }
  return result
}

function requiredText(value: string, name: string): string {
  const text = value.trim()
  if (text === '') throw new TypeError(`${name} must be non-empty`)
  return text
}

function usefulText(value: string | null): string | undefined {
  if (value === null) return undefined
  const text = value.trim()
  return text === '' ? undefined : text
}

function artifactText(description: string, visibleText: string | null): string {
  const descriptionText = description.trim()
  const contentText = usefulText(visibleText)
  if (contentText === undefined || contentText === descriptionText) return descriptionText
  if (descriptionText === '') return contentText
  return `${descriptionText}\n${contentText}`
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  name: string,
): number {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) {
    throw new RangeError(`${name} must be an integer from 1 to ${maximum}`)
  }
  return result
}
