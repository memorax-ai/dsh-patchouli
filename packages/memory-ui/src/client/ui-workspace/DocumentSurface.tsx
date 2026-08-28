import {
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import { Button, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  useDocumentActions,
  type DocumentActionContext,
  type DocumentActionRegistry,
} from './DocumentActions.js'
import type { DocumentRenderRequest } from './document-rendering.js'
import {
  useUiSurface,
  type DocumentRef,
  type DocumentSnapshot,
  type UiSurfaceConnection,
} from '../ui-container/index.js'

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; snapshot: DocumentSnapshot }
  | { status: 'error'; message: string }

export type RenderDocument = (
  request: DocumentRenderRequest,
  fallback: ReactNode,
) => ReactNode

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function DocumentSurface({
  reference,
  mode,
  context,
  actions,
  renderDocument,
  openAgent,
  labels,
}: {
  reference: DocumentRef
  mode?: string
  context: Readonly<Record<string, unknown>>
  actions: DocumentActionRegistry
  renderDocument: RenderDocument
  openAgent: () => void
  labels: {
    loading: string
    unavailable: string
    unsupported: string
  }
}) {
  const { surface, sessionId } = useUiSurface()
  const workspaceVersion = useSyncExternalStore(
    surface.subscribe,
    surface.getSnapshot,
    surface.getSnapshot,
  )
  const [refresh, setRefresh] = useState(0)
  const [load, setLoad] = useState<LoadState>({ status: 'loading' })

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    setLoad((current) => current.status === 'ready' && current.snapshot.uri === reference.uri
      ? current
      : { status: 'loading' })
    void surface.resolve(reference, sessionId, controller.signal).then(
      (snapshot) => {
        if (active) setLoad({ status: 'ready', snapshot })
      },
      (error: unknown) => {
        if (active && !controller.signal.aborted) {
          setLoad({ status: 'error', message: messageOf(error) })
        }
      },
    )
    return () => {
      active = false
      controller.abort()
    }
  }, [reference, refresh, sessionId, surface, workspaceVersion])

  useEffect(() => {
    try {
      return surface.subscribeDocument(reference, sessionId, () => {
        setRefresh((current) => current + 1)
      })
    } catch {
      return
    }
  }, [reference, sessionId, surface, workspaceVersion])

  if (load.status === 'loading') {
    return <div className="dsh-workspace-document-state" role="status">{labels.loading}</div>
  }
  if (load.status === 'error') {
    return (
      <div className="dsh-workspace-document-state" role="alert">
        <strong>{labels.unavailable}</strong>
        <span>{load.message}</span>
      </div>
    )
  }

  return (
    <ReadyDocumentSurface
      document={load.snapshot}
      surfaceId={surface.id}
      sessionId={sessionId}
      mode={mode}
      context={context}
      surface={surface}
      actions={actions}
      renderDocument={renderDocument}
      openAgent={openAgent}
      labels={labels}
    />
  )
}

function ReadyDocumentSurface({
  document,
  surfaceId,
  sessionId,
  mode,
  context,
  surface,
  actions,
  renderDocument,
  openAgent,
  labels,
}: {
  document: DocumentSnapshot
  surfaceId: string
  sessionId: string
  mode?: string
  context: Readonly<Record<string, unknown>>
  surface: UiSurfaceConnection
  actions: DocumentActionRegistry
  renderDocument: RenderDocument
  openAgent: () => void
  labels: {
    unsupported: string
  }
}) {
  const [activePanelId, setActivePanelId] = useState<string | null>(null)

  useEffect(() => setActivePanelId(null), [document.uri])
  const openDocument = (next: DocumentRef) => surface.open(sessionId, next)
  const actionContext: DocumentActionContext = {
    surfaceId,
    sessionId,
    mode,
    context,
    document,
    openDocument,
    openAgent,
  }
  const availableActions = useDocumentActions(actions, actionContext)
  const activeAction = availableActions.find((action) =>
    action.id === activePanelId && action.renderPanel,
  )
  const renderPart = (part: DocumentSnapshot): ReactNode => renderDocument({
    surfaceId,
    sessionId,
    mode,
    context,
    document: part,
    openDocument,
    renderPart,
  }, <div className="dsh-workspace-document-state">{labels.unsupported}</div>)

  return (
    <article className="dsh-workspace-detail">
      <header className="dsh-workspace-detail-header">
        <div className="dsh-workspace-detail-title-row">
          <div className="dsh-workspace-detail-heading">
            <h3 className="dsh-workspace-detail-title">{document.title ?? document.uri}</h3>
            {document.kind && <Pill>{document.kind}</Pill>}
          </div>
          {availableActions.length > 0 && (
            <div className="dsh-workspace-detail-actions">
              {availableActions.map((action) => (
                <Button
                  key={action.id}
                  size="sm"
                  variant={activePanelId === action.id ? 'outline' : 'ghost'}
                  icon={typeof action.icon === 'function' ? action.icon(actionContext) : action.icon}
                  onClick={() => {
                    if (action.renderPanel) {
                      setActivePanelId((current) => current === action.id ? null : action.id)
                    } else {
                      void action.run?.(actionContext)
                    }
                  }}
                >
                  {action.label(actionContext)}
                </Button>
              ))}
            </div>
          )}
        </div>
      </header>
      <div className="dsh-workspace-detail-body">
        {renderPart(document)}
        {activeAction?.renderPanel?.({
          ...actionContext,
          close: () => setActivePanelId(null),
        })}
      </div>
    </article>
  )
}
