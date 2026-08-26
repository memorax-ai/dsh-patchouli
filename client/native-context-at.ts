const BRIDGE_KEY = '__dshPatchouliNativeContextAt'
const SEARCH_DEBOUNCE_MS = 180

export type NativeContextAtAppearance = 'file' | 'session'

export interface NativeContextAtSearchRequest {
  readonly sessionId: string
  readonly query: string
  readonly signal: AbortSignal
}

export interface NativeContextAtResult {
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly detail?: string
  readonly sourceLabel?: string
  readonly ref: string
  readonly appearance?: NativeContextAtAppearance
  readonly clipboardText?: string
}

export interface NativeContextAtProvider {
  /** Async-iterable batches are deltas; the @ menu keeps earlier ids and updates matching ones. */
  search(request: NativeContextAtSearchRequest):
    | Promise<readonly NativeContextAtResult[]>
    | AsyncIterable<readonly NativeContextAtResult[]>
}

interface NativeContextSettingsPresence {
  getSnapshot(): { readonly status: 'loading' | 'ready' | 'unavailable' }
}

interface TriggerCandidate {
  readonly name: string
  readonly description?: string
  readonly detail?: string
  readonly section?: string
  readonly value: string
}

export interface NativeContextAtInputTriggers {
  registerSource(source: {
    readonly trigger: '@'
    readonly name: 'patchouli-reference'
    readonly showGroupTitle: false
    candidates(
      session: { readonly sessionId: string },
      request: { readonly query: string; readonly signal: AbortSignal },
    ): AsyncIterable<readonly TriggerCandidate[]>
    onPick(input: { readonly candidate: TriggerCandidate }): TriggerInsertOutcome | undefined
  }): () => void
}

interface TriggerInsertOutcome {
  readonly insert: {
    readonly source: 'reference'
    readonly ref: string
    readonly label: string
    readonly appearance: NativeContextAtAppearance
    readonly clipboardText: string
  }
}

interface NativeContextAtValue extends NativeContextAtResult {
  readonly kind: 'native-context'
}

interface NativeContextAtStatusValue {
  readonly kind: 'native-context-status'
}

interface NativeContextAtBridge {
  enabled(): boolean
  candidates(
    session: { readonly sessionId: string },
    request: { readonly query: string; readonly signal: AbortSignal },
  ): AsyncIterable<readonly TriggerCandidate[]>
  onPick(value: unknown): TriggerInsertOutcome | undefined
}

let provider: NativeContextAtProvider | undefined

export function registerNativeContextAtProvider(next: NativeContextAtProvider): () => void {
  provider = next
  return () => {
    if (provider === next) provider = undefined
  }
}

export function installNativeContextAtBridge(
  settings: NativeContextSettingsPresence,
  inputTriggers: NativeContextAtInputTriggers,
): () => void {
  const bridge: NativeContextAtBridge = {
    enabled: () => settings.getSnapshot().status === 'ready',
    candidates: (session, request) => nativeContextCandidates(session.sessionId, request),
    onPick: nativeContextPick,
  }
  const target = globalThis as typeof globalThis & Record<string, unknown>
  target[BRIDGE_KEY] = bridge
  const unregister = inputTriggers.registerSource({
    trigger: '@',
    name: 'patchouli-reference',
    showGroupTitle: false,
    candidates: (session, request) => bridge.candidates(session, request),
    onPick: ({ candidate }) => bridge.onPick(parseCandidateValue(candidate.value)),
  })
  return () => {
    unregister()
    if (target[BRIDGE_KEY] === bridge) delete target[BRIDGE_KEY]
  }
}

