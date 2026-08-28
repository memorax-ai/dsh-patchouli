import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import {
  Button,
  IconArchiveOutline20,
  IconCloseOutline16,
  IconDataOutline16,
  IconFolderOpenOutline16,
  IconGlobeOutline14,
  IconSettingsOutline14,
  IconSparkle16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsLocale, PropsRenderSlots, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import {
  SurfaceHost,
  type DocumentRef,
  type UiSurfaceConnection,
} from './ui-container/index.js'
import {
  DocumentSurface,
  ExplorerPaneStack,
  Sash,
  TabbedEditor,
  type DocumentActionRegistry,
  type EditorTabDefinition,
  type ExplorerPaneLayout,
  type ExplorerPaneRegistry,
  type RenderDocument,
} from './ui-workspace/index.js'
import { NS } from './locales.js'
import { EditModeSwitch } from './EditModeSwitch.js'
import { confirmEditMode, hasEditModeConsent } from './edit-mode-consent.js'
import { DocumentIcon, type ExplorerPaneContext } from './PreviewExplorerPanes.js'
import { KnowledgeSearch } from './KnowledgeSearch.js'
import { initialOpenDocumentUris } from './preview-data.js'
import { useFilterDefinitions, type FilterRegistry, type FilterValue } from './filters.js'
import {
  DEFAULT_EXPLORER_WIDTH,
  DEFAULT_AGENT_WIDTH,
  type KnowledgeScope,
  type SessionLayout,
  useSessionLayout,
} from './session-layout.js'
import { usePatchouliThemeStyle, type PatchouliMode } from './theme.js'
import { useAnchoredPopover } from './useAnchoredPopover.js'

type KnowledgeViewProps = ConvViewProps & PropsLocale<typeof NS>
  & PropsRenderSlots<'patchouli.document.renderer' | 'patchouli.agent.surface'>
  & {
    documents: UiSurfaceConnection
    explorerPanes: ExplorerPaneRegistry<ExplorerPaneContext>
    documentActions: DocumentActionRegistry
    filters: FilterRegistry
  }
type T = TranslateNS<typeof NS>

const EXPLORER_MIN = 190
const EDITOR_MIN = 240
const AGENT_MIN = 300

type MainPaneWidths = {
  explorer: number
  editor: number
  agent: number
}

function resizeExplorerPanes(
  start: MainPaneWidths,
  delta: number,
  agentOpen: boolean,
): Pick<MainPaneWidths, 'explorer' | 'agent'> {
  if (delta <= 0) {
    return {
      explorer: Math.max(EXPLORER_MIN, start.explorer + delta),
      agent: start.agent,
    }
  }

  const editorShrink = Math.min(delta, Math.max(0, start.editor - EDITOR_MIN))
  const afterEditor = delta - editorShrink
  const agentShrink = agentOpen
    ? Math.min(afterEditor, Math.max(0, start.agent - AGENT_MIN))
    : 0
  const applied = editorShrink + agentShrink
  return {
    explorer: start.explorer + applied,
    agent: start.agent - agentShrink,
  }
}

function resizeAgentPanes(
  start: MainPaneWidths,
  delta: number,
): Pick<MainPaneWidths, 'explorer' | 'agent'> {
  if (delta >= 0) {
    return {
      explorer: start.explorer,
      agent: Math.max(AGENT_MIN, start.agent - delta),
    }
  }

  const requested = -delta
  const editorShrink = Math.min(requested, Math.max(0, start.editor - EDITOR_MIN))
  const afterEditor = requested - editorShrink
  const explorerShrink = Math.min(afterEditor, Math.max(0, start.explorer - EXPLORER_MIN))
  const applied = editorShrink + explorerShrink
  return {
    explorer: start.explorer - explorerShrink,
    agent: start.agent + applied,
  }
}

function ScopeSwitch({ scope, sessionId, onChange, t }: {
  scope: KnowledgeScope
  sessionId: string
  onChange: (scope: KnowledgeScope) => void
  t: T
}) {
  const options = [
    {
      id: 'session',
      label: t('scope.session'),
      hint: t('scope.sessionHint'),
      icon: <IconDataOutline16 size={14} />,
      suffix: <span className="patchouli-session-id">{sessionId}</span>,
    },
    {
      id: 'workspace',
      label: t('scope.workspace'),
      hint: t('scope.workspaceHint'),
      icon: <IconFolderOpenOutline16 size={14} />,
    },
    {
      id: 'global',
      label: t('scope.global'),
      hint: t('scope.globalHint'),
      icon: <IconGlobeOutline14 size={14} />,
    },
  ] satisfies Array<{
    id: KnowledgeScope
    label: string
    hint: string
    icon: ReactNode
    suffix?: ReactNode
  }>

  return (
    <div className="patchouli-scope" role="group" aria-label={t('scope.aria')}>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          className="patchouli-scope-button"
          data-active={scope === option.id}
          aria-pressed={scope === option.id}
          title={option.hint}
          onClick={() => onChange(option.id)}
        >
          {option.icon}
          <span>{option.label}</span>
          {option.suffix}
        </button>
      ))}
    </div>
  )
}

