import type {
  InvocationDescriptor,
  RemoteResult,
  TypertRemoteContribution,
} from '@deepseek-ai/dsh-typert-protocol'

export interface NativeContextAtSearchInput {
  readonly sessionId: string
  readonly query: string
  readonly cursor?: number
}

export interface NativeContextAtSearchResult {
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly detail?: string
  readonly sourceLabel?: string
  readonly ref: string
  readonly appearance?: 'file' | 'session'
  readonly clipboardText?: string
}

export interface NativeContextAtSearchPage {
  readonly items: readonly NativeContextAtSearchResult[]
  readonly nextCursor?: number
  readonly complete: boolean
}

export interface NativeContextAtClient {
  search(
    input: NativeContextAtSearchInput,
    signal?: AbortSignal,
  ): Promise<RemoteResult<NativeContextAtSearchPage>>
}

const JSON_CODEC = {
  mode: 'strict',
  typeSymbol: 'dsh-patchouli/native-context-at#JsonValue',
  // This protocol is deliberately JSON-shaped and the host owns its result.
  // Keep the shared client contract dependency-free so DSH can materialize it
  // without requiring a separate browser-side Zod package factory.
  schema: { parse: (value: unknown) => value },
} as const

export const NATIVE_CONTEXT_AT_INVOCATIONS = [{
  id: 'dsh-patchouli#native-context-at/search',
  service: 'patchouliNativeContextAt',
  namespace: 'patchouliNativeContextAt',
  method: 'search',
  invocation: { kind: 'direct' },
  parameters: [{ name: 'input', wire: 'input', source: 'json', codec: JSON_CODEC }],
  cancellation: { parameter: 'signal' },
  result: JSON_CODEC,
}] as const satisfies readonly InvocationDescriptor[]

export const NATIVE_CONTEXT_AT_REMOTE: TypertRemoteContribution = {
  package: 'dsh-patchouli/native-context-at',
  descriptors: NATIVE_CONTEXT_AT_INVOCATIONS,
}

export const NATIVE_CONTEXT_AT_LOCAL = {
  package: 'dsh-patchouli/native-context-at',
  face: 'host',
  schemas: [],
  model: { services: [], events: [], objects: [] },
  invocations: NATIVE_CONTEXT_AT_INVOCATIONS,
} as const
