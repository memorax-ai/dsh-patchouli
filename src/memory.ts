import { Service, type Context } from '@deepseek-ai/cordis'
import type { JsonObject, JsonValue } from 'dsh-patchouli-protocol'
import { isDeepStrictEqual } from 'node:util'

export type MemoryMetadata = JsonObject
export type MemoryData = JsonValue

export interface MemoryCallMeta {
  readonly source: Readonly<{
    readonly type: string
    readonly id: string
  }>
  readonly scope: string
  readonly requestId?: string
  readonly attributes?: JsonObject
}

export interface MemoryUpdateRequest {
  readonly meta: MemoryCallMeta
  /** Source-owned, lossless JSON facts. Interpretation belongs to the memory plugin. */
  readonly data: MemoryData
}

export interface MemoryRetrieveRequest {
  readonly meta: MemoryCallMeta
  /** Source-owned, lossless JSON facts used to decide what to retrieve. */
  readonly data: MemoryData
}

export interface MemorySubscribeRequest {
  readonly meta: MemoryCallMeta
}

/** A provider-local change. Cursors are opaque and may only be compared for equality. */
export interface MemoryChange {
  readonly cursor: string
  readonly memoryId?: string
  readonly metadata?: MemoryMetadata
}

export interface MemoryChangeEvent extends MemoryChange {
  readonly pluginId: string
}

export interface MemoryPluginSubscribeRequest extends MemorySubscribeRequest {
  readonly afterCursor?: string
}

export type MemoryPluginChangeHandler = (change: MemoryChange) => void | Promise<void>
export type MemoryChangeHandler = (change: MemoryChangeEvent) => void | Promise<void>

export interface MemoryPluginSubscription {
  /** Boundary captured by the provider before live changes are delivered. */
  readonly cursor: string
  /** Reject with a retryable MemorySubscriptionError for an unexpected disconnect. */
  readonly closed: Promise<void>
  unsubscribe(): Promise<void>
}

/** Cursor storage already bound to one consumer, subscription, and scope. */
export interface MemoryCursorStore {
  load(pluginId: string): Promise<string | undefined>
  save(pluginId: string, cursor: string): Promise<void>
  /** Clear a cursor only after the consumer has completed its explicit resync. */
  delete(pluginId: string): Promise<void>
}

export interface MemorySubscriptionErrorOptions {
  readonly retryable?: boolean
  readonly resetRequired?: boolean
  readonly cause?: unknown
}

/** A classified subscription failure. Unknown failures are always fatal. */
export class MemorySubscriptionError extends Error {
  readonly retryable: boolean
  readonly resetRequired: boolean

  constructor(message: string, options: MemorySubscriptionErrorOptions = {}) {
    super(message, { cause: options.cause })
    this.name = 'MemorySubscriptionError'
    this.retryable = options.retryable ?? false
    this.resetRequired = options.resetRequired ?? false
  }
}

export interface MemorySubscriptionFailure {
  readonly pluginId: string
  readonly error: MemorySubscriptionError
}

export interface MemorySubscriptionOptions {
  readonly cursorStore: MemoryCursorStore
  readonly onError?: (failure: MemorySubscriptionFailure) => void
  readonly signal?: AbortSignal
}

export interface MemorySubscription {
  readonly pluginIds: readonly string[]
  readonly closed: Promise<void>
  unsubscribe(): Promise<void>
}

export interface MemoryPluginContext {
  readonly signal?: AbortSignal
}

export type MemoryPluginRetrieveResult = Promise<MemoryData> | AsyncIterable<MemoryData>

export type MemoryOperation = 'update' | 'retrieve' | 'subscribe'

export interface MemoryRouteCall {
  readonly operation: MemoryOperation
  readonly meta: MemoryCallMeta
}

export type MemoryRouteFilter = (call: MemoryRouteCall) => boolean

