import type { ChangeEvent, ComponentType, KeyboardEvent, ReactElement, ReactNode } from 'react'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'
import {
  NATIVE_CONTEXT_AT_REMOTE,
  type NativeContextAtClient,
  type NativeContextAtSearchResult,
} from '../src/native-context-at.js'

import { PATCHOULI_ICON_MONOCHROME_DATA_URL, PATCHOULI_ICON_NAV_MASK_DATA_URL } from './patchouli-icon.js'
import {
  installNativeContextAtBridge,
  registerNativeContextAtProvider,
  type NativeContextAtInputTriggers,
} from './native-context-at.js'

export {
  registerNativeContextAtProvider,
  type NativeContextAtAppearance,
  type NativeContextAtProvider,
  type NativeContextAtResult,
  type NativeContextAtSearchRequest,
} from './native-context-at.js'

const CORE_NAMESPACE = 'dsh-patchouli'
const NATIVE_NAMESPACE = 'dsh-patchouli-native-context'
const FLEET_NAMESPACE = 'dsh-fleet-patchouli'
const STYLE_ID = 'dsh-patchouli-settings-style'

export const PATCHOULI_SETTINGS_SLOTS = {
  navigation: 'patchouli.settings.navigation',
  content: 'patchouli.settings.content',
} as const

type Effort = 'low' | 'medium' | 'high'

interface CoreSettings {
  readonly retrieveTimeoutMs: number
}

interface NativeSettings {
  readonly effort: Effort
  readonly agent: boolean
  readonly standardProvider: string
  readonly standardModel: string
  readonly standardReasoningEffort: string
  readonly standardMaxTokens: number | null
  readonly lowMaxCharacters: number
  readonly mediumMaxCharacters: number
  readonly highMaxCharacters: number
  readonly gitEnabled: boolean
  readonly gitFetchRemote: boolean
  readonly gitFetchIntervalMinutes: number
  readonly gitCommitLimit: number
  readonly gitPathLimit: number
}

interface FleetSettings {
  readonly effort: Effort
  readonly agent: boolean
}

interface SettingsSnapshot<T> {
  readonly status: 'loading' | 'ready' | 'unavailable'
  readonly value?: T
  readonly writable?: boolean
}

interface SettingsScope<T> {
  getSnapshot(): SettingsSnapshot<T>
  subscribe(listener: () => void): () => void
  set<K extends keyof T>(field: K, value: T[K]): Promise<void>
}

interface ClientContext {
  effect(callback: () => void | (() => void), label?: string): void
  readonly settingsScope: {
    bind<T>(options: {
      readonly namespace: string
      readonly decode: (value: unknown) => T | undefined
    }): SettingsScope<T>
  }
  readonly remote: {
    $mount(contribution: typeof NATIVE_CONTEXT_AT_REMOTE): Promise<() => Promise<void>>
  }
  readonly slots: {
    inject(name: string, register: () => unknown): void
    register(options: {
      readonly name: string
      readonly id: string
      readonly key?: string
      readonly order?: number
      readonly label?: () => string
      readonly children?: Readonly<Record<string, {
        readonly kind: 'single' | 'list' | 'keyed'
        readonly scope: 'session'
      }>>
    }, component: ComponentType<any>): unknown
  }
  get?(name: string): unknown
}

export interface PatchouliSettingsNavItemProps {
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly active: boolean
  readonly onSelect: (id: string) => void
}

export interface PatchouliSettingsNavigationOwner {
  readonly active: string
  readonly select: (id: string) => void
  readonly NavItem: ComponentType<PatchouliSettingsNavItemProps>
}

export interface PatchouliSettingsContentOwner {
  readonly active: string
  readonly reportFailure: () => void
}

type PatchouliSettingsRenderSlot = (
  name: string,
  owner: Readonly<Record<string, unknown>>,
  options?: { readonly only?: string; readonly fallback?: ReactNode },
) => ReactNode

interface Copy {
  readonly intro: string
  readonly core: string
  readonly coreDescription: string
  readonly native: string
  readonly nativeDescription: string
  readonly fleet: string
  readonly fleetDescription: string
  readonly timeout: string
  readonly timeoutDescription: string
  readonly restart: string
  readonly effort: string
  readonly effortDescription: string
  readonly agent: string
  readonly agentDescription: string
  readonly standardRunner: string
  readonly standardRunnerDescription: string
  readonly standardProvider: string
  readonly standardProviderDescription: string
  readonly standardModel: string
  readonly standardModelDescription: string
  readonly standardReasoning: string
  readonly standardReasoningDescription: string
  readonly providerDefault: string
  readonly noLimit: string
  readonly standardMaxTokens: string
  readonly standardMaxTokensDescription: string
  readonly highWithoutAgent: string
  readonly budget: string
  readonly budgetDescription: string
  readonly low: string
  readonly medium: string
  readonly high: string
  readonly characters: string
  readonly git: string
  readonly gitDescription: string
  readonly gitRemote: string
  readonly gitRemoteDescription: string
  readonly gitFetchInterval: string
  readonly gitFetchIntervalDescription: string
  readonly gitCommits: string
  readonly gitCommitsDescription: string
  readonly gitPaths: string
  readonly gitPathsDescription: string
  readonly unavailable: string
  readonly readOnly: string
  readonly writeFailed: string
}

