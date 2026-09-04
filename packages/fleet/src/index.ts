import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import { installSettingsSection } from '@deepseek-ai/dsh-settings'
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
export const inject = [
  'patchouli',
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
  void ctx.patchouli
  void ctx.fleetRuns

  const initial = archivePolicy(config)
  let current = (): ArchivePolicy => initial
  const root = resolve(config.root ?? join(homedir(), '.dsh', 'session-archive'))
  const archive = new SessionArchive(root, {
    compaction: ctx.compaction,
    persistence: ctx.sessionPersistence,
    sessions: ctx.sessions,
    create: options => ctx.agents.create(options),
    resume: options => ctx.agents.resume(options),
  }, current())

  installSettingsSection(
    ctx,
    FLEET_ARCHIVE_SETTINGS_NAMESPACE,
    ArchivePolicySchema,
    initial,
    {
      setSource(source) { current = source },
      onChange() { archive.configure(current()) },
    },
  )
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
