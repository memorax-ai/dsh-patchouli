import type { GitIndexModule } from '../index/git.js'
import type { SessionIndex } from '../index/session.js'
import type { WorkspaceIndexModule } from '../index/workspace.js'
import type { NativeContextService } from '../service.js'
import type { NativeContextModuleContext } from '../types.js'
import type { FastRetrieveHit } from './fast.js'

export const SOURCE_EXPANDER_MAX_CHARACTERS = 32_000

/** Expands a ranked hit through its native source instead of another fuzzy query. */
export class SourceExpander {
  constructor(private readonly nativeContext: NativeContextService) {}

  async expand(
    hit: FastRetrieveHit,
    context: NativeContextModuleContext,
  ): Promise<FastRetrieveHit> {
    context.signal?.throwIfAborted()
    const source = hit.source
    if ('type' in source && this.nativeContext.hasIndex('session')) {
      const records = await (this.nativeContext.getIndex('session') as SessionIndex)
        .expand(source, context)
      const text = records
        .filter(record => record.text.trim() !== '')
        .map(record => `[${record.kind} #${record.source.seq}]\n${record.text}`)
        .join('\n\n')
      return text === '' ? hit : { ...hit, text: bounded(text) }
    }
    if ('kind' in source && source.kind === 'workspace-file' && this.nativeContext.hasIndex('workspace')) {
      const text = await (this.nativeContext.getIndex('workspace') as WorkspaceIndexModule)
        .expand(source, context, SOURCE_EXPANDER_MAX_CHARACTERS)
      return text === null ? hit : { ...hit, text: bounded(`${source.path}\n${text}`) }
    }
    if ('kind' in source && source.kind === 'git' && this.nativeContext.hasIndex('git')) {
      const text = await (this.nativeContext.getIndex('git') as GitIndexModule)
        .expand(source, context)
      return text === null ? hit : { ...hit, text: bounded(text) }
    }
    return hit
  }
}

function bounded(text: string): string {
  return text.slice(0, SOURCE_EXPANDER_MAX_CHARACTERS)
}