const zh: Copy = {
  intro: '统一管理 Patchouli 与已接入处理器。每个插件仍保存自己的设置。',
  core: '核心',
  coreDescription: 'Patchouli 路由与运行边界。',
  native: '本地上下文',
  nativeDescription: '普通会话可用的本地索引与分级检索。',
  fleet: '团队记忆',
  fleetDescription: 'Agent Fleet 的团队历史与共享上下文。',
  timeout: '检索超时',
  timeoutDescription: '单次记忆检索允许等待的最长时间。',
  restart: '重启后生效',
  effort: '默认检索档位',
  effortDescription: '档位决定本地扫描、聚合范围与返回预算。',
  agent: 'Agent 辅助',
  agentDescription: '独立于检索档位；开启后，标准检索可使用模型进行查询规划和结果综合。',
  standardRunner: 'Standard Runner',
  standardRunnerDescription: '标准检索使用同一个模型先规划查询，再综合 Fast 检索结果。',
  standardProvider: 'Provider',
  standardProviderDescription: 'DSH 中已注册的模型 Provider 标识。',
  standardModel: '模型',
  standardModelDescription: 'Provider 接受的模型标识。',
  standardReasoning: '思考等级',
  standardReasoningDescription: '留空时使用模型或 Provider 的默认值。',
  providerDefault: 'Provider 默认',
  noLimit: '不限制',
  standardMaxTokens: '最大输出 Token',
  standardMaxTokensDescription: '留空时不主动限制；填写后作为规划与综合两次模型调用各自的输出上限。',
  highWithoutAgent: '高档位仍会执行大范围本地检索，但不会进行 Agent 查询规划与综合。',
  budget: '返回内容预算',
  budgetDescription: '各档位最多返回的字符数。',
  low: '快速',
  medium: '标准',
  high: '深度',
  characters: '字符',
  git: 'Git 上下文',
  gitDescription: '索引当前工作区的仓库状态、近期提交与未提交变更。',
  gitRemote: '同步远端',
  gitRemoteDescription: '定期抓取所有远端 refs 并纳入检索；认证复用运行 DSH 的 SSH 或 Git 凭据。',
  gitFetchInterval: '远端刷新间隔',
  gitFetchIntervalDescription: '两次 git fetch 之间的最小间隔。',
  gitCommits: '近期提交',
  gitCommitsDescription: '每次索引读取的最近提交数量。',
  gitPaths: '变更路径',
  gitPathsDescription: '每次索引读取的未提交变更路径数量。',
  unavailable: '该组件当前未加载。安装并启用后会自动出现在这里。',
  readOnly: '当前设置只读。',
  writeFailed: '保存失败，请重试。',
}

const en: Copy = {
  intro: 'Configure Patchouli and connected processors in one place. Each plugin remains the owner of its settings.',
  core: 'Core',
  coreDescription: 'Patchouli routing and runtime boundaries.',
  native: 'Native context',
  nativeDescription: 'Local indexing and tiered retrieval for ordinary sessions.',
  fleet: 'Fleet memory',
  fleetDescription: 'Team history and shared context for Agent Fleet.',
  timeout: 'Retrieval timeout',
  timeoutDescription: 'Maximum time allowed for one memory retrieval.',
  restart: 'Applies after restart',
  effort: 'Default retrieval effort',
  effortDescription: 'Effort controls local scan breadth, aggregation, and result budget.',
  agent: 'Agent assistance',
  agentDescription: 'Independent from effort. Standard retrieval can use a model for query planning and result synthesis.',
  standardRunner: 'Standard Runner',
  standardRunnerDescription: 'Standard retrieval uses one model to plan queries, then synthesize Fast retrieval evidence.',
  standardProvider: 'Provider',
  standardProviderDescription: 'Provider route registered in DSH.',
  standardModel: 'Model',
  standardModelDescription: 'Model identifier accepted by the selected Provider.',
  standardReasoning: 'Reasoning effort',
  standardReasoningDescription: 'Leave empty to use the model or Provider default.',
  providerDefault: 'Provider default',
  noLimit: 'No limit',
  standardMaxTokens: 'Maximum output tokens',
  standardMaxTokensDescription: 'Leave empty to avoid an explicit limit; otherwise applies to each planning and synthesis call.',
  highWithoutAgent: 'High effort still performs broad local retrieval, without Agent planning or synthesis.',
  budget: 'Result budgets',
  budgetDescription: 'Maximum returned characters for each effort tier.',
  low: 'Low',
  medium: 'Standard',
  high: 'High',
  characters: 'characters',
  git: 'Git context',
  gitDescription: 'Index repository state, recent commits, and uncommitted changes for the current workspace.',
  gitRemote: 'Sync remotes',
  gitRemoteDescription: 'Periodically fetch all remote refs for retrieval, using the SSH or Git credentials available to DSH.',
  gitFetchInterval: 'Remote refresh interval',
  gitFetchIntervalDescription: 'Minimum interval between git fetch operations.',
  gitCommits: 'Recent commits',
  gitCommitsDescription: 'Number of recent commits read by each indexing pass.',
  gitPaths: 'Changed paths',
  gitPathsDescription: 'Number of uncommitted paths read by each indexing pass.',
  unavailable: 'This component is not loaded. It will appear here when installed and enabled.',
  readOnly: 'These settings are read-only.',
  writeFailed: 'Could not save the setting. Try again.',
}

