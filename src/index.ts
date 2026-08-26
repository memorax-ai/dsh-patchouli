import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  PatchouliService,
  type MemoryRoutePolicy,
  type MemoryServiceConfig,
} from './memory.js'
import { installPatchouliSettings } from './settings.js'

export * from './memory.js'
export * from './settings.js'

/** Cordis plugin identity used by loader diagnostics and model provenance. */
export const name = 'dsh-patchouli'

/** The common memory frontend has no service dependencies. */
export const inject = [] as const

export interface Config {
  /** Per-plugin user routing policies. Plugins without a policy receive all calls. */
  routing?: Record<string, MemoryRoutePolicy>
  /** Default independent deadline for each provider retrieval. */
  retrieveTimeoutMs?: number
}

const operation = z.union([
  z.const('update'),
  z.const('retrieve'),
  z.const('subscribe'),
])

export const Config: z<Config> = z.object({
  routing: z.dict(z.object({
    enabled: z.boolean().default(true),
    operations: z.array(operation).default([]),
    sourceTypes: z.array(z.string()).default([]),
    sourceIds: z.array(z.string()).default([]),
    scopes: z.array(z.string()).default([]),
    attributes: z.dict(z.any()).default({}),
    retrieveTimeoutMs: z.natural().min(1),
  })).default({}),
  retrieveTimeoutMs: z.natural().min(1).default(30_000),
})

/**
 * Install the common Patchouli memory frontend into a Cordis context.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const serviceConfig: MemoryServiceConfig = {
    routing: config.routing ?? {},
    retrieveTimeoutMs: config.retrieveTimeoutMs ?? 30_000,
  }
  ctx.plugin(PatchouliService, serviceConfig)
  installPatchouliSettings(ctx, {
    retrieveTimeoutMs: config.retrieveTimeoutMs ?? 30_000,
  })
}
