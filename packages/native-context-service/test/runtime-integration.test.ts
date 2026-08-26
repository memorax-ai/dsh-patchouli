import assert from 'node:assert/strict'
import test from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import * as patchouli from 'dsh-patchouli'
import {
  PatchouliRpcError,
  type PatchouliStorageService,
} from 'dsh-patchouli/storage'

import * as nativeContext from '../lib/index.js'

const sessionHeader = {
  id: 'session-1',
  version: 0,
  createdAt: 1_700_000_000_000,
  cwd: '/work',
}

const sessionEvents = [
  {
    type: 'user/message',
    seq: 1,
    time: 101,
    surface: 'current',
    data: {
      id: 'message-user',
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'find the auth handler' }],
    },
  },
  {
    type: 'turn/end',
    seq: 2,
    time: 102,
    surface: 'log-only',
    data: { turn: 0, reason: { kind: 'completed' } },
  },
]

function callMeta(point, attributes = {}) {
  return {
    source: { type: 'agent-loop', id: 'dsh-agent-loop' },
    scope: '/work',
    attributes: { point, sessionId: 'session-1', workspaceRoot: '/work', ...attributes },
  }
}

function createStorage() {
  const entities = new Map()
  const queries = []
  let version = 0
  let writes = 0
  const refKey = ref => `${ref.type}:${ref.id}`
  const active = (type, id, value) => ({
    ref: { type, id },
    version: `v${++version}`,
    state: 'active',
    value,
  })
  return {
    queries,
    get writes() { return writes },
    service: {
      async read(request) {
        const entity = entities.get(refKey(request.data.ref))
        if (entity === undefined) {
          throw new PatchouliRpcError(
            'patchouli.entity.read@1',
            -32003,
            'not found',
            { reason: 'NOT_FOUND' },
          )
        }
        return { meta: {}, data: { state: 'resolved', variants: [entity] } }
      },
      async create(request) {
        writes += 1
        const entity = active(request.data.type, request.data.id, request.data.value)
        entities.set(refKey(entity.ref), entity)
        return { meta: {}, data: { entity } }
      },
      async update(request) {
        writes += 1
        const entity = active(request.data.ref.type, request.data.ref.id, request.data.value)
        entities.set(refKey(entity.ref), entity)
        return { meta: {}, data: { entity } }
      },
      async delete(request) {
        writes += 1
        entities.delete(refKey(request.data.ref))
        return { meta: {}, data: {} }
      },
      async *queryPages(meta, instruction, options) {
        queries.push({ meta, instruction, options })
        yield { meta: {}, data: { hits: [] } }
      },
      async query(meta, instruction, options) {
        queries.push({ meta, instruction, options })
        const hits = [...entities.values()].flatMap((entity) => {
          if (!options.types.includes(entity.ref.type)) return []
          const binding = instruction.where?.['/metadata/core/origin/binding']
          if (binding !== undefined && entity.value.metadata?.core?.origin?.binding !== binding) {
            return []
          }
          return [{ score: 0.9, variants: [entity] }]
        })
        return { meta: {}, data: { hits } }
      },
    } as unknown as PatchouliStorageService,
  }
}

test('loads without optional sources and exposes an empty fast MemoryPlugin result', async (t) => {
  const ctx = new Context()
  const patchouliFiber = await ctx.plugin(patchouli)
  const nativeFiber = await ctx.plugin(nativeContext)
  t.after(() => patchouliFiber.dispose())

  const outcomes = await ctx.patchouli.retrieve({
    meta: callMeta('tool/memory-retrieve'),
    data: { query: 'auth', limit: 5 },
  })
  assert.deepEqual(outcomes, [{
    pluginId: nativeContext.NATIVE_CONTEXT_MEMORY_PLUGIN_ID,
    ok: true,
    value: {
      answer: '',
      references: [],
      truncated: false,
      effort: 'medium',
      agent: true,
    },
  }])
  assert.equal(ctx.nativeContext.hasRetriever('fast'), false)
  assert.equal(ctx.nativeContext.hasAlgorithm('session-history'), false)

  await nativeFiber.dispose()
  assert.deepEqual(await ctx.patchouli.retrieve({
    meta: callMeta('tool/memory-retrieve'),
    data: { query: 'auth' },
  }), [])
})