function currentCopy(): Copy {
  return typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('zh') ? zh : en
}

function object(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined
}

function effort(value: unknown): Effort | undefined {
  return value === 'low' || value === 'medium' || value === 'high' ? value : undefined
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function decodeCore(value: unknown): CoreSettings | undefined {
  const source = object(value)
  const retrieveTimeoutMs = positiveInteger(source?.retrieveTimeoutMs)
  return retrieveTimeoutMs === undefined ? undefined : { retrieveTimeoutMs }
}

function decodeNative(value: unknown): NativeSettings | undefined {
  const source = object(value)
  const selectedEffort = effort(source?.effort)
  const standardProvider = string(source?.standardProvider)
  const standardModel = string(source?.standardModel)
  const standardReasoningEffort = string(source?.standardReasoningEffort)
  const standardMaxTokens = source?.standardMaxTokens === null
    ? null
    : positiveInteger(source?.standardMaxTokens)
  const lowMaxCharacters = positiveInteger(source?.lowMaxCharacters)
  const mediumMaxCharacters = positiveInteger(source?.mediumMaxCharacters)
  const highMaxCharacters = positiveInteger(source?.highMaxCharacters)
  const gitCommitLimit = positiveInteger(source?.gitCommitLimit)
  const gitPathLimit = positiveInteger(source?.gitPathLimit)
  const gitFetchIntervalMinutes = positiveInteger(source?.gitFetchIntervalMinutes)
  if (selectedEffort === undefined || typeof source?.agent !== 'boolean'
    || standardProvider === undefined || standardModel === undefined
    || standardReasoningEffort === undefined || standardMaxTokens === undefined
    || lowMaxCharacters === undefined || mediumMaxCharacters === undefined
    || highMaxCharacters === undefined || typeof source?.gitEnabled !== 'boolean'
    || typeof source?.gitFetchRemote !== 'boolean' || gitFetchIntervalMinutes === undefined
    || gitCommitLimit === undefined || gitPathLimit === undefined) return undefined
  return {
    effort: selectedEffort,
    agent: source.agent,
    standardProvider,
    standardModel,
    standardReasoningEffort,
    standardMaxTokens,
    lowMaxCharacters,
    mediumMaxCharacters,
    highMaxCharacters,
    gitEnabled: source.gitEnabled,
    gitFetchRemote: source.gitFetchRemote,
    gitFetchIntervalMinutes,
    gitCommitLimit,
    gitPathLimit,
  }
}

function decodeFleet(value: unknown): FleetSettings | undefined {
  const source = object(value)
  const selectedEffort = effort(source?.effort)
  return selectedEffort === undefined || typeof source?.agent !== 'boolean'
    ? undefined
    : { effort: selectedEffort, agent: source.agent }
}

function PatchouliMark(): ReactElement {
  return jsx('img', {
    src: PATCHOULI_ICON_MONOCHROME_DATA_URL,
    className: 'dsh-patchouli-mark',
    alt: '',
    'aria-hidden': 'true',
  })
}

function useScope<T>(scope: SettingsScope<T>): SettingsSnapshot<T> {
  return useSyncExternalStore(
    listener => scope.subscribe(listener),
    () => scope.getSnapshot(),
    () => scope.getSnapshot(),
  )
}

function SettingRow({ title, description, children }: {
  readonly title: string
  readonly description: string
  readonly children: ReactElement
}): ReactElement {
  return jsxs('div', {
    className: 'dsh-patchouli-setting-row',
    children: [
      jsxs('div', {
        className: 'dsh-patchouli-setting-copy',
        children: [jsx('strong', { children: title }), jsx('span', { children: description })],
      }),
      jsx('div', { className: 'dsh-patchouli-setting-control', children }),
    ],
  })
}

function EffortControl({ value, disabled, copy, onChange }: {
  readonly value: Effort
  readonly disabled: boolean
  readonly copy: Copy
  readonly onChange: (value: Effort) => void
}): ReactElement {
  return jsx('div', {
    className: 'dsh-patchouli-segments',
    role: 'radiogroup',
    'aria-label': copy.effort,
    children: (['low', 'medium', 'high'] as const).map(item => jsx('button', {
      type: 'button',
      role: 'radio',
      disabled,
      'aria-checked': value === item ? 'true' : 'false',
      onClick: () => { onChange(item) },
      children: copy[item],
    }, item)),
  })
}

function Toggle({ value, disabled, label, onChange }: {
  readonly value: boolean
  readonly disabled: boolean
  readonly label: string
  readonly onChange: (value: boolean) => void
}): ReactElement {
  return jsx('button', {
    type: 'button',
    className: 'dsh-patchouli-toggle',
    role: 'switch',
    disabled,
    'aria-label': label,
    'aria-checked': value ? 'true' : 'false',
    onClick: () => { onChange(!value) },
    children: jsx('span', {}),
  })
}

function NumberField({ value, disabled, suffix, max, onCommit }: {
  readonly value: number
  readonly disabled: boolean
  readonly suffix: string
  readonly max?: number
  readonly onCommit: (value: number) => void
}): ReactElement {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => { setDraft(String(value)) }, [value])
  const commit = () => {
    const next = Number(draft)
    if (!Number.isSafeInteger(next) || next < 1 || (max !== undefined && next > max)) {
      setDraft(String(value))
      return
    }
    if (next !== value) onCommit(next)
  }
  return jsxs('label', {
    className: 'dsh-patchouli-number',
    children: [
      jsx('input', {
        type: 'number', min: 1, max, step: 1, value: draft, disabled,
        onChange: (event: ChangeEvent<HTMLInputElement>) => { setDraft(event.target.value) },
        onBlur: commit,
        onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => { if (event.key === 'Enter') event.currentTarget.blur() },
      }),
      jsx('span', { children: suffix }),
    ],
  })
}

