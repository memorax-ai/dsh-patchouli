import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

export type SashOrientation = 'horizontal' | 'vertical'

export type SashProps = {
  orientation: SashOrientation
  label: string
  value: number
  minimum: number
  maximum: number
  disabled?: boolean
  className?: string
  step?: number
  onResizeStart?: () => void
  onResize: (delta: number) => void
  onResizeEnd?: () => void
  onReset?: () => void
}

/** Pointer- and keyboard-accessible separator shared by Workspace layouts. */
export function Sash({
  orientation,
  label,
  value,
  minimum,
  maximum,
  disabled = false,
  className,
  step = 16,
  onResizeStart,
  onResize,
  onResizeEnd,
  onReset,
}: SashProps) {
  const drag = useRef<{ pointerId: number; start: number } | undefined>(undefined)
  const [active, setActive] = useState(false)

  const coordinate = (event: ReactPointerEvent) => orientation === 'vertical'
    ? event.clientX
    : event.clientY

  const finish = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return
    drag.current = undefined
    setActive(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    onResizeEnd?.()
  }

  return (
    <div
      className={className}
      role="separator"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-orientation={orientation}
      aria-valuemin={Math.round(minimum)}
      aria-valuemax={Math.round(maximum)}
      aria-valuenow={Math.round(value)}
      aria-disabled={disabled}
      data-enabled={!disabled}
      data-active={active}
      onDoubleClick={() => {
        if (!disabled) onReset?.()
      }}
      onKeyDown={(event) => {
        if (disabled) return
        let delta = 0
        if (event.key === (orientation === 'vertical' ? 'ArrowLeft' : 'ArrowUp')) delta = -step
        else if (event.key === (orientation === 'vertical' ? 'ArrowRight' : 'ArrowDown')) delta = step
        else if (event.key === 'Home') delta = minimum - value
        else if (event.key === 'End') delta = maximum - value
        else return
        event.preventDefault()
        onResizeStart?.()
        onResize(event.shiftKey ? delta * 4 : delta)
        onResizeEnd?.()
      }}
      onPointerDown={(event) => {
        if (disabled || event.button !== 0) return
        event.preventDefault()
        drag.current = { pointerId: event.pointerId, start: coordinate(event) }
        setActive(true)
        event.currentTarget.setPointerCapture(event.pointerId)
        onResizeStart?.()
      }}
      onPointerMove={(event) => {
        if (drag.current?.pointerId !== event.pointerId) return
        onResize(coordinate(event) - drag.current.start)
      }}
      onPointerUp={finish}
      onPointerCancel={finish}
      onLostPointerCapture={(event) => {
        if (drag.current?.pointerId !== event.pointerId) return
        drag.current = undefined
        setActive(false)
        onResizeEnd?.()
      }}
    />
  )
}
