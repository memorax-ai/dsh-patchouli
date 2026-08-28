import { useSyncExternalStore, type ReactNode } from 'react'
import type { DocumentRef, DocumentSnapshot } from '../ui-container/index.js'
export type DocumentActionContext = {
  surfaceId: string
  sessionId: string
  mode?: string
  context: Readonly<Record<string, unknown>>
  document: DocumentSnapshot
  openDocument: (document: DocumentRef) => void
  openAgent: () => void
}

export type DocumentActionPanelContext = DocumentActionContext & {
  close: () => void
}

export type DocumentActionDefinition = {
  id: string
  order?: number
  label: (context: DocumentActionContext) => string
  icon?: ReactNode | ((context: DocumentActionContext) => ReactNode)
  when?: (context: DocumentActionContext) => boolean
  run?: (context: DocumentActionContext) => void | Promise<void>
  renderPanel?: (context: DocumentActionPanelContext) => ReactNode
}

export class DocumentActionRegistry {
  readonly #definitions = new Map<string, DocumentActionDefinition>()
  readonly #listeners = new Set<() => void>()
  #version = 0

  register(definition: DocumentActionDefinition): () => void {
    if (this.#definitions.has(definition.id)) {
      throw new Error(`Document action already registered: ${definition.id}`)
    }
    if (!definition.run && !definition.renderPanel) {
      throw new Error(`Document action must define run or renderPanel: ${definition.id}`)
    }
    this.#definitions.set(definition.id, definition)
    this.#emit()
    return () => {
      if (this.#definitions.get(definition.id) !== definition) return
      this.#definitions.delete(definition.id)
      this.#emit()
    }
  }

  list(context: DocumentActionContext): readonly DocumentActionDefinition[] {
    return [...this.#definitions.values()]
      .filter((definition) => definition.when?.(context) ?? true)
      .sort((left, right) =>
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

export function useDocumentActions(
  registry: DocumentActionRegistry,
  context: DocumentActionContext,
): readonly DocumentActionDefinition[] {
  useSyncExternalStore(registry.subscribe, registry.getSnapshot, registry.getSnapshot)
  return registry.list(context)
}
