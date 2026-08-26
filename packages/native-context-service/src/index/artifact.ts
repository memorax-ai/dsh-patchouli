import type { MemoryMetadata } from 'dsh-patchouli'
import type { PatchouliStorageService } from 'dsh-patchouli/storage'

import type {
  NativeContextIndexModule,
  NativeContextModuleContext,
} from '../types.js'

export interface ArtifactIndexReference {
  readonly id: string
  /** Artifact-ingestor receipts provide this pin. Omit only for an unconflicted entity. */
  readonly version?: string
  readonly role?: 'source' | 'attachment' | 'embedding'
}

export interface ArtifactIndexRequest {
  /** Patchouli scope-routing metadata used for entity and artifact reads. */
  readonly meta: MemoryMetadata
  readonly artifacts: readonly ArtifactIndexReference[]
}

export interface ArtifactSource {
  readonly kind: 'patchouli-artifact'
  readonly id: string
  readonly version: string
  readonly role: 'source' | 'attachment' | 'embedding'
  readonly provider: string
  readonly locator: string
}

export interface ArtifactIndexEntry {
  readonly id: string
  readonly version: string
  readonly mediaType: string
  readonly name: string | null
  readonly byteLength: number | null
  readonly digest: string | null
  readonly metadata: Readonly<Record<string, unknown>>
  /** Present only for already stored textual artifacts; no OCR or transcription runs here. */
  readonly text: string | null
  readonly textTruncated: boolean
  readonly source: ArtifactSource
}

export interface ArtifactIndexResult {
  readonly artifacts: readonly ArtifactIndexEntry[]
  readonly truncated: boolean
}

export interface ArtifactIndexOptions {
  readonly maxArtifacts?: number
  readonly maxTextBytesPerArtifact?: number
  readonly maxTotalTextBytes?: number
  readonly chunkBytes?: number
}

type ArtifactStorage = Pick<
  PatchouliStorageService,
  'downloadArtifactChunk' | 'read'
>

interface StoredArtifact {
  readonly id: string
  readonly version: string
  readonly value: Readonly<Record<string, unknown>>
}

const defaults = {
  maxArtifacts: 64,
  maxTextBytesPerArtifact: 256 * 1024,
  maxTotalTextBytes: 1024 * 1024,
  chunkBytes: 64 * 1024,
} as const

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new TypeError(`${name} must be a positive safe integer`)
  }
  return resolved
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new TypeError(`stored artifact ${field} must be a non-empty string`)
  }
  return value
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null || typeof value === 'string') return value
  throw new TypeError(`stored artifact ${field} must be a string or null`)
}

function byteLength(value: unknown): number | null {
  if (value === null) return null
  if (Number.isSafeInteger(value) && Number(value) >= 0) return Number(value)
  throw new TypeError('stored artifact byte_length must be a non-negative integer or null')
}

function decodeBase64(value: unknown): Uint8Array {
  if (typeof value !== 'string') {
    throw new TypeError('stored artifact bytes_base64 must be a string')
  }
  const encoded = value
  const binary = atob(encoded)
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}

function textualMediaType(mediaType: string): boolean {
  return mediaType.startsWith('text/')
    || mediaType === 'application/json'
    || mediaType === 'application/javascript'
    || mediaType === 'application/xml'
    || mediaType === 'application/yaml'
    || mediaType.endsWith('+json')
    || mediaType.endsWith('+xml')
}

function placement(value: Readonly<Record<string, unknown>>): {
  readonly provider: string
  readonly locator: string
} {
  const raw = value.placement
  if (!isObject(raw)) throw new TypeError('stored artifact placement must be an object')
  const provider = requiredString(raw.provider, 'placement.provider')
  if (raw.kind === 'managed') {
    return { provider, locator: requiredString(raw.key, 'placement.key') }
  }
  if (raw.kind === 'indexed') {
    return { provider, locator: requiredString(raw.locator, 'placement.locator') }
  }
  throw new TypeError('stored artifact placement kind is unsupported')
}

/** Read Patchouli artifact records and bounded text bytes without re-extracting media. */
export class ArtifactIndexModule implements NativeContextIndexModule<
  ArtifactIndexRequest,
  ArtifactIndexResult
