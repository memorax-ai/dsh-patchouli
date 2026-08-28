import type { DocumentRef, DocumentResolveContext, DocumentSnapshot } from './documents.js'

export const UI_REMOTE_PROTOCOL_VERSION = 1 as const

export const UI_REMOTE_METHODS = {
  handshake: 'ui.container.handshake@1',
  documentResolve: 'ui.container.document.resolve@1',
  documentSubscribe: 'ui.container.document.subscribe@1',
  documentUnsubscribe: 'ui.container.document.unsubscribe@1',
  documentChanged: 'ui.container.document.changed@1',
  surfaceOpen: 'ui.container.surface.open@1',
  surfaceClose: 'ui.container.surface.close@1',
  surfaceReveal: 'ui.container.surface.reveal@1',
} as const

export type UiRemoteCapability = 'documents' | 'subscriptions' | 'surface_commands'
export type UiRemoteId = string | number

export type UiRemoteValue =
  | null
  | boolean
  | number
  | string
  | readonly UiRemoteValue[]
  | { readonly [key: string]: UiRemoteValue }

export type UiRemoteDocumentSnapshot = Omit<DocumentSnapshot, 'content' | 'metadata'> & {
  content: UiRemoteValue
  metadata?: Readonly<Record<string, UiRemoteValue>>
}

export type UiRemoteRequest = {
  jsonrpc: '2.0'
  id: UiRemoteId
  method: string
  params?: UiRemoteValue
}

export type UiRemoteNotification = {
  jsonrpc: '2.0'
  method: string
  params?: UiRemoteValue
}

export type UiRemoteResponse = {
  jsonrpc: '2.0'
  id: UiRemoteId
  result?: UiRemoteValue
  error?: {
    code: number
    message: string
    data?: UiRemoteValue
  }
}

export type UiRemoteMessage = UiRemoteRequest | UiRemoteNotification | UiRemoteResponse

export type UiRemoteHandshakeParams = {
  client: { name: string; version: string; instance_id: string }
  protocol_versions: readonly number[]
  capabilities: readonly UiRemoteCapability[]
}

export type UiRemoteHandshakeResult = {
  protocol_version: typeof UI_REMOTE_PROTOCOL_VERSION
  server: { name: string; version: string; instance_id: string }
  capabilities: readonly UiRemoteCapability[]
  document_schemes: readonly string[]
}

export type UiRemoteResolveParams = {
  uri: string
  context: DocumentResolveContext
  known_revision?: string
}

export type UiRemoteResolveResult =
  | { status: 'not_modified'; revision: string }
  | { status: 'resolved'; snapshot: UiRemoteDocumentSnapshot }

export type UiRemoteSubscribeParams = {
  uri: string
  context: DocumentResolveContext
}

export type UiRemoteSubscribeResult = { subscription_id: string }
export type UiRemoteUnsubscribeParams = { subscription_id: string }
export type UiRemoteUnsubscribeResult = { removed: boolean }

export type UiRemoteDocumentChangedParams = {
  subscription_id: string
  uri: string
}

export type UiRemoteSurfaceOpenParams = {
  surface_id: string
  session_id: string
  document: DocumentRef
}

export type UiRemoteSurfaceCloseParams = {
  surface_id: string
  session_id: string
  uri: string
}

export type UiRemoteSurfaceRevealParams = UiRemoteSurfaceOpenParams