test('bounds long-running Session cursors by evicting the oldest key', async () => {
  const service = new nativeContext.NativeContextService(new Context())
  const runtime = new nativeContext.NativeContextRuntime(service)
  let indexed = 0
  service.registerAlgorithm({
    id: 'repair-history',
    async ingest() { return { created: 0, updated: 0, refs: [] } },
    async query() { return { hits: [], truncated: false } },
  })
  runtime.useSessionIndex({
    id: 'session',
    async index(request) {
      indexed += 1
      return {
        session: { id: request.sessionId, version: 0, createdAt: 0 },
        records: [],
        nextAfterSeq: 2,
        hasMore: false,
      }
    },
  })
  const data = {
    event: { seq: 2 },
    events: [{ seq: 2 }],
  }
  for (let index = 0; index <= nativeContext.NATIVE_CONTEXT_SESSION_CURSOR_LIMIT; index += 1) {
    await runtime.update({
      meta: callMeta('session/turn-end', { sessionId: `session-${index}` }),
      data,
    }, {})
  }
  await runtime.update({
    meta: callMeta('session/turn-end', { sessionId: 'session-0' }),
    data,
  }, {})
  assert.equal(indexed, nativeContext.NATIVE_CONTEXT_SESSION_CURSOR_LIMIT + 2)
})

test('restores and advances the durable Session cursor', async () => {
  const service = new nativeContext.NativeContextService(new Context())
  const runtime = new nativeContext.NativeContextRuntime(service)
  const saved = new Map([['session-1', 5]])
  const afterSeqs = []
  runtime.useSessionCursorStore({
    async load(sessionId) { return saved.get(sessionId) },
    async save(sessionId, cursor) { saved.set(sessionId, cursor) },
  })
  service.registerAlgorithm({
    id: 'repair-history',
    async ingest() { return {} },
    async query() { return { hits: [], truncated: false } },
  })
  runtime.useSessionIndex({
    id: 'session',
    async index(request) {
      afterSeqs.push(request.afterSeq)
      return {
        session: { id: request.sessionId, version: 0, createdAt: 0 },
        records: [],
        nextAfterSeq: 8,
        hasMore: false,
      }
    },
  })

  await runtime.update({
    meta: callMeta('session/turn-end'),
    data: { event: { seq: 8 } },
  }, {})
  assert.deepEqual(afterSeqs, [5])
  assert.equal(saved.get('session-1'), 8)

  const resumed = new nativeContext.NativeContextRuntime(service)
  resumed.useSessionCursorStore({
    async load(sessionId) { return saved.get(sessionId) },
    async save(sessionId, cursor) { saved.set(sessionId, cursor) },
  })
  resumed.useSessionIndex({
    id: 'session',
    async index() { throw new Error('already indexed history should not be replayed') },
  })
  assert.deepEqual(await resumed.update({
    meta: callMeta('session/turn-end'),
    data: { event: { seq: 8 } },
  }, {}), { sessionId: 'session-1', indexed: 0 })
})

test('refreshes a cold Workspace before retrieval and shares an in-flight scan', async () => {
  const service = new nativeContext.NativeContextService(new Context())
  const runtime = new nativeContext.NativeContextRuntime(service)
  let scans = 0
  let releaseScan
  const scanGate = new Promise(resolve => { releaseScan = resolve })
  service.registerRetriever(new nativeContext.FastRetrieveModule(service))
  const workspaceIndex = {
    id: 'workspace',
    async index() {
      scans += 1
      await scanGate
      return {
        workspace: { id: 'workspace-1', path: '/work', title: 'work', updatedAt: null },
        files: [],
        truncated: false,
      }
    },
  }
  service.registerIndex(workspaceIndex)
  runtime.useWorkspaceSource({
    index: workspaceIndex,
    async resolveId() { return 'workspace-1' },
  })
  const request = {
    meta: callMeta('tool/memory-retrieve'),
    data: { query: 'context', metadata: { sourceIds: ['workspace-context'] } },
  }
  const first = runtime.retrieve(request, {})
  while (scans === 0) await Promise.resolve()
  const second = runtime.retrieve(request, {})
  releaseScan()
  await Promise.all([first, second])
  assert.equal(scans, 1)
})

