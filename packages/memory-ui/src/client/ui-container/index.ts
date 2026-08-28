import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { UiContainer } from './documents.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    uiContainer: UiContainer
  }
}

export function installUiContainer(ctx: ClientContext): UiContainer {
  const container = new UiContainer()
  ctx.provide('uiContainer', container)
  return container
}

export * from './documents.js'
export * from './remote-channel.js'
export * from './remote-protocol.js'
export * from './remote.js'
export * from './SurfaceHost.js'