function CustomFilterTrigger({ open, effective, buttonRef, onClick, t }: {
  open: boolean
  effective: boolean
  buttonRef: RefObject<HTMLButtonElement>
  onClick: () => void
  t: T
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      className="patchouli-custom-scope-button"
      data-open={open}
      data-effective={effective}
      aria-label={t('scope.custom')}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls="patchouli-custom-filter"
      aria-describedby="patchouli-custom-filter-status"
      title={t('scope.customHint')}
      onClick={onClick}
    >
      <IconSettingsOutline14 size={14} />
      <span>{t('scope.custom')}</span>
      {effective && <span className="patchouli-custom-scope-status">{t('filter.status.effective')}</span>}
      <span id="patchouli-custom-filter-status" className="patchouli-visually-hidden">
        {t(effective ? 'filter.status.effective' : 'filter.status.inactive')}
      </span>
    </button>
  )
}

function Explorer({
  openDocuments,
  activeDocumentUri,
  documents,
  registry,
  paneLayout,
  treeExpanded,
  onActivate,
  onPreview,
  onPin,
  onPaneLayoutChange,
  onTreeNodeExpandedChange,
  t,
}: {
  openDocuments: readonly DocumentRef[]
  activeDocumentUri: string
  documents: UiSurfaceConnection
  registry: ExplorerPaneRegistry<ExplorerPaneContext>
  paneLayout: ExplorerPaneLayout
  treeExpanded: Readonly<Record<string, boolean>>
  onActivate: (document: DocumentRef) => void
  onPreview: (document: DocumentRef) => void
  onPin: (document: DocumentRef) => void
  onPaneLayoutChange: (layout: ExplorerPaneLayout) => void
  onTreeNodeExpandedChange: (nodeId: string, expanded: boolean) => void
  t: T
}) {
  return (
    <aside className="patchouli-explorer" aria-label={t('explorer.title')}>
      <div className="patchouli-explorer-title">{t('explorer.title')}</div>
      <ExplorerPaneStack
        registry={registry}
        context={{
          openDocuments,
          activeDocumentUri,
          describeDocument: (document) => documents.describe(document),
          activateDocument: onActivate,
          previewDocument: onPreview,
          pinDocument: onPin,
          treeExpanded,
          setTreeNodeExpanded: onTreeNodeExpandedChange,
          t,
        }}
        initialLayout={paneLayout}
        resizeLabel={(before, after) => t('explorer.resizePanes', {
          before: String(before ?? ''),
          after: String(after ?? ''),
        })}
        onLayoutChange={onPaneLayoutChange}
      />
    </aside>
  )
}