function OptionalNumberField({ value, disabled, suffix, max, placeholder, onCommit }: {
  readonly value: number | null
  readonly disabled: boolean
  readonly suffix: string
  readonly max?: number
  readonly placeholder: string
  readonly onCommit: (value: number | null) => void
}): ReactElement {
  const [draft, setDraft] = useState(value === null ? '' : String(value))
  useEffect(() => { setDraft(value === null ? '' : String(value)) }, [value])
  const commit = () => {
    if (draft.trim() === '') {
      if (value !== null) onCommit(null)
      return
    }
    const next = Number(draft)
    if (!Number.isSafeInteger(next) || next < 1 || (max !== undefined && next > max)) {
      setDraft(value === null ? '' : String(value))
      return
    }
    if (next !== value) onCommit(next)
  }
  return jsxs('label', {
    className: 'dsh-patchouli-number',
    children: [
      jsx('input', {
        type: 'number', min: 1, max, step: 1, value: draft, disabled, placeholder,
        onChange: (event: ChangeEvent<HTMLInputElement>) => { setDraft(event.target.value) },
        onBlur: commit,
        onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => { if (event.key === 'Enter') event.currentTarget.blur() },
      }),
      jsx('span', { children: suffix }),
    ],
  })
}

function TextField({ value, disabled, placeholder, onCommit }: {
  readonly value: string
  readonly disabled: boolean
  readonly placeholder?: string
  readonly onCommit: (value: string) => void
}): ReactElement {
  const [draft, setDraft] = useState(value)
  useEffect(() => { setDraft(value) }, [value])
  const commit = () => {
    const next = draft.trim()
    if (next !== value) onCommit(next)
  }
  return jsx('input', {
    className: 'dsh-patchouli-text',
    type: 'text',
    value: draft,
    disabled,
    placeholder,
    onChange: (event: ChangeEvent<HTMLInputElement>) => { setDraft(event.target.value) },
    onBlur: commit,
    onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => { if (event.key === 'Enter') event.currentTarget.blur() },
  })
}

function ScopeStatus({ snapshot, copy }: {
  readonly snapshot: SettingsSnapshot<unknown>
  readonly copy: Copy
}): ReactElement | null {
  if (snapshot.status === 'loading') return jsx('div', { className: 'dsh-patchouli-status', children: '…' })
  if (snapshot.status === 'unavailable' || snapshot.value === undefined) {
    return jsx('p', { className: 'dsh-patchouli-status', children: copy.unavailable })
  }
  if (snapshot.writable === false) return jsx('p', { className: 'dsh-patchouli-note', children: copy.readOnly })
  return null
}

function CorePanel({ scope, copy, reportFailure }: {
  readonly scope: SettingsScope<CoreSettings>
  readonly copy: Copy
  readonly reportFailure: () => void
}): ReactElement {
  const snapshot = useScope(scope)
  if (snapshot.status !== 'ready' || snapshot.value === undefined) {
    return jsx(ScopeStatus, { snapshot, copy }) ?? jsx('span', {})
  }
  const disabled = snapshot.writable === false
  return jsxs('div', {
    className: 'dsh-patchouli-section',
    children: [
      jsx(ScopeStatus, { snapshot, copy }),
      jsx(SettingRow, {
        title: copy.timeout,
        description: copy.timeoutDescription,
        children: jsx(NumberField, {
          value: snapshot.value.retrieveTimeoutMs,
          disabled,
          suffix: 'ms',
          onCommit: (value: number) => { void scope.set('retrieveTimeoutMs', value).catch(reportFailure) },
        }),
      }),
      jsx('p', { className: 'dsh-patchouli-note', children: copy.restart }),
    ],
  })
}

