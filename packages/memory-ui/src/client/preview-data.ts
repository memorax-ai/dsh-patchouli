import type { PatchouliLocaleKey, PatchouliTranslate } from './locales.js'
import type { DocumentRef, DocumentSnapshot } from './ui-container/index.js'

export type PreviewDocumentKind =
  | 'design'
  | 'protocol'
  | 'note'
  | 'relation'
  | 'file'
  | 'log'
  | 'timeline'

type PreviewDocumentLocaleId =
  | 'uiFramework'
  | 'jsonRpc'
  | 'cordisRouting'
  | 'relationUiProtocol'
  | 'relationRoutingUi'
  | 'fileUiDesign'
  | 'fileProtocolSpec'
  | 'logRetrieveCordis'
  | 'logProposalRouting'
  | 'timelineHandshake'
  | 'timelineUiView'

export type PreviewDocument = {
  uri: string
  localeId: PreviewDocumentLocaleId
  kind: PreviewDocumentKind
  source: string
  history: number
  retrievals: number
  references: number
}

export type PreviewTreeNode = {
  id: string
  labelKey?: PatchouliLocaleKey
  kind: 'folder' | 'document'
  documentUri?: string
  children?: readonly PreviewTreeNode[]
}

function document(
  id: string,
  localeId: PreviewDocumentLocaleId,
  kind: PreviewDocumentKind,
  source: string,
  counts: readonly [history: number, retrievals: number, references: number],
): PreviewDocument {
  const [history, retrievals, references] = counts
  return {
    uri: `patchouli://preview/${id}`,
    localeId,
    kind,
    source,
    history,
    retrievals,
    references,
  }
}

function documentKey(
  document: PreviewDocument,
  field: 'title' | 'updated' | 'summary',
): PatchouliLocaleKey {
  return `preview.document.${document.localeId}.${field}` as PatchouliLocaleKey
}

export function documentTitle(document: PreviewDocument, t: PatchouliTranslate): string {
  return t(documentKey(document, 'title'))
}

export function documentUpdated(document: PreviewDocument, t: PatchouliTranslate): string {
  return t(documentKey(document, 'updated'))
}

export function documentSummary(document: PreviewDocument, t: PatchouliTranslate): string {
  return t(documentKey(document, 'summary'))
}

export type PreviewDocumentContent = {
  type: 'patchouli.preview'
  document: PreviewDocument
}

export function previewDocumentRef(document: PreviewDocument, t: PatchouliTranslate): DocumentRef {
  return {
    uri: document.uri,
    title: documentTitle(document, t),
    mediaType: 'application/vnd.patchouli.preview+json',
    kind: document.kind,
  }
}

export function previewDocumentSnapshot(
  document: PreviewDocument,
  t: PatchouliTranslate,
): DocumentSnapshot {
  return {
    ...previewDocumentRef(document, t),
    revision: String(document.history),
    content: { type: 'patchouli.preview', document } satisfies PreviewDocumentContent,
  }
}

export function isPreviewDocumentContent(value: unknown): value is PreviewDocumentContent {
  return typeof value === 'object' && value !== null
    && 'type' in value && value.type === 'patchouli.preview'
    && 'document' in value
}

export const previewDocuments: readonly PreviewDocument[] = [
  document('ui-framework', 'uiFramework', 'design', 'docs/ui-design.md', [4, 7, 3]),
  document('json-rpc', 'jsonRpc', 'protocol', 'packages/protocol/SPEC.md', [11, 19, 8]),
  document('cordis-routing', 'cordisRouting', 'note', 'memory-agent', [2, 5, 4]),
  document('relation-ui-protocol', 'relationUiProtocol', 'relation', 'relation-index', [3, 9, 2]),
  document('relation-routing-ui', 'relationRoutingUi', 'relation', 'relation-index', [1, 4, 2]),
  document('file-ui-design', 'fileUiDesign', 'file', 'docs/ui-design.md', [4, 7, 3]),
  document('file-protocol-spec', 'fileProtocolSpec', 'file', 'packages/protocol/SPEC.md', [11, 19, 8]),
  document('log-retrieve-cordis', 'logRetrieveCordis', 'log', 'retrieve-run/7f2a', [1, 1, 3]),
  document('log-proposal-routing', 'logProposalRouting', 'log', 'operation/18c4', [1, 0, 1]),
  document('timeline-handshake', 'timelineHandshake', 'timeline', 'change/0042', [1, 3, 5]),
  document('timeline-ui-view', 'timelineUiView', 'timeline', 'change/0047', [1, 2, 2]),
]

export const previewDocumentByUri = new Map(
  previewDocuments.map((entry) => [entry.uri, entry] as const),
)

export const knowledgeTree: readonly PreviewTreeNode[] = [
  {
    id: 'knowledge-product',
    labelKey: 'preview.tree.productDesign',
    kind: 'folder',
    children: [
      { id: 'knowledge-ui-framework', kind: 'document', documentUri: 'patchouli://preview/ui-framework' },
    ],
  },
  {
    id: 'knowledge-engineering',
    labelKey: 'preview.tree.engineeringDesign',
    kind: 'folder',
    children: [
      {
        id: 'knowledge-protocols',
        labelKey: 'preview.tree.protocols',
        kind: 'folder',
        children: [
          { id: 'knowledge-json-rpc', kind: 'document', documentUri: 'patchouli://preview/json-rpc' },
        ],
      },
      { id: 'knowledge-cordis', kind: 'document', documentUri: 'patchouli://preview/cordis-routing' },
    ],
  },
]

export const relationTree: readonly PreviewTreeNode[] = [
  {
    id: 'relations-dependencies',
    labelKey: 'preview.tree.dependencies',
    kind: 'folder',
    children: [
      { id: 'relation-ui-protocol-node', kind: 'document', documentUri: 'patchouli://preview/relation-ui-protocol' },
    ],
  },
  {
    id: 'relations-routing',
    labelKey: 'preview.tree.routing',
    kind: 'folder',
    children: [
      { id: 'relation-routing-ui-node', kind: 'document', documentUri: 'patchouli://preview/relation-routing-ui' },
    ],
  },
]

export const fileTree: readonly PreviewTreeNode[] = [
  {
    id: 'files-docs',
    labelKey: 'preview.tree.docs',
    kind: 'folder',
    children: [
      { id: 'file-ui-design-node', kind: 'document', documentUri: 'patchouli://preview/file-ui-design' },
    ],
  },
  {
    id: 'files-packages',
    labelKey: 'preview.tree.packages',
    kind: 'folder',
    children: [
      {
        id: 'files-protocol',
        labelKey: 'preview.tree.protocol',
        kind: 'folder',
        children: [
          { id: 'file-protocol-spec-node', kind: 'document', documentUri: 'patchouli://preview/file-protocol-spec' },
        ],
      },
    ],
  },
]

export const logDocumentUris = [
  'patchouli://preview/log-retrieve-cordis',
  'patchouli://preview/log-proposal-routing',
] as const
export const timelineDocumentUris = [
  'patchouli://preview/timeline-ui-view',
  'patchouli://preview/timeline-handshake',
] as const
export const initialOpenDocumentUris = [
  'patchouli://preview/ui-framework',
  'patchouli://preview/json-rpc',
] as const
