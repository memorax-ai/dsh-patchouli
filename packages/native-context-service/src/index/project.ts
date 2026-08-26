import type {
  NativeContextIndexModule,
  NativeContextModuleContext,
} from '../types.js'
import type {
  WorkspaceFileIndexEntry,
  WorkspaceIndexRequest,
  WorkspaceIndexResult,
} from './workspace.js'

export const PROJECT_INDEX_DEFAULT_LIMIT = 32
export const PROJECT_INDEX_MAX_LIMIT = 100

export interface ProjectIndexRequest extends WorkspaceIndexRequest {
  readonly limit?: number
}

export type ProjectDocumentKind =
  | 'readme'
  | 'plan'
  | 'roadmap'
  | 'checklist'
  | 'tasks'
  | 'contributing'

export interface ProjectDocumentIndexEntry extends WorkspaceFileIndexEntry {
  readonly kind: ProjectDocumentKind
}

export interface ProjectIndexResult {
  readonly workspace: WorkspaceIndexResult['workspace']
  readonly documents: readonly ProjectDocumentIndexEntry[]
  readonly truncated: boolean
}

/** Selects explicit project material from the already policy-filtered Workspace index. */
export class ProjectIndexModule implements NativeContextIndexModule<
  ProjectIndexRequest,
  ProjectIndexResult
> {
  readonly id = 'project'

  constructor(private readonly workspace: NativeContextIndexModule<WorkspaceIndexRequest, WorkspaceIndexResult>) {}

  async index(
    request: ProjectIndexRequest,
    context: NativeContextModuleContext,
  ): Promise<ProjectIndexResult> {
    const limit = request.limit ?? PROJECT_INDEX_DEFAULT_LIMIT
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > PROJECT_INDEX_MAX_LIMIT) {
      throw new RangeError(`project index limit must be an integer from 1 to ${PROJECT_INDEX_MAX_LIMIT}`)
    }
    context.signal?.throwIfAborted()
    const indexed = await this.workspace.index({
      ...(request.workspaceId === undefined ? {} : { workspaceId: request.workspaceId }),
      ...(request.workspacePath === undefined ? {} : { workspacePath: request.workspacePath }),
    }, context)
    context.signal?.throwIfAborted()
    return projectIndexFromWorkspace(indexed, limit)
  }
}

/** Reuse an acquired workspace snapshot without scanning the same workspace twice. */
export function projectIndexFromWorkspace(
  indexed: WorkspaceIndexResult,
  limit = PROJECT_INDEX_DEFAULT_LIMIT,
): ProjectIndexResult {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > PROJECT_INDEX_MAX_LIMIT) {
    throw new RangeError(`project index limit must be an integer from 1 to ${PROJECT_INDEX_MAX_LIMIT}`)
  }
  const candidates = indexed.files.flatMap(file => {
    const kind = projectDocumentKind(file.path)
    return kind === undefined ? [] : [{ ...file, kind }]
  })
  return {
    workspace: indexed.workspace,
    documents: candidates.slice(0, limit),
    truncated: indexed.truncated || candidates.length > limit,
  }
}

function projectDocumentKind(path: string): ProjectDocumentKind | undefined {
  const name = path.slice(path.lastIndexOf('/') + 1).toLocaleLowerCase()
  const stem = name.replace(/\.(?:md|markdown|txt|rst)$/u, '')
  if (stem === 'readme') return 'readme'
  if (stem === 'plan' || stem.endsWith('-plan') || stem.startsWith('plan-')) return 'plan'
  if (stem === 'roadmap') return 'roadmap'
  if (stem === 'checklist' || stem.endsWith('-checklist')) return 'checklist'
  if (stem === 'todo' || stem === 'todos' || stem === 'tasks') return 'tasks'
  if (stem === 'contributing') return 'contributing'
  return undefined
}
