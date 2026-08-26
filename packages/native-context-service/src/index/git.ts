import { execFile } from 'node:child_process'

import type {
  NativeContextIndexModule,
  NativeContextModuleContext,
} from '../types.js'

export const GIT_INDEX_DEFAULT_COMMIT_LIMIT = 20
export const GIT_INDEX_MAX_COMMIT_LIMIT = 100
export const GIT_INDEX_DEFAULT_PATH_LIMIT = 100
export const GIT_INDEX_MAX_PATH_LIMIT = 500

export interface GitIndexRequest {
  readonly workspaceId?: string
  readonly workspacePath?: string
  readonly fetchRemote?: boolean
  readonly fetchIntervalMinutes?: number
  readonly commitLimit?: number
  readonly pathLimit?: number
}

export interface GitIndexCommit {
  readonly hash: string
  readonly parents: readonly string[]
  readonly author: string
  readonly authoredAt: string
  readonly subject: string
}

export interface GitIndexPath {
  readonly path: string
  readonly status: string
  readonly staged: boolean
}

export interface GitIndexSnapshot {
  readonly workspace: { readonly id: string; readonly path: string }
  readonly repository: { readonly root: string }
  readonly status: {
    readonly branch: string | null
    readonly head: string | null
    readonly clean: boolean
  }
  readonly commits: readonly GitIndexCommit[]
  readonly paths: readonly GitIndexPath[]
}

export interface GitIndexResult {
  readonly workspace: { readonly id: string; readonly path: string }
  readonly repository: {
    readonly root: string
    readonly branch: string | null
    readonly head: string | null
  } | null
  readonly commits: readonly GitIndexCommit[]
  readonly paths: readonly GitIndexPath[]
  readonly clean: boolean | null
  readonly commitsTruncated: boolean
  readonly pathsTruncated: boolean
  readonly truncated: boolean
}

/**
 * Host-owned read seam. Implementations resolve a visible registered workspace and
 * enforce its filesystem/sandbox policy before inspecting Git.
 */
export interface GitIndexReader {
  snapshot(
    request: {
      readonly workspaceId?: string
      readonly workspacePath?: string
      readonly fetchRemote: boolean
      readonly fetchIntervalMinutes: number
      readonly commitLimit: number
      readonly pathLimit: number
    },
    signal?: AbortSignal,
  ): Promise<GitIndexSnapshot | null>
  expand?(source: GitContextSourceLike, signal?: AbortSignal): Promise<string>
}

interface GitContextSourceLike {
  readonly repository_root: string
  readonly entity: 'repository' | 'commit' | 'path'
  readonly commit?: string
  readonly path?: string
}

export interface GitIndexWorkspace {
  readonly id: string
  readonly path: string
}

export interface GitIndexWorkspaceRegistry {
  get(id: string): GitIndexWorkspace | undefined
  resolveByPath(path: string): Promise<GitIndexWorkspace | undefined>
}

/** Reads bounded Git state directly from a registered local workspace. */
export class LocalGitIndexReader implements GitIndexReader {
  private readonly fetchedAt = new Map<string, number>()

  constructor(private readonly workspaces: GitIndexWorkspaceRegistry) {}

  async snapshot(
    request: {
      readonly workspaceId?: string
      readonly workspacePath?: string
      readonly fetchRemote: boolean
      readonly fetchIntervalMinutes: number
      readonly commitLimit: number
      readonly pathLimit: number
    },
    signal?: AbortSignal,
  ): Promise<GitIndexSnapshot | null> {
    const workspace = request.workspaceId === undefined
      ? await this.workspaces.resolveByPath(request.workspacePath as string)
      : this.workspaces.get(request.workspaceId)
    if (workspace === undefined) throw new Error('workspace is not registered')
    signal?.throwIfAborted()

    const root = await git(workspace.path, ['rev-parse', '--show-toplevel'], signal, true)
    if (root === '') return null
    if (request.fetchRemote) {
      const lastFetchedAt = this.fetchedAt.get(root) ?? 0
      if (Date.now() - lastFetchedAt >= request.fetchIntervalMinutes * 60_000) {
        await git(root, ['fetch', '--all', '--prune', '--quiet'], signal)
        this.fetchedAt.set(root, Date.now())
      }
    }
    const [branch, head, status] = await Promise.all([
      git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], signal, true),
      git(root, ['rev-parse', '--verify', 'HEAD'], signal, true),
      git(root, ['status', '--porcelain=v1', '-z', '--no-renames'], signal),
    ])
    const log = head === '' ? '' : await git(root, [
      'log', ...(request.fetchRemote ? ['--all'] : []),
      `--max-count=${String(request.commitLimit + 1)}`,
      '--format=%H%x1f%P%x1f%an%x1f%aI%x1f%s%x00',
    ], signal)
    signal?.throwIfAborted()
    const paths = parseStatus(status)
    return {
      workspace: { id: workspace.id, path: workspace.path },
      repository: { root },
      status: {
        branch: branch || null,
        head: head || null,
        clean: paths.length === 0,
      },
      commits: parseLog(log),
      paths: paths.slice(0, request.pathLimit + 1),
    }
  }

  async expand(source: GitContextSourceLike, signal?: AbortSignal): Promise<string> {
    if (source.entity === 'commit' && source.commit !== undefined) {
      return git(source.repository_root, [
        'show', '--stat', '--format=fuller', '--no-renames', source.commit,
      ], signal)
    }
    if (source.entity === 'path' && source.path !== undefined) {
      const [unstaged, staged] = await Promise.all([
        git(source.repository_root, ['diff', '--no-ext-diff', '--', source.path], signal),
        git(source.repository_root, ['diff', '--cached', '--no-ext-diff', '--', source.path], signal),
      ])
      return [unstaged, staged].filter(Boolean).join('\n\n')
    }
    return git(source.repository_root, ['status', '--short', '--branch'], signal)
  }
}

