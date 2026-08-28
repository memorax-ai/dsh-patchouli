import {
  IconCodeOutline16,
  IconDataOutline16,
  IconFolderClose16,
  IconFolderOpenOutline16,
  IconLinkOutline16,
  IconListPenOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { DocumentRef } from './ui-container/index.js'
import { ExplorerPaneRegistry, TreeView } from './ui-workspace/index.js'
import type { PatchouliTranslate } from './locales.js'
import {
  documentTitle,
  fileTree,
  knowledgeTree,
  logDocumentUris,
  previewDocumentByUri,
  previewDocumentRef,
  relationTree,
  timelineDocumentUris,
  type PreviewTreeNode,
} from './preview-data.js'

export type ExplorerPaneContext = {
  openDocuments: readonly DocumentRef[]
  activeDocumentUri: string
  describeDocument: (document: DocumentRef) => DocumentRef
  activateDocument: (document: DocumentRef) => void
  previewDocument: (document: DocumentRef) => void
  pinDocument: (document: DocumentRef) => void
  treeExpanded: Readonly<Record<string, boolean>>
  setTreeNodeExpanded: (nodeId: string, expanded: boolean) => void
  t: PatchouliTranslate
}

export function DocumentIcon({ document }: { document: Pick<DocumentRef, 'kind'> }) {
  if (document.kind === 'relation') return <IconLinkOutline16 size={16} />
  if (document.kind === 'file') return <IconCodeOutline16 size={16} />
  if (document.kind === 'log' || document.kind === 'timeline') return <IconListPenOutline16 size={16} />
  return <IconDataOutline16 size={16} />
}

function DocumentRow({ document, active, onActivate, onOpen }: {
  document: DocumentRef
  active: boolean
  onActivate: (document: DocumentRef) => void
  onOpen: (document: DocumentRef) => void
}) {
  const title = document.title ?? document.uri

  return (
    <button
      type="button"
      className="patchouli-tree-row patchouli-document-row"
      data-active={active}
      title={title}
      onClick={() => onActivate(document)}
      onDoubleClick={() => onOpen(document)}
    >
      <span className="patchouli-tree-spacer" />
      <span className="patchouli-tree-icon"><DocumentIcon document={document} /></span>
      <span className="patchouli-tree-label">{title}</span>
    </button>
  )
}

function PreviewTree({ nodes, context }: {
  nodes: readonly PreviewTreeNode[]
  context: ExplorerPaneContext
}) {
  return (
    <TreeView
      nodes={nodes}
      className="patchouli-tree"
      ariaLabel={context.t('explorer.tree')}
      selectedId={context.activeDocumentUri}
      getId={(node) => node.documentUri ?? node.id}
      getLabel={(node) => node.kind === 'folder'
        ? node.labelKey ? context.t(node.labelKey) : ''
        : node.documentUri
          ? previewDocumentByUri.has(node.documentUri)
            ? documentTitle(previewDocumentByUri.get(node.documentUri)!, context.t)
            : node.documentUri
          : ''}
      getChildren={(node) => node.children}
      isExpanded={(node, depth) => context.treeExpanded[node.id] ?? depth === 0}
      renderIcon={(node, expanded) => node.kind === 'folder'
        ? expanded ? <IconFolderOpenOutline16 size={16} /> : <IconFolderClose16 size={16} />
        : <DocumentIcon document={previewDocumentByUri.get(node.documentUri ?? '') ?? { kind: undefined }} />}
      onExpandedChange={(node, expanded) => context.setTreeNodeExpanded(node.id, expanded)}
      onActivate={(node) => {
        const document = node.documentUri ? previewDocumentByUri.get(node.documentUri) : undefined
        if (document) context.previewDocument(previewDocumentRef(document, context.t))
      }}
      onOpen={(node) => {
        const document = node.documentUri ? previewDocumentByUri.get(node.documentUri) : undefined
        if (document) context.pinDocument(previewDocumentRef(document, context.t))
      }}
    />
  )
}

const treePanes = [
  { id: 'knowledge', order: 20, title: 'explorer.knowledge', nodes: knowledgeTree },
  { id: 'relations', order: 30, title: 'explorer.relations', nodes: relationTree },
  { id: 'files', order: 40, title: 'explorer.files', nodes: fileTree },
] as const

const listPanes = [
  { id: 'logs', order: 50, title: 'explorer.logs', documentUris: logDocumentUris },
  { id: 'timeline', order: 60, title: 'explorer.timeline', documentUris: timelineDocumentUris },
] as const

export function registerPreviewExplorerPanes(
  registry: ExplorerPaneRegistry<ExplorerPaneContext>,
): () => void {
  const disposers = [registry.register({
    id: 'open',
    order: 10,
    defaultExpanded: true,
    title: ({ t }) => t('explorer.openEditors'),
    render: (context) => context.openDocuments.length > 0
      ? context.openDocuments.map((entry) => {
          const document = context.describeDocument(entry)
          return (
            <DocumentRow
              key={document.uri}
              document={document}
              active={document.uri === context.activeDocumentUri}
              onActivate={context.activateDocument}
              onOpen={context.pinDocument}
            />
          )
        })
      : <div className="patchouli-explorer-empty">{context.t('explorer.noOpenEditors')}</div>,
  })]

  for (const pane of treePanes) {
    disposers.push(registry.register({
      id: pane.id,
      order: pane.order,
      defaultExpanded: true,
      title: ({ t }) => t(pane.title),
      render: (context) => <PreviewTree nodes={pane.nodes} context={context} />,
    }))
  }

  for (const pane of listPanes) {
    disposers.push(registry.register({
      id: pane.id,
      order: pane.order,
      defaultExpanded: true,
      title: ({ t }) => t(pane.title),
      render: (context) => pane.documentUris.flatMap((uri) => {
        const preview = previewDocumentByUri.get(uri)
        if (!preview) return []
        const document = previewDocumentRef(preview, context.t)
        return [(
          <DocumentRow
            key={uri}
            document={document}
            active={uri === context.activeDocumentUri}
            onActivate={context.previewDocument}
            onOpen={context.pinDocument}
          />
        )]
      }),
    }))
  }

  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}
