import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'

import { DEFAULT_ARCHIVE_POLICY, type ArchivePolicy } from './archive.js'

export const FLEET_ARCHIVE_SETTINGS_NAMESPACE = settingsNamespace('dsh-patchouli-fleet')

export const ArchivePolicySchema = z.object({
  enabled: z.boolean().default(DEFAULT_ARCHIVE_POLICY.enabled),
  maxEvents: z.natural().default(DEFAULT_ARCHIVE_POLICY.maxEvents),
  maxMegabytes: z.natural().default(DEFAULT_ARCHIVE_POLICY.maxMegabytes),
  maxAgeHours: z.natural().default(DEFAULT_ARCHIVE_POLICY.maxAgeHours),
})

export function archivePolicy(input: Partial<ArchivePolicy>): ArchivePolicy {
  return {
    enabled: input.enabled ?? DEFAULT_ARCHIVE_POLICY.enabled,
    maxEvents: input.maxEvents ?? DEFAULT_ARCHIVE_POLICY.maxEvents,
    maxMegabytes: input.maxMegabytes ?? DEFAULT_ARCHIVE_POLICY.maxMegabytes,
    maxAgeHours: input.maxAgeHours ?? DEFAULT_ARCHIVE_POLICY.maxAgeHours,
  }
}
