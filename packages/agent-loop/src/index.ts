import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { snapshotJsonValue, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionInspection } from '@deepseek-ai/dsh-session-persistence'
import { AsyncLocalStorage } from 'node:async_hooks'
import {
  defineTool,
  type PostToolDecision,
  type ToolExecution,
  type ToolExecutionResult,
} from '@deepseek-ai/dsh-tools'
import type {
  MemoryCallMeta,
  MemoryData,
  MemoryPluginOutcome,
} from 'dsh-patchouli'

export const name = 'dsh-patchouli-agent-loop'

export const inject = [
  'agents',
  'sessions',
  'sessionPersistence',
  'tools',
  'patchouli',
] as const

export interface RetrieveHooksConfig {
  sessionStart?: boolean
  preStep?: boolean
  turnStopping?: boolean
  toolPostExecute?: boolean
}

export interface StoreHooksConfig {
  agentCreated?: boolean
  agentDisposed?: boolean
  requestError?: boolean
  agentError?: boolean
  turnEnd?: boolean
  toolResult?: boolean
}

export interface ModelToolsConfig {
  retrieve?: boolean
  update?: boolean
}

export interface Config {
  retrieve?: RetrieveHooksConfig
  store?: StoreHooksConfig
  modelTools?: ModelToolsConfig
}

export const Config: z<Config> = z.object({
  retrieve: z.object({
    sessionStart: z.boolean().default(false),
    preStep: z.boolean().default(true),
    turnStopping: z.boolean().default(false),
    toolPostExecute: z.boolean().default(false),
  }).default({
    sessionStart: false,
    preStep: true,
    turnStopping: false,
    toolPostExecute: false,
  }),
  store: z.object({
    agentCreated: z.boolean().default(false),
    agentDisposed: z.boolean().default(false),
    requestError: z.boolean().default(false),
    agentError: z.boolean().default(false),
    turnEnd: z.boolean().default(true),
    toolResult: z.boolean().default(false),
  }).default({
    agentCreated: false,
    agentDisposed: false,
    requestError: false,
    agentError: false,
    turnEnd: true,
    toolResult: false,
  }),
  modelTools: z.object({
    retrieve: z.boolean().default(true),
    update: z.boolean().default(true),
  }).default({ retrieve: true, update: true }),
})

export type AgentLoopDataPoint =
  | 'tool/memory-retrieve'
  | 'tool/memory-update'
  | 'agent/created'
  | 'agent/disposed'
  | 'agent/session-start'
  | 'agent/pre-step'
  | 'agent/request-error'
  | 'agent/turn-stopping'
  | 'agent/error'
  | 'session/turn-end'
  | 'tools/post-execute'
  | 'tools/result'

export interface WorkspaceFileResource {
  readonly kind: 'workspace-file'
  readonly path: string
  readonly mediaType?: string
  readonly name?: string
  readonly role?: 'source' | 'attachment'
}

function snapshot(value: unknown): MemoryData {
  const data = snapshotJsonValue(value)
  if (data === undefined) throw new TypeError('agent-loop observation must be lossless JSON')
  return data as MemoryData
}

function scopeForSession(session: Session): string {
  return session.header.cwd ?? String(session.header.id)
}

function callMeta(
  session: Session,
  point: AgentLoopDataPoint,
  attributes: Record<string, string | number> = {},
): MemoryCallMeta {
  return {
    source: {
      type: 'agent-loop',
      id: name,
    },
    scope: scopeForSession(session),
    attributes: {
      point,
      sessionId: String(session.header.id),
      ...session.header.cwd === undefined ? {} : { workspaceRoot: session.header.cwd },
      ...attributes,
    },
  }
}

function observation(
  agent: Agent,
  data: Record<string, unknown>,
  events?: readonly SessionEvent[],
): MemoryData {
  return snapshot({
    agent: agentData(agent),
    session: {
      header: agent.session.header,
      ...events === undefined ? {} : { events },
    },
    ...data,
  })
}

function agentData(agent: Agent): Record<string, unknown> {
  return {
    id: String(agent.id),
    status: agent.status,
    options: agent.options,
  }
}

