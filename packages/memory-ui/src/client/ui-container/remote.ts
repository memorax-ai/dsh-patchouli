import type {
  DocumentProvider,
  DocumentRef,
  DocumentResolveContext,
  DocumentSnapshot,
  UiContainer,
} from './documents.js'
import {
  createWebSocketUiRemoteChannel,
  type UiRemoteChannel,
  type WebSocketLike,
} from './remote-channel.js'
import {
  UI_REMOTE_METHODS,
  UI_REMOTE_PROTOCOL_VERSION,
  type UiRemoteCapability,
  type UiRemoteDocumentChangedParams,
  type UiRemoteDocumentSnapshot,
  type UiRemoteHandshakeParams,
  type UiRemoteHandshakeResult,
  type UiRemoteId,
  type UiRemoteMessage,
  type UiRemoteResolveParams,
  type UiRemoteResolveResult,
  type UiRemoteSubscribeParams,
  type UiRemoteSubscribeResult,
  type UiRemoteSurfaceCloseParams,
  type UiRemoteSurfaceOpenParams,
  type UiRemoteSurfaceRevealParams,
  type UiRemoteUnsubscribeParams,
  type UiRemoteUnsubscribeResult,
  type UiRemoteValue,
} from './remote-protocol.js'

type RecordValue = Record<string, unknown>

function record(value: unknown): RecordValue | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as RecordValue
    : undefined
}

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} must be a non-empty string`)
  return value
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${name} must be an array of strings`)
  }
  return value
}

function toWireValue(value: unknown, seen = new Set<unknown>()): UiRemoteValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'object') throw new Error('UI container remote values must be JSON-compatible')
  if (seen.has(value)) throw new Error('UI container remote values must not contain cycles')
  seen.add(value)
  if (Array.isArray(value)) {
    const result = value.map((entry) => toWireValue(entry, seen))
    seen.delete(value)
    return result
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('UI container remote values must be JSON-compatible')
  }
  const result: Record<string, UiRemoteValue> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) result[key] = toWireValue(entry, seen)
  }
  seen.delete(value)
  return result
}

function parseDocumentRef(value: unknown): DocumentRef {
  const data = record(value)
  if (!data) throw new Error('document must be an object')
  return {
    uri: nonEmptyString(data.uri, 'document.uri'),
    title: typeof data.title === 'string' ? data.title : undefined,
    mediaType: typeof data.mediaType === 'string' ? data.mediaType : undefined,
    kind: typeof data.kind === 'string' ? data.kind : undefined,
  }
}

function parseContext(value: unknown): DocumentResolveContext {
  const data = record(value)
  if (!data) throw new Error('context must be an object')
  return {
    surfaceId: nonEmptyString(data.surfaceId, 'context.surfaceId'),
    sessionId: nonEmptyString(data.sessionId, 'context.sessionId'),
  }
}

function wireSnapshot(snapshot: DocumentSnapshot): UiRemoteDocumentSnapshot {
  const metadata = snapshot.metadata === undefined
    ? undefined
    : toWireValue(snapshot.metadata)
  if (metadata !== undefined && (!record(metadata))) {
    throw new Error('document metadata must be a JSON object')
  }
  return {
    uri: snapshot.uri,
    title: snapshot.title,
    mediaType: snapshot.mediaType,
    kind: snapshot.kind,
    revision: snapshot.revision,
    content: toWireValue(snapshot.content),
    metadata: metadata as Readonly<Record<string, UiRemoteValue>> | undefined,
  }
}

function parseSnapshot(value: unknown): UiRemoteDocumentSnapshot {
  const data = record(value)
  if (!data || !('content' in data)) throw new Error('snapshot must contain content')
  const reference = parseDocumentRef(data)
  const metadata = data.metadata === undefined ? undefined : record(data.metadata)
  if (data.metadata !== undefined && !metadata) throw new Error('snapshot.metadata must be an object')
  return {
    ...reference,
    revision: typeof data.revision === 'string' ? data.revision : undefined,
    content: toWireValue(data.content),
    metadata: metadata === undefined
      ? undefined
      : toWireValue(metadata) as Readonly<Record<string, UiRemoteValue>>,
  }
}

