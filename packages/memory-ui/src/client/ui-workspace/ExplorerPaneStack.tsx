import {
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import {
  IconChevronDownOutline14,
  IconChevronRightOutline14,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { ExplorerScrollPane } from './ExplorerScrollPane.js'
import { Sash } from './Sash.js'

const PANE_HEADER_HEIGHT = 29
const DEFAULT_MINIMUM_BODY_HEIGHT = 44

export type ExplorerPaneDefinition<TContext> = {
  id: string
  order?: number
  defaultExpanded?: boolean
  minimumBodyHeight?: number
  title: (context: TContext) => ReactNode
  render: (context: TContext) => ReactNode
}

type PaneSizes = Record<string, number>
type ExpandedState = Record<string, boolean>

export type ExplorerPaneLayout = {
  expanded: ExpandedState
  sizes: PaneSizes
}

type SashDragState = {
  separatorIndex: number
  sizes: PaneSizes
}

export class ExplorerPaneRegistry<TContext> {
  readonly #definitions = new Map<string, ExplorerPaneDefinition<TContext>>()
  readonly #listeners = new Set<() => void>()
  #version = 0

  register(definition: ExplorerPaneDefinition<TContext>): () => void {
    if (this.#definitions.has(definition.id)) {
      throw new Error(`Explorer pane already registered: ${definition.id}`)
    }
    if ((definition.minimumBodyHeight ?? DEFAULT_MINIMUM_BODY_HEIGHT) < 0) {
      throw new Error(`Explorer pane minimumBodyHeight must not be negative: ${definition.id}`)
    }

    this.#definitions.set(definition.id, definition)
    this.#emit()
    return () => {
      if (this.#definitions.get(definition.id) !== definition) return
      this.#definitions.delete(definition.id)
      this.#emit()
    }
  }

  list(): readonly ExplorerPaneDefinition<TContext>[] {
    return [...this.#definitions.values()].sort((left, right) =>
      (left.order ?? 0) - (right.order ?? 0) || left.id.localeCompare(right.id),
    )
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  getSnapshot = (): number => this.#version

  #emit(): void {
    this.#version += 1
    for (const listener of this.#listeners) listener()
  }
}

function paneIsExpanded<TContext>(pane: ExplorerPaneDefinition<TContext>, expanded: ExpandedState): boolean {
  return expanded[pane.id] ?? pane.defaultExpanded ?? false
}

function paneMinimumHeight<TContext>(pane: ExplorerPaneDefinition<TContext>): number {
  return PANE_HEADER_HEIGHT + (pane.minimumBodyHeight ?? DEFAULT_MINIMUM_BODY_HEIGHT)
}

function requiredMinimumHeight<TContext>(
  panes: readonly ExplorerPaneDefinition<TContext>[],
  expanded: ExpandedState,
): number {
  return panes.reduce((total, pane) => total + (
    paneIsExpanded(pane, expanded) ? paneMinimumHeight(pane) : PANE_HEADER_HEIGHT
  ), 0)
}

function fitPaneSizes<TContext>(
  panes: readonly ExplorerPaneDefinition<TContext>[],
  expanded: ExpandedState,
  previous: PaneSizes,
  availableHeight: number,
): PaneSizes {
  const openPanes = panes.filter((pane) => paneIsExpanded(pane, expanded))
  if (openPanes.length === 0) return previous

  const collapsedHeight = (panes.length - openPanes.length) * PANE_HEADER_HEIGHT
  const targetOpenHeight = Math.max(0, availableHeight - collapsedHeight)
  const minimumOpenHeight = openPanes.reduce((total, pane) => total + paneMinimumHeight(pane), 0)
  const overflow = minimumOpenHeight > targetOpenHeight
  const next: PaneSizes = { ...previous }

  for (const pane of openPanes) {
    next[pane.id] = Math.max(previous[pane.id] ?? paneMinimumHeight(pane), paneMinimumHeight(pane))
  }

  if (!overflow) {
    let total = openPanes.reduce((sum, pane) => sum + (next[pane.id] ?? 0), 0)
    if (total < targetOpenHeight) {
      const addition = (targetOpenHeight - total) / openPanes.length
      for (const pane of openPanes) next[pane.id] = (next[pane.id] ?? 0) + addition
    } else if (total > targetOpenHeight) {
      let remaining = total - targetOpenHeight
      let candidates = openPanes.filter((pane) => (next[pane.id] ?? 0) > paneMinimumHeight(pane))
      while (remaining > 0.01 && candidates.length > 0) {
        const share = remaining / candidates.length
        let consumed = 0
        const stillResizable: typeof candidates = []
        for (const pane of candidates) {
          const current = next[pane.id] ?? 0
          const capacity = current - paneMinimumHeight(pane)
          const amount = Math.min(share, capacity)
          next[pane.id] = current - amount
          consumed += amount
          if (capacity - amount > 0.01) stillResizable.push(pane)
        }
        if (consumed <= 0.01) break
        remaining -= consumed
        candidates = stillResizable
      }
    }
  }

  for (const id of Object.keys(next)) {
    if (!panes.some((pane) => pane.id === id)) delete next[id]
  }
  return next
}

function sizesEqual(left: PaneSizes, right: PaneSizes): boolean {
  const leftIds = Object.keys(left)
  const rightIds = Object.keys(right)
  return leftIds.length === rightIds.length
    && leftIds.every((id) => Math.abs((left[id] ?? 0) - (right[id] ?? 0)) < 0.01)
}

function resizeAtSash<TContext>(
  panes: readonly ExplorerPaneDefinition<TContext>[],
  expanded: ExpandedState,
  initialSizes: PaneSizes,
  separatorIndex: number,
  delta: number,
): PaneSizes {
  const before = panes
    .map((pane, index) => ({ pane, index }))
    .filter(({ pane, index }) => index <= separatorIndex && paneIsExpanded(pane, expanded))
    .reverse()
  const after = panes
    .map((pane, index) => ({ pane, index }))
    .filter(({ pane, index }) => index > separatorIndex && paneIsExpanded(pane, expanded))

  if (before.length === 0 || after.length === 0 || delta === 0) return initialSizes
  const shrinking = delta > 0 ? after : before
  const growing = delta > 0 ? before[0]?.pane : after[0]?.pane
  if (!growing) return initialSizes

  let remaining = Math.abs(delta)
  let transferred = 0
  const next = { ...initialSizes }
  for (const { pane } of shrinking) {
    if (remaining <= 0) break
    const current = next[pane.id] ?? paneMinimumHeight(pane)
    const capacity = Math.max(0, current - paneMinimumHeight(pane))
    const amount = Math.min(remaining, capacity)
    next[pane.id] = current - amount
    remaining -= amount
    transferred += amount
  }

  next[growing.id] = (next[growing.id] ?? paneMinimumHeight(growing)) + transferred
  return next
}

export function ExplorerPaneStack<TContext>({ registry, context, initialLayout, resizeLabel, onLayoutChange }: {
  registry: ExplorerPaneRegistry<TContext>
  context: TContext
  initialLayout?: ExplorerPaneLayout
  resizeLabel: (before: ReactNode, after: ReactNode) => string
  onLayoutChange?: (layout: ExplorerPaneLayout) => void
}) {
  const registryVersion = useSyncExternalStore(registry.subscribe, registry.getSnapshot, registry.getSnapshot)
  const panes = useMemo(() => registry.list(), [registry, registryVersion])
  const stackRef = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState<ExpandedState>(initialLayout?.expanded ?? {})
  const [sizes, setSizes] = useState<PaneSizes>(initialLayout?.sizes ?? {})
  const [availableHeight, setAvailableHeight] = useState(0)
  const [dragState, setDragState] = useState<SashDragState | null>(null)
  const dragStateRef = useRef<SashDragState | null>(null)
  const headerRefs = useRef<Array<HTMLButtonElement | null>>([])
  const overflow = availableHeight > 0 && requiredMinimumHeight(panes, expanded) > availableHeight

  useLayoutEffect(() => {
    const stack = stackRef.current
    if (!stack) return

    const updateHeight = () => setAvailableHeight(stack.clientHeight)
    const observer = new ResizeObserver(updateHeight)
    observer.observe(stack)
    updateHeight()
    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => {
    if (availableHeight <= 0) return
    setSizes((current) => {
      const next = fitPaneSizes(panes, expanded, current, availableHeight)
      return sizesEqual(current, next) ? current : next
    })
  }, [availableHeight, expanded, panes])

  useEffect(() => {
    if (dragState) return
    onLayoutChange?.({ expanded, sizes })
  }, [dragState, expanded, onLayoutChange, sizes])

  const beginSashDrag = (separatorIndex: number) => {
    const state = { separatorIndex, sizes }
    dragStateRef.current = state
    setDragState(state)
  }

  const resizeSash = (separatorIndex: number, delta: number) => {
    const initial = dragStateRef.current?.separatorIndex === separatorIndex
      ? dragStateRef.current.sizes
      : sizes
    setSizes(resizeAtSash(panes, expanded, initial, separatorIndex, delta))
  }

  const endSashDrag = () => {
    dragStateRef.current = null
    setDragState(null)
  }

  const togglePane = (pane: ExplorerPaneDefinition<TContext>) => {
    setExpanded((current) => ({ ...current, [pane.id]: !paneIsExpanded(pane, current) }))
  }

  return (
    <div
      ref={stackRef}
      className="dsh-workspace-explorer-scroll"
      data-overflow={overflow}
      data-resizing={dragState !== null}
    >
      {panes.map((pane, index) => {
        const open = paneIsExpanded(pane, expanded)
        const contentId = `dsh-workspace-explorer-${pane.id}`
        const hasOpenBefore = panes.some((candidate, candidateIndex) =>
          candidateIndex <= index && paneIsExpanded(candidate, expanded),
        )
        const hasOpenAfter = panes.some((candidate, candidateIndex) =>
          candidateIndex > index && paneIsExpanded(candidate, expanded),
        )
        const resizable = hasOpenBefore && hasOpenAfter
        const height = open ? sizes[pane.id] ?? paneMinimumHeight(pane) : PANE_HEADER_HEIGHT

        return (
          <section
            key={pane.id}
            className="dsh-workspace-explorer-section"
            data-open={open}
            style={{ height }}
          >
            <button
              ref={(element) => { headerRefs.current[index] = element }}
              type="button"
              className="dsh-workspace-explorer-section-toggle"
              aria-expanded={open}
              aria-controls={contentId}
              onClick={() => togglePane(pane)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowUp') {
                  event.preventDefault()
                  headerRefs.current[Math.max(0, index - 1)]?.focus()
                } else if (event.key === 'ArrowDown') {
                  event.preventDefault()
                  headerRefs.current[Math.min(panes.length - 1, index + 1)]?.focus()
                } else if (event.key === 'ArrowLeft' && open) {
                  event.preventDefault()
                  togglePane(pane)
                } else if (event.key === 'ArrowRight' && !open) {
                  event.preventDefault()
                  togglePane(pane)
                }
              }}
            >
              {open ? <IconChevronDownOutline14 size={14} /> : <IconChevronRightOutline14 size={14} />}
              <span>{pane.title(context)}</span>
            </button>
            {open && <ExplorerScrollPane id={contentId}>{pane.render(context)}</ExplorerScrollPane>}
            {index < panes.length - 1 && (
              <Sash
                className="dsh-workspace-explorer-pane-sash"
                orientation="horizontal"
                label={resizeLabel(pane.title(context), panes[index + 1]?.title(context))}
                value={panes.slice(0, index + 1).reduce((total, candidate) => total + (
                  paneIsExpanded(candidate, expanded)
                    ? sizes[candidate.id] ?? paneMinimumHeight(candidate)
                    : PANE_HEADER_HEIGHT
                ), 0)}
                minimum={0}
                maximum={availableHeight}
                disabled={!resizable}
                onResizeStart={() => beginSashDrag(index)}
                onResize={(delta) => resizeSash(index, delta)}
                onResizeEnd={endSashDrag}
                onReset={() => setSizes(fitPaneSizes(panes, expanded, {}, availableHeight))}
              />
            )}
          </section>
        )
      })}
    </div>
  )
}