function RetrievalPanel<T extends { effort: Effort; agent: boolean }>({
  scope, copy, reportFailure, budgets,
}: {
  readonly scope: SettingsScope<T>
  readonly copy: Copy
  readonly reportFailure: () => void
  readonly budgets?: T extends NativeSettings ? true : never
}): ReactElement {
  const snapshot = useScope(scope)
  if (snapshot.status !== 'ready' || snapshot.value === undefined) {
    return jsx(ScopeStatus, { snapshot, copy }) ?? jsx('span', {})
  }
  const value = snapshot.value
  const disabled = snapshot.writable === false
  return jsxs('div', {
    className: 'dsh-patchouli-section',
    children: [
      jsx(ScopeStatus, { snapshot, copy }),
      jsx(SettingRow, {
        title: copy.effort,
        description: copy.effortDescription,
        children: jsx(EffortControl, {
          value: value.effort,
          disabled,
          copy,
          onChange: (next: Effort) => { void scope.set('effort', next as T['effort']).catch(reportFailure) },
        }),
      }),
      jsx(SettingRow, {
        title: copy.agent,
        description: copy.agentDescription,
        children: jsx(Toggle, {
          value: value.agent,
          disabled,
          label: copy.agent,
          onChange: (next: boolean) => { void scope.set('agent', next as T['agent']).catch(reportFailure) },
        }),
      }),
      value.effort === 'high' && !value.agent
        ? jsx('p', { className: 'dsh-patchouli-advisory', children: copy.highWithoutAgent })
        : null,
      budgets === true && jsx(BudgetFields, {
        scope: scope as unknown as SettingsScope<NativeSettings>,
        value: value as unknown as NativeSettings,
        disabled,
        copy,
        reportFailure,
      }),
      budgets === true && value.agent && jsx(StandardFields, {
        scope: scope as unknown as SettingsScope<NativeSettings>,
        value: value as unknown as NativeSettings,
        disabled,
        copy,
        reportFailure,
      }),
      budgets === true && jsx(GitFields, {
        scope: scope as unknown as SettingsScope<NativeSettings>,
        value: value as unknown as NativeSettings,
        disabled,
        copy,
        reportFailure,
      }),
    ],
  })
}

function StandardFields({ scope, value, disabled, copy, reportFailure }: {
  readonly scope: SettingsScope<NativeSettings>
  readonly value: NativeSettings
  readonly disabled: boolean
  readonly copy: Copy
  readonly reportFailure: () => void
}): ReactElement {
  return jsxs('div', {
    className: 'dsh-patchouli-standard-block',
    children: [
      jsxs('div', {
        className: 'dsh-patchouli-setting-copy dsh-patchouli-block-heading',
        children: [jsx('strong', { children: copy.standardRunner }), jsx('span', { children: copy.standardRunnerDescription })],
      }),
      jsx(SettingRow, {
        title: copy.standardProvider,
        description: copy.standardProviderDescription,
        children: jsx(TextField, {
          value: value.standardProvider,
          disabled,
          onCommit: (next: string) => { void scope.set('standardProvider', next).catch(reportFailure) },
        }),
      }),
      jsx(SettingRow, {
        title: copy.standardModel,
        description: copy.standardModelDescription,
        children: jsx(TextField, {
          value: value.standardModel,
          disabled,
          onCommit: (next: string) => { void scope.set('standardModel', next).catch(reportFailure) },
        }),
      }),
      jsx(SettingRow, {
        title: copy.standardReasoning,
        description: copy.standardReasoningDescription,
        children: jsx(TextField, {
          value: value.standardReasoningEffort,
          disabled,
          placeholder: copy.providerDefault,
          onCommit: (next: string) => { void scope.set('standardReasoningEffort', next).catch(reportFailure) },
        }),
      }),
      jsx(SettingRow, {
        title: copy.standardMaxTokens,
        description: copy.standardMaxTokensDescription,
        children: jsx(OptionalNumberField, {
          value: value.standardMaxTokens,
          disabled,
          suffix: 'tokens',
          max: 128_000,
          placeholder: copy.noLimit,
          onCommit: (next: number | null) => { void scope.set('standardMaxTokens', next).catch(reportFailure) },
        }),
      }),
    ],
  })
}

function GitFields({ scope, value, disabled, copy, reportFailure }: {
  readonly scope: SettingsScope<NativeSettings>
  readonly value: NativeSettings
  readonly disabled: boolean
  readonly copy: Copy
  readonly reportFailure: () => void
}): ReactElement {
  return jsxs('div', {
    className: 'dsh-patchouli-git-block',
    children: [
      jsx(SettingRow, {
        title: copy.git,
        description: copy.gitDescription,
        children: jsx(Toggle, {
          value: value.gitEnabled,
          disabled,
          label: copy.git,
          onChange: (next: boolean) => { void scope.set('gitEnabled', next).catch(reportFailure) },
        }),
      }),
      value.gitEnabled && jsx(SettingRow, {
        title: copy.gitRemote,
        description: copy.gitRemoteDescription,
        children: jsx(Toggle, {
          value: value.gitFetchRemote,
          disabled,
          label: copy.gitRemote,
          onChange: (next: boolean) => { void scope.set('gitFetchRemote', next).catch(reportFailure) },
        }),
      }),
      value.gitEnabled && value.gitFetchRemote && jsx(SettingRow, {
        title: copy.gitFetchInterval,
        description: copy.gitFetchIntervalDescription,
        children: jsx(NumberField, {
          value: value.gitFetchIntervalMinutes,
          disabled,
          suffix: 'min',
          max: 1_440,
          onCommit: (next: number) => { void scope.set('gitFetchIntervalMinutes', next).catch(reportFailure) },
        }),
      }),
      value.gitEnabled && jsx(SettingRow, {
        title: copy.gitCommits,
        description: copy.gitCommitsDescription,
        children: jsx(NumberField, {
          value: value.gitCommitLimit,
          disabled,
          suffix: '',
          max: 100,
          onCommit: (next: number) => { void scope.set('gitCommitLimit', next).catch(reportFailure) },
        }),
      }),
      value.gitEnabled && jsx(SettingRow, {
        title: copy.gitPaths,
        description: copy.gitPathsDescription,
        children: jsx(NumberField, {
          value: value.gitPathLimit,
          disabled,
          suffix: '',
          max: 500,
          onCommit: (next: number) => { void scope.set('gitPathLimit', next).catch(reportFailure) },
        }),
      }),
    ],
  })
}