/** User allow-list for one plugin. Omitted or empty selector lists match all. */
export interface MemoryRoutePolicy {
  enabled?: boolean
  operations?: MemoryOperation[]
  sourceTypes?: string[]
  sourceIds?: string[]
  scopes?: string[]
  attributes?: JsonObject
  /** Override the independent retrieval deadline for this provider. */
  retrieveTimeoutMs?: number
}

export type MemoryRoutingConfig = Readonly<Record<string, MemoryRoutePolicy>>

export interface MemoryServiceConfig {
  readonly routing?: MemoryRoutingConfig
  readonly retrieveTimeoutMs?: number
}

export interface MemoryPluginRegistrationOptions {
  /** A synchronous, side-effect-free predicate. Omit it to receive every call. */
  readonly filter?: MemoryRouteFilter
}

/** A concrete memory implementation registered with the common frontend. */
export interface MemoryPlugin {
  readonly id: string
  /** Provider-owned routing constraint, combined with registration and user filters. */
  readonly filter?: MemoryRouteFilter
  update(
    request: MemoryUpdateRequest,
    context: MemoryPluginContext,
  ): Promise<MemoryData>
  retrieve(
    request: MemoryRetrieveRequest,
    context: MemoryPluginContext,
  ): MemoryPluginRetrieveResult
  subscribe?(
    request: MemoryPluginSubscribeRequest,
    handler: MemoryPluginChangeHandler,
    context: MemoryPluginContext,
  ): Promise<MemoryPluginSubscription>
}

export type MemoryPluginOutcome<T> =
  | {
      readonly pluginId: string
      readonly ok: true
      readonly value: T
    }
  | {
      readonly pluginId: string
      readonly ok: false
      readonly error: string
    }

export type MemoryRetrieveProgress = MemoryPluginOutcome<MemoryData> & {
  /** Provider results are partial until the final aggregate chunk is emitted. */
  readonly complete: false
}

export interface MemoryRetrieveComplete {
  readonly complete: true
  readonly outcomes: readonly MemoryPluginOutcome<MemoryData>[]
}

export type MemoryRetrieveChunk = MemoryRetrieveProgress | MemoryRetrieveComplete
export type MemoryRetrieveHandler = (chunk: MemoryRetrieveChunk) => void | Promise<void>

interface RegisteredMemoryPlugin {
  readonly plugin: MemoryPlugin
  readonly filters: readonly MemoryRouteFilter[]
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    patchouli: PatchouliService
  }
}

/** Cordis service that registers, routes to, and dispatches memory plugins. */
export class PatchouliService extends Service {
  private readonly plugins = new Map<string, RegisteredMemoryPlugin>()
  private readonly routing: MemoryRoutingConfig
  private readonly retrieveTimeoutMs: number

  constructor(
    ctx: Context,
    config: MemoryServiceConfig = {},
  ) {
    super(ctx, 'patchouli')
    this.routing = config.routing ?? {}
    this.retrieveTimeoutMs = positiveTimeout(config.retrieveTimeoutMs, 30_000)
  }

  register(
    plugin: MemoryPlugin,
    options: MemoryPluginRegistrationOptions = {},
  ): () => void {
    if (plugin.id.trim() === '') {
      throw new Error('memory plugin id must be a non-empty string')
    }
    if (this.plugins.has(plugin.id)) {
      throw new Error(`memory plugin "${plugin.id}" is already registered`)
    }

    const registration = {
      plugin,
      filters: [plugin.filter, options.filter].filter(
        (filter): filter is MemoryRouteFilter => filter !== undefined,
      ),
    }
    const dispose = this.ctx.effect(() => {
      this.plugins.set(plugin.id, registration)
      return () => {
        if (this.plugins.get(plugin.id) === registration) {
          this.plugins.delete(plugin.id)
        }
      }
    }, `patchouli.register(${JSON.stringify(plugin.id)})`)

    return () => void dispose()
  }

  update(
    request: MemoryUpdateRequest,
    signal?: AbortSignal,
  ): Promise<readonly MemoryPluginOutcome<MemoryData>[]> {
    return this.dispatch(
      { operation: 'update', meta: request.meta },
      plugin => plugin.update(request, { signal }),
      signal,
    )
  }