async function* nativeContextCandidates(
  sessionId: string,
  request: { readonly query: string; readonly signal: AbortSignal },
): AsyncGenerator<readonly TriggerCandidate[], void, void> {
  const copy = nativeContextAtCopy()
  const section = `Patchouli · ${copy.fast}`
  if (request.query.trim() === '') {
    yield [statusCandidate(copy.prompt, copy.promptDescription, section)]
    return
  }
  if (provider === undefined) {
    yield [statusCandidate(copy.pending, copy.pendingDescription, section)]
    return
  }

  // Keep the same suggestion panel mounted while debounce and retrieval run.
  yield [statusCandidate(copy.searching, copy.searchingDescription, section)]
  if (!await waitForSearch(request.signal)) return

  const result = provider.search({ sessionId, query: request.query, signal: request.signal })
  if (!isAsyncIterable(result)) {
    const results = await result
    if (!request.signal.aborted) {
      yield results.length === 0
        ? [statusCandidate(copy.empty, copy.emptyDescription, section)]
        : toCandidates(results, section)
    }
    return
  }

  const accumulated = new Map<string, NativeContextAtResult>()
  for await (const batch of result) {
    if (request.signal.aborted) return
    for (const item of batch) accumulated.set(item.id, item)
    if (batch.length > 0) yield toCandidates([...accumulated.values()], section)
  }
  if (accumulated.size === 0 && !request.signal.aborted) {
    yield [statusCandidate(copy.empty, copy.emptyDescription, section)]
  }
}

function statusCandidate(
  name: string,
  description: string,
  section: string,
): TriggerCandidate {
  return {
    name,
    description,
    section,
    value: JSON.stringify({ kind: 'native-context-status' } satisfies NativeContextAtStatusValue),
  }
}

function toCandidates(
  results: readonly NativeContextAtResult[],
  section: string,
): readonly TriggerCandidate[] {
  return results.map(result => ({
    name: result.label,
    description: [result.sourceLabel, result.description].filter(Boolean).join(' · ') || undefined,
    detail: result.detail,
    section,
    value: JSON.stringify({ kind: 'native-context', ...result } satisfies NativeContextAtValue),
  }))
}

function nativeContextPick(value: unknown): TriggerInsertOutcome | undefined {
  if (!isObject(value) || value.kind !== 'native-context') return undefined
  const result = value as unknown as NativeContextAtValue
  return {
    insert: {
      source: 'reference',
      ref: result.ref,
      label: result.label,
      appearance: result.appearance ?? 'file',
      clipboardText: result.clipboardText ?? result.ref,
    },
  }
}

function nativeContextAtCopy(): {
  readonly fast: string
  readonly prompt: string
  readonly promptDescription: string
  readonly pending: string
  readonly pendingDescription: string
  readonly searching: string
  readonly searchingDescription: string
  readonly empty: string
  readonly emptyDescription: string
} {
  return typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('zh')
    ? {
        fast: '即时检索',
        prompt: '输入关键词以查询本地上下文',
        promptDescription: 'Session、工作区、项目、产物与 Git 上下文',
        pending: 'Fast 查询接口等待后端接入',
        pendingDescription: '前端重载已经启用，检索服务尚未连接',
        searching: '正在检索本地上下文',
        searchingDescription: '匹配结果会持续添加到这里',
        empty: '没有相关内容',
        emptyDescription: '尝试更换关键词或缩短查询内容',
      }
    : {
        fast: 'Fast retrieval',
        prompt: 'Type to search local context',
        promptDescription: 'Sessions, workspace, project, artifacts, and Git context',
        pending: 'Fast search is waiting for its backend',
        pendingDescription: 'The frontend override is active; the retrieval service is not connected yet',
        searching: 'Searching local context',
        searchingDescription: 'Matching results will be added here as they arrive',
        empty: 'No related content',
        emptyDescription: 'Try another keyword or a shorter query',
      }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseCandidateValue(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T> {
  return isObject(value)
    && Symbol.asyncIterator in value
    && typeof value[Symbol.asyncIterator] === 'function'
}

function waitForSearch(signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise(resolve => {
    const finish = (ready: boolean): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      resolve(ready)
    }
    const abort = (): void => finish(false)
    const timer = setTimeout(() => finish(true), SEARCH_DEBOUNCE_MS)
    signal.addEventListener('abort', abort, { once: true })
  })
}
