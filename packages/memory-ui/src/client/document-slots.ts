import type {
  DocumentRef,
} from './ui-container/index.js'
import type { DocumentRenderRequest } from './ui-workspace/index.js'
import type { KnowledgeScope } from './session-layout.js'
import type { PatchouliMode } from './theme.js'

export type { DocumentRenderRequest } from './ui-workspace/index.js'

export type AgentSurfaceProps = {
  scope: KnowledgeScope
  mode: PatchouliMode
  activeDocument?: DocumentRef
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'patchouli.document.renderer': {
      kind: 'chain'
      scope: 'session'
      owner: DocumentRenderRequest
    }
    'patchouli.agent.surface': {
      kind: 'single'
      scope: 'session'
      owner: AgentSurfaceProps
    }
  }
}
