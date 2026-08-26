import assert from 'node:assert/strict'
import test from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import {
  FAST_RETRIEVE_PER_SOURCE_LIMIT,
  FastRetrieveModule,
} from '../lib/retrieve/fast.js'
import { NativeContextService } from '../lib/service.js'

const meta = { workspace: 'workspace-1', channel_id: 'session-1' }

const sessionSource = {
  type: 'session-event',
  sessionId: 'session-1',
  seq: 4,
  time: 1_700_000_000_000,
  eventType: 'assistant/message',
  surface: 'current',
}

const artifactSource = {
  kind: 'patchouli-artifact',
  id: 'artifact-1',
  version: 'v1',
  role: 'source',
  provider: 'managed',
  locator: 'blob/1',
}

const gitSource = {
  kind: 'git',
  workspace_id: 'workspace-1',
  workspace_path: '/work',
  repository_root: '/work',
  entity: 'commit',
  commit: 'abc123',
}

const readmeSource = {
  kind: 'workspace-file',
  workspaceId: 'workspace-1',
  workspacePath: '/work',
  path: 'README.md',
  uri: 'file:///work/README.md',
  version: 'v1',
}

function mockAlgorithm(id, query) {
  return {
    id,
    async ingest() { return undefined },
    query,
  }
}

test('queries selected registered sources concurrently and skips missing optional algorithms', async () => {
  const service = new NativeContextService(new Context())
  const calls = []
  const completions = new Map()
  const pending = (id, result) => mockAlgorithm(id, (request, context) => {
    calls.push({ id, request, signal: context.signal })
    return new Promise(resolve => completions.set(id, () => resolve(result)))
  })
  service.registerAlgorithm(pending('session-history', {
    hits: [{
      score: 0.7,
      ref: { type: 'knowledge', id: 'session-hit', version: 'v1' },
      text: 'session result',
      kind: 'assistant-message',
      session: { id: 'session-1' },
      source: sessionSource,
      data: null,
    }],
    truncated: false,
  }))
  service.registerAlgorithm(pending('artifact-context', {
    hits: [{
      score: 0.9,
      description: 'artifact description',
      text: 'artifact body',
      source: artifactSource,
    }],
  }))
  service.registerAlgorithm(pending('git-context', {
    hits: [{ score: 0.8, text: 'git result', source: gitSource }],
  }))

  const controller = new AbortController()
  const retrieval = new FastRetrieveModule(service).retrieve({
    meta,
    query: ' context ',
    sessionId: 'session-1',
    workspaceId: 'workspace-1',
    limit: 8,
  }, { signal: controller.signal })

  await Promise.resolve()
  assert.deepEqual(calls.map(call => call.id).sort(), [
    'artifact-context',
    'git-context',
    'session-history',
  ])
  for (const complete of completions.values()) complete()

  const result = await retrieval
  assert.deepEqual(result.hits.map(hit => hit.sourceId), [
    'artifact-context',
    'git-context',
    'session-history',
  ])
  assert.ok(result.hits.every(hit => hit.ranking?.sourceRank === 1))
  assert.equal(result.hits[0]?.text, 'artifact description\nartifact body')
  assert.equal(result.hits[0]?.source, artifactSource)
  assert.equal(result.truncated, false)
  assert.deepEqual(calls.map(call => call.request), [
    { meta, query: 'context', sessionId: 'session-1', limit: 8 },
    { meta, text: 'context', limit: 8 },
    { meta, text: 'context', workspaceId: 'workspace-1', limit: 8 },
  ])
  assert.ok(calls.every(call => call.signal === controller.signal))
})

test('enforces a per-source cap, total limit, score order, and total character budget', async () => {
  const service = new NativeContextService(new Context())
  const queryLimits = []
  service.registerAlgorithm(mockAlgorithm('git-context', async (request) => {
    queryLimits.push(request.limit)
    return {
      hits: Array.from({ length: FAST_RETRIEVE_PER_SOURCE_LIMIT + 3 }, (_, index) => ({
        score: 100 - index,
        text: index === 0 ? 'abcdef' : `hit-${index}`,
        source: { ...gitSource, commit: `commit-${index}` },
      })),
    }
  }))

  const result = await new FastRetrieveModule(service).retrieve({
    meta,
    query: 'git history',
    workspaceId: 'workspace-1',
    sourceIds: ['git-context'],
    limit: 30,
    maxCharacters: 4,
  }, {})

  assert.deepEqual(queryLimits, [FAST_RETRIEVE_PER_SOURCE_LIMIT])
  assert.equal(result.hits.length, 1)
  assert.equal(result.hits[0]?.sourceId, 'git-context')
  assert.equal(result.hits[0]?.text, 'abcd')
  assert.equal(result.hits[0]?.ranking?.sourceRank, 1)
  assert.equal(result.truncated, true)
})