> {
  readonly id = 'artifact'

  private readonly maxArtifacts: number
  private readonly maxTextBytesPerArtifact: number
  private readonly maxTotalTextBytes: number
  private readonly chunkBytes: number

  constructor(
    private readonly storage: ArtifactStorage,
    options: ArtifactIndexOptions = {},
  ) {
    this.maxArtifacts = positiveInteger(
      options.maxArtifacts,
      defaults.maxArtifacts,
      'maxArtifacts',
    )
    this.maxTextBytesPerArtifact = positiveInteger(
      options.maxTextBytesPerArtifact,
      defaults.maxTextBytesPerArtifact,
      'maxTextBytesPerArtifact',
    )
    this.maxTotalTextBytes = positiveInteger(
      options.maxTotalTextBytes,
      defaults.maxTotalTextBytes,
      'maxTotalTextBytes',
    )
    this.chunkBytes = positiveInteger(options.chunkBytes, defaults.chunkBytes, 'chunkBytes')
  }

  async index(
    request: ArtifactIndexRequest,
    context: NativeContextModuleContext,
  ): Promise<ArtifactIndexResult> {
    const { signal } = context
    signal?.throwIfAborted()
    const entries: ArtifactIndexEntry[] = []
    let totalTextBytes = 0

    for (const reference of request.artifacts.slice(0, this.maxArtifacts)) {
      signal?.throwIfAborted()
      if (reference.id.trim() === '') throw new TypeError('artifact id must be non-empty')
      const stored = await this.readArtifact(request.meta, reference, signal)
      const value = stored.value
      const mediaType = requiredString(value.media_type, 'media_type')
      const storedBytes = byteLength(value.byte_length)
      const metadata = value.metadata
      if (!isObject(metadata)) throw new TypeError('stored artifact metadata must be an object')
      const location = placement(value)
      const remaining = this.maxTotalTextBytes - totalTextBytes
      const textLimit = Math.min(this.maxTextBytesPerArtifact, remaining)
      const content = textualMediaType(mediaType) && textLimit > 0
        ? await this.readText(request.meta, stored, textLimit, signal)
        : { text: null, bytes: 0, truncated: textualMediaType(mediaType) && storedBytes !== 0 }
      totalTextBytes += content.bytes

      entries.push({
        id: stored.id,
        version: stored.version,
        mediaType,
        name: nullableString(value.name, 'name'),
        byteLength: storedBytes,
        digest: nullableString(value.digest, 'digest'),
        metadata,
        text: content.text,
        textTruncated: content.truncated,
        source: {
          kind: 'patchouli-artifact',
          id: stored.id,
          version: stored.version,
          role: reference.role ?? 'attachment',
          provider: location.provider,
          locator: location.locator,
        },
      })
    }

    return {
      artifacts: entries,
      truncated: request.artifacts.length > this.maxArtifacts,
    }
  }

  private async readArtifact(
    meta: MemoryMetadata,
    reference: ArtifactIndexReference,
    signal?: AbortSignal,
  ): Promise<StoredArtifact> {
    const result = await this.storage.read({
      meta,
      data: { ref: { type: 'artifact', id: reference.id } },
    })
    signal?.throwIfAborted()
    const variants = result.data.variants.filter(variant => variant.state === 'active')
    const selected = reference.version === undefined
      ? variants.length === 1 ? variants[0] : undefined
      : variants.find(variant => variant.version === reference.version)
    if (selected === undefined || selected.state !== 'active' || !isObject(selected.value)) {
      throw new Error(
        reference.version === undefined
          ? `artifact is missing or conflicted: ${reference.id}`
          : `artifact version is unavailable: ${reference.id}@${reference.version}`,
      )
    }
    return {
      id: selected.ref.id,
      version: selected.version,
      value: selected.value,
    }
  }

  private async readText(
    meta: MemoryMetadata,
    artifact: StoredArtifact,
    limit: number,
    signal?: AbortSignal,
  ): Promise<{
      readonly text: string
      readonly bytes: number
      readonly truncated: boolean
    }> {
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let offset = 0
    let text = ''
    let eof = false
    while (offset < limit && !eof) {
      signal?.throwIfAborted()
      const page = await this.storage.downloadArtifactChunk({
        meta,
        data: {
          id: artifact.id,
          version: artifact.version,
          offset,
          max_bytes: Math.min(this.chunkBytes, limit - offset),
        },
      })
      signal?.throwIfAborted()
      const bytes = decodeBase64(page.data.bytes_base64)
      if (page.data.entity.version !== artifact.version
        || page.data.offset !== offset
        || page.data.next_offset !== offset + bytes.byteLength) {
        throw new Error(`artifact text read returned an invalid page: ${artifact.id}`)
      }
      if (bytes.byteLength === 0 && !page.data.eof) {
        throw new Error(`artifact text read did not advance: ${artifact.id}`)
      }
      text += decoder.decode(bytes, { stream: !page.data.eof })
      offset = page.data.next_offset
      eof = page.data.eof
    }
    if (eof) text += decoder.decode()
    return { text, bytes: offset, truncated: !eof }
  }
}