test('bounds direct Workspace snapshots by evicting the oldest workspace', async () => {
  const service = new nativeContext.NativeContextService(new Context())
  const runtime = new nativeContext.NativeContextRuntime(service)
  let scans = 0
  service.registerRetriever(new nativeContext.FastRetrieveModule(service))
  const workspaceIndex = {
    id: 'workspace',
    async index(request) {
      scans += 1
      return {
        workspace: {
          id: request.workspaceId,
          path: request.workspaceId,
          title: request.workspaceId,
          updatedAt: null,
        },
        files: [],
        truncated: false,
      }
    },
  }
  service.registerIndex(workspaceIndex)
  runtime.useWorkspaceSource({
    index: workspaceIndex,
    async resolveId(path) { return path },
  })
  for (
    let index = 0;
    index <= nativeContext.NATIVE_CONTEXT_WORKSPACE_FRESHNESS_LIMIT;
    index += 1
  ) {
    await runtime.retrieve({
      meta: callMeta('tool/memory-retrieve', {
        sessionId: `session-${index}`,
        workspaceRoot: `/work-${index}`,
      }),
      data: { query: 'context', metadata: { sourceIds: ['workspace-context'] } },
    }, {})
  }
  await runtime.retrieve({
    meta: callMeta('tool/memory-retrieve', {
      sessionId: 'session-repeat',
      workspaceRoot: '/work-0',
    }),
    data: { query: 'context', metadata: { sourceIds: ['workspace-context'] } },
  }, {})

  assert.equal(scans, nativeContext.NATIVE_CONTEXT_WORKSPACE_FRESHNESS_LIMIT + 2)
})

test('backfills every bounded Session page through turn end before advancing the cursor', async () => {
  const service = new nativeContext.NativeContextService(new Context())
  const runtime = new nativeContext.NativeContextRuntime(service)
  const afterSeqs = []
  const ingested = []
  service.registerAlgorithm({
    id: 'repair-history',
    async ingest(request) { ingested.push(request.index); return {} },
    async query() { return { hits: [], truncated: false } },
  })
  runtime.useSessionIndex({
    id: 'session',
    async index(request) {
      afterSeqs.push([request.afterSeq, request.throughSeq, request.limit])
      const page = request.afterSeq === -1
        ? { size: 100, nextAfterSeq: 99, hasMore: true }
        : request.afterSeq === 99
          ? { size: 100, nextAfterSeq: 199, hasMore: true }
          : { size: 50, nextAfterSeq: 249, hasMore: false }
      return {
        session: { id: request.sessionId, version: 0, createdAt: 0 },
        records: Array.from({ length: page.size }, () => ({})),
        nextAfterSeq: page.nextAfterSeq,
        hasMore: page.hasMore,
      }
    },
  })

  const result = await runtime.update({
    meta: callMeta('session/turn-end', { sessionId: 'paged-session' }),
    data: { event: { seq: 300 }, events: [{ seq: 250 }] },
  }, {})
  assert.deepEqual(result, { sessionId: 'paged-session', indexed: 250 })
  assert.deepEqual(afterSeqs, [
    [-1, 300, 100],
    [99, 300, 100],
    [199, 300, 100],
  ])
  assert.equal(ingested.length, 3)

  await runtime.update({
    meta: callMeta('session/turn-end', { sessionId: 'paged-session' }),
    data: { event: { seq: 400 }, events: [{ seq: 301 }] },
  }, {})
  assert.deepEqual(afterSeqs[3], [300, 400, 100])
})

