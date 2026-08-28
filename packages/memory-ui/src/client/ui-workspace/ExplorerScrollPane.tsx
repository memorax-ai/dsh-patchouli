import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useLayoutEffect,
  useRef,
} from 'react'

type ScrollMetrics = {
  scrollable: boolean
  thumbHeight: number
  thumbTop: number
  maxScrollTop: number
  maxThumbTop: number
}

const EMPTY_METRICS: ScrollMetrics = {
  scrollable: false,
  thumbHeight: 0,
  thumbTop: 0,
  maxScrollTop: 0,
  maxThumbTop: 0,
}

const TRACK_INSET = 3
const MIN_THUMB_HEIGHT = 18

export function ExplorerScrollPane({ id, children }: { id: string; children: ReactNode }) {
  const bodyRef = useRef<HTMLDivElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const metricsRef = useRef<ScrollMetrics>(EMPTY_METRICS)
  const dragRef = useRef<{ pointerId: number; y: number; scrollTop: number } | undefined>(undefined)

  const updateMetrics = () => {
    const body = bodyRef.current
    const viewport = viewportRef.current
    if (!body || !viewport) return

    const { clientHeight, scrollHeight, scrollTop } = viewport
    const maxScrollTop = Math.max(0, scrollHeight - clientHeight)
    const trackHeight = Math.max(0, clientHeight - TRACK_INSET * 2)
    if (maxScrollTop === 0 || trackHeight === 0) {
      metricsRef.current = EMPTY_METRICS
      body.dataset.scrollable = 'false'
      return
    }

    const thumbHeight = Math.min(trackHeight, Math.max(
      MIN_THUMB_HEIGHT,
      trackHeight * clientHeight / scrollHeight,
    ))
    const maxThumbTop = Math.max(0, trackHeight - thumbHeight)
    const metrics = {
      scrollable: true,
      thumbHeight,
      thumbTop: maxThumbTop * scrollTop / maxScrollTop,
      maxScrollTop,
      maxThumbTop,
    }
    metricsRef.current = metrics
    body.dataset.scrollable = 'true'
    body.style.setProperty('--dsh-workspace-thumb-height', `${metrics.thumbHeight}px`)
    body.style.setProperty('--dsh-workspace-thumb-top', `${metrics.thumbTop}px`)
  }

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    const content = contentRef.current
    if (!viewport || !content) return

    const observer = new ResizeObserver(updateMetrics)
    observer.observe(viewport)
    observer.observe(content)
    updateMetrics()
    return () => observer.disconnect()
  }, [])

  const finishThumbDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return
    dragRef.current = undefined
    bodyRef.current?.removeAttribute('data-dragging')
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  return (
    <div ref={bodyRef} id={id} className="dsh-workspace-explorer-section-body" data-scrollable="false">
      <div ref={viewportRef} className="dsh-workspace-explorer-section-viewport" onScroll={updateMetrics}>
        <div ref={contentRef} className="dsh-workspace-explorer-section-content">{children}</div>
      </div>
      <div
        className="dsh-workspace-explorer-scrollbar"
        aria-hidden="true"
        onPointerDown={(event) => {
          const viewport = viewportRef.current
          const metrics = metricsRef.current
          if (!viewport || event.target !== event.currentTarget || metrics.maxThumbTop === 0) return
          const trackRect = event.currentTarget.getBoundingClientRect()
          const requestedTop = event.clientY - trackRect.top - metrics.thumbHeight / 2
          const thumbTop = Math.max(0, Math.min(metrics.maxThumbTop, requestedTop))
          viewport.scrollTop = metrics.maxScrollTop * thumbTop / metrics.maxThumbTop
        }}
      >
        <div
          className="dsh-workspace-explorer-scrollbar-thumb"
          onPointerDown={(event) => {
            const viewport = viewportRef.current
            const metrics = metricsRef.current
            if (!viewport || !metrics.scrollable || metrics.maxThumbTop === 0 || event.button !== 0) return
            event.preventDefault()
            event.stopPropagation()
            dragRef.current = { pointerId: event.pointerId, y: event.clientY, scrollTop: viewport.scrollTop }
            bodyRef.current?.setAttribute('data-dragging', 'true')
            event.currentTarget.setPointerCapture(event.pointerId)
          }}
          onPointerMove={(event) => {
            const viewport = viewportRef.current
            const drag = dragRef.current
            const metrics = metricsRef.current
            if (!viewport || drag?.pointerId !== event.pointerId || metrics.maxThumbTop === 0) return
            viewport.scrollTop = drag.scrollTop
              + (event.clientY - drag.y) * metrics.maxScrollTop / metrics.maxThumbTop
          }}
          onPointerUp={finishThumbDrag}
          onPointerCancel={finishThumbDrag}
          onLostPointerCapture={(event) => {
            if (dragRef.current?.pointerId !== event.pointerId) return
            dragRef.current = undefined
            bodyRef.current?.removeAttribute('data-dragging')
          }}
        />
      </div>
    </div>
  )
}