function BudgetFields({ scope, value, disabled, copy, reportFailure }: {
  readonly scope: SettingsScope<NativeSettings>
  readonly value: NativeSettings
  readonly disabled: boolean
  readonly copy: Copy
  readonly reportFailure: () => void
}): ReactElement {
  const fields = [
    ['lowMaxCharacters', copy.low],
    ['mediumMaxCharacters', copy.medium],
    ['highMaxCharacters', copy.high],
  ] as const
  return jsxs('div', {
    className: 'dsh-patchouli-budget-block',
    children: [
      jsxs('div', {
        className: 'dsh-patchouli-setting-copy',
        children: [jsx('strong', { children: copy.budget }), jsx('span', { children: copy.budgetDescription })],
      }),
      jsx('div', {
        className: 'dsh-patchouli-budget-grid',
        children: fields.map(([field, label]) => jsxs('div', {
          children: [
            jsx('span', { children: label }),
            jsx(NumberField, {
              value: value[field], disabled, suffix: copy.characters,
              max: 100_000,
              onCommit: (next: number) => { void scope.set(field, next).catch(reportFailure) },
            }),
          ],
        }, field)),
      }),
    ],
  })
}

function PatchouliSettingsNavItem({
  id,
  label,
  description,
  active,
  onSelect,
}: PatchouliSettingsNavItemProps): ReactElement {
  return jsx('button', {
    type: 'button',
    'aria-current': active ? 'page' : undefined,
    onClick: () => { onSelect(id) },
    children: jsxs('span', {
      children: [
        jsx('strong', { children: label }),
        description === undefined ? null : jsx('small', { children: description }),
      ],
    }),
  })
}

function PatchouliSettingsPage({ core, native, fleet, renderSlot }: {
  readonly core: SettingsScope<CoreSettings>
  readonly native: SettingsScope<NativeSettings>
  readonly fleet: SettingsScope<FleetSettings>
  readonly renderSlot?: PatchouliSettingsRenderSlot
}): ReactElement {
  const copy = currentCopy()
  const nativeSnapshot = useScope(native)
  const fleetSnapshot = useScope(fleet)
  const tabs = [
    { id: 'core' as const, label: copy.core, description: copy.coreDescription },
    ...(nativeSnapshot.status === 'unavailable' ? [] : [{ id: 'native' as const, label: copy.native, description: copy.nativeDescription }]),
    ...(fleetSnapshot.status === 'unavailable' ? [] : [{ id: 'fleet' as const, label: copy.fleet, description: copy.fleetDescription }]),
  ]
  const [selected, setSelected] = useState<string>('core')
  const active = (selected === 'native' && nativeSnapshot.status === 'unavailable')
    || (selected === 'fleet' && fleetSnapshot.status === 'unavailable')
    ? 'core'
    : selected
  const [failed, setFailed] = useState(false)
  const reportFailure = () => { setFailed(true) }
  const select = (id: string) => {
    setSelected(id)
    setFailed(false)
  }
  const navigationOwner: PatchouliSettingsNavigationOwner = {
    active,
    select,
    NavItem: PatchouliSettingsNavItem,
  }
  const contentOwner: PatchouliSettingsContentOwner = { active, reportFailure }
  return jsxs('section', {
    className: 'dsh-patchouli-settings',
    children: [
      jsxs('header', {
        className: 'dsh-patchouli-header',
        children: [
          jsx(PatchouliMark, {}),
          jsxs('div', {
            children: [jsx('h2', { children: 'Patchouli' }), jsx('p', { children: copy.intro })],
          }),
        ],
      }),
      jsxs('div', {
        className: 'dsh-patchouli-layout',
        children: [
          jsx('nav', {
            className: 'dsh-patchouli-nav',
            'aria-label': 'Patchouli',
            children: [
              ...tabs.map(tab => jsx(PatchouliSettingsNavItem, {
                id: tab.id,
                label: tab.label,
                description: tab.description,
                active: active === tab.id,
                onSelect: select,
              }, tab.id)),
              renderSlot?.(
                PATCHOULI_SETTINGS_SLOTS.navigation,
                navigationOwner as unknown as Readonly<Record<string, unknown>>,
              ),
            ],
          }),
          jsxs('main', {
            className: 'dsh-patchouli-content',
            children: [
              failed && jsx('p', { className: 'dsh-patchouli-error', role: 'alert', children: copy.writeFailed }),
              active === 'core' && jsx(CorePanel, { scope: core, copy, reportFailure }),
              active === 'native' && jsx(RetrievalPanel, { scope: native, copy, reportFailure, budgets: true }),
              active === 'fleet' && jsx(RetrievalPanel, { scope: fleet, copy, reportFailure }),
              renderSlot?.(
                PATCHOULI_SETTINGS_SLOTS.content,
                contentOwner as unknown as Readonly<Record<string, unknown>>,
                { only: active },
              ),
            ],
          }),
        ],
      }),
    ],
  })
}

