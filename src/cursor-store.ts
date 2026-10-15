import { Service, type Context } from '@deepseek-ai/cordis'
import {
  defineDomain,
  domainTable,
  type DomainTableSpec,
  type KvTable,
} from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

import type { MemoryCursorStore } from './memory.js'

export interface MemoryCursorBinding {
  readonly consumerId: string
  readonly subscriptionKey: string
  readonly scope: string
}

const cursorRecord = z.object({ cursor: z.string() })
type CursorRecord = z.infer<typeof cursorRecord>

// Table storage only calls parse(); Zod's internal types differ across DSH versions.
const cursorTable = domainTable as (
  schema: Pick<typeof cursorRecord, 'parse'>,
) => DomainTableSpec<string, CursorRecord>

/** Durable storage owned by the common memory consumer, independent of memory backends. */
export const memoryCursorDomainSpec = defineDomain({
  name: 'patchouli_memory',
  version: 1,
  tables: {
    cursors: cursorTable(cursorRecord),
  },
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    patchouliCursors: MemoryCursorStoreService
  }
}

/** Binds durable per-plugin cursors to one logical memory subscription. */
export class MemoryCursorStoreService extends Service {
  static inject = ['storageDomain']

  private table?: KvTable<string, CursorRecord>

  constructor(ctx: Context) {
    super(ctx, 'patchouliCursors')
  }

  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(memoryCursorDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'patchouliCursors.domainClose')
    this.table = domain.table('cursors')
  }

  bind(binding: MemoryCursorBinding): MemoryCursorStore {
    const { consumerId, subscriptionKey, scope } = binding
    requireNonBlank('consumerId', consumerId)
    requireNonBlank('subscriptionKey', subscriptionKey)
    requireNonBlank('scope', scope)

    const table = this.requireTable()
    const keyFor = (pluginId: string): string => JSON.stringify([
      consumerId,
      subscriptionKey,
      scope,
      pluginId,
    ])

    return {
      async load(pluginId) {
        return table.get(keyFor(pluginId))?.cursor
      },
      async save(pluginId, cursor) {
        await table.put(keyFor(pluginId), { cursor })
      },
      async delete(pluginId) {
        await table.delete(keyFor(pluginId))
      },
    }
  }

  private requireTable(): KvTable<string, CursorRecord> {
    if (this.table === undefined) {
      throw new Error('memory cursor store is not initialized')
    }
    return this.table
  }
}

function requireNonBlank(name: keyof MemoryCursorBinding, value: string): void {
  if (value.trim() === '') {
    throw new Error(`memory cursor ${name} must be a non-empty string`)
  }
}

export default MemoryCursorStoreService
