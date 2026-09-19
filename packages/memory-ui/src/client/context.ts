import type { Context } from '@deepseek-ai/cordis'
import type { SlotCore, SlotMap } from '@deepseek-ai/dsh-client-ui-slots'

/** The stable composition face shared by the legacy runtime and UI renderer. */
export type MemoryClientContext = Context & {
  slots: Pick<SlotCore, 'register'> & {
    inject(key: keyof SlotMap & string, setup: () => () => void): () => void
  }
}
