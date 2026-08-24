import { spawn } from 'node:child_process'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { createConnection, type Socket } from 'node:net'

import { Service, type Context } from '@deepseek-ai/cordis'
import {
  type ArtifactDownloadChunkParams,
  type ArtifactDownloadChunkResult,
  type ArtifactUploadBeginParams,
  type ArtifactUploadBeginResult,
  type ArtifactUploadChunkParams,
  type ArtifactUploadChunkResult,
  type ArtifactUploadCommitParams,
  type ArtifactUploadCommitResult,
  type ChangesEventParams,
  type CreateEntityParams,
  type ControlCheckpointResult,
  type DeleteEntityParams,
  type JsonObject,
  type JsonValue,
  type Meta,
  type MutationResult,
  methods,
  protocolVersion,
  type ControlStatusResult,
  type HandshakeResult,
  type JsonRpcFailure,
  type JsonRpcId,
  type JsonRpcNotification,
  type JsonRpcSuccess,
  type ReadEntityParams,
  type ReadEntityResult,
  type RetrieveEntitiesData,
  type RetrieveEntitiesParams,
  type RetrieveEntitiesResult,
  type SubscribeChangesParams,
  type SubscribeChangesResult,
  type UnsubscribeChangesParams,
  type UnsubscribeChangesResult,
  type UpdateEntityParams,
} from 'dsh-patchouli-protocol'

import type { Config } from './storage.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    patchouliStorage: PatchouliStorageService
  }
}

interface PendingCall {
  readonly method: string
  resolve(value: JsonValue): void
  reject(error: Error): void
}

/** Called in wire order; handlers own any required async serialization. */
export type ChangeHandler<TType extends string = string> = (
  event: ChangesEventParams<TType>,
) => void | Promise<void>

export interface ChangeSubscriptionClose {
  readonly kind: 'unsubscribed' | 'connection-lost' | 'client-closed'
  readonly error?: Error
}

export type EntityQueryOptions<TType extends string = string> = Omit<
  RetrieveEntitiesData<TType>,
  'query'
>

export type WorkUnitMutation<TResult> = (meta: Meta) => Promise<TResult>

/** A subscribe result with an observable, locally managed lifecycle. */
export interface ChangeSubscriptionHandle extends SubscribeChangesResult {
  readonly closed: Promise<ChangeSubscriptionClose>
  unsubscribe(): Promise<void>
}

interface ActiveSubscription {
  readonly handler: ChangeHandler
  readonly resolveClosed: (result: ChangeSubscriptionClose) => void
  settled: boolean
}

/** Structured JSON-RPC failure returned by the Patchouli daemon. */
export class PatchouliRpcError extends Error {
  readonly reason?: string

  constructor(
    readonly method: string,
    readonly code: number,
    message: string,
    readonly data?: JsonValue,
  ) {
    super(`Patchouli RPC ${code}: ${message}`)
    this.name = 'PatchouliRpcError'
    this.reason = rpcErrorReason(data)
  }
}

const subscriptionsCapability = 'subscriptions'
const artifactsCapability = 'artifacts'

