import type { MemoryData, MemoryMetadata } from 'dsh-patchouli'
import {
  PatchouliRpcError,
  type PatchouliStorageService,
} from 'dsh-patchouli/storage'

import type { ArtifactIndexEntry, ArtifactIndexResult, ArtifactSource } from '../index/artifact.js'
import type {
  NativeContextAlgorithmModule,
  NativeContextModuleContext,
} from '../types.js'

const entityType = 'knowledge' as const
const contextKind = 'artifact' as const
const defaultQueryLimit = 10
const maximumQueryLimit = 50

type ArtifactContextStorage = Pick<
  PatchouliStorageService,
  'create' | 'query' | 'read' | 'update'
>

export interface ArtifactContextIngestInput {
  readonly meta: MemoryMetadata
  readonly index: ArtifactIndexResult
}

export interface ArtifactContextIngestResult {
  readonly stored: number
}

export interface ArtifactContextQuery {
  readonly meta: MemoryMetadata
  readonly text: string
  readonly limit?: number
}

export interface ArtifactContextQueryHit {
  readonly score: number
  readonly description: string
  readonly text: string | null
  readonly source: ArtifactSource
}

export interface ArtifactContextQueryResult {
  readonly hits: readonly ArtifactContextQueryHit[]
}

/** Persist and retrieve bounded, user-visible artifact context without copying artifact bytes. */
export class ArtifactContextAlgorithm implements NativeContextAlgorithmModule<
  ArtifactContextIngestInput,
  ArtifactContextIngestResult,
  ArtifactContextQuery,
  ArtifactContextQueryResult
> {
  readonly id = 'artifact-context'

  constructor(private readonly storage: ArtifactContextStorage) {}

  async ingest(
    input: ArtifactContextIngestInput,
    context: NativeContextModuleContext,
  ): Promise<ArtifactContextIngestResult> {
    let stored = 0
    for (const artifact of input.index.artifacts) {
      context.signal?.throwIfAborted()
      await createOrUpdate(
        this.storage,
        input.meta,
        artifactEntityId(artifact),
        artifactEntity(artifact),
        context.signal,
      )
      stored += 1
    }
    return { stored }
  }

  async query(
    request: ArtifactContextQuery,
    context: NativeContextModuleContext,
  ): Promise<ArtifactContextQueryResult> {
    const text = requiredText(request.text)
    const limit = queryLimit(request.limit)
    context.signal?.throwIfAborted()
    const result = await this.storage.query(
      request.meta,
      {
        text,
        where: {
          '/metadata/extensions/dsh.native_context/context_kind': contextKind,
        },
        order: 'relevance',
      },
      { types: [entityType], limit },
    )
    context.signal?.throwIfAborted()
    const hits: ArtifactContextQueryHit[] = []
    for (const hit of result.data.hits.slice(0, limit)) {
      const variant = hit.variants.find(candidate => candidate.state === 'active')
      if (variant?.state !== 'active') continue
      const stored = storedArtifact(variant.value)
      if (stored === undefined) continue
      hits.push({
        score: hit.score,
        description: stored.description,
        text: stored.text,
        source: stored.source,
      })
    }
    return { hits }
  }
}

function artifactEntity(artifact: ArtifactIndexEntry): MemoryData {
  const now = new Date().toISOString()
  const description = artifactDescription(artifact)
  return {
    content: {
      kind: 'structured',
      value: { description, visible_text: artifact.text },
    },
    metadata: {
      core: {
        schema: 'patchouli.knowledge@1',
        scope: { tenant: null, workspace: null, user: null, session: null },
        origin: {
          provider: 'deepseek-harness',
          binding: 'dsh-patchouli-native-context-service',
          native_type: contextKind,
          native_id: artifact.id,
          native_revision: artifact.version,
        },
        time: {
          event_at: null,
          source_created_at: null,
          source_updated_at: null,
          observed_at: now,
          ingested_at: now,
        },
        lifecycle: { status: 'active', expires_at: null },
        provenance: [{
          kind: 'observed',
          actor: 'native-context-service',
          source: `${artifact.source.id}@${artifact.source.version}`,
          recorded_at: now,
        }],
      },
      extensions: {
        'dsh.native_context': {
          context_kind: contextKind,
          media_type: artifact.mediaType,
          byte_length: artifact.byteLength,
          digest: artifact.digest,
          source: { ...artifact.source },
        },
      },
    },
    artifact: [],
    profile: {
      epistemic: 'observation',
      temporal: { kind: 'timeless' },
      ownership: 'shared',
      abstraction: 'instance',
      persistence: 'working',
      retrieval: ['exact', 'contextual'],
      actionability: 'informational',
    },
  }
}

function artifactDescription(artifact: ArtifactIndexEntry): string {
  const metadataDescription = artifact.metadata.description
  const description = typeof metadataDescription === 'string'
    ? metadataDescription.trim()
    : ''
  return [artifact.name, description, artifact.mediaType]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join(' · ')
}

function artifactEntityId(artifact: ArtifactIndexEntry): string {
  return `native-context:artifact:${artifact.id.length}:${artifact.id}:${artifact.version.length}:${artifact.version}`
}

async function createOrUpdate(
  storage: ArtifactContextStorage,
  meta: MemoryMetadata,
  id: string,
  value: MemoryData,
  signal?: AbortSignal,
): Promise<void> {
  let current
  try {
    current = await storage.read({ meta, data: { ref: { type: entityType, id } } })
    signal?.throwIfAborted()
  } catch (error: unknown) {
    signal?.throwIfAborted()
    if (!(error instanceof PatchouliRpcError) || error.reason !== 'NOT_FOUND') throw error
  }
  if (current === undefined) {
    await storage.create({ meta, data: { type: entityType, id, value } })
  } else {
    const baseVersions = current.data.variants.map(variant => variant.version)
    if (baseVersions.length === 0) throw new Error(`artifact context entity has no version: ${id}`)
    await storage.update({
      meta: { ...meta, base_versions: baseVersions },
      data: { ref: { type: entityType, id }, value },
    })
  }
  signal?.throwIfAborted()
}

function requiredText(value: string): string {
  const text = value.trim()
  if (text.length === 0) throw new TypeError('artifact context query text must be non-empty')
  return text
}

function storedArtifact(value: unknown): {
  readonly description: string
  readonly text: string | null
  readonly source: ArtifactSource
} | undefined {
  if (!isObject(value) || !isObject(value.content) || value.content.kind !== 'structured') {
    return undefined
  }
  const content = value.content.value
  const metadata = value.metadata
  if (!isObject(content)
    || typeof content.description !== 'string'
    || (content.visible_text !== null && typeof content.visible_text !== 'string')
    || !isObject(metadata)
    || !isObject(metadata.extensions)
    || !isObject(metadata.extensions['dsh.native_context'])) return undefined
  const extension = metadata.extensions['dsh.native_context']
  if (extension.context_kind !== contextKind || !isArtifactSource(extension.source)) return undefined
  return {
    description: content.description,
    text: content.visible_text,
    source: extension.source,
  }
}

function isArtifactSource(value: unknown): value is ArtifactSource {
  return isObject(value)
    && value.kind === 'patchouli-artifact'
    && typeof value.id === 'string'
    && typeof value.version === 'string'
    && (value.role === 'source' || value.role === 'attachment' || value.role === 'embedding')
    && typeof value.provider === 'string'
    && typeof value.locator === 'string'
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function queryLimit(value: number | undefined): number {
  const limit = value ?? defaultQueryLimit
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximumQueryLimit) {
    throw new RangeError(`limit must be an integer from 1 to ${maximumQueryLimit}`)
  }
  return limit
}
