import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'

import {
  createMnemeAdapter,
  createMnemonAdapter,
  type MnemeService,
  type MnemonRuntime,
  type MnemonService,
} from '../lib/goojfc/index.js'

const require = createRequire(import.meta.url)
const meta = {
  source: { type: 'agent-loop', id: 'dsh-patchouli-agent-loop' },
  scope: '/workspace/project',
  requestId: 'request-1',
  attributes: { workspaceRoot: '/workspace/project' },
} as const

test('keeps exact-version Harmony patches available without installing them by default', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.deepEqual(manifest.dsh.harmony.patches, [
    './patches/settings-nav-icon.patch.cjs',
    './patches/native-context-at.patch.cjs',
  ])
  const settingsPatch = require('../patches/settings-nav-icon.patch.cjs')
  assert.equal(settingsPatch[0].id, 'patchouli-settings-nav-icon')
  assert.equal(settingsPatch[0].target.package, '@deepseek-ai/dsh-client-ui-settings-general')
  const nativeContextAtPatch = require('../patches/native-context-at.patch.cjs')
  assert.deepEqual(nativeContextAtPatch.map((patch: { readonly id: string }) => patch.id), [
    'native-context-at-stream',
    'native-context-at-source-order',
    'native-context-at-boundary-highlight',
    'native-context-at-bounded-navigation',
    'native-context-at-progressive-navigation',
    'native-context-at-mirrored-menu',
  ])
  const patchSources = [
    './patches/openviking.patch.cjs',
    './patches/hindsight.patch.cjs',
    './patches/memos.patch.cjs',
    './patches/mneme-inject.patch.cjs',
    './patches/mneme-service.patch.cjs',
    './patches/mneme-passive.patch.cjs',
    './patches/mnemon-inject.patch.cjs',
    './patches/mnemon-service.patch.cjs',
    './patches/mnemon-passive.patch.cjs',
    './patches/memory-gate.patch.cjs',
    './patches/lingshu.patch.cjs',
    './patches/graph-memory.patch.cjs',
    './patches/engramory.patch.cjs',
    './patches/memory-evolve.patch.cjs',
  ]
  assert.ok(manifest.files.includes('patches'))
  for (const relativePath of patchSources) {
    const source = readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8')
    assert.doesNotMatch(source, /dsh-patchouli\/goojfc/)
  }

  const patches = [
    require('../patches/mneme-inject.patch.cjs'),
    require('../patches/mneme-service.patch.cjs'),
    ...require('../patches/mneme-passive.patch.cjs'),
    require('../patches/mnemon-inject.patch.cjs'),
    require('../patches/mnemon-service.patch.cjs'),
    require('../patches/mnemon-passive.patch.cjs'),
  ]
  assert.deepEqual(patches.map(patch => patch.target.package), [
    ...Array(6).fill('@modusensus/dsh-mneme'),
    ...Array(3).fill('dsh-mnemon'),
  ])
  assert.deepEqual(patches.map(patch => patch.target.version), [
    ...Array(6).fill('0.3.7'),
    ...Array(3).fill('0.1.6'),
  ])
  assert.deepEqual(patches.map(patch => patch.expect), [1, 1, 1, 1, 1, 1, 1, 1, 3])
  assert.deepEqual(patches.slice(0, 2).map(patch => patch.target), [
    ...Array(2).fill({
      package: '@modusensus/dsh-mneme',
      version: '0.3.7',
      file: 'lib/index.js',
    }),
  ])
})

test('routes Mneme updates and retrieval through its native service', async () => {
  const calls: unknown[] = []
  const nativeRows = [{ id: 'memory-1', content: 'SQLite' }]
  const service: MnemeService = {
    saveWithDedupe(memory) {
      calls.push(['save', memory])
      return { action: 'created', memory: { id: 'memory-1' } }
    },
    async searchMemories(query, options) {
      calls.push(['search', query, options])
      return nativeRows
    },
    toApiList(rows) {
      calls.push(['list', rows])
      return rows as typeof nativeRows
    },
    injectCandidates() { return [] },
  }
  const adapter = createMnemeAdapter(service, {
    async summarize() { throw new Error('unexpected summarize') },
  }, {
    autoInject: true,
    maxInjectedItems: 5,
    importanceThreshold: 3,
    session: () => undefined,
    getProfile: () => '',
    getRules: () => [],
  })

  assert.deepEqual(await adapter.update({
    meta,
    data: {
      type: 'decision',
      title: 'Database',
      content: 'Use SQLite',
      importance: 5,
      tags: ['storage'],
    },
  }, {}), { action: 'created', memory: { id: 'memory-1' } })
  assert.deepEqual(await adapter.retrieve({
    meta,
    data: { query: 'database', limit: 4, mode: 'hybrid' },
  }, {}), { items: nativeRows })
  assert.deepEqual(calls, [
    ['save', {
      type: 'decision',
      title: 'Database',
      content: 'Use SQLite',
      tags: ['storage'],
      importance: 5,
      source: 'patchouli',
    }],
    ['search', 'database', { topK: 4, mode: 'hybrid', recordRecall: true }],
    ['list', nativeRows],
  ])
})