function turnEvents(session: Session, turn: number, endSeq?: number): readonly SessionEvent[] {
  const start = session.events.findLastIndex(event => (
    event.type === 'turn/start'
    && event.data.turn === turn
    && (endSeq === undefined || event.seq <= endSeq)
  ))
  if (start < 0) return []
  return session.events.slice(start).filter(event => endSeq === undefined || event.seq <= endSeq)
}

function turnStartSeq(session: Session, turn: number, endSeq: number): number {
  const start = session.events.findLast(event => (
    event.type === 'turn/start'
    && event.data.turn === turn
    && event.seq <= endSeq
  ))
  if (start === undefined) throw new Error(`session has no matching turn/start for turn ${turn}`)
  return start.seq
}

function persistedTurn(
  inspection: SessionInspection,
  turn: number,
  endSeq: number,
): { event: SessionEvent, events: readonly SessionEvent[] } {
  const inspectedEvents = inspection.events.filter(event => event.seq <= endSeq)
  const endIndex = inspectedEvents.findIndex(event => event.seq === endSeq)
  const event = inspectedEvents[endIndex]
  if (event?.type !== 'turn/end' || event.data.turn !== turn) {
    throw new Error(`persisted session has no matching turn/end at seq ${endSeq}`)
  }
  const startIndex = inspectedEvents.findLastIndex((candidate, index) => (
    index <= endIndex
    && candidate.type === 'turn/start'
    && candidate.data.turn === turn
  ))
  if (startIndex < 0) throw new Error(`persisted session has no matching turn/start for turn ${turn}`)
  const events = inspectedEvents.slice(startIndex, endIndex + 1)
  for (let index = 1; index < events.length; index += 1) {
    if (events[index]!.seq !== events[index - 1]!.seq + 1) {
      throw new Error(`persisted turn ${turn} is not contiguous`)
    }
  }
  return { event, events }
}

function toolExecutionData(exec: ToolExecution): MemoryData {
  return snapshot({
    callId: exec.callId,
    rootCallId: exec.rootCallId,
    name: exec.name,
    arguments: exec.arguments,
    nested: exec.parent !== undefined,
  })
}

function errorData(error: unknown): MemoryData {
  const json = snapshotJsonValue(error)
  if (json !== undefined) return json as MemoryData
  if (error instanceof Error) {
    return snapshot({
      name: error.name,
      message: error.message,
      ...error.stack === undefined ? {} : { stack: error.stack },
    })
  }
  return String(error)
}

function aggregateForContext(
  point: AgentLoopDataPoint,
  outcomes: readonly MemoryPluginOutcome<MemoryData>[],
): UserMessage | undefined {
  const results = outcomes.flatMap((outcome) => {
    if (!outcome.ok) return []
    if (isSemanticallyEmpty(outcome.value)) return []
    return [{ pluginId: outcome.pluginId, data: outcome.value }]
  })
  if (results.length === 0) return undefined
  return createUserMessage({
    content: [{
      type: 'text',
      text: JSON.stringify({
        kind: 'patchouli-memory-results',
        point,
        results,
      }),
    }],
    source: { kind: 'plugin', plugin: name, form: 'recall' },
  })
}

const emptyResultMetadata = new Set([
  'count',
  'hasMore',
  'length',
  'size',
  'total',
  'truncated',
])

function isSemanticallyEmpty(value: MemoryData, field?: string): boolean {
  if (value === null) return true
  if (typeof value === 'string') return value.trim() === ''
  if (typeof value === 'number') return value === 0 && emptyResultMetadata.has(field ?? '')
  if (typeof value === 'boolean') return !value && emptyResultMetadata.has(field ?? '')
  if (Array.isArray(value)) return value.every(item => isSemanticallyEmpty(item))
  return Object.entries(value).every(([key, item]) => isSemanticallyEmpty(item, key))
}

function outcomeJson<T>(outcomes: readonly MemoryPluginOutcome<T>[]): string {
  return JSON.stringify(outcomes)
}

function warnFailures(
  ctx: Context,
  operation: 'retrieve' | 'update',
  outcomes: readonly MemoryPluginOutcome<unknown>[],
): void {
  for (const outcome of outcomes) {
    if (!outcome.ok) {
      ctx.logger.warn(`patchouli ${operation} failed for memory plugin ${JSON.stringify(outcome.pluginId)}: ${outcome.error}`)
    }
  }
}

