import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { ArchivePolicy } from './archive.js'

export type ArchivePolicyOverride = Partial<ArchivePolicy>
type MutableArchivePolicyOverride = { -readonly [Key in keyof ArchivePolicy]?: ArchivePolicy[Key] }

function directoryName(logicalId: string): string {
  return Buffer.from(logicalId, 'utf8').toString('base64url') || '_'
}

function decodePolicyOverride(value: unknown): ArchivePolicyOverride {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('archive policy override must be an object')
  }
  const source = value as Record<string, unknown>
  const override: MutableArchivePolicyOverride = {}
  if (source.enabled !== undefined) {
    if (typeof source.enabled !== 'boolean') throw new Error('archive policy enabled override must be a boolean')
    override.enabled = source.enabled
  }
  for (const key of ['maxEvents', 'maxMegabytes', 'maxAgeHours'] as const) {
    const candidate = source[key]
    if (candidate === undefined) continue
    if (!Number.isSafeInteger(candidate) || (candidate as number) < 0) {
      throw new Error(`archive policy ${key} override must be a non-negative integer`)
    }
    override[key] = candidate as number
  }
  return override
}

export class ArchivePolicyStore {
  constructor(private readonly root: string) {}

  async read(logicalId: string): Promise<ArchivePolicyOverride | undefined> {
    try {
      return decodePolicyOverride(JSON.parse(await readFile(this.path(logicalId), 'utf8')) as unknown)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  async write(
    logicalId: string,
    input: ArchivePolicyOverride | undefined,
  ): Promise<ArchivePolicyOverride | undefined> {
    const path = this.path(logicalId)
    if (input === undefined || Object.keys(input).length === 0) {
      await rm(path, { force: true })
      return undefined
    }
    const override = decodePolicyOverride(input)
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, `${JSON.stringify(override)}\n`, { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, path)
    } finally {
      await rm(temporary, { force: true })
    }
    return override
  }

  private path(logicalId: string): string {
    return join(this.root, directoryName(logicalId), 'policy.json')
  }
}
