import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from 'dsh-patchouli'

import { SessionArchive, type ArchivePolicy } from './archive.js'
import {
  ArchivePolicySchema,
  FLEET_ARCHIVE_SETTINGS_NAMESPACE,
  archivePolicy,
} from './settings.js'

export * from './archive.js'
export * from './policy-store.js'
export * from './settings.js'
export * from './timeline.js'

export const name = 'dsh-patchouli-fleet'

/** The adapter is inert unless both Patchouli and the complete Fleet runtime exist. */
export const inject = ['patchouli'] as const

const fleetServices = [
  'fleetRuns',
  'agents',
  'sessions',
  'sessionPersistence',
  'compaction',
] as const

export interface Config extends Partial<ArchivePolicy> {
  readonly root?: string
}

export function apply(ctx: Context, config: Config = {}): void {
  ctx.inject(fleetServices, source => activate(source, config))
}

function activate(ctx: Context, config: Config): void {
  void ctx.patchouli
  void ctx.fleetRuns

  const initial = archivePolicy(config)
  const root = resolve(config.root ?? join(homedir(), '.dsh', 'session-archive'))
  const archive = new SessionArchive(root, {
    compaction: ctx.compaction,
    persistence: ctx.sessionPersistence,
    sessions: ctx.sessions,
    create: options => ctx.agents.create(options),
    resume: options => ctx.agents.resume(options),
  }, initial)

  ctx.inject(['settings'], source => {
    const settings = source.settings as unknown as {
      register(namespace: string, schema: typeof ArchivePolicySchema, options: { base: ArchivePolicy; applies: 'live' }): {
        get(): ArchivePolicy
        watch(listener: (value: ArchivePolicy) => void): () => void
      }
    }
    const scope = settings.register(FLEET_ARCHIVE_SETTINGS_NAMESPACE, ArchivePolicySchema, { base: initial, applies: 'live' })
    archive.configure(scope.get())
    const unwatch = scope.watch(next => archive.configure(next))
    return () => { unwatch(); archive.configure(initial) }
  })
  ctx.provide('sessionArchive', archive)
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Presence marker and runtime owned by dsh-agent-fleet. */
    fleetRuns: unknown
    /** Optional Session continuity capability consumed by Fleet Core. */
    sessionArchive: SessionArchive
  }
}
