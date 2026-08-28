import type { ReactNode } from 'react'
import type { DocumentRef, DocumentSnapshot } from '../ui-container/index.js'

export type RenderDocumentPart = (document: DocumentSnapshot) => ReactNode

export type DocumentRenderRequest = {
  surfaceId: string
  sessionId: string
  mode?: string
  context: Readonly<Record<string, unknown>>
  document: DocumentSnapshot
  openDocument: (document: DocumentRef) => void
  renderPart: RenderDocumentPart
}
