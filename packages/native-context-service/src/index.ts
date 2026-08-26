import type { Context } from '@deepseek-ai/cordis'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-typert-registry'
import type {} from 'dsh-patchouli/storage'
import type {} from 'dsh-patchouli/cursor-store'
import { NATIVE_CONTEXT_AT_LOCAL } from 'dsh-patchouli/native-context-at'

import { ArtifactContextAlgorithm } from './algo/artifact-context.js'
import { RepairHistoryAlgorithm } from './algo/repair-history.js'
import { ArtifactIndexModule } from './index/artifact.js'
import { GitIndexModule, LocalGitIndexReader } from './index/git.js'
import { ProjectIndexModule } from './index/project.js'
import { SessionIndex } from './index/session.js'
import { WorkspaceIndexModule } from './index/workspace.js'
import { FastRetrieveModule } from './retrieve/fast.js'
import { StandardLlmRunner } from './retrieve/standard-llm.js'
import { StandardRetrieveModule } from './retrieve/standard.js'
import {
  createNativeContextMemoryPlugin,
  NativeContextRuntime,
} from './runtime.js'
import { NativeContextService } from './service.js'
import { NativeContextAtRemote } from './web.js'
import {
  DEFAULT_NATIVE_CONTEXT_SETTINGS,
  installNativeContextSettings,
  type NativeContextSettings,
} from './settings.js'

export * from './algo/index.js'
export * from './index/index.js'
export * from './retrieve/index.js'
export * from './runtime.js'
export * from './service.js'
export * from './settings.js'
export * from './types.js'
export * from './web.js'

/** Cordis plugin identity used by loader diagnostics. */
export const name = 'dsh-patchouli-native-context-service'

/** Native context modules route persistence through the Patchouli service. */
export const inject = ['patchouli'] as const

/** Install the registry and bind indexes while their native source services exist. */
export type Config = Partial<NativeContextSettings>

export function apply(ctx: Context, config: Config = {}): void {
  const service = new NativeContextService(ctx)
  const runtime = new NativeContextRuntime(service)
  let settings = { ...DEFAULT_NATIVE_CONTEXT_SETTINGS, ...config }
  runtime.configure(settings)
  installNativeContextSettings(ctx, config, (next) => {
    settings = next
    runtime.configure(next)
  })
  ctx.patchouli.register(createNativeContextMemoryPlugin(runtime))

  let listPersistedSessions: ((signal?: AbortSignal) => Promise<readonly {
    readonly id: string
    readonly version: number
    readonly createdAt: number
    readonly cwd?: string
    readonly parentSession?: string
    readonly seedLength?: number
    readonly origin?: 'subagent'
    readonly delegationDepth?: number
    readonly agentPreset?: string
  }[]>) | undefined

  ctx.inject(['sessionPersistence'], (sourceCtx) => {
    listPersistedSessions = signal => sourceCtx.sessionPersistence.list(signal)
    return () => { listPersistedSessions = undefined }
  })

  ctx.inject(['typert', 'agents', 'sessions'], (sourceCtx) => {
    new NativeContextAtRemote(sourceCtx, runtime, sourceCtx.agents, sourceCtx.sessions)
    return sourceCtx.typert.register(NATIVE_CONTEXT_AT_LOCAL)
  })

  ctx.inject(['sessionQuery'], (sourceCtx) => {
    const index = new SessionIndex(
      sourceCtx.sessionQuery,
      signal => listPersistedSessions?.(signal) ?? sourceCtx.sessionQuery.listSessions(signal)
        .then(sessions => sessions.map(session => session.header)),
    )
    const unregisterIndex = service.registerIndex(index)
    const unsetRuntimeIndex = runtime.useSessionIndex(index)
    return () => {
      unsetRuntimeIndex()
      unregisterIndex()
    }
  })

  ctx.inject(['patchouliCursors'], (sourceCtx) => runtime.useSessionCursorStore({
    async load(sessionId) {
      const value = await sourceCtx.patchouliCursors.bind({
        consumerId: 'native-context',
        subscriptionKey: 'session-history',
        scope: sessionId,
      }).load('session-history')
      if (value === undefined) return undefined
      const cursor = Number(value)
      return Number.isSafeInteger(cursor) && cursor >= -1 ? cursor : undefined
    },
    async save(sessionId, cursor) {
      await sourceCtx.patchouliCursors.bind({
        consumerId: 'native-context',
        subscriptionKey: 'session-history',
        scope: sessionId,
      }).save('session-history', String(cursor))
    },
  }))

  ctx.inject(['workspaceRegistry', 'fs'], (sourceCtx) => {
    const workspace = new WorkspaceIndexModule(sourceCtx.fs, {
      get: id => sourceCtx.workspaceRegistry.get(WorkspaceId(id)),
      resolveByPath: path => sourceCtx.workspaceRegistry.resolveByPath(path),
    })
    const disposeWorkspace = service.registerIndex(workspace)
    const disposeProject = service.registerIndex(new ProjectIndexModule(workspace))
    const git = new GitIndexModule(new LocalGitIndexReader({
      get: id => sourceCtx.workspaceRegistry.get(WorkspaceId(id)),
      resolveByPath: path => sourceCtx.workspaceRegistry.resolveByPath(path),
    }))
    const disposeGit = service.registerIndex(git)
    const unsetRuntimeSource = runtime.useWorkspaceSource({
      index: workspace,
      async resolveId(path) {
        const resolved = await sourceCtx.workspaceRegistry.resolveByPath(path)
        return resolved === undefined ? undefined : String(resolved.id)
      },
    })
    const unsetGitSource = runtime.useGitSource({ index: git })
    return () => {
      unsetGitSource()
      unsetRuntimeSource()
      disposeGit()
      disposeProject()
      disposeWorkspace()
    }
  })

  ctx.inject(['patchouliStorage'], (sourceCtx) => {
    const storage = sourceCtx.patchouliStorage
    const disposers = [
      service.registerIndex(new ArtifactIndexModule(storage)),
      service.registerAlgorithm(new ArtifactContextAlgorithm(storage)),
      service.registerAlgorithm(new RepairHistoryAlgorithm(storage)),
    ]
    disposers.push(service.registerRetriever(new FastRetrieveModule(service)))
    return () => {
      for (const dispose of disposers.reverse()) dispose()
    }
  })

  ctx.inject(['patchouliStorage', 'llm'], (sourceCtx) => {
    const fast = service.getRetriever('fast') as FastRetrieveModule
    const runner = new StandardLlmRunner(sourceCtx.llm, () => settings)
    return service.registerRetriever(new StandardRetrieveModule(fast, runner, runner))
  })
}
