import { randomUUID } from 'node:crypto'

import type {
  AgentHandle,
  AgentOptions,
  AgentSetup,
  CreateAgentOptions,
  ResumeAgentOptions,
} from '@deepseek-ai/dsh-agent'
import type { CompactionEngine } from '@deepseek-ai/dsh-compaction'
import type {
  Session,
  SessionEvent,
  SessionHeader,
  SessionId,
  SessionStore,
} from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'

import { ArchivePolicyStore, type ArchivePolicyOverride } from './policy-store.js'
import { TimelineStore, type ArchiveTimeline } from './timeline.js'

export interface SessionArchiveRuntime {
  readonly compaction: Pick<CompactionEngine, 'compactRegion'>
  readonly persistence: Pick<SessionPersistence, 'readFrom'>
  readonly sessions: Pick<SessionStore, 'flush'>
  create(options: CreateAgentOptions): Promise<AgentHandle>
  resume(options: ResumeAgentOptions): Promise<AgentHandle>
}

export interface RotateOptions {
  readonly sessionId?: SessionId
  readonly setup?: AgentSetup
  readonly signal?: AbortSignal
}

export interface ResumeOptions {
  readonly agentOptions?: AgentOptions
  readonly setup?: AgentSetup
  readonly signal?: AbortSignal
}

export interface ArchivePolicy {
  readonly enabled: boolean
  readonly maxEvents: number
  readonly maxMegabytes: number
  readonly maxAgeHours: number
}

export const DEFAULT_ARCHIVE_POLICY: ArchivePolicy = {
  enabled: true,
  maxEvents: 2_000,
  maxMegabytes: 64,
  maxAgeHours: 24,
}

export interface ArchiveRotation {
  readonly handle: AgentHandle
  readonly reasons: readonly ('events' | 'size' | 'age')[]
}

export interface ArchivePolicySelection {
  readonly global: ArchivePolicy
  readonly override?: ArchivePolicyOverride
  readonly effective: ArchivePolicy
}

export interface ArchiveCursor {
  readonly segment: number
  readonly beforeSeq: number
}

export interface ArchivePageItem {
  readonly segment: number
  readonly sessionId: string
  readonly event: SessionEvent
}

export interface ArchivePage {
  readonly items: readonly ArchivePageItem[]
  readonly previous?: ArchiveCursor
}

export class SessionArchive {
  private readonly timelines: TimelineStore
  private readonly policies: ArchivePolicyStore
  private readonly rotating = new Set<string>()
  private readonly measuredSessions = new WeakMap<Session, { count: number; bytes: number }>()
  private policy: ArchivePolicy

  constructor(
    root: string,
    private readonly runtime: SessionArchiveRuntime,
    policy: ArchivePolicy = DEFAULT_ARCHIVE_POLICY,
  ) {
    this.timelines = new TimelineStore(root)
    this.policies = new ArchivePolicyStore(root)
    this.policy = policy
  }

  configure(policy: ArchivePolicy): void {
    this.policy = policy
  }

  async policyFor(logicalId: string): Promise<ArchivePolicySelection> {
    const override = await this.policies.read(logicalId)
    return {
      global: { ...this.policy },
      ...(override === undefined ? {} : { override }),
      effective: { ...this.policy, ...override },
    }
  }

  async setPolicyOverride(
    logicalId: string,
    override: ArchivePolicyOverride | undefined,
  ): Promise<ArchivePolicySelection> {
    await this.policies.write(logicalId, override)
    return this.policyFor(logicalId)
  }

  attach(logicalId: string, sessionId: string): Promise<ArchiveTimeline> {
    return this.timelines.attach(logicalId, sessionId)
  }

  timeline(logicalId: string): Promise<ArchiveTimeline> {
    return this.timelines.require(logicalId)
  }

  find(logicalId: string): Promise<ArchiveTimeline | undefined> {
    return this.timelines.read(logicalId)
  }

  async rotateIfNeeded(
    logicalId: string,
    handle: AgentHandle,
    options: RotateOptions = {},
  ): Promise<ArchiveRotation | undefined> {
    const policy = (await this.policyFor(logicalId)).effective
    if (!policy.enabled) return undefined
    const timeline = await this.timelines.attach(logicalId, String(handle.agent.id))
    const reasons: Array<'events' | 'size' | 'age'> = []
    if (policy.maxEvents > 0 && handle.agent.session.events.length >= policy.maxEvents) reasons.push('events')
    if (policy.maxMegabytes > 0
      && this.sessionBytes(handle.agent.session) >= policy.maxMegabytes * 1024 * 1024) reasons.push('size')
    const openedAt = timeline.segments.at(-1)?.openedAt ?? Date.now()
    if (policy.maxAgeHours > 0
      && Date.now() - openedAt >= policy.maxAgeHours * 60 * 60 * 1_000) reasons.push('age')
    if (reasons.length === 0) return undefined
    return { handle: await this.rotate(logicalId, handle, options), reasons }
  }