function Editor({
  openDocuments,
  activeDocumentUri,
  previewDocumentUri,
  scope,
  mode,
  documents,
  actions,
  renderDocument,
  openAgent,
  onActivate,
  onPin,
  onClose,
  t,
}: {
  openDocuments: readonly DocumentRef[]
  activeDocumentUri: string
  previewDocumentUri?: string
  scope: KnowledgeScope
  mode: PatchouliMode
  documents: UiSurfaceConnection
  actions: DocumentActionRegistry
  renderDocument: RenderDocument
  openAgent: () => void
  onActivate: (document: DocumentRef) => void
  onPin: (document: DocumentRef) => void
  onClose: (uri: string) => void
  t: T
}) {
  useSyncExternalStore(documents.subscribe, documents.getSnapshot, documents.getSnapshot)
  const tabs = openDocuments.map<EditorTabDefinition>((reference) => {
    const document = documents.describe(reference)
    return {
      id: document.uri,
      title: document.title ?? document.uri,
      icon: <DocumentIcon document={document} />,
      document,
      preview: reference.uri === previewDocumentUri,
    }
  })

  const empty = (
    <div className="patchouli-editor-empty" role="status">
      <div className="patchouli-editor-empty-mark"><IconArchiveOutline20 /></div>
      <p>{t('editor.empty')}</p>
      <span>{t('editor.emptyHint')}</span>
    </div>
  )

  return (
    <TabbedEditor
      tabs={tabs}
      activeTabId={activeDocumentUri}
      tabsLabel={t('editor.tabs')}
      closeTabLabel={t('editor.closeTab')}
      empty={empty}
      renderDocument={(reference) => (
        <DocumentSurface
          key={reference.uri}
          reference={reference}
          mode={mode}
          context={{ scope }}
          actions={actions}
          renderDocument={renderDocument}
          openAgent={openAgent}
          labels={{
            loading: t('document.loading'),
            unavailable: t('document.unavailable'),
            unsupported: t('document.unsupported'),
          }}
        />
      )}
      onActivate={(uri) => {
        const document = openDocuments.find((entry) => entry.uri === uri)
        if (document) onActivate(document)
      }}
      onClose={onClose}
      onPin={(uri) => {
        const document = openDocuments.find((entry) => entry.uri === uri)
        if (document) onPin(document)
      }}
    />
  )
}

