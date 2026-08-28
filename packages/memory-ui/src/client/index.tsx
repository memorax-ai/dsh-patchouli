import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import {
  DocumentActionRegistry,
  ExplorerPaneRegistry,
} from './ui-workspace/index.js'
import { installUiContainer } from './ui-container/index.js'
import { EmptyAgentSurface } from './AgentSurface.js'
import { registerBuiltinDocumentRenderers } from './BuiltinRenderers.js'
import type { MemoryUiContributions } from './client-services.js'
import './client-services.js'
import './document-slots.js'
import { FilterRegistry } from './filters.js'
import { KnowledgeView } from './KnowledgeView.js'
import { en, NS, zh } from './locales.js'
import {
  registerPreviewExplorerPanes,
  type ExplorerPaneContext,
} from './PreviewExplorerPanes.js'
import {
  previewDocumentByUri,
  previewDocumentRef,
  previewDocumentSnapshot,
} from './preview-data.js'
import { installStyles } from './styles.js'

export const name = 'dsh-patchouli-memory-ui'
export const inject = ['slots', 'locale'] as const

export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  const uiContainer = installUiContainer(ctx)
  const { surface, disconnect } = uiContainer.connectSurface({ id: 'patchouli.memory' })
  const contributions: MemoryUiContributions = {
    explorerPanes: new ExplorerPaneRegistry<ExplorerPaneContext>(),
    documentActions: new DocumentActionRegistry(),
    filters: new FilterRegistry(),
  }

  ctx.provide('patchouliMemoryUi', contributions)
  ctx.effect(() => disconnect, 'patchouli: disconnect UI surface')
  ctx.effect(installStyles, 'patchouli: styles')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'patchouli: dictionaries')
  ctx.effect(() => uiContainer.documents.registerProvider({
    scheme: 'patchouli',
    describe: (uri) => {
      const document = previewDocumentByUri.get(uri)
      return document ? previewDocumentRef(document, t) : undefined
    },
    resolve: (uri) => {
      const document = previewDocumentByUri.get(uri)
      if (!document) throw new Error(`Patchouli document not found: ${uri}`)
      return previewDocumentSnapshot(document, t)
    },
  }), 'patchouli: preview document provider')
  ctx.effect(
    () => registerPreviewExplorerPanes(contributions.explorerPanes),
    'patchouli: explorer panes',
  )
  registerBuiltinDocumentRenderers(ctx)
  ctx.slots.inject('patchouli.agent.surface', () => ctx.slots.register({
    name: 'patchouli.agent.surface',
    priority: 1000,
    locale: NS,
  }, EmptyAgentSurface))

  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'knowledge',
    order: 20,
    locale: NS,
    label: () => t('view.knowledge'),
    children: {
      'patchouli.document.renderer': { kind: 'chain', scope: 'session' },
      'patchouli.agent.surface': { kind: 'single', scope: 'session' },
    },
    inject: () => ({
      documents: surface,
      explorerPanes: contributions.explorerPanes,
      documentActions: contributions.documentActions,
      filters: contributions.filters,
    }),
  }, KnowledgeView))
}

export * from './client-services.js'
export * from './document-slots.js'
export * from './filters.js'
export * from './PreviewExplorerPanes.js'
export * from './theme.js'
