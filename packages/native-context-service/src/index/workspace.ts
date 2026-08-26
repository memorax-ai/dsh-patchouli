import type {
  FileSystem,
  FsDirEntry,
  FsTarget,
} from '@deepseek-ai/dsh-fs'
import { FsError } from '@deepseek-ai/dsh-fs'
import { join } from 'node:path'

import type {
  NativeContextIndexModule,
  NativeContextModuleContext,
} from '../types.js'

export interface WorkspaceIndexRequest {
  /** Resolve a registered workspace by stable id. Exactly one selector is required. */
  readonly workspaceId?: string
  /** Resolve a registered workspace by its canonical directory. */
  readonly workspacePath?: string
}

export interface WorkspaceFileSource {
  readonly kind: 'workspace-file'
  readonly workspaceId: string
  readonly workspacePath: string
  readonly path: string
  readonly uri: string
  readonly version: string | null
}

export interface WorkspaceFileIndexEntry {
  readonly name: string
  readonly path: string
  readonly size: number | null
  readonly version: string | null
  /** A leading, bounded text window; null for binary or oversized files. */
  readonly text: string | null
  readonly textTruncated: boolean
  readonly source: WorkspaceFileSource
}

export interface WorkspaceIndexResult {
  readonly workspace: {
    readonly id: string
    readonly path: string
    readonly title: string
    readonly updatedAt: string
  }
  readonly files: readonly WorkspaceFileIndexEntry[]
  /** True when traversal or output stopped at a configured bound. */
  readonly truncated: boolean
}

export interface WorkspaceIndexOptions {
  readonly maxEntries?: number
  readonly maxFiles?: number
  readonly maxFileBytes?: number
  readonly maxTextCharactersPerFile?: number
  readonly maxTotalTextCharacters?: number
  readonly excludedDirectoryNames?: readonly string[]
}

/** Narrow projection of the real `@deepseek-ai/dsh-workspace` Workspace API. */
export interface WorkspaceIndexWorkspace {
  readonly id: string
  readonly path: string
  readonly title: string
  readonly updatedAt: string
}

/** Adapter seam for the branded-id WorkspaceRegistry API. */
export interface WorkspaceIndexRegistry {
  get(id: string): WorkspaceIndexWorkspace | undefined
  resolveByPath(path: string): Promise<WorkspaceIndexWorkspace | undefined>
}

type WorkspaceFileSystem = Pick<
  FileSystem,
  'contains' | 'fileUrl' | 'listDir' | 'resolve' | 'stat' | 'streamText'
>

interface TraversalDirectory {
  readonly target: FsTarget
  readonly relativePath: string
}

const defaults = {
  maxEntries: 2_000,
  maxFiles: 256,
  maxFileBytes: 256 * 1024,
  maxTextCharactersPerFile: 16_000,
  maxTotalTextCharacters: 512_000,
  excludedDirectoryNames: ['.git', '.patchouli', 'node_modules'],
} as const

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new TypeError(`${name} must be a positive safe integer`)
  }
  return resolved
}

function isUnreadableText(error: unknown): boolean {
  const code = error instanceof FsError
    ? error.code
    : typeof error === 'object' && error !== null && 'code' in error
      ? String(error.code)
      : undefined
  if (code === 'FS_NOT_TEXT' || code === 'FS_NOT_REGULAR_FILE') return true
  return error instanceof Error && /\bbinary file\b/iu.test(error.message)
}

async function leadingText(
  fs: WorkspaceFileSystem,
  target: FsTarget,
  limit: number,
  signal?: AbortSignal,
): Promise<{ readonly text: string; readonly truncated: boolean }> {
  signal?.throwIfAborted()
  const stream = await fs.streamText(target, signal)
  let text = ''
  for await (const chunk of stream) {
    signal?.throwIfAborted()
    const remaining = limit - text.length
    if (chunk.length > remaining) {
      return { text: text + chunk.slice(0, remaining), truncated: true }
    }
    text += chunk
  }
  return { text, truncated: false }
}

/** Read-only, bounded workspace acquisition for the native context pipeline. */
export class WorkspaceIndexModule implements NativeContextIndexModule<
  WorkspaceIndexRequest,
  WorkspaceIndexResult