const styles = `
.dsh-patchouli-settings-nav-mark{display:inline-block;width:16px;height:16px;flex:none;background:currentColor;-webkit-mask-image:url("${PATCHOULI_ICON_NAV_MASK_DATA_URL}");-webkit-mask-position:center;-webkit-mask-size:contain;-webkit-mask-repeat:no-repeat;mask-image:url("${PATCHOULI_ICON_NAV_MASK_DATA_URL}");mask-position:center;mask-size:contain;mask-repeat:no-repeat}
.dsh-patchouli-at-detail-shell{position:fixed;z-index:101;box-sizing:border-box;max-width:calc(100vw - 24px);padding:4px;border:1px solid var(--dsw-alias-border-inverted);border-radius:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-specific-menu);box-shadow:var(--dsw-shadow-lv3)}
.dsh-patchouli-at-detail{box-sizing:border-box;width:100%;max-height:min(360px,calc(100vh - 24px));overflow:auto;overflow-wrap:anywhere;white-space:pre-wrap;padding:8px 10px;border-radius:8px;color:var(--dsw-alias-label-primary);background:transparent;font:14px/22px var(--dsw-font-family)}
.dshHarmonySettingsPanel:has(.dsh-patchouli-settings){width:1200px}
.dsh-patchouli-settings{box-sizing:border-box;width:100%;height:100%;min-height:0;max-width:1040px;margin:0 auto;overflow:hidden;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column}
.dsh-patchouli-header{flex:none;display:flex;align-items:center;gap:14px;padding:4px 2px 22px}.dsh-patchouli-header h2{margin:0;font-size:20px;line-height:28px;font-weight:650}.dsh-patchouli-header p{max-width:68ch;margin:3px 0 0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
.dsh-patchouli-mark{width:46px;height:46px;flex:none;object-fit:contain}
.dsh-patchouli-layout{flex:1;min-height:0;overflow:hidden;display:grid;grid-template-columns:minmax(168px,210px) minmax(0,1fr);gap:18px}
.dsh-patchouli-nav{min-height:0;overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable;scrollbar-width:thin;padding-right:4px;display:flex;flex-direction:column;gap:4px}.dsh-patchouli-nav button{appearance:none;width:100%;min-width:0;border:0;border-radius:9px;padding:9px 10px;color:var(--dsw-alias-label-secondary);background:transparent;display:flex;align-items:center;gap:9px;text-align:left;font:inherit;cursor:pointer}.dsh-patchouli-nav button:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}.dsh-patchouli-nav button[aria-current=page]{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-module-platform)}.dsh-patchouli-nav button:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}.dsh-patchouli-nav button>span{min-width:0;display:flex;flex-direction:column}.dsh-patchouli-nav strong{font-size:13px;line-height:19px;font-weight:600}.dsh-patchouli-nav small{overflow:hidden;color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:15px;text-overflow:ellipsis;white-space:nowrap}
.dsh-patchouli-content{min-width:0;min-height:0;overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable;scrollbar-width:thin;border-left:1px solid var(--dsw-alias-border-l3);padding:2px 10px 24px 22px}.dsh-patchouli-section{display:flex;flex-direction:column}.dsh-patchouli-setting-row{min-height:70px;padding:14px 0;border-bottom:1px solid var(--dsw-alias-border-l3);display:flex;align-items:center;justify-content:space-between;gap:18px}.dsh-patchouli-setting-copy{min-width:0;display:flex;flex-direction:column;gap:3px}.dsh-patchouli-setting-copy strong{font-size:13px;line-height:20px;font-weight:600}.dsh-patchouli-setting-copy span{max-width:62ch;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}.dsh-patchouli-setting-control{flex:none}
.dsh-patchouli-segments{height:32px;padding:2px;border-radius:9px;background:var(--dsw-alias-bg-module-platform);display:flex}.dsh-patchouli-segments button{appearance:none;min-width:58px;border:0;border-radius:7px;padding:0 10px;color:var(--dsw-alias-label-secondary);background:transparent;font:inherit;font-size:12px;cursor:pointer}.dsh-patchouli-segments button[aria-checked=true]{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-shadow-lv1)}.dsh-patchouli-segments button:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}.dsh-patchouli-segments button:disabled{cursor:default;opacity:.55}
.dsh-patchouli-toggle{appearance:none;width:38px;height:22px;border:0;border-radius:999px;padding:2px;background:var(--dsw-alias-bg-module-platform);cursor:pointer;transition:background .15s}.dsh-patchouli-toggle span{width:18px;height:18px;border-radius:50%;background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-shadow-lv1);display:block;transition:transform .15s}.dsh-patchouli-toggle[aria-checked=true]{background:var(--dsw-alias-state-business-primary)}.dsh-patchouli-toggle[aria-checked=true] span{transform:translateX(16px)}.dsh-patchouli-toggle:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}.dsh-patchouli-toggle:disabled{cursor:default;opacity:.55}
.dsh-patchouli-number{height:32px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);display:flex;align-items:center;overflow:hidden}.dsh-patchouli-number:focus-within{border-color:var(--dsw-alias-state-business-primary);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--dsw-alias-state-business-primary) 16%,transparent)}.dsh-patchouli-number input{box-sizing:border-box;width:92px;height:100%;border:0;outline:0;padding:0 8px;color:var(--dsw-alias-label-primary);background:transparent;font:inherit;font-size:12px;font-variant-numeric:tabular-nums}.dsh-patchouli-number>span{padding-right:8px;color:var(--dsw-alias-label-caption);font-size:10px;white-space:nowrap}.dsh-patchouli-number:has(input:disabled){opacity:.55}
.dsh-patchouli-text{box-sizing:border-box;width:220px;height:32px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;outline:0;padding:0 9px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);font:inherit;font-size:12px}.dsh-patchouli-text::placeholder{color:var(--dsw-alias-label-caption)}.dsh-patchouli-text:focus{border-color:var(--dsw-alias-state-business-primary);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--dsw-alias-state-business-primary) 16%,transparent)}.dsh-patchouli-text:disabled{opacity:.55}
.dsh-patchouli-standard-block{padding-top:18px}.dsh-patchouli-block-heading{padding-bottom:6px}
.dsh-patchouli-budget-block{padding:18px 0}.dsh-patchouli-budget-grid{margin-top:12px;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.dsh-patchouli-budget-grid>div{display:flex;flex-direction:column;align-items:flex-start;gap:5px}.dsh-patchouli-budget-grid>div>span{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:17px}.dsh-patchouli-budget-grid .dsh-patchouli-number{width:100%}.dsh-patchouli-budget-grid input{min-width:0;flex:1;width:auto}
.dsh-patchouli-note,.dsh-patchouli-advisory,.dsh-patchouli-error,.dsh-patchouli-status{margin:12px 0 0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}.dsh-patchouli-advisory{padding:8px 10px;border-radius:8px;color:var(--dsw-alias-label-secondary);background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#b7791f) 9%,transparent)}.dsh-patchouli-error{margin:0 0 8px;color:var(--dsw-alias-state-error-primary)}
@container(max-width:650px){.dsh-patchouli-layout{grid-template-columns:1fr;grid-template-rows:auto minmax(0,1fr);gap:12px}.dsh-patchouli-nav{overflow-x:auto;overflow-y:hidden;scrollbar-gutter:auto;padding:0 0 4px;flex-direction:row}.dsh-patchouli-nav button{width:auto;min-width:132px}.dsh-patchouli-content{border-left:0;border-top:1px solid var(--dsw-alias-border-l3);padding:14px 0 22px}.dsh-patchouli-setting-row{align-items:flex-start;flex-direction:column}.dsh-patchouli-budget-grid{grid-template-columns:1fr}}
@media(prefers-reduced-motion:reduce){.dsh-patchouli-toggle,.dsh-patchouli-toggle span{transition:none}}
`

