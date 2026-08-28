import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { DocumentRef } from './ui-container/index.js'
import type { ExplorerPaneLayout } from './ui-workspace/index.js'
import type { FilterValue } from './filters.js'

export type KnowledgeScope = 'session' | 'workspace' | 'global'

export type SessionLayout = {
  scope: KnowledgeScope
  agentOpen: boolean
  editMode: boolean
  openDocuments: DocumentRef[]
  activeDocumentUri: string
  previewDocumentUri?: string
  explorerWidth: number
  agentWidth: number
  explorerPanes: ExplorerPaneLayout
  treeExpanded: Record<string, boolean>
  searchHistory: string[]
  filterValues: Record<string, FilterValue>
}

export const DEFAULT_EXPLORER_WIDTH = 252
export const DEFAULT_AGENT_WIDTH = 360
const STORAGE_PREFIX = 'dsh-patchouli/session-layout/'
const SAVE_DELAY = 120

function defaultLayout(initialDocuments: readonly DocumentRef[]): SessionLayout {
  return {
    scope: 'session',
    agentOpen: false,
    editMode: false,
    openDocuments: [...initialDocuments],
    activeDocumentUri: initialDocuments[0]?.uri ?? '',
    explorerWidth: DEFAULT_EXPLORER_WIDTH,
    agentWidth: DEFAULT_AGENT_WIDTH,
    explorerPanes: { expanded: {}, sizes: {} },
    treeExpanded: {},
    searchHistory: [],
    filterValues: {},
  }
}

function filterValue(value: unknown): FilterValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (Array.isArray(value)) {
    const entries = value.map(filterValue)
    return entries.some((entry) => entry === undefined) ? undefined : entries as FilterValue[]
  }
  if (!isRecord(value)) return undefined
  const entries = Object.entries(value).map(([key, entry]) => [key, filterValue(entry)] as const)
  if (entries.some((entry) => entry[1] === undefined)) return undefined
  return Object.fromEntries(entries) as Record<string, FilterValue>
}

function filterRecord(value: unknown): Record<string, FilterValue> {
  if (!isRecord(value)) return {}
  return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => {
    const parsed = filterValue(entry)
    return parsed === undefined ? [] : [[key, parsed]]
  }))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function booleanRecord(value: unknown): Record<string, boolean> {
  if (!isRecord(value)) return {}
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, boolean] =>
    typeof entry[1] === 'boolean',
  ))
}

function sizeRecord(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {}
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] =>
    typeof entry[1] === 'number' && Number.isFinite(entry[1]) && entry[1] >= 0,
  ))
}

export function readSessionLayout(
  storage: Pick<Storage, 'getItem'>,
  sessionId: string,
  initialDocuments: readonly DocumentRef[] = [],
): SessionLayout {
  const fallback = defaultLayout(initialDocuments)
  try {
    const value: unknown = JSON.parse(storage.getItem(`${STORAGE_PREFIX}${sessionId}`) ?? 'null')
    if (!isRecord(value)) return fallback

    const openDocuments = Array.isArray(value.openDocumentUris)
      ? value.openDocumentUris.flatMap((uri) => typeof uri === 'string' ? [{ uri }] : [])
      : fallback.openDocuments
    const activeDocumentUri = typeof value.activeDocumentUri === 'string'
      && openDocuments.some((document) => document.uri === value.activeDocumentUri)
      ? value.activeDocumentUri
      : openDocuments[0]?.uri ?? ''
    const panes = isRecord(value.explorerPanes) ? value.explorerPanes : {}

    return {
      scope: value.scope === 'workspace' || value.scope === 'global' ? value.scope : 'session',
      agentOpen: typeof value.agentOpen === 'boolean' ? value.agentOpen : fallback.agentOpen,
      editMode: typeof value.editMode === 'boolean' ? value.editMode : fallback.editMode,
      openDocuments,
      activeDocumentUri,
      previewDocumentUri: typeof value.previewDocumentUri === 'string'
        && openDocuments.some((document) => document.uri === value.previewDocumentUri)
        ? value.previewDocumentUri
        : undefined,
      explorerWidth: typeof value.explorerWidth === 'number' && Number.isFinite(value.explorerWidth)
        ? value.explorerWidth
        : fallback.explorerWidth,
      agentWidth: typeof value.agentWidth === 'number' && Number.isFinite(value.agentWidth)
        ? value.agentWidth
        : fallback.agentWidth,
      explorerPanes: {
        expanded: booleanRecord(panes.expanded),
        sizes: sizeRecord(panes.sizes),
      },
      treeExpanded: booleanRecord(value.treeExpanded),
      searchHistory: Array.isArray(value.searchHistory)
        ? value.searchHistory.filter((entry): entry is string => typeof entry === 'string').slice(0, 8)
        : [],
      filterValues: filterRecord(value.filterValues),
    }
  } catch {
    return fallback
  }
}

export function writeSessionLayout(
  storage: Pick<Storage, 'setItem'>,
  sessionId: string,
  layout: SessionLayout,
): void {
  const { openDocuments, ...persisted } = layout
  storage.setItem(`${STORAGE_PREFIX}${sessionId}`, JSON.stringify({
    ...persisted,
    openDocumentUris: openDocuments.map((document) => document.uri),
  }))
}

function getStorage(): Storage | undefined {
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

function persist(storage: Storage, sessionId: string, layout: SessionLayout): void {
  try {
    writeSessionLayout(storage, sessionId, layout)
  } catch {
    // Layout caching is optional and must never prevent the view from working.
  }
}

export function useSessionLayout(
  sessionId: string,
  initialDocuments: readonly DocumentRef[] = [],
): [SessionLayout, Dispatch<SetStateAction<SessionLayout>>] {
  const storage = getStorage()
  const [layout, setLayout] = useState(() => storage
    ? readSessionLayout(storage, sessionId, initialDocuments)
    : defaultLayout(initialDocuments))
  const latestLayout = useRef(layout)
  latestLayout.current = layout

  useEffect(() => {
    if (!storage) return
    const timer = window.setTimeout(() => persist(storage, sessionId, layout), SAVE_DELAY)
    return () => window.clearTimeout(timer)
  }, [layout, sessionId, storage])

  useEffect(() => {
    if (!storage) return
    return () => persist(storage, sessionId, latestLayout.current)
  }, [sessionId, storage])

  return [layout, setLayout]
}