test('routes Mneme turn-end through its exposed native summarizer', async () => {
  const sessions: unknown[] = []
  const event = { type: 'user/message', data: { content: 'Remember SQLite' } }
  const liveSession = {
    id: 'session-1',
    events: [event],
    requestHeader: () => ({ config: { provider: 'deepseek', model: 'chat' } }),
  }
  const adapter = createMnemeAdapter({
    saveWithDedupe() { throw new Error('unexpected save') },
    async searchMemories() { return [] },
    toApiList() { return [] },
    injectCandidates() { return [] },
  }, {
    async summarize(session) { sessions.push(session) },
  }, {
    autoInject: true,
    maxInjectedItems: 5,
    importanceThreshold: 3,
    session: id => id === liveSession.id ? liveSession : undefined,
    getProfile: () => '',
    getRules: () => [],
  })
  assert.deepEqual(await adapter.update({
    meta: {
      ...meta,
      attributes: { ...meta.attributes, sessionId: 'session-1', point: 'session/turn-end' },
    },
    data: { events: [event] },
  }, {}), { summarized: true })
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0], liveSession)
})

test('uses Mneme native injection policy and honors autoInject', async () => {
  const calls: unknown[] = []
  const service: MnemeService = {
    saveWithDedupe() { throw new Error('unexpected save') },
    async searchMemories() { return [] },
    toApiList() { return [] },
    injectCandidates(options) {
      calls.push(options)
      return [{ type: 'decision', title: 'Database', importance: 5, content: 'Use SQLite' }]
    },
  }
  const options = {
    autoInject: true,
    maxInjectedItems: 4,
    importanceThreshold: 2,
    session: () => undefined,
    getProfile: () => 'Database engineer',
    getRules: () => ['Prefer local storage'],
  }
  const adapter = createMnemeAdapter(service, {}, options)
  const preStepMeta = {
    ...meta,
    attributes: { ...meta.attributes, point: 'agent/pre-step', step: 1 },
  }

  const value = await adapter.retrieve({ meta: preStepMeta, data: { messages: [] } }, {})
  assert.equal(typeof value, 'string')
  assert.match(value as string, /Database engineer/)
  assert.match(value as string, /Prefer local storage/)
  assert.match(value as string, /Use SQLite/)
  assert.deepEqual(calls, [{ maxItems: 4, threshold: 2 }])

  const disabled = createMnemeAdapter(service, {}, { ...options, autoInject: false })
  assert.equal(await disabled.retrieve({ meta: preStepMeta, data: { messages: [] } }, {}), null)
  assert.equal(calls.length, 1)
  assert.equal(await adapter.retrieve({ meta, data: { query: 'missing' } }, {}), null)
})

test('routes Mnemon to the native workspace selected by Patchouli metadata', async () => {
  const calls: unknown[] = []
  const globalService = mnemonService(calls, 'global')
  const workspaceService = mnemonService(calls, 'workspace')
  const runtime: MnemonRuntime = {
    config: { storageScope: 'workspace' },
    service: globalService,
    forWorkspacePath(path) {
      calls.push(['workspace', path])
      return { service: workspaceService }
    },
  }
  const adapter = createMnemonAdapter(runtime, {
    async remember() { throw new Error('unexpected lifecycle remember') },
    async recall() { throw new Error('unexpected lifecycle recall') },
  }, {
    session: () => undefined,
  })

  assert.deepEqual(await adapter.update({
    meta,
    data: { content: 'Use SQLite', category: 'decision' },
  }, {}), { source: 'workspace', stored: true })
  assert.deepEqual(await adapter.retrieve({
    meta,
    data: { query: 'database', limit: 2 },
  }, {}), { source: 'workspace', results: ['database'] })
  assert.deepEqual(calls, [
    ['workspace', '/workspace/project'],
    ['workspace', 'remember', { content: 'Use SQLite', category: 'decision' }],
    ['workspace', '/workspace/project'],
    ['workspace', 'search', { query: 'database', limit: 2 }],
  ])
})

