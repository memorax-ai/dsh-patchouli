import { useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react'

export function useAnchoredPopover(
  anchorRef: RefObject<HTMLElement>,
  popoverRef: RefObject<HTMLElement>,
  align: 'start' | 'end' = 'start',
  active = true,
): CSSProperties {
  const [position, setPosition] = useState<CSSProperties>({ top: 0, left: 0, visibility: 'hidden' })

  useLayoutEffect(() => {
    if (!active) return
    const anchor = anchorRef.current
    const popover = popoverRef.current
    if (!anchor || !popover) return

    const updatePosition = () => {
      const anchorRect = anchor.getBoundingClientRect()
      const width = popover.offsetWidth
      const height = popover.offsetHeight
      const edge = 12
      const gap = 8
      const preferredLeft = align === 'end' ? anchorRect.right - width : anchorRect.left
      const left = Math.max(edge, Math.min(preferredLeft, window.innerWidth - width - edge))
      const below = anchorRect.bottom + gap
      const top = below + height <= window.innerHeight - edge
        ? below
        : Math.max(edge, anchorRect.top - height - gap)
      setPosition({ top, left })
    }

    updatePosition()
    const observer = new ResizeObserver(updatePosition)
    observer.observe(anchor)
    observer.observe(popover)
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [active, align, anchorRef, popoverRef])

  return position
}