function ResizableEditorLayout({
  openDocuments,
  activeDocumentUri,
  previewDocumentUri,
  scope,
  mode,
  documents,
  explorerPanes,
  actions,
  renderDocument,
  openAgent,
  initialExplorerWidth,
  initialAgentWidth,
  agent,
  paneLayout,
  treeExpanded,
  onActivate,
  onPreview,
  onPin,
  onClose,
  onExplorerWidthChange,
  onAgentWidthChange,
  onPaneLayoutChange,
  onTreeNodeExpandedChange,
  t,
}: {
  openDocuments: readonly DocumentRef[]
  activeDocumentUri: string
  previewDocumentUri?: string
  scope: KnowledgeScope
  mode: PatchouliMode
  documents: UiSurfaceConnection
  explorerPanes: ExplorerPaneRegistry<ExplorerPaneContext>
  actions: DocumentActionRegistry
  renderDocument: RenderDocument
  openAgent: () => void
  initialExplorerWidth: number
  initialAgentWidth: number
  agent?: ReactNode
  paneLayout: ExplorerPaneLayout
  treeExpanded: Readonly<Record<string, boolean>>
  onActivate: (document: DocumentRef) => void
  onPreview: (document: DocumentRef) => void
  onPin: (document: DocumentRef) => void
  onClose: (uri: string) => void
  onExplorerWidthChange: (width: number) => void
  onAgentWidthChange: (width: number) => void
  onPaneLayoutChange: (layout: ExplorerPaneLayout) => void
  onTreeNodeExpandedChange: (nodeId: string, expanded: boolean) => void
  t: T
}) {
  const shellRef = useRef<HTMLDivElement>(null)
  const dragStart = useRef<MainPaneWidths>({
    explorer: initialExplorerWidth,
    editor: EDITOR_MIN,
    agent: initialAgentWidth,
  })
  const explorerWidthRef = useRef(initialExplorerWidth)
  const agentWidthRef = useRef(initialAgentWidth)
  const [explorerWidth, setExplorerWidth] = useState(initialExplorerWidth)
  const [agentWidth, setAgentWidth] = useState(initialAgentWidth)
  const [availableWidth, setAvailableWidth] = useState(0)
  const [resizing, setResizing] = useState<'explorer' | 'agent' | null>(null)
  explorerWidthRef.current = explorerWidth
  agentWidthRef.current = agentWidth

  const agentOpen = agent !== undefined
  const explorerMax = Math.max(
    EXPLORER_MIN,
    availableWidth - EDITOR_MIN - (agentOpen ? AGENT_MIN : 0),
  )
  const agentMax = Math.max(AGENT_MIN, availableWidth - EDITOR_MIN - EXPLORER_MIN)

  const readPaneWidths = (): MainPaneWidths => {
    const editorElement = shellRef.current?.querySelector<HTMLElement>(
      ':scope > [data-ui-surface-id="editor"]',
    )
    return {
      explorer: explorerWidthRef.current,
      editor: editorElement?.getBoundingClientRect().width
        ?? Math.max(EDITOR_MIN, availableWidth - explorerWidthRef.current - (agentOpen ? agentWidthRef.current : 0)),
      agent: agentWidthRef.current,
    }
  }

  const applyPaneWidths = (widths: Pick<MainPaneWidths, 'explorer' | 'agent'>) => {
    explorerWidthRef.current = widths.explorer
    agentWidthRef.current = widths.agent
    setExplorerWidth(widths.explorer)
    setAgentWidth(widths.agent)
  }

  const persistPaneWidths = () => {
    onExplorerWidthChange(explorerWidthRef.current)
    if (agentOpen) onAgentWidthChange(agentWidthRef.current)
  }

  useLayoutEffect(() => {
    const shell = shellRef.current
    if (!shell) return

    const updateBounds = () => {
      const sashWidth = [...shell.querySelectorAll<HTMLElement>(':scope > .patchouli-resizer')]
        .reduce((total, sash) => total + sash.getBoundingClientRect().width, 0)
      setAvailableWidth(Math.max(0, shell.getBoundingClientRect().width - sashWidth))
    }
    const observer = new ResizeObserver(updateBounds)
    observer.observe(shell)
    updateBounds()
    return () => observer.disconnect()
  }, [agentOpen])

  useLayoutEffect(() => {
    if (availableWidth <= 0) return
    let nextExplorer = Math.max(EXPLORER_MIN, explorerWidthRef.current)
    let nextAgent = Math.max(AGENT_MIN, agentWidthRef.current)
    let overflow = nextExplorer + (agentOpen ? nextAgent : 0) + EDITOR_MIN - availableWidth
    if (agentOpen && overflow > 0) {
      const shrink = Math.min(overflow, nextAgent - AGENT_MIN)
      nextAgent -= shrink
      overflow -= shrink
    }
    if (overflow > 0) nextExplorer -= Math.min(overflow, nextExplorer - EXPLORER_MIN)
    if (nextExplorer !== explorerWidthRef.current || nextAgent !== agentWidthRef.current) {
      applyPaneWidths({ explorer: nextExplorer, agent: nextAgent })
    }
  }, [agentOpen, availableWidth])

  return (
    <div ref={shellRef} className="patchouli-editor-shell" data-resizing={resizing ?? undefined}>
      <SurfaceHost
        id="explorer"
        className="patchouli-explorer-seat"
        style={{ width: explorerWidth, minWidth: EXPLORER_MIN }}
      >
        <Explorer
          openDocuments={openDocuments}
          activeDocumentUri={activeDocumentUri}
          documents={documents}
          registry={explorerPanes}
          paneLayout={paneLayout}
          treeExpanded={treeExpanded}
          onActivate={onActivate}
          onPreview={onPreview}
          onPin={onPin}
          onPaneLayoutChange={onPaneLayoutChange}
          onTreeNodeExpandedChange={onTreeNodeExpandedChange}
          t={t}
        />
      </SurfaceHost>
      <Sash
        className="patchouli-resizer"
        orientation="vertical"
        label={t('editor.resizeExplorer')}
        value={explorerWidth}
        minimum={EXPLORER_MIN}
        maximum={explorerMax}
        onResizeStart={() => {
          dragStart.current = readPaneWidths()
          setResizing('explorer')
        }}
        onResize={(delta) => {
          applyPaneWidths(resizeExplorerPanes(dragStart.current, delta, agentOpen))
        }}
        onResizeEnd={() => {
          setResizing(null)
          persistPaneWidths()
        }}
        onReset={() => {
          const start = readPaneWidths()
          const widths = resizeExplorerPanes(start, DEFAULT_EXPLORER_WIDTH - start.explorer, agentOpen)
          applyPaneWidths(widths)
          onExplorerWidthChange(widths.explorer)
          if (agentOpen) onAgentWidthChange(widths.agent)
        }}
      />
      <SurfaceHost id="editor" style={{ width: 'auto', minWidth: EDITOR_MIN, flex: 1 }}>
        <Editor
          openDocuments={openDocuments}
          activeDocumentUri={activeDocumentUri}
          previewDocumentUri={previewDocumentUri}
          scope={scope}
          mode={mode}
          documents={documents}
          actions={actions}
          renderDocument={renderDocument}
          openAgent={openAgent}
          onActivate={onActivate}
          onPin={onPin}
          onClose={onClose}
          t={t}
        />
      </SurfaceHost>
      {agent && (
        <>
          <Sash
            className="patchouli-resizer patchouli-agent-resizer"
            orientation="vertical"
            label={t('editor.resizeAgent')}
            value={Math.max(0, availableWidth - agentWidth)}
            minimum={Math.max(0, availableWidth - agentMax)}
            maximum={Math.max(0, availableWidth - AGENT_MIN)}
            onResizeStart={() => {
              dragStart.current = readPaneWidths()
              setResizing('agent')
            }}
            onResize={(delta) => {
              applyPaneWidths(resizeAgentPanes(dragStart.current, delta))
            }}
            onResizeEnd={() => {
              setResizing(null)
              persistPaneWidths()
            }}
            onReset={() => {
              const start = readPaneWidths()
              const widths = resizeAgentPanes(start, start.agent - DEFAULT_AGENT_WIDTH)
              applyPaneWidths(widths)
              onExplorerWidthChange(widths.explorer)
              onAgentWidthChange(widths.agent)
            }}
          />
          <SurfaceHost
            id="agent"
            className="patchouli-agent-seat"
            style={{ width: agentWidth, minWidth: AGENT_MIN }}
          >
            {agent}
          </SurfaceHost>
        </>
      )}
    </div>
  )
}

