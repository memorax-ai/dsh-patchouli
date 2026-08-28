import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import {
  IconChevronDownOutline14,
  IconChevronRightOutline14,
} from '@deepseek-ai/dsh-client-ui-primitives'

type VisibleTreeItem<T> = {
  node: T
  id: string
  label: string
  depth: number
  parentId?: string
  expandable: boolean
  expanded: boolean
}

type StickyTreeItem = {
  id: string
  offset: number
}

const MAX_TREE_DEPTH = 100

export type TreeViewProps<T> = {
  nodes: readonly T[]
  ariaLabel: string
  className?: string
  selectedId?: string
  getId: (node: T) => string
  getLabel: (node: T) => string
  getChildren: (node: T) => readonly T[] | undefined
  isExpanded: (node: T, depth: number) => boolean
  renderIcon?: (node: T, expanded: boolean) => ReactNode
  onExpandedChange: (node: T, expanded: boolean) => void
  onActivate: (node: T) => void
  onOpen?: (node: T) => void
}

/** A controlled workspace tree with Explorer-style focus and keyboard behavior. */
export function TreeView<T>({
  nodes,
  ariaLabel,
  className,
  selectedId,
  getId,
  getLabel,
  getChildren,
  isExpanded,
  renderIcon,
  onExpandedChange,
  onActivate,
  onOpen,
}: TreeViewProps<T>) {
  const visibleItems = useMemo(() => {
    const result: VisibleTreeItem<T>[] = []
    const seenIds = new Set<string>()
    const visit = (entries: readonly T[], depth: number, parentId?: string) => {
      if (depth >= MAX_TREE_DEPTH) return
      for (const node of entries) {
        const id = getId(node)
        if (seenIds.has(id)) continue
        seenIds.add(id)
        const children = getChildren(node) ?? []
        const expandable = children.length > 0
        const expanded = expandable && isExpanded(node, depth)
        result.push({ node, id, label: getLabel(node), depth, parentId, expandable, expanded })
        if (expanded) visit(children, depth + 1, id)
      }
    }
    visit(nodes, 0)
    return result
  }, [getChildren, getId, getLabel, isExpanded, nodes])
  const [focusedId, setFocusedId] = useState(selectedId ?? visibleItems[0]?.id ?? '')
  const [stickyItems, setStickyItems] = useState<readonly StickyTreeItem[]>([])
  const treeRef = useRef<HTMLDivElement>(null)
  const rowRefs = useRef(new Map<string, HTMLButtonElement>())
  const typeahead = useRef({ value: '', timer: undefined as ReturnType<typeof setTimeout> | undefined })
  const itemsById = useMemo(
    () => new Map(visibleItems.map((item) => [item.id, item])),
    [visibleItems],
  )

  useEffect(() => {
    if (visibleItems.some((item) => item.id === focusedId)) return
    setFocusedId(selectedId && visibleItems.some((item) => item.id === selectedId)
      ? selectedId
      : visibleItems[0]?.id ?? '')
  }, [focusedId, selectedId, visibleItems])

  useEffect(() => () => {
    if (typeahead.current.timer) clearTimeout(typeahead.current.timer)
  }, [])

  useLayoutEffect(() => {
    const tree = treeRef.current
    const viewport = tree?.closest<HTMLElement>('.dsh-workspace-explorer-section-viewport')
    if (!tree || !viewport) return

    const updateStickyItems = () => {
      const scrollOffset = viewport.scrollTop - tree.offsetTop
      if (scrollOffset <= 0) {
        setStickyItems((current) => current.length === 0 ? current : [])
        return
      }

      let currentItem: VisibleTreeItem<T> | undefined
      for (const item of visibleItems) {
        const row = rowRefs.current.get(item.id)
        if (!row || row.offsetTop > scrollOffset) break
        currentItem = item
      }

      const nextItems: VisibleTreeItem<T>[] = []
      const appendAncestors = (item: VisibleTreeItem<T> | undefined) => {
        if (!item) return
        appendAncestors(item.parentId ? itemsById.get(item.parentId) : undefined)
        if (item.expandable && item.expanded) nextItems.push(item)
      }
      appendAncestors(currentItem)

      let stickyBottom = 0
      const nextStickyItems = nextItems.map((item) => {
        const row = rowRefs.current.get(item.id)
        stickyBottom += row?.offsetHeight ?? 25
        const itemIndex = visibleItems.indexOf(item)
        const boundary = visibleItems.slice(itemIndex + 1).find((candidate) => candidate.depth <= item.depth)
        const boundaryRow = boundary ? rowRefs.current.get(boundary.id) : undefined
        const boundaryTop = boundaryRow ? boundaryRow.offsetTop - scrollOffset : Number.POSITIVE_INFINITY
        return { id: item.id, offset: Math.min(0, boundaryTop - stickyBottom) }
      })
      setStickyItems((current) => current.length === nextStickyItems.length
        && current.every((item, index) => item.id === nextStickyItems[index]?.id
          && item.offset === nextStickyItems[index]?.offset)
        ? current
        : nextStickyItems)
    }

    let frame = 0
    const scheduleUpdate = () => {
      if (frame !== 0) return
      frame = requestAnimationFrame(() => {
        frame = 0
        updateStickyItems()
      })
    }
    const observer = new ResizeObserver(scheduleUpdate)
    observer.observe(viewport)
    observer.observe(tree)
    viewport.addEventListener('scroll', scheduleUpdate, { passive: true })
    updateStickyItems()
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame)
      observer.disconnect()
      viewport.removeEventListener('scroll', scheduleUpdate)
    }
  }, [itemsById, visibleItems])

  const renderItemContent = (item: VisibleTreeItem<T>) => (
    <>
      <span className="dsh-workspace-tree-chevron">
        {item.expandable && (item.expanded
          ? <IconChevronDownOutline14 size={14} />
          : <IconChevronRightOutline14 size={14} />)}
      </span>
      {renderIcon && <span className="dsh-workspace-tree-icon">{renderIcon(item.node, item.expanded)}</span>}
      <span className="dsh-workspace-tree-label">{item.label}</span>
    </>
  )

  const focusItem = (id: string) => {
    setFocusedId(id)
    requestAnimationFrame(() => {
      const row = rowRefs.current.get(id)
      row?.focus()
      row?.scrollIntoView({ block: 'nearest' })
    })
  }

  const focusByIndex = (index: number) => {
    const item = visibleItems[Math.max(0, Math.min(visibleItems.length - 1, index))]
    if (item) focusItem(item.id)
  }

  const handleTypeahead = (key: string, currentIndex: number) => {
    if (key.length !== 1 || key.trim().length === 0) return false
    if (typeahead.current.timer) clearTimeout(typeahead.current.timer)
    typeahead.current.value = `${typeahead.current.value}${key}`.toLocaleLowerCase()
    typeahead.current.timer = setTimeout(() => {
      typeahead.current.value = ''
      typeahead.current.timer = undefined
    }, 700)
    const ordered = [...visibleItems.slice(currentIndex + 1), ...visibleItems.slice(0, currentIndex + 1)]
    const match = ordered.find((item) => item.label.toLocaleLowerCase().startsWith(typeahead.current.value))
    if (match) focusItem(match.id)
    return true
  }

  return (
    <div ref={treeRef} className={className} role="tree" aria-label={ariaLabel}>
      {stickyItems.length > 0 && (
        <div className="dsh-workspace-tree-sticky-scroll" aria-hidden="true">
          {stickyItems.map((stickyItem, index) => {
            const item = itemsById.get(stickyItem.id)
            if (!item) return null
            const style = {
              '--dsh-workspace-tree-depth': item.depth,
              '--dsh-workspace-tree-sticky-offset': `${stickyItem.offset}px`,
              zIndex: stickyItems.length - index,
            } as CSSProperties
            return (
              <div key={stickyItem.id} className="dsh-workspace-tree-row dsh-workspace-tree-sticky-row" style={style}>
                {renderItemContent(item)}
              </div>
            )
          })}
        </div>
      )}
      {visibleItems.map((item, index) => {
        const style = { '--dsh-workspace-tree-depth': item.depth } as CSSProperties
        return (
          <button
            key={item.id}
            ref={(element) => {
              if (element) rowRefs.current.set(item.id, element)
              else rowRefs.current.delete(item.id)
            }}
            type="button"
            className="dsh-workspace-tree-row"
            role="treeitem"
            aria-level={item.depth + 1}
            aria-expanded={item.expandable ? item.expanded : undefined}
            aria-selected={selectedId === item.id}
            data-selected={selectedId === item.id}
            data-sticky-source={stickyItems.some((stickyItem) => stickyItem.id === item.id) || undefined}
            tabIndex={focusedId === item.id ? 0 : -1}
            style={style}
            title={item.label}
            onFocus={() => setFocusedId(item.id)}
            onClick={() => {
              if (item.expandable) onExpandedChange(item.node, !item.expanded)
              else onActivate(item.node)
            }}
            onDoubleClick={() => {
              if (!item.expandable) onOpen?.(item.node)
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowUp') focusByIndex(index - 1)
              else if (event.key === 'ArrowDown') focusByIndex(index + 1)
              else if (event.key === 'Home') focusByIndex(0)
              else if (event.key === 'End') focusByIndex(visibleItems.length - 1)
              else if (event.key === 'ArrowRight') {
                if (item.expandable && !item.expanded) onExpandedChange(item.node, true)
                else if (item.expandable) focusByIndex(index + 1)
                else return
              } else if (event.key === 'ArrowLeft') {
                if (item.expandable && item.expanded) onExpandedChange(item.node, false)
                else if (item.parentId) focusItem(item.parentId)
                else return
              } else if (event.key === 'Enter' || event.key === ' ') {
                if (item.expandable) onExpandedChange(item.node, !item.expanded)
                else onActivate(item.node)
              } else if (!handleTypeahead(event.key, index)) return
              event.preventDefault()
            }}
          >
            {renderItemContent(item)}
          </button>
        )
      })}
    </div>
  )
}
