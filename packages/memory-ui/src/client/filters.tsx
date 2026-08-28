import { useSyncExternalStore, type ReactNode } from 'react'
import type { KnowledgeScope } from './session-layout.js'

export type FilterValue =
  | null
  | boolean
  | number
  | string
  | readonly FilterValue[]
  | { readonly [key: string]: FilterValue }

export type FilterControlProps = {
  sessionId: string
  scope: KnowledgeScope
  value: FilterValue | undefined
  onChange: (value: FilterValue | undefined) => void
}

export type FilterDefinition = {
  id: string
  order?: number
  isActive: (value: FilterValue | undefined) => boolean
  render: (props: FilterControlProps) => ReactNode
}

export class FilterRegistry {
  readonly #definitions = new Map<string, FilterDefinition>()
  readonly #listeners = new Set<() => void>()
  #version = 0

  register(definition: FilterDefinition): () => void {
    if (this.#definitions.has(definition.id)) {
      throw new Error(`Filter already registered: ${definition.id}`)
    }
    this.#definitions.set(definition.id, definition)
    this.#emit()
    return () => {
      if (this.#definitions.get(definition.id) !== definition) return
      this.#definitions.delete(definition.id)
      this.#emit()
    }
  }

  list(): readonly FilterDefinition[] {
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

export function useFilterDefinitions(registry: FilterRegistry): readonly FilterDefinition[] {
  useSyncExternalStore(registry.subscribe, registry.getSnapshot, registry.getSnapshot)
  return registry.list()
}