function parseResolveParams(value: unknown): UiRemoteResolveParams {
  const data = record(value)
  if (!data) throw new Error('resolve params must be an object')
  return {
    uri: nonEmptyString(data.uri, 'uri'),
    context: parseContext(data.context),
    known_revision: typeof data.known_revision === 'string' ? data.known_revision : undefined,
  }
}

function parseSubscribeParams(value: unknown): UiRemoteSubscribeParams {
  const data = record(value)
  if (!data) throw new Error('subscribe params must be an object')
  return {
    uri: nonEmptyString(data.uri, 'uri'),
    context: parseContext(data.context),
  }
}

function parseHandshake(value: unknown): UiRemoteHandshakeResult {
  const data = record(value)
  const server = record(data?.server)
  if (!data || !server || data.protocol_version !== UI_REMOTE_PROTOCOL_VERSION) {
    throw new Error('UI container remote negotiated an unsupported protocol')
  }
  const capabilities = stringArray(data.capabilities, 'capabilities')
  const validCapabilities = capabilities.filter((entry): entry is UiRemoteCapability =>
    entry === 'documents' || entry === 'subscriptions' || entry === 'surface_commands',
  )
  return {
    protocol_version: UI_REMOTE_PROTOCOL_VERSION,
    server: {
      name: nonEmptyString(server.name, 'server.name'),
      version: nonEmptyString(server.version, 'server.version'),
      instance_id: nonEmptyString(server.instance_id, 'server.instance_id'),
    },
    capabilities: validCapabilities,
    document_schemes: stringArray(data.document_schemes, 'document_schemes'),
  }
}

export class UiContainerRemoteError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: UiRemoteValue,
  ) {
    super(message)
    this.name = 'UiContainerRemoteError'
  }
}

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
  cleanup: () => void
}

export class UiContainerRemoteClient {
  readonly #channel: UiRemoteChannel
  readonly #pending = new Map<UiRemoteId, PendingRequest>()
  readonly #subscriptions = new Map<string, () => void>()
  readonly #offMessage: () => void
  readonly #offClose: () => void
  #handshake?: UiRemoteHandshakeResult
  #nextRequestId = 0
  #closed = false

  private constructor(channel: UiRemoteChannel) {
    this.#channel = channel
    this.#offMessage = channel.onMessage((message) => this.#receive(message))
    this.#offClose = channel.onClose(() => this.#disconnect(new Error('UI container remote disconnected')))
  }