test('does not advance the Session cursor when a later page fails', async () => {
  const service = new nativeContext.NativeContextService(new Context())
  const runtime = new nativeContext.NativeContextRuntime(service)
  const afterSeqs = []
  let ingests = 0
  service.registerAlgorithm({
    id: 'repair-history',
    async ingest() {
      ingests += 1
      if (ingests === 2) throw new Error('page ingest failed')
      return {}
    },
    async query() { return { hits: [], truncated: false } },
  })
  runtime.useSessionIndex({
    id: 'session',
    async index(request) {
      afterSeqs.push(request.afterSeq)
      const first = request.afterSeq === -1
      return {
        session: { id: request.sessionId, version: 0, createdAt: 0 },
        records: Array.from({ length: 100 }, () => ({})),
        nextAfterSeq: first ? 99 : 199,
        hasMore: first,
      }
    },
  })
  const request = {
    meta: callMeta('session/turn-end', { sessionId: 'retry-session' }),
    data: { event: { seq: 200 }, events: [{ seq: 1 }] },
  }

  await assert.rejects(runtime.update(request, {}), /page ingest failed/)
  assert.deepEqual(await runtime.update(request, {}), {
    sessionId: 'retry-session',
    indexed: 200,
  })
  assert.deepEqual(afterSeqs, [-1, 99, -1, 99])
})

test('searches Session Index directly while persisting only derived repair history', async (t) => {
  const ctx = new Context()
  const storage = createStorage()
  let sessionReads = 0
  const sessionQuery = {
    async searchSessions() {
      sessionReads += 1
      return { items: [] }
    },
    async searchEvents(request) {
      sessionReads += 1
      assert.equal(String(request.sessionId), sessionHeader.id)
      return {
        session: sessionHeader,
        items: [{
          seq: 1,
          type: 'user/message',
          time: 101,
          surface: 'current',
          snippet: '[user-message #1]\nfind the auth handler',
        }],
      }
    },
    async listSessions() {
      sessionReads += 1
      return [{ header: sessionHeader }]
    },
    async listEvents(sessionId) {
      sessionReads += 1
      assert.equal(String(sessionId), sessionHeader.id)
      return sessionEvents.map(({ data: _data, ...event }) => event)
    },
    async readEvent(request, signal) {
      sessionReads += 1
      signal?.throwIfAborted()
      const target = sessionEvents.find(event => event.seq === request.seq)
      if (target === undefined) throw new Error('missing event')
      return { session: sessionHeader, target }
    },
  } as unknown as SessionQueryEngine

  const patchouliFiber = await ctx.plugin(patchouli)
  const disposeStorage = ctx.provide('patchouliStorage', storage.service)
  const disposeSession = ctx.provide('sessionQuery', sessionQuery)
  const nativeFiber = await ctx.plugin(nativeContext)
  t.after(async () => {
    await nativeFiber.dispose()
    await disposeSession()
    await disposeStorage()
    await patchouliFiber.dispose()
  })

  for (const id of ['artifact-context', 'repair-history']) {
    assert.equal(ctx.nativeContext.hasAlgorithm(id), true)
  }
  for (const id of ['session-history', 'workspace-context', 'project-state', 'git-context']) {
    assert.equal(ctx.nativeContext.hasAlgorithm(id), false)
  }
  assert.equal(ctx.nativeContext.hasRetriever('fast'), true)
  assert.throws(() => ctx.nativeContext.getRetriever('agent'), /is not registered/)
  assert.throws(() => ctx.nativeContext.getRetriever('deep'), /is not registered/)

  const updates = await ctx.patchouli.update({
    meta: callMeta('session/turn-end'),
    data: {
      event: sessionEvents[1],
      events: sessionEvents,
    },
  })
  assert.deepEqual(updates, [{
    pluginId: nativeContext.NATIVE_CONTEXT_MEMORY_PLUGIN_ID,
    ok: true,
    value: { sessionId: 'session-1', indexed: 1 },
  }])
  const writesBeforeRetrieve = storage.writes
  const sessionReadsBeforeRetrieve = sessionReads

  const outcomes = await ctx.patchouli.retrieve({
    meta: callMeta('tool/memory-retrieve'),
    data: {
      query: 'auth',
      limit: 3,
      metadata: { sourceIds: ['session-history'], maxCharacters: 100 },
    },
  })
  assert.equal(outcomes.length, 1)
  assert.equal(outcomes[0]?.ok, true)
  if (outcomes[0]?.ok !== true) return
  assert.equal(outcomes[0].value.answer, '[1] [user-message #1]\nfind the auth handler')
  assert.equal(outcomes[0].value.references[0]?.sourceId, 'session-history')
  assert.equal(outcomes[0].value.rawHits, undefined)
  assert.deepEqual(outcomes[0].value.references[0]?.source, {
    type: 'session-event',
    sessionId: 'session-1',
    seq: 1,
    time: 101,
    eventType: 'user/message',
    surface: 'current',
    cwd: '/work',
  })

  const rawOutcomes = await ctx.patchouli.retrieve({
    meta: callMeta('tool/memory-retrieve'),
    data: {
      query: 'auth',
      limit: 3,
      metadata: {
        sourceIds: ['session-history'],
        maxCharacters: 100,
        includeRawHits: true,
      },
    },
  })
  assert.equal(rawOutcomes[0]?.ok, true)
  if (rawOutcomes[0]?.ok === true) {
    assert.equal(rawOutcomes[0].value.rawHits[0]?.text, '[user-message #1]\nfind the auth handler')
  }
  assert.equal(storage.writes, writesBeforeRetrieve)
  assert.equal(sessionReads, sessionReadsBeforeRetrieve + 6)
  assert.equal(storage.queries.length, 0)
})

