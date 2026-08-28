import {
  cloneElement,
  createContext,
  isValidElement,
  useContext,
  useMemo,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from 'react'
import type { UiSurfaceConnection } from './documents.js'

export type UiSurfaceContextValue = {
  surface: UiSurfaceConnection
  sessionId: string
  path: readonly string[]
}

export type SurfaceHostProps = {
  id?: string
  surface?: UiSurfaceConnection
  sessionId?: string
  asChild?: boolean
  className?: string
  style?: CSSProperties
  children: ReactNode
}

export type SurfaceBoundaryProps = {
  id: string
  children: ReactElement
}

const UiSurfaceContext = createContext<UiSurfaceContextValue | null>(null)

function surfacePath(path: readonly string[]): string {
  return JSON.stringify(path)
}

function validatedSegment(value: string): string {
  if (!value.trim()) throw new Error('Surface path segment must not be empty')
  return value
}

function childPath(parent: UiSurfaceContextValue, id: string): UiSurfaceContextValue {
  return { ...parent, path: [...parent.path, validatedSegment(id)] }
}

/** A visible surface boundary. Nested hosts inherit the current connection and session. */
export function SurfaceHost({
  id,
  surface,
  sessionId,
  asChild = false,
  className,
  style,
  children,
}: SurfaceHostProps) {
  const parent = useContext(UiSurfaceContext)
  const resolvedSurface = surface ?? parent?.surface
  const resolvedSessionId = sessionId ?? parent?.sessionId
  const requestedSegment = id ?? surface?.id

  if (parent !== null && (surface !== undefined || sessionId !== undefined)) {
    throw new Error('Nested SurfaceHost must inherit its surface and session')
  }
  if (!resolvedSurface) throw new Error('Root SurfaceHost requires a surface connection')
  if (!resolvedSessionId) throw new Error('Root SurfaceHost requires a session id')
  if (!requestedSegment) throw new Error('Nested SurfaceHost requires an id or a surface connection')

  const pathSegment = validatedSegment(requestedSegment)

  const value = useMemo<UiSurfaceContextValue>(() => ({
    surface: resolvedSurface,
    sessionId: resolvedSessionId,
    path: [...(parent?.path ?? []), pathSegment],
  }), [parent?.path, pathSegment, resolvedSessionId, resolvedSurface])

  const attributes = {
    'data-ui-surface': value.surface.id,
    'data-ui-surface-id': pathSegment,
    'data-ui-surface-path': surfacePath(value.path),
    'data-ui-surface-root': parent === null ? 'true' : undefined,
  }

  if (asChild) {
    if (!isValidElement<Record<string, unknown>>(children) || typeof children.type !== 'string') {
      throw new Error('SurfaceHost with asChild requires one intrinsic DOM element child')
    }
    const childClass = typeof children.props.className === 'string' ? children.props.className : undefined
    const childStyle = typeof children.props.style === 'object' && children.props.style !== null
      ? children.props.style as CSSProperties
      : undefined
    return (
      <UiSurfaceContext.Provider value={value}>
        {cloneElement(children, {
          ...attributes,
          ...(className === undefined ? {} : { className: [childClass, className].filter(Boolean).join(' ') }),
          ...(style === undefined ? {} : { style: { ...childStyle, ...style } }),
        })}
      </UiSurfaceContext.Provider>
    )
  }

  return (
    <UiSurfaceContext.Provider value={value}>
      <div
        className={className}
        {...attributes}
        style={{
          position: 'relative',
          width: '100%',
          height: '100%',
          minWidth: 0,
          minHeight: 0,
          boxSizing: 'border-box',
          ...style,
        }}
      >
        {children}
      </div>
    </UiSurfaceContext.Provider>
  )
}

/** Marks an existing DOM root as a nested surface without adding layout. */
export function SurfaceBoundary({ id, children }: SurfaceBoundaryProps) {
  const parent = useUiSurface()
  const value = useMemo(() => childPath(parent, id), [id, parent])
  if (!isValidElement<Record<string, unknown>>(children) || typeof children.type !== 'string') {
    throw new Error('SurfaceBoundary requires one intrinsic DOM element child')
  }
  return (
    <UiSurfaceContext.Provider value={value}>
      {cloneElement(children, {
        'data-ui-surface': value.surface.id,
        'data-ui-surface-id': id,
        'data-ui-surface-path': surfacePath(value.path),
      })}
    </UiSurfaceContext.Provider>
  )
}

export function useUiSurface(): UiSurfaceContextValue {
  const value = useContext(UiSurfaceContext)
  if (!value) throw new Error('useUiSurface must be called inside SurfaceHost')
  return value
}
