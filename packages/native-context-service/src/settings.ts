import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

import type { NativeContextRetrieveLevel } from './types.js'

export const NATIVE_CONTEXT_SETTINGS_NAMESPACE = 'dsh-patchouli-native-context'

export interface NativeContextSettings {
  effort: NativeContextRetrieveLevel
  agent: boolean
  standardProvider: string
  standardModel: string
  standardReasoningEffort: string
  standardMaxTokens: number | null
  lowMaxCharacters: number
  mediumMaxCharacters: number
  highMaxCharacters: number
  gitEnabled: boolean
  gitFetchRemote: boolean
  gitFetchIntervalMinutes: number
  gitCommitLimit: number
  gitPathLimit: number
}

export const DEFAULT_NATIVE_CONTEXT_SETTINGS: NativeContextSettings = {
  effort: 'medium',
  agent: true,
  standardProvider: 'deepseek-official',
  standardModel: 'deepseek-chat',
  standardReasoningEffort: '',
  standardMaxTokens: null,
  lowMaxCharacters: 8_000,
  mediumMaxCharacters: 32_000,
  highMaxCharacters: 100_000,
  gitEnabled: true,
  gitFetchRemote: false,
  gitFetchIntervalMinutes: 15,
  gitCommitLimit: 20,
  gitPathLimit: 100,
}

export const NativeContextSettings: z<NativeContextSettings> = z.object({
  effort: z.union(['low', 'medium', 'high']).default('medium'),
  agent: z.boolean().default(true),
  standardProvider: z.string().default('deepseek-official'),
  standardModel: z.string().default('deepseek-chat'),
  standardReasoningEffort: z.string().default(''),
  standardMaxTokens: z.union([z.const(null), z.natural().min(1).max(128_000)]).default(null),
  lowMaxCharacters: z.natural().min(1).max(100_000).default(8_000),
  mediumMaxCharacters: z.natural().min(1).max(100_000).default(32_000),
  highMaxCharacters: z.natural().min(1).max(100_000).default(100_000),
  gitEnabled: z.boolean().default(true),
  gitFetchRemote: z.boolean().default(false),
  gitFetchIntervalMinutes: z.natural().min(1).max(1_440).default(15),
  gitCommitLimit: z.natural().min(1).max(100).default(20),
  gitPathLimit: z.natural().min(1).max(500).default(100),
})

interface NativeContextSettingsScope {
  get(): NativeContextSettings
  watch(callback: (next: NativeContextSettings) => void): () => void
}

interface SettingsHostContext extends Context {
  readonly settings: {
    register(
      namespace: string,
      schema: z<NativeContextSettings>,
      options: { readonly base: Partial<NativeContextSettings>; readonly applies: 'live' },
    ): NativeContextSettingsScope
  }
}

export function installNativeContextSettings(
  ctx: Context,
  base: Partial<NativeContextSettings>,
  applySettings: (settings: NativeContextSettings) => void,
): void {
  const host = ctx as Context & {
    inject(
      services: readonly string[],
      callback: (scope: SettingsHostContext) => (() => void) | void,
    ): void
  }
  host.inject(['settings'], (scope) => {
    const settings = scope.settings.register(
      NATIVE_CONTEXT_SETTINGS_NAMESPACE,
      NativeContextSettings,
      { base, applies: 'live' },
    )
    applySettings(settings.get())
    return settings.watch(next => applySettings(next))
  })
}