test('scans the current Workspace on demand and never mirrors it into storage', async (t) => {
  const ctx = new Context()
  const storage = createStorage()
  const workspace = {
    id: 'workspace-1',
    path: '/work',
    title: 'work',
    updatedAt: '2026-08-26T00:00:00.000Z',
  }
  const root = { displayPath: '/work' }
  let scans = 0
  const fs = {
    async resolve() { return root },
    async stat() { return { type: 'directory' } },
    async listDir() { scans += 1; return [] },
    contains() { return true },
    fileUrl() { return 'file:///work' },
    async *streamText() {},
  } as unknown as FileSystem
  const workspaces = {
    get() { return workspace },
    async resolveByPath(path) { return path === '/work' ? workspace : undefined },
  } as unknown as WorkspaceRegistry

  const patchouliFiber = await ctx.plugin(patchouli)
  const disposeStorage = ctx.provide('patchouliStorage', storage.service)
  const disposeFs = ctx.provide('fs', fs)
  const disposeWorkspaces = ctx.provide('workspaceRegistry', workspaces)
  const nativeFiber = await ctx.plugin(nativeContext)
  t.after(async () => {
    await nativeFiber.dispose()
    await disposeWorkspaces()
    await disposeFs()
    await disposeStorage()
    await patchouliFiber.dispose()
  })

  const updates = await ctx.patchouli.update({
    meta: callMeta('session/turn-end'),
    data: { event: { seq: 2 }, events: [{ seq: 1 }] },
  })
  assert.equal(updates[0]?.ok, true, JSON.stringify(updates))
  assert.equal(scans, 0)
  const repeatedUpdates = await ctx.patchouli.update({
    meta: callMeta('session/turn-end'),
    data: { event: { seq: 2 }, events: [{ seq: 1 }] },
  })
  assert.equal(repeatedUpdates[0]?.ok, true, JSON.stringify(repeatedUpdates))
  assert.equal(scans, 0)
  const writesBeforeRetrieve = storage.writes

  const retrieveRequest = {
    meta: callMeta('tool/memory-retrieve'),
    data: {
      query: 'project docs',
      metadata: { sourceIds: ['workspace-context', 'project-state'] },
    },
  }
  const outcomes = await ctx.patchouli.retrieve(retrieveRequest)
  const repeatedOutcomes = await ctx.patchouli.retrieve(retrieveRequest)
  assert.equal(outcomes[0]?.ok, true)
  assert.equal(repeatedOutcomes[0]?.ok, true)
  assert.equal(scans, 1)
  assert.equal(storage.writes, writesBeforeRetrieve)
  assert.equal(storage.queries.length, 0)
})