function mergeAdditionalContexts(
  decision: PostToolDecision,
  messages: UserMessage[],
): PostToolDecision {
  if (messages.length === 0) return decision
  return {
    ...decision,
    additionalContexts: [...decision.additionalContexts ?? [], ...messages],
  }
}

export function apply(ctx: Context, config: Config): void {
  const retrieve = {
    sessionStart: config.retrieve?.sessionStart ?? false,
    preStep: config.retrieve?.preStep ?? true,
    turnStopping: config.retrieve?.turnStopping ?? false,
    toolPostExecute: config.retrieve?.toolPostExecute ?? false,
  }
  const store = {
    agentCreated: config.store?.agentCreated ?? false,
    agentDisposed: config.store?.agentDisposed ?? false,
    requestError: config.store?.requestError ?? false,
    agentError: config.store?.agentError ?? false,
    turnEnd: config.store?.turnEnd ?? true,
    toolResult: config.store?.toolResult ?? false,
  }
  const modelTools = {
    retrieve: config.modelTools?.retrieve ?? true,
    update: config.modelTools?.update ?? true,
  }
  const lifetime = new AbortController()
  const internalSessionFlush = new AsyncLocalStorage<Session>()
  const updateChains = new Map<Session, Promise<void>>()
  const backgroundTasks = new Set<Promise<void>>()

  ctx.effect(() => async () => {
    lifetime.abort(new Error('dsh-patchouli-agent-loop disposed'))
    await Promise.allSettled([...updateChains.values(), ...backgroundTasks])
  }, 'dsh-patchouli-agent-loop: abort and drain memory work')

  function track(task: Promise<void>): void {
    backgroundTasks.add(task)
    const settled = (): void => {
      backgroundTasks.delete(task)
    }
    void task.then(settled, settled)
  }

  function enqueueSessionTask(session: Session, run: () => Promise<void>): Promise<void> {
    const previous = updateChains.get(session) ?? Promise.resolve()
    const current = previous.then(run, run)
    updateChains.set(session, current)
    const settled = (): void => {
      if (updateChains.get(session) === current) updateChains.delete(session)
    }
    void current.then(settled, settled)
    return current
  }

  async function dispatchUpdate(
    session: Session,
    point: AgentLoopDataPoint,
    data: MemoryData,
    attributes: Record<string, string | number> = {},
  ): Promise<void> {
    if (lifetime.signal.aborted) return
    try {
      const outcomes = await ctx.patchouli.update({
        meta: callMeta(session, point, attributes),
        data,
      }, lifetime.signal)
      warnFailures(ctx, 'update', outcomes)
    } catch (error: unknown) {
      if (lifetime.signal.aborted) return
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger.warn(`patchouli update at ${point} failed: ${message}`)
    }
  }

  function enqueueUpdate(
    session: Session,
    point: AgentLoopDataPoint,
    data: MemoryData,
    attributes: Record<string, string | number> = {},
  ): void {
    void enqueueSessionTask(
      session,
      () => dispatchUpdate(session, point, data, attributes),
    )
  }

  async function retrieveAt(
    session: Session,
    point: AgentLoopDataPoint,
    data: MemoryData,
    signal: AbortSignal,
    attributes: Record<string, string | number> = {},
  ): Promise<UserMessage[]> {
    try {
      const outcomes = await ctx.patchouli.retrieve({
        meta: callMeta(session, point, attributes),
        data,
      }, signal)
      signal.throwIfAborted()
      warnFailures(ctx, 'retrieve', outcomes)
      const message = aggregateForContext(point, outcomes)
      return message === undefined ? [] : [message]
    } catch (error: unknown) {
      signal.throwIfAborted()
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger.warn(`patchouli retrieve at ${point} failed: ${message}`)
      return []
    }
  }

  if (modelTools.retrieve) {
    ctx.tools.register(defineTool({
      name: 'memory_retrieve',
      description: 'Retrieve stored data related to the supplied query.',
      parameters: {
        query: {
          type: 'string',
          required: true,
          description: 'The information to retrieve.',
        },
        limit: {
          type: 'integer',
          description: 'Optional positive maximum number of results requested from each plugin.',
        },
        metadata: {
          type: 'object',
          additionalProperties: true,
          description: 'Optional plugin-defined JSON metadata used to refine retrieval.',
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args, exec) {
        if (exec.agent === undefined) throw new Error('memory_retrieve requires an owning agent session')
        const query = args.query.trim()
        if (query === '') throw new Error('memory_retrieve query must be non-empty')
        if (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || args.limit < 1)) {
          throw new Error('memory_retrieve limit must be a positive safe integer')
        }

        const outcomes = await ctx.patchouli.retrieve({
          meta: callMeta(exec.agent.session, 'tool/memory-retrieve'),
          data: snapshot({
            query,
            ...args.limit === undefined ? {} : { limit: args.limit },
            ...args.metadata === undefined ? {} : { metadata: args.metadata },
          }),
        }, exec.signal)
        warnFailures(ctx, 'retrieve', outcomes)
        return outcomeJson(outcomes)
      },
      presentCall: args => ({ card: 'generic', title: 'Retrieve memory', kind: 'read', rawInput: args.query }),
    }))
  }

  if (modelTools.update) {
    ctx.tools.register(defineTool({
      name: 'memory_update',
      description: 'Submit messages or workspace files to installed memory plugins.',
      parameters: {
        messages: {
          type: 'array',
          description: 'One or more user or assistant messages to submit.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              role: {
                type: 'string',
                required: true,
                enum: ['user', 'assistant'],
              },
              content: {
                type: 'string',
                required: true,
              },
            },
          },
        },
        resources: {
          type: 'array',
          description: 'Workspace files to store as managed knowledge artifacts.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: {
                type: 'string',
                required: true,
                enum: ['workspace-file'],
              },
              path: {
                type: 'string',
                required: true,
              },
              mediaType: {
                type: 'string',
              },
              name: {
                type: 'string',
              },
              role: {
                type: 'string',
                enum: ['source', 'attachment'],
              },
            },
          },
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args, exec) {
        if (exec.agent === undefined) throw new Error('memory_update requires an owning agent session')
        const messages = (args.messages ?? []).map(message => {
          const content = message.content.trim()
          if (content === '') throw new Error('memory_update message content must be non-empty')
          return { role: message.role, content }
        })
        const resources: WorkspaceFileResource[] = (args.resources ?? []).map(resource => {
          const path = resource.path.trim()
          if (path === '') throw new Error('memory_update resource path must be non-empty')
          const mediaType = resource.mediaType?.trim()
          if (resource.mediaType !== undefined && mediaType === '') {
            throw new Error('memory_update resource mediaType must be non-empty')
          }
          const name = resource.name?.trim()
          if (resource.name !== undefined && name === '') {
            throw new Error('memory_update resource name must be non-empty')
          }
          return {
            kind: 'workspace-file',
            path,
            ...mediaType === undefined ? {} : { mediaType },
            ...name === undefined ? {} : { name },
            ...resource.role === undefined ? {} : { role: resource.role },
          }
        })
        if (messages.length === 0 && resources.length === 0) {
          throw new Error('memory_update requires at least one message or resource')
        }

        const outcomes = await ctx.patchouli.update({
          meta: callMeta(exec.agent.session, 'tool/memory-update'),
          data: snapshot({
            ...messages.length === 0 ? {} : { messages },
            ...resources.length === 0 ? {} : { resources },
          }),
        }, exec.signal)
        warnFailures(ctx, 'update', outcomes)
        return outcomeJson(outcomes)
      },
      presentCall: args => ({
        card: 'generic',
        title: 'Update memory',
        kind: 'other',
        rawInput: args,
      }),
    }))
  }

  if (store.agentCreated) {
    ctx.on('agent/created', ({ agent }) => {
      enqueueUpdate(agent.session, 'agent/created', observation(agent, {}))
    })
  }

  if (store.agentDisposed) {
    ctx.on('agent/disposed', ({ agent }) => {
      enqueueUpdate(agent.session, 'agent/disposed', observation(agent, {}))
    })
  }

  if (retrieve.sessionStart) {
    ctx.on('agent/session-start', ({ agent, source }) => {
      const task = (async (): Promise<void> => {
        const messages = await retrieveAt(
          agent.session,
          'agent/session-start',
          observation(agent, { source }),
          lifetime.signal,
        )
        for (const message of messages) agent.inject(message)
      })().catch((error: unknown) => {
        if (lifetime.signal.aborted) return
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger.warn(`patchouli session-start injection failed: ${message}`)
      })
      track(task)
    })
  }

  if (retrieve.preStep) {
    ctx.on('agent/pre-step', async (
      { agent, turn, step, signal },
      next,
    ): Promise<PreStepDecision> => {
      const decision = await next()
      if (decision.kind === 'reject' || signal.aborted) return decision
      const messages = await retrieveAt(
        agent.session,
        'agent/pre-step',
        observation(agent, {
          turn,
          step,
          messages: decision.messages,
        }),
        signal,
        { turn, step },
      )
      if (messages.length === 0) return decision
      return {
        kind: 'enter',
        messages: [...decision.messages, ...messages],
      }
    }, { prepend: true })
  }

  if (store.requestError) {
    ctx.on('agent/request-error', (payload, next) => {
      const { agent, turn, step, provider, failure, retryPolicy } = payload
      enqueueUpdate(
        agent.session,
        'agent/request-error',
        observation(agent, {
          turn,
          step,
          provider,
          failure,
          ...retryPolicy === undefined ? {} : { retryPolicy },
        }),
        { turn, step },
      )
      return next()
    })
  }

  if (retrieve.turnStopping) {
    ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
      const events = turnEvents(agent.session, turn)
      const messages = await retrieveAt(
        agent.session,
        'agent/turn-stopping',
        observation(agent, { turn }, events),
        signal,
        { turn },
      )
      for (const message of messages) agent.inject(message)
    })
  }

  if (store.agentError) {
    ctx.on('agent/error', ({ agent, turn, step, error }) => {
      enqueueUpdate(
        agent.session,
        'agent/error',
        observation(agent, { turn, step, error: errorData(error) }),
        { turn, step },
      )
    })
  }

  if (store.turnEnd) {
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'turn/end') return
      const agent = ctx.agents.get(session.header.id)
      const agentSnapshot = agent === undefined
        ? { id: String(session.header.id), options: {} }
        : agentData(agent)
      void enqueueSessionTask(session, async () => {
        try {
          const startSeq = turnStartSeq(session, event.data.turn, event.seq)
          await internalSessionFlush.run(
            session,
            () => ctx.sessions.flush(session),
          )
          lifetime.signal.throwIfAborted()
          const inspection = await ctx.sessionPersistence.readFrom(
            session.header.id,
            startSeq,
            lifetime.signal,
          )
          lifetime.signal.throwIfAborted()
          const persisted = persistedTurn(inspection, event.data.turn, event.seq)
          await dispatchUpdate(
            session,
            'session/turn-end',
            snapshot({
              agent: agentSnapshot,
              session: {
                header: inspection.meta,
              },
              event: persisted.event,
              events: persisted.events,
            }),
            {
              turn: event.data.turn,
              outcome: event.data.reason.kind,
            },
          )
        } catch (error: unknown) {
          if (lifetime.signal.aborted) return
          const message = error instanceof Error ? error.message : String(error)
          ctx.logger.warn(`patchouli durable turn capture failed: ${message}`)
        }
      })
    })
  }

  if (retrieve.toolPostExecute) {
    ctx.on('tools/post-execute', async (exec, result, next) => {
      const decision = await next()
      if (exec.agent === undefined || exec.signal.aborted) return decision
      const messages = await retrieveAt(
        exec.agent.session,
        'tools/post-execute',
        observation(exec.agent, {
          execution: toolExecutionData(exec),
          result,
          decision,
        }),
        exec.signal,
      )
      return mergeAdditionalContexts(decision, messages)
    })
  }

  if (store.toolResult) {
    ctx.on('tools/result', (exec, result) => {
      if (exec.agent === undefined) return
      enqueueUpdate(
        exec.agent.session,
        'tools/result',
        observation(exec.agent, {
          execution: toolExecutionData(exec),
          result: result as ToolExecutionResult,
        }),
      )
    })
  }

  if (Object.values(store).some(Boolean)) {
    ctx.on('session/flush', async (session) => {
      if (internalSessionFlush.getStore() === session) return
      await updateChains.get(session)
    })
  }
}