  retrieve(
    request: MemoryRetrieveRequest,
    signal?: AbortSignal,
    onChunk?: MemoryRetrieveHandler,
  ): Promise<readonly MemoryPluginOutcome<MemoryData>[]> {
    return this.dispatchRetrieve(request, signal, onChunk)
  }

  /** Stream provider progress while preserving retrieve() as the final aggregate API. */
  async *retrieveStream(
    request: MemoryRetrieveRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<MemoryRetrieveChunk, void, void> {
    const lifetime = new AbortController()
    const onAbort = () => lifetime.abort(signal?.reason ?? new Error('memory retrieval aborted'))
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
    const queue: Array<{
      readonly chunk: MemoryRetrieveChunk
      readonly consumed: () => void
    }> = []
    let wake = deferred<void>()
    let finished = false
    let failure: unknown
    const retrieval = this.retrieve(request, lifetime.signal, chunk => new Promise<void>((resolve) => {
      queue.push({ chunk, consumed: resolve })
      wake.resolve()
    })).catch((error: unknown) => {
      failure = error
    }).finally(() => {
      finished = true
      wake.resolve()
    })

    try {
      while (!finished || queue.length > 0) {
        if (queue.length === 0) {
          await wake.promise
          wake = deferred<void>()
          continue
        }
        const item = queue.shift()!
        try {
          yield item.chunk
        } finally {
          item.consumed()
        }
      }
      if (failure !== undefined) throw failure
      await retrieval
    } finally {
      signal?.removeEventListener('abort', onAbort)
      if (!finished) lifetime.abort(new Error('memory retrieval stream closed'))
      for (const item of queue.splice(0)) item.consumed()
    }
  }

  async subscribe(
    request: MemorySubscribeRequest,
    handler: MemoryChangeHandler,
    options: MemorySubscriptionOptions,
  ): Promise<MemorySubscription> {
    options.signal?.throwIfAborted()
    const call: MemoryRouteCall = { operation: 'subscribe', meta: request.meta }
    const plugins: Array<MemoryPlugin & Required<Pick<MemoryPlugin, 'subscribe'>>> = []
    for (const registration of this.plugins.values()) {
      const { plugin } = registration
      if (plugin.subscribe === undefined) continue
      const subscribingPlugin = plugin as MemoryPlugin & Required<Pick<MemoryPlugin, 'subscribe'>>
      try {
        if (this.shouldRoute(registration, call)) plugins.push(subscribingPlugin)
      } catch (error: unknown) {
        notifySubscriptionError(options.onError, {
          pluginId: plugin.id,
          error: classifySubscriptionError(error),
        })
      }
    }
    const pluginIds = Object.freeze(plugins.map(plugin => plugin.id))
    const lifetime = new AbortController()
    const active = new Map<string, ManagedPluginSubscription>()
    const workers: Promise<void>[] = []
    const aborted = new Promise<never>((_resolve, reject) => {
      lifetime.signal.addEventListener('abort', () => {
        reject(lifetime.signal.reason ?? new Error('memory subscription aborted'))
      }, { once: true })
    })
    void aborted.catch(() => {})

    let resolveClosed!: () => void
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve
    })
    let shutdownTask: Promise<void> | undefined
    let onAbort: (() => void) | undefined
    const shutdown = (): Promise<void> => shutdownTask ??= (async () => {
      lifetime.abort(options.signal?.reason ?? new Error('memory subscription disposed'))
      if (onAbort) options.signal?.removeEventListener('abort', onAbort)
      await Promise.allSettled([...active.values()].map(subscription => subscription.stop()))
      await Promise.allSettled(workers)
      resolveClosed()
    })()

    const dispose = this.ctx.effect(
      () => shutdown,
      `patchouli.subscribe(${JSON.stringify(pluginIds)})`,
    )
    onAbort = () => void dispose()
    options.signal?.addEventListener('abort', onAbort, { once: true })