function installStyles(): void {
  const current = document.getElementById(STYLE_ID)
  if (current !== null) {
    current.textContent = styles
    return
  }
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = styles
  document.head.append(style)
}

export const name = 'dsh-patchouli'
export const inject = ['slots', 'settingsScope', 'remote', 'inputTriggers'] as const

export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  installStyles()
  const core = ctx.settingsScope.bind({ namespace: CORE_NAMESPACE, decode: decodeCore })
  const native = ctx.settingsScope.bind({ namespace: NATIVE_NAMESPACE, decode: decodeNative })
  const fleet = ctx.settingsScope.bind({ namespace: FLEET_NAMESPACE, decode: decodeFleet })
  const inputTriggers = ctx.get?.('inputTriggers') as NativeContextAtInputTriggers | undefined
  if (inputTriggers === undefined) throw new Error('DSH input trigger registry is unavailable')
  ctx.effect(
    () => installNativeContextAtBridge(native, inputTriggers),
    'dsh-patchouli: native context @ source',
  )
  const disposeRemote = await ctx.remote.$mount(NATIVE_CONTEXT_AT_REMOTE)
  const remote = ctx.get?.('remote.patchouliNativeContextAt') as NativeContextAtClient | undefined
  if (remote === undefined) {
    await disposeRemote()
    throw new Error('Patchouli Native Context @ Remote did not mount')
  }
  const disposeAtProvider = registerNativeContextAtProvider({
    async *search(request) {
      let cursor: number | undefined
      let remaining = 20
      do {
        const result = await remote.search({
          sessionId: request.sessionId,
          query: request.query,
          ...(cursor === undefined ? {} : { cursor }),
        }, request.signal)
        if (!result.ok) throw new Error(result.error.message)
        const page = result.value
        const items = page.items.slice(0, remaining) as readonly NativeContextAtSearchResult[]
        if (items.length > 0) {
          yield items
          remaining -= items.length
        }
        if (page.complete || remaining === 0) return
        cursor = page.nextCursor
      } while (cursor !== undefined && !request.signal.aborted)
    },
  })
  const SettingsPage = ({ renderSlot }: { readonly renderSlot?: PatchouliSettingsRenderSlot }) =>
    jsx(PatchouliSettingsPage, { core, native, fleet, renderSlot })
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'patchouli',
    order: 55,
    label: () => 'Patchouli',
    children: {
      [PATCHOULI_SETTINGS_SLOTS.navigation]: { kind: 'list', scope: 'session' },
      [PATCHOULI_SETTINGS_SLOTS.content]: { kind: 'keyed', scope: 'session' },
    },
  }, SettingsPage))
  return async () => {
    disposeAtProvider()
    await disposeRemote()
  }
}