  get handshake(): UiRemoteHandshakeResult {
    if (!this.#handshake) throw new Error('UI container remote handshake is not complete')
    return this.#handshake
  }

  static async connect(
    channel: UiRemoteChannel,
    params: UiRemoteHandshakeParams,
  ): Promise<UiContainerRemoteClient> {
    const client = new UiContainerRemoteClient(channel)
    try {
      await channel.ready
      const result = await client.#request(UI_REMOTE_METHODS.handshake, params)
      client.#handshake = parseHandshake(result)
      return client
    } catch (error) {
      client.dispose()
      throw error
    }
  }

  createDocumentProvider(scheme: string): DocumentProvider {
    if (!this.handshake.capabilities.includes('documents')) {
      throw new Error('Remote does not provide document capability')
    }
    if (!this.handshake.document_schemes.includes(scheme)) {
      throw new Error(`Remote does not provide document scheme: ${scheme}`)
    }
    const cache = new Map<string, UiRemoteDocumentSnapshot>()
    let subscriptionError: unknown
    return {
      scheme,
      describe: (uri) => cache.get(uri),
      resolve: async (uri, context, signal) => {
        if (subscriptionError) throw subscriptionError
        const known = cache.get(uri)
        const result = record(await this.#request(UI_REMOTE_METHODS.documentResolve, {
          uri,
          context,
          known_revision: known?.revision,
        }, signal))
        if (!result) throw new Error('Invalid remote document result')
        if (result.status === 'not_modified') {
          if (!known || result.revision !== known.revision) {
            throw new Error('Remote returned not_modified without a matching cached revision')
          }
          return known
        }
        if (result.status !== 'resolved') throw new Error('Invalid remote document result status')
        const snapshot = parseSnapshot(result.snapshot)
        if (snapshot.uri !== uri) throw new Error(`Remote returned a different document URI: ${snapshot.uri}`)
        cache.set(uri, snapshot)
        return snapshot
      },
      subscribe: !this.handshake.capabilities.includes('subscriptions') ? undefined : (uri, context, listener) => {
        let active = true
        let subscriptionId: string | undefined
        void this.#subscribe(uri, context, () => {
          if (active) listener()
        }).then((id) => {
          subscriptionError = undefined
          subscriptionId = id
          if (!active) void this.#unsubscribe(id)
        }).catch((error: unknown) => {
          if (!active) return
          subscriptionError = error
          listener()
        })
        return () => {
          active = false
          if (subscriptionId) void this.#unsubscribe(subscriptionId)
        }
      },
    }
  }

  async open(surfaceId: string, sessionId: string, document: DocumentRef): Promise<void> {
    this.#requireCapability('surface_commands')
    await this.#request(UI_REMOTE_METHODS.surfaceOpen, {
      surface_id: surfaceId,
      session_id: sessionId,
      document,
    } satisfies UiRemoteSurfaceOpenParams)
  }

  async close(surfaceId: string, sessionId: string, uri: string): Promise<void> {
    this.#requireCapability('surface_commands')
    await this.#request(UI_REMOTE_METHODS.surfaceClose, {
      surface_id: surfaceId,
      session_id: sessionId,
      uri,
    } satisfies UiRemoteSurfaceCloseParams)
  }

  async reveal(surfaceId: string, sessionId: string, document: DocumentRef): Promise<void> {
    this.#requireCapability('surface_commands')
    await this.#request(UI_REMOTE_METHODS.surfaceReveal, {
      surface_id: surfaceId,
      session_id: sessionId,
      document,
    } satisfies UiRemoteSurfaceRevealParams)
  }

  dispose(): void {
    if (this.#closed) return
    this.#disconnect(new Error('UI container remote disposed'))
    this.#channel.close()
  }

  async #subscribe(uri: string, context: DocumentResolveContext, listener: () => void): Promise<string> {
    this.#requireCapability('subscriptions')
    const result = record(await this.#request(UI_REMOTE_METHODS.documentSubscribe, { uri, context }))
    const subscriptionId = nonEmptyString(result?.subscription_id, 'subscription_id')
    this.#subscriptions.set(subscriptionId, listener)
    return subscriptionId
  }

  async #unsubscribe(subscriptionId: string): Promise<void> {
    this.#subscriptions.delete(subscriptionId)
    if (this.#closed) return
    await this.#request(UI_REMOTE_METHODS.documentUnsubscribe, {
      subscription_id: subscriptionId,
    } satisfies UiRemoteUnsubscribeParams)
  }

  #requireCapability(capability: UiRemoteCapability): void {
    if (!this.handshake.capabilities.includes(capability)) {
      throw new Error(`Remote capability was not negotiated: ${capability}`)
    }
  }

  #request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error('UI container remote is closed'))
    if (signal?.aborted) return Promise.reject(new Error('UI container remote request was cancelled'))
    const id = `ui-${++this.#nextRequestId}`
    return new Promise((resolve, reject) => {
      const cancelled = () => {
        this.#pending.delete(id)
        reject(new Error('UI container remote request was cancelled'))
      }
      const cleanup = () => signal?.removeEventListener('abort', cancelled)
      this.#pending.set(id, { resolve, reject, cleanup })
      signal?.addEventListener('abort', cancelled, { once: true })
      this.#channel.send({
        jsonrpc: '2.0',
        id,
        method,
        params: toWireValue(params),
      })
    })
  }

  #receive(message: unknown): void {
    const data = record(message)
    if (!data || data.jsonrpc !== '2.0') return
    if ('id' in data && (typeof data.id === 'string' || typeof data.id === 'number')) {
      const pending = this.#pending.get(data.id)
      if (!pending) return
      this.#pending.delete(data.id)
      pending.cleanup()
      const error = record(data.error)
      if (error) {
        pending.reject(new UiContainerRemoteError(
          typeof error.code === 'number' ? error.code : -32000,
          typeof error.message === 'string' ? error.message : 'UI container remote error',
          error.data === undefined ? undefined : toWireValue(error.data),
        ))
      } else {
        pending.resolve(data.result)
      }
      return
    }
    if (data.method !== UI_REMOTE_METHODS.documentChanged) return
    const params = record(data.params)
    if (!params) return
    const subscriptionId = typeof params.subscription_id === 'string' ? params.subscription_id : undefined
    if (subscriptionId) this.#subscriptions.get(subscriptionId)?.()
  }

  #disconnect(error: Error): void {
    if (this.#closed) return
    this.#closed = true
    this.#offMessage()
    this.#offClose()
    for (const pending of this.#pending.values()) {
      pending.cleanup()
      pending.reject(error)
    }
    this.#pending.clear()
    this.#subscriptions.clear()
  }
}