    if (options.signal?.aborted) {
      void dispose()
    } else {
      for (const plugin of plugins) {
        workers.push(this.runSubscriptionWorker(
          plugin,
          request,
          handler,
          options,
          lifetime.signal,
          aborted,
          active,
        ))
      }
    }

    return {
      pluginIds,
      closed,
      async unsubscribe() {
        await dispose()
      },
    }
  }

  private async dispatch<T>(
    call: MemoryRouteCall,
    invoke: (plugin: MemoryPlugin) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<readonly MemoryPluginOutcome<T>[]> {
    signal?.throwIfAborted()
    const registrations = [...this.plugins.values()]
    const outcomes = await Promise.all(registrations.map(async (
      registration,
    ): Promise<MemoryPluginOutcome<T> | undefined> => {
      const { plugin } = registration
      try {
        if (!this.shouldRoute(registration, call)) return undefined
        const timeoutMs = call.operation === 'retrieve'
          ? positiveTimeout(
              this.routing[plugin.id]?.retrieveTimeoutMs,
              this.retrieveTimeoutMs,
            )
          : undefined
        return {
          pluginId: plugin.id,
          ok: true,
          value: await waitForProvider(
            invoke(plugin),
            signal,
            timeoutMs,
            `${plugin.id} ${call.operation}`,
          ),
        }
      } catch (error) {
        return {
          pluginId: plugin.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    }))
    signal?.throwIfAborted()
    return outcomes.filter((outcome): outcome is MemoryPluginOutcome<T> => outcome !== undefined)
  }

  private async dispatchRetrieve(
    request: MemoryRetrieveRequest,
    signal?: AbortSignal,
    onChunk?: MemoryRetrieveHandler,
  ): Promise<readonly MemoryPluginOutcome<MemoryData>[]> {
    signal?.throwIfAborted()
    const call: MemoryRouteCall = { operation: 'retrieve', meta: request.meta }
    let emission = Promise.resolve()
    const emit = (chunk: MemoryRetrieveChunk): Promise<void> => {
      if (onChunk === undefined) return Promise.resolve()
      const next = emission.then(() => onChunk(chunk))
      emission = next.then(() => undefined)
      return next
    }
    const outcomes = await Promise.all([...this.plugins.values()].map(async (
      registration,
    ): Promise<MemoryPluginOutcome<MemoryData> | undefined> => {
      const { plugin } = registration
      try {
        if (!this.shouldRoute(registration, call)) return undefined
        const timeoutMs = positiveTimeout(
          this.routing[plugin.id]?.retrieveTimeoutMs,
          this.retrieveTimeoutMs,
        )
        const startedAt = Date.now()
        const result = plugin.retrieve(request, { signal })
        let value: MemoryData
        if (isAsyncIterable<MemoryData>(result)) {
          value = null
          const iterator = result[Symbol.asyncIterator]()
          for (;;) {
            const remaining = Math.max(1, timeoutMs - (Date.now() - startedAt))
            const step = await waitForProvider(
              iterator.next(),
              signal,
              remaining,
              `${plugin.id} retrieve`,
            )
            if (step.done) break
            value = step.value
            await emit({ pluginId: plugin.id, ok: true, value, complete: false })
          }
        } else {
          value = await waitForProvider(
            result,
            signal,
            timeoutMs,
            `${plugin.id} retrieve`,
          )
          await emit({ pluginId: plugin.id, ok: true, value, complete: false })
        }
        return { pluginId: plugin.id, ok: true, value }
      } catch (error: unknown) {
        const outcome = {
          pluginId: plugin.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        } as const
        await emit({ ...outcome, complete: false })
        return outcome
      }
    }))
    signal?.throwIfAborted()
    const completed = outcomes.filter(
      (outcome): outcome is MemoryPluginOutcome<MemoryData> => outcome !== undefined,
    )
    await emit({ complete: true, outcomes: completed })
    return completed
  }

  private shouldRoute(
    registration: RegisteredMemoryPlugin,
    call: MemoryRouteCall,
  ): boolean {
    const policy = this.routing[registration.plugin.id]
    if (policy !== undefined && !matchesRoutePolicy(policy, call)) return false
    return registration.filters.every(filter => filter(call))
  }

  private async runSubscriptionWorker(
    plugin: MemoryPlugin & Required<Pick<MemoryPlugin, 'subscribe'>>,
    request: MemorySubscribeRequest,
    handler: MemoryChangeHandler,
    options: MemorySubscriptionOptions,
    signal: AbortSignal,
    aborted: Promise<never>,
    active: Map<string, ManagedPluginSubscription>,
  ): Promise<void> {
    const cursor = { value: undefined as string | undefined }
    let loaded = false
    let retry = 0

    while (!signal.aborted) {
      try {
        if (!loaded) {
          cursor.value = await options.cursorStore.load(plugin.id)
          loaded = true
        }
        await this.runSubscriptionAttempt(
          plugin,
          request,
          handler,
          options.cursorStore,
          cursor,
          () => {
            retry = 0
          },
          signal,
          aborted,
          active,
        )
        return
      } catch (error: unknown) {
        if (signal.aborted) return
        const classified = classifySubscriptionError(error)
        notifySubscriptionError(options.onError, {
          pluginId: plugin.id,
          error: classified,
        })
        // Reset requires an explicit consumer resync; never discard its cursor here.
        if (classified.resetRequired || !classified.retryable) return
        if (!await retryDelay(retry++, signal)) return
      }
    }
  }

  private async runSubscriptionAttempt(
    plugin: MemoryPlugin & Required<Pick<MemoryPlugin, 'subscribe'>>,
    request: MemorySubscribeRequest,
    handler: MemoryChangeHandler,
    cursorStore: MemoryCursorStore,
    cursor: { value: string | undefined },
    onProgress: () => void,
    signal: AbortSignal,
    aborted: Promise<never>,
    active: Map<string, ManagedPluginSubscription>,
  ): Promise<void> {
    let releaseBoundary!: () => void
    const boundary = new Promise<void>((resolve) => {
      releaseBoundary = resolve
    })
    let boundaryError: unknown | typeof noSubscriptionError = noSubscriptionError
    let pipelineError: unknown | typeof noSubscriptionError = noSubscriptionError
    let accepting = true
    let failAttempt!: (error: unknown) => void
    const failed = new Promise<never>((_resolve, reject) => {
      failAttempt = reject
    })
    void failed.catch(() => {})
    let tail = Promise.resolve()

    const onChange: MemoryPluginChangeHandler = (change) => {
      if (!accepting || signal.aborted) return Promise.resolve()
      const processing = tail.then(async () => {
        await boundary
        if (boundaryError !== noSubscriptionError) throw boundaryError
        if (pipelineError !== noSubscriptionError) throw pipelineError
        if (change.cursor === cursor.value) return
        try {
          signal.throwIfAborted()
          await handler({ ...change, pluginId: plugin.id })
          signal.throwIfAborted()
          await cursorStore.save(plugin.id, change.cursor)
          cursor.value = change.cursor
          onProgress()
        } catch (error: unknown) {
          pipelineError = error
          throw error
        }
      })
      tail = processing.then(
        () => undefined,
        (error: unknown) => failAttempt(error),
      )
      return processing
    }

    let managed: ManagedPluginSubscription | undefined
    let attemptError: unknown | typeof noSubscriptionError = noSubscriptionError
    try {
      const starting = plugin.subscribe({
        meta: request.meta,
        afterCursor: cursor.value,
      }, onChange, { signal })
      let subscription: MemoryPluginSubscription
      try {
        subscription = await Promise.race([starting, aborted])
      } catch (error: unknown) {
        if (signal.aborted) {
          void starting.then(
            late => managePluginSubscription(late).stop().catch(() => {}),
            () => {},
          )
        }
        throw error
      }

      managed = managePluginSubscription(subscription)
      active.set(plugin.id, managed)
      signal.throwIfAborted()
      await cursorStore.save(plugin.id, subscription.cursor)
      cursor.value = subscription.cursor
      releaseBoundary()
      await Promise.race([managed.closed, failed, aborted])
    } catch (error: unknown) {
      attemptError = error
      boundaryError = error
    } finally {
      accepting = false
      releaseBoundary()
      if (managed) {
        try {
          await managed.stop()
        } catch (error: unknown) {
          if (attemptError === noSubscriptionError) attemptError = error
        }
        if (active.get(plugin.id) === managed) active.delete(plugin.id)
      }
      await tail
      if (attemptError === noSubscriptionError) attemptError = pipelineError
    }

    if (attemptError !== noSubscriptionError) throw attemptError
  }
}

async function waitForProvider<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
  label: string,
): Promise<T> {
  signal?.throwIfAborted()
  if (signal === undefined && timeoutMs === undefined) return operation

  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const boundary = new Promise<never>((_resolve, reject) => {
    if (signal !== undefined) {
      onAbort = () => reject(signal.reason ?? new Error('memory operation aborted'))
      signal.addEventListener('abort', onAbort, { once: true })
    }
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        reject(new Error(`memory provider ${JSON.stringify(label)} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      timer.unref?.()
    }
  })

  try {
    return await Promise.race([operation, boundary])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort)
  }
}

function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T> {
  return typeof value === 'object'
    && value !== null
    && Symbol.asyncIterator in value
    && typeof value[Symbol.asyncIterator] === 'function'
}

function deferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T | PromiseLike<T>) => void
} {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(complete => { resolve = complete })
  return { promise, resolve }
}

function positiveTimeout(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value !== undefined && value > 0 ? value : fallback
}

function matchesRoutePolicy(policy: MemoryRoutePolicy, call: MemoryRouteCall): boolean {
  if (policy.enabled === false) return false
  if (policy.operations?.length && !policy.operations.includes(call.operation)) return false
  if (policy.sourceTypes?.length && !policy.sourceTypes.includes(call.meta.source.type)) return false
  if (policy.sourceIds?.length && !policy.sourceIds.includes(call.meta.source.id)) return false
  if (policy.scopes?.length && !policy.scopes.includes(call.meta.scope)) return false
  if (policy.attributes !== undefined) {
    for (const [key, value] of Object.entries(policy.attributes)) {
      if (!isDeepStrictEqual(call.meta.attributes?.[key], value)) return false
    }
  }
  return true
}

const noSubscriptionError = Symbol('no subscription error')

interface ManagedPluginSubscription {
  readonly closed: Promise<void>
  stop(): Promise<void>
}

function managePluginSubscription(subscription: MemoryPluginSubscription): ManagedPluginSubscription {
  const closed = subscription.closed
  // Observe disconnects immediately, before boundary persistence or teardown can await.
  void closed.catch(() => {})
  let stopping: Promise<void> | undefined
  return {
    closed,
    stop() {
      return stopping ??= subscription.unsubscribe()
    },
  }
}

function classifySubscriptionError(error: unknown): MemorySubscriptionError {
  if (error instanceof MemorySubscriptionError) return error
  return new MemorySubscriptionError(
    error instanceof Error ? error.message : String(error),
    { cause: error },
  )
}

function notifySubscriptionError(
  onError: MemorySubscriptionOptions['onError'],
  failure: MemorySubscriptionFailure,
): void {
  try {
    onError?.(failure)
  } catch {
    // Consumer diagnostics must not stop another plugin's worker.
  }
}

function retryDelay(retry: number, signal: AbortSignal): Promise<boolean> {
  const base = Math.min(30_000, 250 * 2 ** Math.min(retry, 16))
  const delay = base + Math.floor(Math.random() * Math.min(base, 1_000))
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false)
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve(true)
    }, delay)
    const abort = () => {
      clearTimeout(timer)
      resolve(false)
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}
