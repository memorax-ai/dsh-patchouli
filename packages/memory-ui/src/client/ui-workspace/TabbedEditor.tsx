import { useId, useLayoutEffect, useRef, type ReactNode } from 'react'
import { IconCloseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DocumentRef } from '../ui-container/index.js'

export type EditorTabDefinition = {
  id: string
  title: string
  icon?: ReactNode
  document: DocumentRef
  preview?: boolean
}

export type TabbedEditorProps = {
  tabs: readonly EditorTabDefinition[]
  activeTabId: string
  tabsLabel: string
  closeTabLabel: string
  empty: ReactNode
  renderDocument: (document: DocumentRef) => ReactNode
  onActivate: (tabId: string) => void
  onClose: (tabId: string) => void
  onPin?: (tabId: string) => void
}

export function TabbedEditor({
  tabs,
  activeTabId,
  tabsLabel,
  closeTabLabel,
  empty,
  renderDocument,
  onActivate,
  onClose,
  onPin,
}: TabbedEditorProps) {
  const activeTab = tabs.find((tab) => tab.id === activeTabId)
  const instanceId = useId()
  const panelId = `${instanceId}-panel`
  const tabElementId = (tabId: string) => `${instanceId}-tab-${encodeURIComponent(tabId)}`
  const tabRefs = useRef(new Map<string, HTMLButtonElement>())
  const focusAfterClose = useRef<string | undefined>(undefined)

  useLayoutEffect(() => {
    const activeElement = tabRefs.current.get(activeTabId)
    activeElement?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    const focusId = focusAfterClose.current
    if (focusId && tabs.some((tab) => tab.id === focusId)) {
      focusAfterClose.current = undefined
      tabRefs.current.get(focusId)?.focus()
    }
  }, [activeTabId, tabs.length])

  const closeTab = (tabId: string) => {
    const index = tabs.findIndex((tab) => tab.id === tabId)
    focusAfterClose.current = tabs[index + 1]?.id ?? tabs[index - 1]?.id
    onClose(tabId)
  }

  const moveFocus = (currentIndex: number, key: string) => {
    let index = currentIndex
    if (key === 'ArrowLeft' || key === 'ArrowUp') index -= 1
    else if (key === 'ArrowRight' || key === 'ArrowDown') index += 1
    else if (key === 'Home') index = 0
    else if (key === 'End') index = tabs.length - 1
    else return false
    const target = tabs[Math.max(0, Math.min(tabs.length - 1, index))]
    if (target) {
      onActivate(target.id)
      requestAnimationFrame(() => tabRefs.current.get(target.id)?.focus())
    }
    return true
  }

  return (
    <main className="dsh-workspace-editor">
      {tabs.length > 0 && (
        <div className="dsh-workspace-editor-tabs" role="tablist" aria-label={tabsLabel}>
          {tabs.map((tab, index) => {
            const active = tab.id === activeTabId
            return (
              <div
                key={tab.id}
                className="dsh-workspace-editor-tab"
                data-active={active}
                data-preview={tab.preview}
              >
                <button
                  ref={(element) => {
                    if (element) tabRefs.current.set(tab.id, element)
                    else tabRefs.current.delete(tab.id)
                  }}
                  type="button"
                  className="dsh-workspace-editor-tab-label"
                  role="tab"
                  id={tabElementId(tab.id)}
                  aria-selected={active}
                  aria-controls={panelId}
                  tabIndex={active ? 0 : -1}
                  title={tab.title}
                  onClick={() => onActivate(tab.id)}
                  onDoubleClick={() => onPin?.(tab.id)}
                  onAuxClick={(event) => {
                    if (event.button === 1) {
                      event.preventDefault()
                      closeTab(tab.id)
                    }
                  }}
                  onKeyDown={(event) => {
                    if (moveFocus(index, event.key)) event.preventDefault()
                    else if (event.key === 'Delete') {
                      event.preventDefault()
                      closeTab(tab.id)
                    }
                  }}
                >
                  {tab.icon}
                  <span>{tab.title}</span>
                </button>
                <button
                  type="button"
                  className="dsh-workspace-tab-close"
                  aria-label={`${closeTabLabel} ${tab.title}`}
                  onClick={() => closeTab(tab.id)}
                >
                  <IconCloseOutline16 size={14} />
                </button>
              </div>
            )
          })}
        </div>
      )}
      <div
        id={panelId}
        className="dsh-workspace-editor-body"
        role="tabpanel"
        aria-labelledby={activeTab ? tabElementId(activeTab.id) : undefined}
      >
        {activeTab ? renderDocument(activeTab.document) : empty}
      </div>
    </main>
  )
}