test('merges the same workspace file while preserving its project classification', async () => {
  const service = new NativeContextService(new Context())
  service.registerAlgorithm(mockAlgorithm('workspace-context', async () => ({
    hits: [
      { score: 0.95, text: 'project readme', source: readmeSource },
      {
        score: 0.7,
        text: 'implementation details',
        source: { ...readmeSource, path: 'src/index.ts', uri: 'file:///work/src/index.ts' },
      },
    ],
  })))
  service.registerAlgorithm(mockAlgorithm('project-state', async () => ({
    hits: [{
      score: 0.8,
      documentKind: 'readme',
      text: 'project readme',
      source: readmeSource,
    }],
  })))

  const result = await new FastRetrieveModule(service).retrieve({
    meta,
    query: 'project',
    workspaceId: 'workspace-1',
    sourceIds: ['workspace-context', 'project-state'],
    limit: 2,
  }, {})

  assert.deepEqual(result.hits.map(hit => ({
    sourceId: hit.sourceId,
    path: hit.source.kind === 'workspace-file' ? hit.source.path : undefined,
  })), [
    { sourceId: 'project-state', path: 'README.md' },
    { sourceId: 'workspace-context', path: 'src/index.ts' },
  ])
  assert.equal(result.truncated, false)
})

test('skips workspace-scoped sources without workspaceId and honors an empty source list', async () => {
  const service = new NativeContextService(new Context())
  const calls = []
  service.registerAlgorithm(mockAlgorithm('workspace-context', async () => {
    calls.push('workspace')
    return { hits: [] }
  }))
  service.registerAlgorithm(mockAlgorithm('project-state', async () => {
    calls.push('project')
    return { hits: [] }
  }))

  const fast = new FastRetrieveModule(service)
  assert.deepEqual(await fast.retrieve({ meta, query: 'readme' }, {}), {
    hits: [],
    truncated: false,
  })
  assert.deepEqual(await fast.retrieve({
    meta,
    query: 'readme',
    workspaceId: 'workspace-1',
    sourceIds: [],
  }, {}), { hits: [], truncated: false })
  assert.deepEqual(calls, [])
})

test('checks AbortSignal before and after concurrent algorithm queries', async () => {
  const service = new NativeContextService(new Context())
  let calls = 0
  const controller = new AbortController()
  service.registerAlgorithm(mockAlgorithm('git-context', async () => {
    calls += 1
    controller.abort(new Error('cancelled after query'))
    return { hits: [] }
  }))
  const fast = new FastRetrieveModule(service)

  const preAborted = new AbortController()
  preAborted.abort(new Error('cancelled before query'))
  await assert.rejects(
    fast.retrieve({ meta, query: 'query', workspaceId: 'workspace-1', sourceIds: ['git-context'] }, {
      signal: preAborted.signal,
    }),
    /cancelled before query/,
  )
  assert.equal(calls, 0)

  await assert.rejects(
    fast.retrieve({ meta, query: 'query', workspaceId: 'workspace-1', sourceIds: ['git-context'] }, {
      signal: controller.signal,
    }),
    /cancelled after query/,
  )
  assert.equal(calls, 1)
})

test('expands top session hits through the native event window', async () => {
  const service = new NativeContextService(new Context())
  service.registerAlgorithm(mockAlgorithm('session-history', async () => ({
    hits: [{
      score: 1,
      text: 'matching event',
      source: sessionSource,
    }],
    truncated: false,
  })))
  service.registerIndex({
    id: 'session',
    async index() { throw new Error('not used') },
    async expand() {
      return [
        { kind: 'user-message', text: 'question', source: { ...sessionSource, seq: 3 } },
        { kind: 'assistant-message', text: 'matching event', source: sessionSource },
        { kind: 'tool-result', text: 'verified', source: { ...sessionSource, seq: 5 } },
      ]
    },
  })

  const result = await new FastRetrieveModule(service).retrieve({
    meta,
    query: 'matching',
    sessionId: 'session-1',
    sourceIds: ['session-history'],
    expandSources: true,
  }, {})
  assert.match(result.hits[0].text, /\[user-message #3\]/)
  assert.match(result.hits[0].text, /verified/)
})

test('filters and boosts timestamped hits through explicit temporal recall', async () => {
  const service = new NativeContextService(new Context())
  service.registerAlgorithm(mockAlgorithm('session-history', async () => ({
    hits: [
      { score: 0.8, text: 'old event', source: { ...sessionSource, seq: 1, time: 100 } },
      { score: 0.7, text: 'recent event', source: { ...sessionSource, seq: 2, time: 900 } },
    ],
    truncated: false,
  })))
  const result = await new FastRetrieveModule(service).retrieve({
    meta,
    query: 'event',
    sourceIds: ['session-history'],
    temporal: { from: 500, to: 1_000 },
  }, {})
  assert.deepEqual(result.hits.map(hit => hit.text), ['recent event'])
})