export type UiContainerRemoteServerOptions = {
  server: { name: string; version: string; instance_id: string }
  capabilities?: readonly UiRemoteCapability[]
}

export function exposeUiContainerRemote(
  container: UiContainer,
  channel: UiRemoteChannel,
  options: UiContainerRemoteServerOptions,
): () => void {
  const supported = new Set(options.capabilities ?? ['documents', 'subscriptions'])
  const negotiated = new Set<UiRemoteCapability>()
  const subscriptions = new Map<string, () => void>()
  let handshaken = false
  let nextSubscriptionId = 0
  let disposed = false

  const sendResult = (id: UiRemoteId, result: unknown) => channel.send({
    jsonrpc: '2.0',
    id,
    result: toWireValue(result),
  })
  const sendError = (id: UiRemoteId, code: number, message: string) => channel.send({
    jsonrpc: '2.0',
    id,
    error: { code, message },
  })
  const requireCapability = (capability: UiRemoteCapability) => {
    if (!negotiated.has(capability)) throw new UiContainerRemoteError(-32002, `Capability not negotiated: ${capability}`)
  }

  const handle = async (message: unknown) => {
    const request = record(message)
    if (!request || request.jsonrpc !== '2.0' || !('id' in request)
      || (typeof request.id !== 'string' && typeof request.id !== 'number')
      || typeof request.method !== 'string') return
    const id = request.id
    try {
      if (request.method === UI_REMOTE_METHODS.handshake) {
        if (handshaken) throw new UiContainerRemoteError(-32600, 'Handshake already completed')
        const params = record(request.params)
        const versions = params?.protocol_versions
        if (!Array.isArray(versions) || !versions.includes(UI_REMOTE_PROTOCOL_VERSION)) {
          throw new UiContainerRemoteError(-32003, 'No supported UI container protocol version')
        }
        const requested = stringArray(params?.capabilities, 'capabilities')
        for (const capability of requested) {
          if (supported.has(capability as UiRemoteCapability)) negotiated.add(capability as UiRemoteCapability)
        }
        handshaken = true
        sendResult(id, {
          protocol_version: UI_REMOTE_PROTOCOL_VERSION,
          server: options.server,
          capabilities: [...negotiated],
          document_schemes: container.documents.listProviderSchemes(),
        } satisfies UiRemoteHandshakeResult)
        return
      }
      if (!handshaken) throw new UiContainerRemoteError(-32001, 'Handshake required')

      if (request.method === UI_REMOTE_METHODS.documentResolve) {
        requireCapability('documents')
        const params = parseResolveParams(request.params)
        const snapshot = await container.documents.resolve(
          { uri: params.uri },
          params.context,
          new AbortController().signal,
        )
        const result: UiRemoteResolveResult = params.known_revision !== undefined
          && snapshot.revision !== undefined
          && params.known_revision === snapshot.revision
          ? { status: 'not_modified', revision: snapshot.revision }
          : { status: 'resolved', snapshot: wireSnapshot(snapshot) }
        sendResult(id, result)
        return
      }

      if (request.method === UI_REMOTE_METHODS.documentSubscribe) {
        requireCapability('subscriptions')
        const params = parseSubscribeParams(request.params)
        const subscriptionId = `remote-sub-${++nextSubscriptionId}`
        let announced = false
        let queued = false
        const notify = () => channel.send({
          jsonrpc: '2.0',
          method: UI_REMOTE_METHODS.documentChanged,
          params: toWireValue({
            subscription_id: subscriptionId,
            uri: params.uri,
          } satisfies UiRemoteDocumentChangedParams),
        })
        const unsubscribe = container.documents.subscribeDocument(
          { uri: params.uri },
          params.context,
          () => announced ? notify() : queued = true,
        )
        subscriptions.set(subscriptionId, unsubscribe)
        sendResult(id, { subscription_id: subscriptionId } satisfies UiRemoteSubscribeResult)
        announced = true
        if (queued) queueMicrotask(notify)
        return
      }

      if (request.method === UI_REMOTE_METHODS.documentUnsubscribe) {
        requireCapability('subscriptions')
        const params = record(request.params)
        const subscriptionId = nonEmptyString(params?.subscription_id, 'subscription_id')
        const unsubscribe = subscriptions.get(subscriptionId)
        if (unsubscribe) {
          subscriptions.delete(subscriptionId)
          unsubscribe()
        }
        sendResult(id, { removed: unsubscribe !== undefined } satisfies UiRemoteUnsubscribeResult)
        return
      }

      if (request.method === UI_REMOTE_METHODS.surfaceOpen) {
        requireCapability('surface_commands')
        const params = record(request.params)
        if (!params) throw new Error('surface open params must be an object')
        container.documents.open(
          nonEmptyString(params.surface_id, 'surface_id'),
          nonEmptyString(params.session_id, 'session_id'),
          parseDocumentRef(params.document),
        )
        sendResult(id, {})
        return
      }

      if (request.method === UI_REMOTE_METHODS.surfaceClose) {
        requireCapability('surface_commands')
        const params = record(request.params)
        if (!params) throw new Error('surface close params must be an object')
        container.documents.close(
          nonEmptyString(params.surface_id, 'surface_id'),
          nonEmptyString(params.session_id, 'session_id'),
          nonEmptyString(params.uri, 'uri'),
        )
        sendResult(id, {})
        return
      }

      if (request.method === UI_REMOTE_METHODS.surfaceReveal) {
        requireCapability('surface_commands')
        const params = record(request.params)
        if (!params) throw new Error('surface reveal params must be an object')
        container.documents.reveal(
          nonEmptyString(params.surface_id, 'surface_id'),
          nonEmptyString(params.session_id, 'session_id'),
          parseDocumentRef(params.document),
        )
        sendResult(id, {})
        return
      }

      sendError(id, -32601, `Method not found: ${request.method}`)
    } catch (error) {
      if (error instanceof UiContainerRemoteError) sendError(id, error.code, error.message)
      else sendError(id, -32602, error instanceof Error ? error.message : String(error))
    }
  }

  const offMessage = channel.onMessage((message) => void handle(message))
  let offClose = () => {}
  const dispose = () => {
    if (disposed) return
    disposed = true
    offMessage()
    offClose()
    for (const unsubscribe of subscriptions.values()) unsubscribe()
    subscriptions.clear()
  }
  offClose = channel.onClose(dispose)
  return dispose
}

export async function connectUiContainerWebSocket(
  url: string,
  params: UiRemoteHandshakeParams,
  protocols?: string | readonly string[],
): Promise<UiContainerRemoteClient> {
  const socket = new WebSocket(url, protocols as string | string[] | undefined)
  return UiContainerRemoteClient.connect(
    createWebSocketUiRemoteChannel(socket as unknown as WebSocketLike),
    params,
  )
}
