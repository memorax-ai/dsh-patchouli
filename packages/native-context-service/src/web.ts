import type { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { SessionId, type SessionStore } from '@deepseek-ai/dsh-session'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Context } from '@deepseek-ai/cordis'
import {
  type NativeContextAtSearchInput,
  type NativeContextAtSearchPage,
  type NativeContextAtSearchResult,
} from 'dsh-patchouli/native-context-at'

import type { FastRetrieveHit } from './retrieve/fast.js'
import type { NativeContextRetrieveResult, NativeContextRuntime } from './runtime.js'

const MAX_RESULTS = 20
const PAGE_RESULTS = 8
const NON_SESSION_SOURCES = [
  'workspace-context',
  'project-state',
  'artifact-context',
  'git-context',
  'repair-history',
  'context-catalog',
] as const

export class NativeContextAtRemote extends TypertRemoteService {
  constructor(
    ctx: Context,
    private readonly runtime: NativeContextRuntime,
    private readonly agents: AgentRegistry,
    private readonly sessions: SessionStore,
  ) {
    super(ctx, 'patchouliNativeContextAt', { namespace: 'patchouliNativeContextAt' })
  }

  async search(
    input: NativeContextAtSearchInput,
    signal: AbortSignal,
  ): Promise<NativeContextAtSearchPage> {
    const sessionId = input.sessionId.trim()
    const query = input.query.trim()
    if (sessionId === '' || query === '') return { items: [], complete: true }
    signal.throwIfAborted()
    const id = SessionId(sessionId)
    const cwd = this.agents.get(id)?.session.header.cwd
      ?? this.sessions.get(id)?.header.cwd
    const meta = {
      source: { type: 'agent-loop' as const, id: 'dsh-patchouli-agent-loop' },
      scope: cwd ?? sessionId,
      attributes: {
        sessionId,
        ...(cwd === undefined ? {} : { workspaceRoot: cwd }),
      },
    }
    const [native, sessions] = await Promise.all([
      input.cursor === undefined
        ? this.runtime.retrieve({
            meta,
            data: {
              query,
              limit: PAGE_RESULTS,
              metadata: {
                effort: 'low',
                agent: false,
                includeRawHits: true,
                sourceIds: NON_SESSION_SOURCES,
              },
            },
          }, { signal }) as unknown as Promise<NativeContextRetrieveResult>
        : Promise.resolve(undefined),
      this.runtime.searchSessionsPage({
        sessionId,
        query,
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        limit: PAGE_RESULTS,
      }, { signal }),
    ])
    signal.throwIfAborted()
    const hits = [...(native?.rawHits ?? []), ...sessions.hits]
    return {
      items: hits.slice(0, MAX_RESULTS).map(toSearchResult),
      ...(sessions.nextCursor === undefined ? {} : { nextCursor: sessions.nextCursor }),
      complete: sessions.complete,
    }
  }
}

function toSearchResult(hit: FastRetrieveHit): NativeContextAtSearchResult {
  return { ...toSearchResultBase(hit), detail: hit.text }
}

function toSearchResultBase(hit: FastRetrieveHit): NativeContextAtSearchResult {
  const source = hit.source
  if ('type' in source && source.type === 'session-event') {
    const location = `${source.sessionId}#${source.seq}`
    return {
      id: `session:${location}`,
      label: eventLabel(source.eventType, source.seq),
      description: preview(hit.text),
      sourceLabel: 'Session',
      ref: inlineReference('Session event', location, hit.text),
      appearance: 'session',
      clipboardText: inlineReference('Session event', location, hit.text),
    }
  }
  if (!('kind' in source)) throw new Error('Native Context returned an unknown source')
  if (source.kind === 'workspace-file') {
    const ref = fileMention(source.path)
    return {
      id: `workspace:${source.workspaceId}:${source.path}`,
      label: basename(source.path),
      description: preview(hit.text),
      sourceLabel: 'Workspace',
      ref,
      appearance: 'file',
      clipboardText: ref,
    }
  }
  if (source.kind === 'git') {
    const location = source.path ?? source.commit ?? source.repository_root
    return {
      id: `git:${source.workspace_id}:${source.entity}:${location}`,
      label: source.path === undefined ? `Git ${source.entity}` : basename(source.path),
      description: preview(hit.text),
      sourceLabel: 'Git',
      ref: inlineReference('Git context', location, hit.text),
      appearance: 'file',
    }
  }
  if (source.kind === 'patchouli-artifact') {
    return {
      id: `artifact:${source.id}:${source.version}`,
      label: source.id,
      description: preview(hit.text),
      sourceLabel: 'Artifact',
      ref: inlineReference('Artifact', `${source.id}@${source.version}`, hit.text),
      appearance: 'file',
    }
  }
  if (source.kind === 'repair-history') {
    const location = `${source.sessionId}#${source.fromSeq}-${source.toSeq}`
    return {
      id: `repair:${location}`,
      label: `Repair #${source.fromSeq}-${source.toSeq}`,
      description: preview(hit.text),
      sourceLabel: 'Repair history',
      ref: inlineReference('Repair history', location, hit.text),
      appearance: 'session',
    }
  }
  const location = source.path ?? source.sessionId ?? source.id
  return {
    id: `catalog:${source.node}:${source.id}`,
    label: source.path === undefined ? source.id : basename(source.path),
    description: preview(hit.text),
    sourceLabel: 'Context catalog',
    ref: inlineReference('Context catalog', location, hit.text),
    appearance: source.node === 'session' ? 'session' : 'file',
  }
}

function eventLabel(type: string, seq: number): string {
  const label = type.split('/').at(-1)?.replaceAll('-', ' ') ?? type
  return `${label} #${seq}`
}

function basename(path: string): string {
  return path.split(/[\\/]/u).at(-1) || path
}

function preview(text: string): string {
  const compact = text.replace(/\s+/gu, ' ').trim()
  return compact.length <= 180 ? compact : `${compact.slice(0, 177)}…`
}

function fileMention(path: string): string {
  return /\s/u.test(path) ? `@"${path.replaceAll('"', '\\"')}"` : `@${path}`
}

function inlineReference(kind: string, location: string, text: string): string {
  return `[Patchouli ${kind}: ${location}]\n${text}`
}