export class PatchouliStorageService extends Service {
  private socket?: Socket
  private buffer = ''
  private nextId = 1
  private readonly pending = new Map<JsonRpcId, PendingCall>()
  private readonly subscriptions = new Map<string, ActiveSubscription>()
  private handshake?: HandshakeResult
  private closing = false

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'patchouliStorage')
  }

  get server(): HandshakeResult | undefined {
    return this.handshake
  }

  async start(): Promise<void> {
    try {
      await this.connect()
    } catch (error) {
      if (!this.config.autoStart || !isUnavailable(error)) throw error
      await startDaemon(
        this.config.command,
        this.config.endpoint,
        this.config.providerConfigPath,
        this.config.backendConfigPath,
        this.config.artifactRootPath,
      )
      await this.waitForDaemon()
    }
    this.ctx.logger('patchouli').info(
      'connected to daemon node %s at %s',
      this.handshake?.server.node_id,
      this.config.endpoint,
    )
  }

  async status(): Promise<ControlStatusResult> {
    return this.call<ControlStatusResult>(methods.controlStatus, { meta: {}, data: {} })
  }

  async checkpoint(): Promise<ControlCheckpointResult> {
    return this.call<ControlCheckpointResult>(methods.controlCheckpoint, { meta: {}, data: {} })
  }

  async beginArtifactUpload(
    params: ArtifactUploadBeginParams,
  ): Promise<ArtifactUploadBeginResult> {
    this.requireCapability(artifactsCapability)
    return this.call<ArtifactUploadBeginResult>(methods.artifactUploadBegin, params)
  }

  async uploadArtifactChunk(
    params: ArtifactUploadChunkParams,
  ): Promise<ArtifactUploadChunkResult> {
    this.requireCapability(artifactsCapability)
    return this.call<ArtifactUploadChunkResult>(methods.artifactUploadChunk, params)
  }

  async commitArtifactUpload(
    params: ArtifactUploadCommitParams,
  ): Promise<ArtifactUploadCommitResult> {
    this.requireCapability(artifactsCapability)
    return this.call<ArtifactUploadCommitResult>(methods.artifactUploadCommit, params)
  }

  async downloadArtifactChunk(
    params: ArtifactDownloadChunkParams,
  ): Promise<ArtifactDownloadChunkResult> {
    this.requireCapability(artifactsCapability)
    return this.call<ArtifactDownloadChunkResult>(methods.artifactDownloadChunk, params)
  }

  async uploadArtifact(
    params: ArtifactUploadBeginParams,
    bytes: Uint8Array,
  ): Promise<ArtifactUploadCommitResult> {
    const begin = await this.beginArtifactUpload(params)
    const chunkBytes = begin.data.max_chunk_bytes
    let offset = 0
    while (offset < bytes.byteLength) {
      const chunk = bytes.subarray(offset, Math.min(offset + chunkBytes, bytes.byteLength))
      const result = await this.uploadArtifactChunk({
        meta: params.meta,
        data: {
          upload_id: begin.data.upload_id,
          offset,
          bytes_base64: Buffer.from(chunk).toString('base64'),
        },
      })
      if (result.data.next_offset <= offset) {
        throw new Error('Patchouli artifact upload did not advance')
      }
      offset = result.data.next_offset
    }
    return this.commitArtifactUpload({
      meta: params.meta,
      data: { upload_id: begin.data.upload_id },
    })
  }

  async downloadArtifact(
    meta: Meta,
    id: string,
    version: string | null = null,
  ): Promise<Uint8Array> {
    this.requireCapability(artifactsCapability)
    const maxBytes = this.handshake?.limits.max_artifact_chunk_bytes
    if (maxBytes === undefined) throw new Error('Patchouli artifact chunk limit is unavailable')
    const chunks: Buffer[] = []
    let offset = 0
    let selectedVersion = version
    while (true) {
      const result = await this.downloadArtifactChunk({
        meta,
        data: { id, version: selectedVersion, offset, max_bytes: maxBytes },
      })
      const bytes = Buffer.from(result.data.bytes_base64, 'base64')
      if (result.data.offset !== offset
        || result.data.next_offset !== offset + bytes.byteLength) {
        throw new Error('Patchouli artifact download returned an invalid offset')
      }
      selectedVersion ??= result.data.entity.version
      if (result.data.entity.version !== selectedVersion) {
        throw new Error('Patchouli artifact changed during download')
      }
      chunks.push(bytes)
      offset = result.data.next_offset
      if (result.data.eof) return Buffer.concat(chunks)
      if (bytes.byteLength === 0) throw new Error('Patchouli artifact download did not advance')
    }
  }

  async create<TType extends string = string, TValue extends JsonValue = JsonValue>(
    params: CreateEntityParams<TType, TValue>,
  ): Promise<MutationResult<TType, TValue>> {
    return this.call<MutationResult<TType, TValue>>(methods.entityCreate, params)
  }

  async read<TType extends string = string, TValue extends JsonValue = JsonValue>(
    params: ReadEntityParams<TType>,
  ): Promise<ReadEntityResult<TType, TValue>> {
    return this.call<ReadEntityResult<TType, TValue>>(methods.entityRead, params)
  }

  async retrieve<TType extends string = string, TValue extends JsonValue = JsonValue>(
    params: RetrieveEntitiesParams<TType>,
  ): Promise<RetrieveEntitiesResult<TType, TValue>> {
    return this.call<RetrieveEntitiesResult<TType, TValue>>(methods.entityRetrieve, params)
  }

  /** Serialize an untyped backend query instruction without changing the RPC shape. */
  async query<TType extends string = string, TValue extends JsonValue = JsonValue>(
    meta: Meta,
    instruction: JsonObject,
    options: EntityQueryOptions<TType> = {},
  ): Promise<RetrieveEntitiesResult<TType, TValue>> {
    return this.retrieve({
      meta,
      data: { ...options, query: JSON.stringify(instruction) },
    })
  }

  /** Follow `meta.next_cursor` until the backend reports the final page. */
  async *queryPages<TType extends string = string, TValue extends JsonValue = JsonValue>(
    meta: Meta,
    instruction: JsonObject,
    options: EntityQueryOptions<TType> = {},
  ): AsyncGenerator<RetrieveEntitiesResult<TType, TValue>> {
    let pageInstruction = instruction
    while (true) {
      const page = await this.query<TType, TValue>(meta, pageInstruction, options)
      yield page
      const cursor = page.meta.next_cursor
      if (cursor === undefined) return
      if (typeof cursor !== 'string') {
        throw new Error('Patchouli retrieval returned a non-string next_cursor')
      }
      pageInstruction = { ...instruction, cursor }
    }
  }

  /** Retrieve active entities by ID through the same JSON query path. */
  retrieveByIds<TType extends string = string, TValue extends JsonValue = JsonValue>(
    meta: Meta,
    ids: readonly string[],
    options: EntityQueryOptions<TType> = {},
  ): Promise<RetrieveEntitiesResult<TType, TValue>> {
    return this.query<TType, TValue>(meta, { ids }, options)
  }

  /** Apply config-defined identity metadata to every mutation and close on the final call. */
  async runWorkUnit<TResult>(
    meta: Meta,
    closeMeta: Meta,
    mutations: readonly WorkUnitMutation<TResult>[],
  ): Promise<readonly TResult[]> {
    if (mutations.length === 0) {
      throw new Error('Patchouli work unit requires at least one mutation')
    }
    const closeFields = Object.keys(closeMeta)
    if (closeFields.length === 0) {
      throw new Error('Patchouli work unit requires close metadata')
    }
    if (closeFields.some(field => Object.hasOwn(meta, field))) {
      throw new Error('Patchouli work unit close metadata must not override base metadata')
    }
    const results: TResult[] = []
    for (const [index, mutation] of mutations.entries()) {
      const mutationMeta = index === mutations.length - 1
        ? { ...meta, ...closeMeta }
        : { ...meta }
      results.push(await mutation(mutationMeta))
    }
    return results
  }

  async update<TType extends string = string, TValue extends JsonValue = JsonValue>(
    params: UpdateEntityParams<TType, TValue>,
  ): Promise<MutationResult<TType, TValue>> {
    return this.call<MutationResult<TType, TValue>>(methods.entityUpdate, params)
  }

  async delete<TType extends string = string>(
    params: DeleteEntityParams<TType>,
  ): Promise<MutationResult<TType, JsonValue>> {
    return this.call<MutationResult<TType, JsonValue>>(methods.entityDelete, params)
  }

  async subscribe<TType extends string = string>(
    params: SubscribeChangesParams<TType>,
    handler: ChangeHandler<TType>,
  ): Promise<ChangeSubscriptionHandle> {
    this.requireCapability(subscriptionsCapability)
    return this.call<ChangeSubscriptionHandle>(methods.changesSubscribe, params, (result) => {
      const subscriptionId = result.data.subscription_id
      let resolveClosed!: (result: ChangeSubscriptionClose) => void
      const closed = new Promise<ChangeSubscriptionClose>((resolve) => {
        resolveClosed = resolve
      })
      const subscription: ActiveSubscription = {
        handler: event => handler(event as ChangesEventParams<TType>),
        resolveClosed,
        settled: false,
      }
      this.subscriptions.set(subscriptionId, subscription)

      let unsubscribePromise: Promise<void> | undefined
      Object.assign(result, {
        closed,
        unsubscribe: (): Promise<void> => {
          if (unsubscribePromise) return unsubscribePromise
          if (subscription.settled) {
            unsubscribePromise = Promise.resolve()
            return unsubscribePromise
          }
          unsubscribePromise = this.unsubscribe({
            meta: {},
            data: { subscription_id: subscriptionId },
          }).then(() => undefined)
          return unsubscribePromise
        },
      })
    })
  }

  async unsubscribe(params: UnsubscribeChangesParams): Promise<UnsubscribeChangesResult> {
    return this.call<UnsubscribeChangesResult>(methods.changesUnsubscribe, params, () => {
      this.settleSubscription(params.data.subscription_id, { kind: 'unsubscribed' })
    })
  }

  async close(): Promise<void> {
    this.closing = true
    this.handshake = undefined
    this.settleSubscriptions({ kind: 'client-closed' })
    this.socket?.destroy()
    this.socket = undefined
    this.rejectPending(new Error('Patchouli connection closed'))
  }

  private async waitForDaemon(): Promise<void> {
    const deadline = Date.now() + this.config.startupTimeoutMs
    let lastError: unknown
    while (Date.now() < deadline) {
      try {
        await this.connect()
        return
      } catch (error) {
        if (!isUnavailable(error)) throw error
        lastError = error
        await delay(50)
      }
    }
    throw new Error(
      `Patchouli daemon did not become ready within ${this.config.startupTimeoutMs}ms`,
      { cause: lastError },
    )
  }

  private async connect(): Promise<void> {
    this.closing = false
    const socket = createConnection(this.config.endpoint)
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve)
        socket.once('error', reject)
      })
    } catch (error) {
      socket.destroy()
      throw error
    }

    socket.setEncoding('utf8')
    socket.on('data', chunk => this.receive(chunk.toString()))
    socket.on('error', error => this.connectionFailed(error))
    socket.on('close', () => this.connectionFailed(new Error('Patchouli daemon disconnected')))
    this.socket = socket

    try {
      this.handshake = await this.call<HandshakeResult>(methods.handshake, {
        client: {
          name: 'dsh-patchouli',
          version: '0.1.3',
          instance_id: randomUUID(),
        },
        protocol_versions: [protocolVersion],
        capabilities: [artifactsCapability, subscriptionsCapability],
      })
    } catch (error) {
      socket.destroy()
      this.socket = undefined
      throw error
    }
  }

  private requireCapability(capability: string): void {
    if (this.handshake && !this.handshake.capabilities.includes(capability)) {
      throw new Error(`Patchouli daemon did not negotiate ${capability}`)
    }
  }

  private call<TResult>(
    method: string,
    params: unknown,
    onResult?: (result: TResult) => void,
  ): Promise<TResult> {
    const socket = this.socket
    if (!socket || socket.destroyed) {
      return Promise.reject(unavailable('Patchouli daemon is not connected'))
    }
    const id = this.nextId++
    const request = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'
    return new Promise<TResult>((resolve, reject) => {
      this.pending.set(id, {
        method,
        resolve: (value) => {
          try {
            const result = value as TResult
            onResult?.(result)
            resolve(result)
          } catch (error) {
            reject(error)
          }
        },
        reject,
      })
      socket.write(request, error => {
        if (!error) return
        this.pending.delete(id)
        reject(error)
      })
    })
  }

  private receive(chunk: string): void {
    this.buffer += chunk
    while (true) {
      const newline = this.buffer.indexOf('\n')
      if (newline < 0) return
      const line = this.buffer.slice(0, newline).trimEnd()
      this.buffer = this.buffer.slice(newline + 1)
      if (!line) continue
      let message: JsonRpcSuccess | JsonRpcFailure | JsonRpcNotification<ChangesEventParams>
      try {
        message = JSON.parse(line) as
          | JsonRpcSuccess
          | JsonRpcFailure
          | JsonRpcNotification<ChangesEventParams>
      } catch (error) {
        this.connectionFailed(new Error('Patchouli daemon returned invalid JSON', { cause: error }))
        return
      }
      if ('method' in message) {
        this.receiveNotification(message)
        continue
      }
      const responseId = message.id
      if (responseId === null) continue
      const pending = this.pending.get(responseId)
      if (!pending) continue
      this.pending.delete(responseId)
      if ('error' in message) {
        pending.reject(new PatchouliRpcError(
          pending.method,
          message.error.code,
          message.error.message,
          message.error.data,
        ))
      } else {
        pending.resolve(message.result)
      }
    }
  }

  private receiveNotification(notification: JsonRpcNotification<ChangesEventParams>): void {
    if (notification.method !== methods.changesEvent) return
    const subscriptionId = notification.params.data.subscription_id
    const subscription = this.subscriptions.get(subscriptionId)
    if (!subscription) return
    try {
      const handling = subscription.handler(notification.params)
      void handling?.catch(error => this.warnChangeHandler(subscriptionId, error))
    } catch (error) {
      this.warnChangeHandler(subscriptionId, error)
    }
  }

  private warnChangeHandler(subscriptionId: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    this.ctx.logger('patchouli').warn(
      'change handler for subscription %s failed: %s',
      subscriptionId,
      message,
    )
  }

  private connectionFailed(error: Error): void {
    this.handshake = undefined
    this.socket = undefined
    this.settleSubscriptions({ kind: 'connection-lost', error })
    this.rejectPending(error)
    if (!this.closing) this.ctx.logger('patchouli').warn(error)
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }

  private settleSubscription(
    subscriptionId: string,
    result: ChangeSubscriptionClose,
  ): void {
    const subscription = this.subscriptions.get(subscriptionId)
    if (!subscription || subscription.settled) return
    subscription.settled = true
    this.subscriptions.delete(subscriptionId)
    subscription.resolveClosed(result)
  }

  private settleSubscriptions(result: ChangeSubscriptionClose): void {
    for (const subscriptionId of [...this.subscriptions.keys()]) {
      this.settleSubscription(subscriptionId, result)
    }
  }
}

async function startDaemon(
  command: string,
  endpoint: string,
  providerConfigPath: string,
  backendConfigPath: string,
  artifactRootPath: string,
): Promise<void> {
  const child = spawn(command, [
    'serve',
    '--endpoint', endpoint,
    '--artifacts', artifactRootPath,
    '--providers', providerConfigPath,
    '--config', backendConfigPath,
  ], {
    detached: true,
    stdio: 'ignore',
  })
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', reject)
  })
  child.unref()
}

function isUnavailable(error: unknown): boolean {
  return error instanceof Error
    && ('code' in error
      ? ['ECONNREFUSED', 'ENOENT', 'EPIPE'].includes(String(error.code))
      : error.message === 'Patchouli daemon is not connected')
}

function unavailable(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: 'ENOENT' })
}

function rpcErrorReason(data: JsonValue | undefined): string | undefined {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return
  const reason = (data as { readonly reason?: JsonValue }).reason
  return typeof reason === 'string' ? reason : undefined
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}