function PanelHeader({ title, subtitle, closeLabel, onClose }: {
  title: string
  subtitle?: string
  closeLabel: string
  onClose: () => void
}) {
  return (
    <header className="patchouli-panel-header">
      <div className="patchouli-panel-heading">
        <h3 className="patchouli-panel-title">{title}</h3>
        {subtitle && <div className="patchouli-panel-subtitle">{subtitle}</div>}
      </div>
      <button type="button" className="patchouli-icon-button" aria-label={closeLabel} onClick={onClose}>
        <IconCloseOutline16 />
      </button>
    </header>
  )
}

function CustomFilterPopover({
  anchorRef,
  sessionId,
  scope,
  definitions,
  values,
  onChange,
  onClose,
  t,
}: {
  anchorRef: RefObject<HTMLButtonElement>
  sessionId: string
  scope: KnowledgeScope
  definitions: ReturnType<FilterRegistry['list']>
  values: Readonly<Record<string, FilterValue>>
  onChange: (id: string, value: FilterValue | undefined) => void
  onClose: () => void
  t: T
}) {
  const popoverRef = useRef<HTMLElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const position = useAnchoredPopover(anchorRef, popoverRef, 'end')

  const close = () => {
    onClose()
    requestAnimationFrame(() => anchorRef.current?.focus())
  }

  useLayoutEffect(() => {
    if (position.visibility === 'hidden') return
    closeButtonRef.current?.focus()
  }, [position.visibility])

  return (
    <section
      id="patchouli-custom-filter"
      ref={popoverRef}
      className="patchouli-custom-filter"
      role="dialog"
      aria-label={t('filter.customPanelTitle')}
      style={position}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        event.stopPropagation()
        close()
      }}
    >
      <header className="patchouli-custom-filter-header">
        <h3 className="patchouli-custom-filter-title">{t('filter.customPanelTitle')}</h3>
        <button
          ref={closeButtonRef}
          type="button"
          className="patchouli-icon-button"
          aria-label={t('action.closeFilters')}
          onClick={close}
        >
          <IconCloseOutline16 />
        </button>
      </header>
      <div className="patchouli-custom-filter-body">
        {definitions.length > 0
          ? definitions.map((definition) => (
              <div key={definition.id} className="patchouli-filter-contribution">
                {definition.render({
                  sessionId,
                  scope,
                  value: values[definition.id],
                  onChange: (value) => onChange(definition.id, value),
                })}
              </div>
            ))
          : <div className="patchouli-filter-empty">{t('filter.empty')}</div>}
      </div>
    </section>
  )
}

function AgentPanel({ children, onClose, t }: {
  children: ReactNode
  onClose: () => void
  t: T
}) {
  return (
    <aside className="patchouli-panel" aria-label={t('agent.title')}>
      <PanelHeader
        title={t('agent.title')}
        subtitle={t('agent.subtitle')}
        closeLabel={t('action.closeAgent')}
        onClose={onClose}
      />
      {children}
    </aside>
  )
}