test('routes Mnemon model-tool calls through its native coordinator lifecycle', async () => {
  const calls: unknown[] = []
  const runtime: MnemonRuntime = {
    config: {},
    service: mnemonService(calls, 'direct'),
    forWorkspacePath() { throw new Error('unexpected workspace lookup') },
  }
  const adapter = createMnemonAdapter(runtime, {
    async remember(sessionId, request) {
      calls.push(['lifecycle-remember', sessionId, request])
      return { stored: true }
    },
    async recall(sessionId, request) {
      calls.push(['lifecycle-recall', sessionId, request])
      return { results: [String(request.query)] }
    },
  }, {
    session: id => id === 'session-1' ? { root: true, hotMemory: 'Use WAL.' } : undefined,
  })
  const toolMeta = {
    ...meta,
    attributes: {
      ...meta.attributes,
      sessionId: 'session-1',
      point: 'tool/memory-update',
    },
  }
  assert.deepEqual(await adapter.update({
    meta: toolMeta,
    data: { content: 'Use SQLite' },
  }, {}), { stored: true })
  assert.deepEqual(await adapter.retrieve({
    meta: {
      ...toolMeta,
      attributes: { ...toolMeta.attributes, point: 'tool/memory-retrieve' },
    },
    data: { query: 'database' },
  }, {}), { results: ['database'] })
  assert.deepEqual(await adapter.retrieve({
    meta: {
      ...toolMeta,
      attributes: { ...toolMeta.attributes, point: 'agent/pre-step', step: 1 },
    },
    data: { query: 'current task' },
  }, {}), { hotMemory: 'Use WAL.', recall: { results: ['current task'] } })
  assert.deepEqual(calls, [
    ['lifecycle-remember', 'session-1', { content: 'Use SQLite' }],
    ['lifecycle-recall', 'session-1', { query: 'database' }],
    ['lifecycle-recall', 'session-1', { query: 'current task' }],
  ])
})

test('keeps Mnemon hot memory visible without recursively recalling from subagents', async () => {
  const recalls: string[] = []
  const runtime: MnemonRuntime = {
    config: { lifecycleEnabled: true, recallMode: 'guided' },
    service: mnemonService([], 'direct'),
    forWorkspacePath() { throw new Error('unexpected workspace lookup') },
  }
  const lifecycle = {
    async remember() { throw new Error('unexpected remember') },
    async recall(sessionId: string) {
      recalls.push(sessionId)
      return { results: ['cold memory'] }
    },
  }
  const sessions = new Map([
    ['root', { root: true, hotMemory: 'root hot memory' }],
    ['child', { root: false, hotMemory: 'child hot memory' }],
  ])
  const adapter = createMnemonAdapter(runtime, lifecycle, { session: id => sessions.get(id) })
  const preStep = (sessionId: string, step: number) => ({
    ...meta,
    attributes: { ...meta.attributes, sessionId, point: 'agent/pre-step', step },
  })

  assert.deepEqual(await adapter.retrieve({
    meta: preStep('child', 1),
    data: { query: 'child query' },
  }, {}), { hotMemory: 'child hot memory' })
  assert.deepEqual(await adapter.retrieve({
    meta: preStep('root', 2),
    data: { query: 'later step' },
  }, {}), { hotMemory: 'root hot memory' })
  assert.deepEqual(recalls, [])

  assert.deepEqual(await adapter.retrieve({
    meta: preStep('root', 1),
    data: { query: 'root query' },
  }, {}), {
    hotMemory: 'root hot memory',
    recall: { results: ['cold memory'] },
  })
  assert.deepEqual(recalls, ['root'])

  const disabled = createMnemonAdapter({
    ...runtime,
    config: { lifecycleEnabled: true, recallMode: 'off' },
  }, lifecycle, { session: id => sessions.get(id) })
  assert.deepEqual(await disabled.retrieve({
    meta: preStep('root', 1),
    data: { query: 'disabled query' },
  }, {}), { hotMemory: 'root hot memory' })
  assert.deepEqual(recalls, ['root'])

  const lifecycleDisabled = createMnemonAdapter({
    ...runtime,
    config: { lifecycleEnabled: false, recallMode: 'guided' },
  }, lifecycle, { session: id => sessions.get(id) })
  assert.deepEqual(await lifecycleDisabled.retrieve({
    meta: preStep('root', 1),
    data: { query: 'disabled lifecycle' },
  }, {}), { hotMemory: 'root hot memory' })
  assert.deepEqual(recalls, ['root'])

  const empty = createMnemonAdapter({
    config: {},
    service: {
      async remember() { throw new Error('unexpected remember') },
      async search() { return { results: [] } },
    },
    forWorkspacePath() { throw new Error('unexpected workspace lookup') },
  }, lifecycle, { session: () => undefined })
  assert.equal(await empty.retrieve({ meta, data: { query: 'missing' } }, {}), null)
})

function mnemonService(calls: unknown[], source: string): MnemonService {
  return {
    async remember(request) {
      calls.push([source, 'remember', request])
      return { source, stored: true }
    },
    async search(request) {
      calls.push([source, 'search', request])
      return { source, results: [request.query as string] }
    },
  }
}
