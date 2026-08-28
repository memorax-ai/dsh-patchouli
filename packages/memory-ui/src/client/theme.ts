import { useSyncExternalStore, type CSSProperties } from 'react'

const themeProperties = {
  foreground: '--dsw-alias-label-primary',
  foregroundSecondary: '--dsw-alias-label-secondary',
  foregroundMuted: '--dsw-alias-label-tertiary',
  foregroundCaption: '--dsw-alias-label-caption',
  surface: '--dsw-alias-bg-base',
  surfaceRaised: '--dsw-specific-input-major',
  surfaceHover: '--dsw-alias-interactive-bg-hover',
  surfaceTip: '--dsw-specific-tip',
  border: '--dsw-alias-border-l2',
  borderSubtle: '--dsw-alias-border-l1',
  accent: '--dsw-alias-state-business-primary',
  accentMuted: '--dsw-alias-state-business-tertiary',
  shadowControl: '--dsw-shadow-lv1',
  shadowPopover: '--dsw-shadow-lv2',
  shadowPanel: '--dsw-shadow-lv3',
  fontFamily: '--dsw-font-family',
  fontFamilyCode: '--ds-font-family-code',
  fontControl: '--dsw-font-xs-13',
  motionEasing: '--ds-ease-out',
  panelRadius: '--patchouli-radius-panel',
  selectionRadius: '--patchouli-radius-selection',
} as const

export type PatchouliMode = 'browse' | 'edit'
export type PatchouliTheme = Partial<Record<keyof typeof themeProperties, string>>
export type PatchouliThemeConfig = {
  browse?: PatchouliTheme
  edit?: PatchouliTheme
}

class PatchouliThemeController {
  readonly #listeners = new Set<() => void>()
  #config: Readonly<PatchouliThemeConfig> = Object.freeze({})

  set(config: PatchouliThemeConfig): void {
    this.#config = Object.freeze({
      browse: config.browse ? Object.freeze({ ...config.browse }) : undefined,
      edit: config.edit ? Object.freeze({ ...config.edit }) : undefined,
    })
    for (const listener of this.#listeners) listener()
  }

  reset(): void {
    this.set({})
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  getSnapshot = (): Readonly<PatchouliThemeConfig> => this.#config
}

export const patchouliTheme = new PatchouliThemeController()

export function usePatchouliThemeStyle(mode: PatchouliMode): CSSProperties {
  const config = useSyncExternalStore(
    patchouliTheme.subscribe,
    patchouliTheme.getSnapshot,
    patchouliTheme.getSnapshot,
  )
  const theme = mode === 'edit'
    ? { ...config.browse, ...config.edit }
    : config.browse ?? {}
  return Object.fromEntries(
    Object.entries(theme).map(([key, value]) => [
      themeProperties[key as keyof typeof themeProperties],
      value,
    ]),
  ) as CSSProperties
}
