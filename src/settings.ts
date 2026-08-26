import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

export const PATCHOULI_SETTINGS_NAMESPACE = 'dsh-patchouli'

export interface PatchouliSettings {
  retrieveTimeoutMs: number
}

export const PatchouliSettings: z<PatchouliSettings> = z.object({
  retrieveTimeoutMs: z.natural().min(1).default(30_000),
})

interface SettingsHostContext extends Context {
  readonly settings: {
    register<T>(
      namespace: string,
      schema: z<T>,
      options: { readonly base: Partial<T>; readonly applies: 'live' | 'restart' },
    ): unknown
  }
}

export function installPatchouliSettings(
  ctx: Context,
  base: Partial<PatchouliSettings>,
): void {
  const host = ctx as Context & {
    inject(
      services: readonly string[],
      callback: (scope: SettingsHostContext) => unknown,
    ): void
  }
  host.inject(['settings'], (scope) => {
    scope.settings.register(
      PATCHOULI_SETTINGS_NAMESPACE,
      PatchouliSettings,
      { base, applies: 'restart' },
    )
  })
}
