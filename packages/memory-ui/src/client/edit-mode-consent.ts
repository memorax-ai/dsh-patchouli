import { PATCHOULI_VERSION } from './build-info.js'

const CONSENT_KEY = `dsh-patchouli/edit-mode-consent/${PATCHOULI_VERSION}`

let confirmedInRuntime = false

export function hasEditModeConsent(): boolean {
  if (confirmedInRuntime) return true
  try {
    return window.localStorage.getItem(CONSENT_KEY) === 'confirmed'
  } catch {
    return false
  }
}

export function confirmEditMode(): void {
  confirmedInRuntime = true
  try {
    window.localStorage.setItem(CONSENT_KEY, 'confirmed')
  } catch {
    // Runtime confirmation still applies when browser persistence is unavailable.
  }
}