> {
  readonly id = 'workspace'

  private readonly maxEntries: number
  private readonly maxFiles: number
  private readonly maxFileBytes: number
  private readonly maxTextCharactersPerFile: number
  private readonly maxTotalTextCharacters: number
  private readonly excludedDirectoryNames: ReadonlySet<string>

  constructor(
    private readonly fs: WorkspaceFileSystem,
    private readonly workspaces: WorkspaceIndexRegistry,
    options: WorkspaceIndexOptions = {},
  ) {
    this.maxEntries = positiveInteger(options.maxEntries, defaults.maxEntries, 'maxEntries')
    this.maxFiles = positiveInteger(options.maxFiles, defaults.maxFiles, 'maxFiles')
    this.maxFileBytes = positiveInteger(
      options.maxFileBytes,
      defaults.maxFileBytes,
      'maxFileBytes',
    )
    this.maxTextCharactersPerFile = positiveInteger(
      options.maxTextCharactersPerFile,
      defaults.maxTextCharactersPerFile,
      'maxTextCharactersPerFile',
    )
    this.maxTotalTextCharacters = positiveInteger(
      options.maxTotalTextCharacters,
      defaults.maxTotalTextCharacters,
      'maxTotalTextCharacters',
    )
    this.excludedDirectoryNames = new Set(
      options.excludedDirectoryNames ?? defaults.excludedDirectoryNames,
    )
  }

  async expand(
    source: WorkspaceFileSource,
    context: NativeContextModuleContext,
    maxCharacters = 32_000,
  ): Promise<string | null> {
    const target = await this.fs.resolve(join(source.workspacePath, source.path), {
      signal: context.signal,
    })
    const root = await this.fs.resolve(source.workspacePath, { signal: context.signal })
    if (!this.fs.contains(root, target)) return null
    try {
      return (await leadingText(this.fs, target, maxCharacters, context.signal)).text
    } catch (error: unknown) {
      if (isUnreadableText(error)) return null
      throw error
    }
  }

  async index(
    request: WorkspaceIndexRequest,
    context: NativeContextModuleContext,
  ): Promise<WorkspaceIndexResult> {
    const { signal } = context
    signal?.throwIfAborted()
    const workspace = await this.resolveWorkspace(request)
    signal?.throwIfAborted()

    const root = await this.fs.resolve(workspace.path, { signal })
    const rootInfo = await this.fs.stat(root, signal)
    if (rootInfo?.type !== 'directory') {
      throw new Error(`workspace directory is unavailable: ${workspace.path}`)
    }

    const files: WorkspaceFileIndexEntry[] = []
    const directories: TraversalDirectory[] = [{ target: root, relativePath: '' }]
    let directoryIndex = 0
    let entriesSeen = 0
    let textCharacters = 0
    let truncated = false

    while (directoryIndex < directories.length && files.length < this.maxFiles) {
      signal?.throwIfAborted()
      const directory = directories[directoryIndex++]
      if (directory === undefined) break
      const entries = await this.fs.listDir(directory.target, signal)
      for (const entry of entries) {
        signal?.throwIfAborted()
        if (entriesSeen >= this.maxEntries || files.length >= this.maxFiles) {
          truncated = true
          break
        }
        entriesSeen += 1
        if (!this.fs.contains(root, entry.target)) continue

        const path = directory.relativePath === ''
          ? entry.name
          : `${directory.relativePath}/${entry.name}`
        if (entry.type === 'directory') {
          if (!this.excludedDirectoryNames.has(entry.name)) {
            directories.push({ target: entry.target, relativePath: path })
          }
          continue
        }
        if (entry.type !== 'file') continue

        const remainingText = this.maxTotalTextCharacters - textCharacters
        const textLimit = Math.min(this.maxTextCharactersPerFile, remainingText)
        const content = await this.readText(entry, textLimit, signal)
        if (content.text !== null) textCharacters += content.text.length
        files.push({
          name: entry.name,
          path,
          size: entry.size ?? null,
          version: entry.version === undefined ? null : String(entry.version),
          text: content.text,
          textTruncated: content.truncated,
          source: {
            kind: 'workspace-file',
            workspaceId: String(workspace.id),
            workspacePath: workspace.path,
            path,
            uri: this.fs.fileUrl(entry.target),
            version: entry.version === undefined ? null : String(entry.version),
          },
        })
      }
    }

    if (directoryIndex < directories.length || files.length >= this.maxFiles) truncated = true
    return {
      workspace: {
        id: String(workspace.id),
        path: workspace.path,
        title: workspace.title,
        updatedAt: workspace.updatedAt,
      },
      files,
      truncated,
    }
  }

  private async resolveWorkspace(request: WorkspaceIndexRequest): Promise<WorkspaceIndexWorkspace> {
    const hasId = request.workspaceId !== undefined
    const hasPath = request.workspacePath !== undefined
    if (hasId === hasPath) {
      throw new TypeError('workspace index requires exactly one workspace selector')
    }
    const workspace = request.workspaceId === undefined
      ? await this.workspaces.resolveByPath(request.workspacePath as string)
      : this.workspaces.get(request.workspaceId)
    if (workspace === undefined) throw new Error('workspace is not registered')
    return workspace
  }

  private async readText(
    entry: FsDirEntry,
    limit: number,
    signal?: AbortSignal,
  ): Promise<{ readonly text: string | null; readonly truncated: boolean }> {
    if (limit === 0 || entry.size === undefined || entry.size > this.maxFileBytes) {
      return { text: null, truncated: entry.size !== 0 }
    }
    try {
      return await leadingText(this.fs, entry.target, limit, signal)
    } catch (error: unknown) {
      if (isUnreadableText(error)) return { text: null, truncated: false }
      throw error
    }
  }
}