function SessionKnowledgeView({
  sessionId,
  t,
  documents,
  explorerPanes,
  documentActions,
  filters,
  renderSlot,
  renderSlotChain,
}: KnowledgeViewProps) {
  const sessionKey = String(sessionId)
  const initialDocuments = initialOpenDocumentUris.map((uri) => documents.describe({ uri }))
  const [layout, setLayout] = useSessionLayout(sessionKey, initialDocuments)
  const editMode = layout.editMode && hasEditModeConsent()
  const mode: PatchouliMode = editMode ? 'edit' : 'browse'
  const themeStyle = usePatchouliThemeStyle(mode)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [editConfirmationOpen, setEditConfirmationOpen] = useState(false)
  const customButtonRef = useRef<HTMLButtonElement>(null)
  const filterDefinitions = useFilterDefinitions(filters)
  const filtersEffective = filterDefinitions.some((definition) =>
    definition.isActive(layout.filterValues[definition.id]),
  )

  const patchLayout = useCallback((patch: Partial<SessionLayout>) => {
    setLayout((current) => ({ ...current, ...patch }))
  }, [setLayout])

  const setPaneLayout = useCallback((explorerPanes: ExplorerPaneLayout) => {
    patchLayout({ explorerPanes })
  }, [patchLayout])

  const setExplorerWidth = useCallback((explorerWidth: number) => {
    patchLayout({ explorerWidth })
  }, [patchLayout])

  const setAgentWidth = useCallback((agentWidth: number) => {
    patchLayout({ agentWidth })
  }, [patchLayout])

  const setTreeNodeExpanded = useCallback((nodeId: string, expanded: boolean) => {
    setLayout((current) => ({
      ...current,
      treeExpanded: { ...current.treeExpanded, [nodeId]: expanded },
    }))
  }, [setLayout])

  const activateDocument = useCallback((document: DocumentRef) => {
    setLayout((current) => current.activeDocumentUri === document.uri
      ? current
      : { ...current, activeDocumentUri: document.uri })
  }, [setLayout])

  const previewDocument = useCallback((document: DocumentRef) => {
    setLayout((current) => ({
      ...current,
      openDocuments: current.openDocuments.some((entry) => entry.uri === document.uri)
        ? current.openDocuments
        : current.previewDocumentUri
          ? current.openDocuments.map((entry) => entry.uri === current.previewDocumentUri ? document : entry)
          : [...current.openDocuments, document],
      activeDocumentUri: document.uri,
      previewDocumentUri: current.openDocuments.some((entry) => entry.uri === document.uri)
        ? current.previewDocumentUri
        : document.uri,
    }))
  }, [setLayout])

  const pinDocument = useCallback((document: DocumentRef) => {
    setLayout((current) => ({
      ...current,
      openDocuments: current.openDocuments.some((entry) => entry.uri === document.uri)
        ? current.openDocuments.map((entry) => entry.uri === document.uri ? document : entry)
        : [...current.openDocuments, document],
      activeDocumentUri: document.uri,
      previewDocumentUri: current.previewDocumentUri === document.uri
        ? undefined
        : current.previewDocumentUri,
    }))
  }, [setLayout])

  const closeDocument = useCallback((uri: string) => {
    setLayout((current) => {
      const index = current.openDocuments.findIndex((document) => document.uri === uri)
      const openDocuments = current.openDocuments.filter((document) => document.uri !== uri)
      return {
        ...current,
        openDocuments,
        previewDocumentUri: current.previewDocumentUri === uri ? undefined : current.previewDocumentUri,
        activeDocumentUri: current.activeDocumentUri === uri
          ? openDocuments[Math.min(index, openDocuments.length - 1)]?.uri ?? ''
          : current.activeDocumentUri,
      }
    })
  }, [setLayout])

  useEffect(() => documents.registerSessionHost(sessionKey, {
    open: pinDocument,
    reveal: previewDocument,
    close: closeDocument,
  }), [closeDocument, documents, pinDocument, previewDocument, sessionKey])

  const renderDocument = useCallback<RenderDocument>((request, fallback) =>
    renderSlotChain('patchouli.document.renderer', request, { fallback }),
  [renderSlotChain])

  const setFilterValue = (id: string, value: FilterValue | undefined) => {
    setLayout((current) => {
      const filterValues = { ...current.filterValues }
      if (value === undefined) delete filterValues[id]
      else filterValues[id] = value
      return { ...current, filterValues }
    })
  }

  const activeDocument = layout.openDocuments.find((document) =>
    document.uri === layout.activeDocumentUri,
  )

  return (
    <SurfaceHost
      surface={documents}
      sessionId={sessionKey}
      style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}
    >
      <div className="patchouli-root" data-mode={mode} style={themeStyle}>
      <header className="patchouli-toolbar">
        <div className="patchouli-scope-controls">
          <ScopeSwitch
            scope={layout.scope}
            sessionId={sessionKey}
            onChange={(scope) => patchLayout({ scope })}
            t={t}
          />
          <CustomFilterTrigger
            open={filtersOpen}
            effective={filtersEffective}
            buttonRef={customButtonRef}
            onClick={() => setFiltersOpen(true)}
            t={t}
          />
          <KnowledgeSearch
            history={layout.searchHistory}
            onHistoryChange={(searchHistory) => patchLayout({ searchHistory })}
            t={t}
          />
        </div>
        <div className="patchouli-toolbar-spacer" />
        <span className="patchouli-preview-note">{t('preview.label')}</span>
        <EditModeSwitch
          enabled={editMode}
          confirmationOpen={editConfirmationOpen}
          onToggle={() => {
            if (editMode) {
              patchLayout({ editMode: false })
            } else if (hasEditModeConsent()) {
              patchLayout({ editMode: true })
            } else {
              setEditConfirmationOpen(true)
            }
          }}
          onCancel={() => setEditConfirmationOpen(false)}
          onConfirm={() => {
            confirmEditMode()
            patchLayout({ editMode: true })
            setEditConfirmationOpen(false)
          }}
          t={t}
        />
        <Button
          className="patchouli-agent-toggle"
          size="sm"
          variant={layout.agentOpen ? 'outline' : 'ghost'}
          icon={<IconSparkle16 size={14} />}
          onClick={() => patchLayout({ agentOpen: !layout.agentOpen })}
        >
          {t('action.agent')}
        </Button>
      </header>
      {filtersOpen && (
        <CustomFilterPopover
          anchorRef={customButtonRef}
          sessionId={sessionKey}
          scope={layout.scope}
          definitions={filterDefinitions}
          values={layout.filterValues}
          onChange={setFilterValue}
          onClose={() => setFiltersOpen(false)}
          t={t}
        />
      )}
      <SurfaceHost id="workspace" className="patchouli-workspace" style={{ height: 'auto' }}>
        <ResizableEditorLayout
          openDocuments={layout.openDocuments}
          activeDocumentUri={layout.activeDocumentUri}
          previewDocumentUri={layout.previewDocumentUri}
          scope={layout.scope}
          mode={mode}
          documents={documents}
          explorerPanes={explorerPanes}
          actions={documentActions}
          renderDocument={renderDocument}
          openAgent={() => patchLayout({ agentOpen: true })}
          initialExplorerWidth={layout.explorerWidth}
          initialAgentWidth={layout.agentWidth}
          agent={layout.agentOpen ? (
            <AgentPanel onClose={() => patchLayout({ agentOpen: false })} t={t}>
              {renderSlot('patchouli.agent.surface', {
                scope: layout.scope,
                mode,
                activeDocument,
              }, {
                fallback: <div className="patchouli-panel-body">{t('agent.empty')}</div>,
              })}
            </AgentPanel>
          ) : undefined}
          paneLayout={layout.explorerPanes}
          treeExpanded={layout.treeExpanded}
          onActivate={activateDocument}
          onPreview={previewDocument}
          onPin={pinDocument}
          onClose={closeDocument}
          onExplorerWidthChange={setExplorerWidth}
          onAgentWidthChange={setAgentWidth}
          onPaneLayoutChange={setPaneLayout}
          onTreeNodeExpandedChange={setTreeNodeExpanded}
          t={t}
        />
      </SurfaceHost>
      </div>
    </SurfaceHost>
  )
}

export function KnowledgeView(props: KnowledgeViewProps) {
  return <SessionKnowledgeView key={String(props.sessionId)} {...props} />
}