/** Bounded normalization over an injected, policy-aware, read-only Git service. */
export class GitIndexModule implements NativeContextIndexModule<GitIndexRequest, GitIndexResult> {
  readonly id = 'git'

  constructor(private readonly reader: GitIndexReader) {}

  async expand(
    source: GitContextSourceLike,
    context: NativeContextModuleContext,
  ): Promise<string | null> {
    if (this.reader.expand === undefined) return null
    const text = await this.reader.expand(source, context.signal)
    return text.trim() === '' ? null : text
  }

  async index(
    request: GitIndexRequest,
    context: NativeContextModuleContext,
  ): Promise<GitIndexResult> {
    const hasId = request.workspaceId !== undefined
    const hasPath = request.workspacePath !== undefined
    if (hasId === hasPath) throw new TypeError('git index requires exactly one workspace selector')
    const commitLimit = boundedLimit(
      request.commitLimit,
      GIT_INDEX_DEFAULT_COMMIT_LIMIT,
      GIT_INDEX_MAX_COMMIT_LIMIT,
      'commitLimit',
    )
    const pathLimit = boundedLimit(
      request.pathLimit,
      GIT_INDEX_DEFAULT_PATH_LIMIT,
      GIT_INDEX_MAX_PATH_LIMIT,
      'pathLimit',
    )
    const fetchIntervalMinutes = boundedLimit(
      request.fetchIntervalMinutes,
      15,
      1_440,
      'fetchIntervalMinutes',
    )
    context.signal?.throwIfAborted()
    const snapshot = await this.reader.snapshot({
      ...(request.workspaceId === undefined ? {} : { workspaceId: request.workspaceId }),
      ...(request.workspacePath === undefined ? {} : { workspacePath: request.workspacePath }),
      fetchRemote: request.fetchRemote ?? false,
      fetchIntervalMinutes,
      commitLimit,
      pathLimit,
    }, context.signal)
    context.signal?.throwIfAborted()
    if (snapshot === null) {
      return {
        workspace: {
          id: request.workspaceId ?? '',
          path: request.workspacePath ?? '',
        },
        repository: null,
        commits: [],
        paths: [],
        clean: null,
        commitsTruncated: false,
        pathsTruncated: false,
        truncated: false,
      }
    }
    const commits = snapshot.commits.slice(0, commitLimit)
    const paths = snapshot.paths.slice(0, pathLimit)
    const commitsTruncated = snapshot.commits.length > commits.length
    const pathsTruncated = snapshot.paths.length > paths.length
    return {
      workspace: snapshot.workspace,
      repository: {
        root: snapshot.repository.root,
        branch: snapshot.status.branch,
        head: snapshot.status.head,
      },
      commits,
      paths,
      clean: snapshot.status.clean,
      commitsTruncated,
      pathsTruncated,
      truncated: commitsTruncated || pathsTruncated,
    }
  }
}

function boundedLimit(
  value: number | undefined,
  fallback: number,
  maximum: number,
  name: string,
): number {
  const limit = value ?? fallback
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) {
    throw new RangeError(`${name} must be an integer from 1 to ${maximum}`)
  }
  return limit
}

function git(
  cwd: string,
  args: readonly string[],
  signal?: AbortSignal,
  allowFailure = false,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      signal,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }, (error, stdout) => {
      if (error !== null) {
        if (allowFailure && !signal?.aborted) {
          resolve('')
          return
        }
        reject(error)
        return
      }
      resolve(stdout.trimEnd())
    })
  })
}

function parseLog(output: string): GitIndexCommit[] {
  return output.split('\0').flatMap((record) => {
    if (record === '') return []
    const [hash, parents = '', author = '', authoredAt = '', subject = ''] = record.split('\x1f')
    if (hash === undefined || hash === '') return []
    return [{
      hash,
      parents: parents === '' ? [] : parents.split(' '),
      author,
      authoredAt,
      subject,
    }]
  })
}

function parseStatus(output: string): GitIndexPath[] {
  return output.split('\0').flatMap((record) => {
    if (record.length < 4) return []
    const stagedCode = record[0] as string
    const workingCode = record[1] as string
    const path = record.slice(3)
    if (path === '') return []
    return [{
      path,
      status: `${stagedCode}${workingCode}`.trim() || 'modified',
      staged: stagedCode !== ' ' && stagedCode !== '?',
    }]
  })
}