  async rotate(
    logicalId: string,
    handle: AgentHandle,
    options: RotateOptions = {},
  ): Promise<AgentHandle> {
    if (this.rotating.has(logicalId)) throw new Error(`logical Session ${logicalId} is already rotating`)
    this.rotating.add(logicalId)
    try {
      const agent = handle.agent
      if (agent.status !== 'idle') throw new Error(`Session ${String(agent.id)} must be idle before rotation`)
      const timeline = await this.timelines.attach(logicalId, String(agent.id))
      if (timeline.activeSessionId !== String(agent.id)) {
        throw new Error(`logical Session ${logicalId} currently points to ${timeline.activeSessionId}`)
      }

      let nodes = [...agent.session.surface.nodes]
      if (nodes.length > 1) {
        await this.runtime.compaction.compactRegion(nodes[0]!, nodes.at(-1)!, agent, options.signal)
        nodes = [...agent.session.surface.nodes]
      }
      if (nodes.length > 1) throw new Error('compaction did not reduce the Session surface to one checkpoint')

      const seed = nodes.length === 0 ? [] : [checkpointSeed(agent.session, nodes[0]!)]
      await this.runtime.sessions.flush(agent.session)
      const previousSessionId = String(agent.id)
      const previousEventCount = agent.session.events.length
      const nextSessionId = options.sessionId ?? (`session-${randomUUID()}` as SessionId)
      const meta = continuationMeta(agent.session.header, previousSessionId as SessionId, seed.length)
      const agentOptions = { ...agent.options }

      await handle.dispose()
      const successor = await this.runtime.create({
        sessionId: nextSessionId,
        seed,
        meta,
        agentOptions,
        ...(options.setup === undefined ? {} : { setup: options.setup }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
      try {
        await this.timelines.rotate(logicalId, previousSessionId, String(nextSessionId), previousEventCount)
      } catch (error) {
        await successor.dispose()
        throw error
      }
      return successor
    } finally {
      this.rotating.delete(logicalId)
    }
  }

  async resume(logicalId: string, options: ResumeOptions = {}): Promise<AgentHandle> {
    const timeline = await this.timelines.require(logicalId)
    return this.runtime.resume({
      resumeSessionId: timeline.activeSessionId as SessionId,
      ...(options.agentOptions === undefined ? {} : { agentOptions: options.agentOptions }),
      ...(options.setup === undefined ? {} : { setup: options.setup }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
  }

  async readPage(logicalId: string, options: {
    readonly cursor?: ArchiveCursor
    readonly limit?: number
    readonly signal?: AbortSignal
  } = {}): Promise<ArchivePage> {
    const timeline = await this.timelines.require(logicalId)
    const limit = options.limit ?? 100
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error('archive page limit must be an integer from 1 to 1000')
    }
    const segment = options.cursor?.segment ?? timeline.segments.length - 1
    if (!Number.isSafeInteger(segment) || segment < 0 || segment >= timeline.segments.length) {
      throw new Error(`archive segment ${segment} is out of range`)
    }
    const descriptor = timeline.segments[segment]!
    const requestedBefore = options.cursor?.beforeSeq ?? descriptor.eventCount
    const fromSeq = requestedBefore === undefined ? 0 : Math.max(0, requestedBefore - limit)
    const loaded = await this.runtime.persistence.readFrom(
      descriptor.sessionId as SessionId,
      fromSeq,
      options.signal,
    )
    const storedEnd = loaded.events.at(-1)?.seq === undefined ? fromSeq : loaded.events.at(-1)!.seq + 1
    const beforeSeq = Math.min(requestedBefore ?? storedEnd, storedEnd)
    if (!Number.isSafeInteger(beforeSeq) || beforeSeq < 0) throw new Error('archive cursor beforeSeq is invalid')
    const start = Math.max(0, beforeSeq - limit)
    const items = loaded.events
      .filter(event => event.seq >= start && event.seq < beforeSeq)
      .map(event => ({ segment, sessionId: descriptor.sessionId, event }))
    const previous = start > 0
      ? { segment, beforeSeq: start }
      : segment > 0
        ? {
            segment: segment - 1,
            beforeSeq: timeline.segments[segment - 1]!.eventCount ?? Number.MAX_SAFE_INTEGER,
          }
        : undefined
    return { items, ...(previous === undefined ? {} : { previous }) }
  }

  private sessionBytes(session: Session): number {
    const measured = this.measuredSessions.get(session) ?? { count: 0, bytes: 0 }
    for (let index = measured.count; index < session.events.length; index += 1) {
      measured.bytes += Buffer.byteLength(JSON.stringify(session.events[index]), 'utf8')
    }
    measured.count = session.events.length
    this.measuredSessions.set(session, measured)
    return measured.bytes
  }
}

function checkpointSeed(session: Session, seq: number): SessionEvent {
  const source = session.events[seq]
  if (source?.type !== 'user/message') {
    throw new Error('rotation requires a user-message checkpoint after compaction')
  }
  const { seq: _seq, time: _time, sourceEventSeqs: _sources, surfaceOp: _surface, ...event } = source
  return {
    ...structuredClone(event),
    seq: 0,
    time: Date.now(),
    surfaceOp: 'append',
  }
}

function continuationMeta(
  header: SessionHeader,
  parentSession: SessionId,
  seedLength: number,
): CreateAgentOptions['meta'] {
  return {
    ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
    parentSession,
    seedLength,
    ...(header.origin === undefined ? {} : { origin: header.origin }),
    ...(header.delegationDepth === undefined ? {} : { delegationDepth: header.delegationDepth }),
    ...(header.agentPreset === undefined ? {} : { agentPreset: header.agentPreset }),
  }
}
