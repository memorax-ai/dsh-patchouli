import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PatchouliRpcError,
  type PatchouliStorageService,
} from 'dsh-patchouli/storage'
import type { JsonValue } from 'dsh-patchouli-protocol'

import {
  SESSION_HISTORY_BINDING,
  SESSION_HISTORY_ENTITY_TYPE,
  SessionHistoryAlgorithm,
} from '../lib/algo/session-history.js'
import type {
  SessionContextRecord,
  SessionIndexResult,
} from '../lib/index/session.js'

function record(
  id: string,
  seq: number,
  kind: SessionContextRecord['kind'],
  text: string,
): SessionContextRecord {
  return {
    id,
    kind,
    text,
    source: {
      type: 'session-event',
      sessionId: 'session-1',
      seq,
      time: 1_700_000_000_000 + seq,
      eventType: kind === 'assistant-message' ? 'assistant/message' : 'user/message',
      surface: 'current',
      cwd: '/workspace',
      turn: 1,
      step: 0,
      messageId: `message-${seq}`,
    },
    data: { content: [{ type: 'text', text }] },
  }
}

const indexed: SessionIndexResult = {
  session: {
    id: 'session-1',
    version: 0,
    createdAt: 1_700_000_000_000,
    cwd: '/workspace',
  },
  records: [
    record('session:session-1:event:1', 1, 'user-message', 'investigate auth'),
    record('session:session-1:event:2', 2, 'assistant-message', 'found handler'),
  ],
  nextAfterSeq: 2,
  hasMore: false,
}

test('ingest creates missing records and updates existing stable ids', async () => {
  const reads: unknown[] = []
  const creates: any[] = []
  const updates: any[] = []
  const storage = {
    async read(request: any) {
      reads.push(request)
      if (request.data.ref.id.endsWith(':1')) {
        throw new PatchouliRpcError(
          'patchouli.entity.read@1',
          -32003,
          'not found',
          { reason: 'NOT_FOUND' },
        )
      }
      return {
        meta: {},
        data: {
          state: 'conflicted',
          variants: [
            {
              ref: request.data.ref,
              version: 'old-a',
              state: 'active',
              value: { previous: true },
            },
            {
              ref: request.data.ref,
              version: 'old-b',
              state: 'active',
              value: { previous: true },
            },
          ],
        },
      }
    },
    async create(request: any) {
      creates.push(request)
      return {
        meta: {},
        data: {
          entity: {
            ref: { type: request.data.type, id: request.data.id },
            version: 'created-v1',
            state: 'active',
            value: request.data.value,
          },
        },
      }
    },
    async update(request: any) {
      updates.push(request)
      return {
        meta: {},
        data: {
          entity: {
            ref: request.data.ref,
            version: 'updated-v2',
            state: 'active',
            value: request.data.value,
          },
        },
      }
    },
    async query() {
      throw new Error('unexpected query')
    },
  } as unknown as PatchouliStorageService

  const result = await new SessionHistoryAlgorithm(storage).ingest({
    meta: { workspace: 'workspace-1', channel_id: 'session-1' },
    index: indexed,
  }, {})

  assert.equal(reads.length, 2)
  assert.equal(creates.length, 1)
  assert.equal(updates.length, 1)
  assert.equal(creates[0].data.type, SESSION_HISTORY_ENTITY_TYPE)
  assert.equal(creates[0].data.id, indexed.records[0]?.id)
  assert.deepEqual(updates[0].meta.base_versions, ['old-a', 'old-b'])
  assert.equal(updates[0].data.ref.id, indexed.records[1]?.id)

  const stored = creates[0].data.value
  assert.equal(stored.content.kind, 'structured')
  assert.deepEqual(stored.content.value, {
    text: 'investigate auth',
    kind: 'user-message',
    session: indexed.session,
    source: indexed.records[0]?.source,
    data: indexed.records[0]?.data,
  })
  assert.equal(stored.metadata.core.origin.binding, SESSION_HISTORY_BINDING)
  assert.deepEqual(result, {
    created: 1,
    updated: 1,
    refs: [
      { type: 'knowledge', id: indexed.records[0]?.id, version: 'created-v1' },
      { type: 'knowledge', id: indexed.records[1]?.id, version: 'updated-v2' },
    ],
  })
})

test('ingest skips unchanged records when replaying session history', async () => {
  const entry = indexed.records[0]!
  const existingValue = storedValue(entry)
  const updates: unknown[] = []
  const storage = {
    async read(request: any) {
      return {
        meta: {},
        data: {
          state: 'active',
          variants: [{
            ref: request.data.ref,
            version: 'existing-v1',
            state: 'active',
            value: existingValue,
          }],
        },
      }
    },
    async update(request: unknown) {
      updates.push(request)
      throw new Error('unchanged record must not be updated')
    },
  } as unknown as PatchouliStorageService

  const result = await new SessionHistoryAlgorithm(storage).ingest({
    meta: {},
    index: { ...indexed, records: [entry] },
  }, {})

  assert.equal(updates.length, 0)
  assert.deepEqual(result, {
    created: 0,
    updated: 0,
    refs: [{ type: 'knowledge', id: entry.id, version: 'existing-v1' }],
  })
})

test('ingest still updates a stable id when record content changes', async () => {
  const entry = indexed.records[0]!
  const previous = record(entry.id, entry.source.seq, entry.kind, 'older content')
  const updates: any[] = []
  const storage = {
    async read(request: any) {
      return {
        meta: {},
        data: {
          state: 'active',
          variants: [{
            ref: request.data.ref,
            version: 'existing-v1',
            state: 'active',
            value: storedValue(previous),
          }],
        },
      }
    },
    async update(request: any) {
      updates.push(request)
      return {
        meta: {},
        data: {
          entity: {
            ref: request.data.ref,
            version: 'updated-v2',
            state: 'active',
            value: request.data.value,
          },
        },
      }
    },
  } as unknown as PatchouliStorageService

  const result = await new SessionHistoryAlgorithm(storage).ingest({
    meta: {},
    index: { ...indexed, records: [entry] },
  }, {})

  assert.equal(updates.length, 1)
  assert.equal(updates[0].data.value.content.value.text, entry.text)
  assert.deepEqual(result, {
    created: 0,
    updated: 1,
    refs: [{ type: 'knowledge', id: entry.id, version: 'updated-v2' }],
  })
})

test('query uses DB text, where, types, and order filters and bounds hits', async () => {
  const calls: any[] = []
  const values = [
    storedValue(record('session:session-1:event:3', 3, 'assistant-message', 'auth result three')),
    storedValue(record('session:session-1:event:2', 2, 'assistant-message', 'auth result two')),
    storedValue(record('session:session-1:event:4', 4, 'assistant-message', 'auth result four')),
  ]
  const storage = {
    async query(meta: unknown, instruction: unknown, options: unknown) {
      calls.push({ meta, instruction, options })
      return {
        meta: {},
        data: {
          hits: values.map((value, index) => ({
            score: [0.4, 0.9, 0.6][index],
            variants: [{
              ref: { type: 'knowledge', id: `history-${index}` },
              version: `v${index}`,
              state: 'active',
              value,
            }],
          })),
        },
      }
    },
  } as unknown as PatchouliStorageService

  const result = await new SessionHistoryAlgorithm(storage).query({
    meta: { workspace: 'workspace-1' },
    query: ' auth ',
    sessionId: 'session-1',
    kinds: ['assistant-message'],
    limit: 2,
  }, {})

  assert.deepEqual(calls, [{
    meta: { workspace: 'workspace-1' },
    instruction: {
      text: 'auth',
      where: {
        '/metadata/core/origin/binding': SESSION_HISTORY_BINDING,
        '/content/value/session/id': 'session-1',
        '/content/value/kind': 'assistant-message',
      },
      order: 'relevance',
    },
    options: { types: ['knowledge'], limit: 2 },
  }])
  assert.equal(result.hits.length, 2)
  assert.deepEqual(result.hits.map(hit => [hit.score, hit.ref.id]), [
    [0.9, 'history-1'],
    [0.6, 'history-2'],
  ])
  assert.equal(result.hits[0]?.source.sessionId, 'session-1')
  assert.equal(result.hits[0]?.kind, 'assistant-message')
  assert.equal(result.truncated, true)
})

test('checks abort before ingest and after query storage calls', async () => {
  let reads = 0
  const before = new AbortController()
  const beforeReason = new Error('stop ingest')
  before.abort(beforeReason)
  const ingestStorage = {
    read: async () => {
      reads += 1
      throw new Error('unexpected')
    },
  } as unknown as PatchouliStorageService
  await assert.rejects(
    new SessionHistoryAlgorithm(ingestStorage).ingest({ meta: {}, index: indexed }, {
      signal: before.signal,
    }),
    error => error === beforeReason,
  )
  assert.equal(reads, 0)

  const after = new AbortController()
  const afterReason = new Error('stop query')
  const queryStorage = {
    async query() {
      after.abort(afterReason)
      return { meta: {}, data: { hits: [] } }
    },
  } as unknown as PatchouliStorageService
  await assert.rejects(
    new SessionHistoryAlgorithm(queryStorage).query({ meta: {}, query: 'auth' }, {
      signal: after.signal,
    }),
    error => error === afterReason,
  )
})

function storedValue(entry: SessionContextRecord): JsonValue {
  return {
    content: {
      kind: 'structured',
      value: {
        text: entry.text,
        kind: entry.kind,
        session: indexed.session,
        source: entry.source as unknown as JsonValue,
        data: entry.data as JsonValue,
      },
    },
    metadata: {
      core: { origin: { binding: SESSION_HISTORY_BINDING } },
    },
    artifact: [],
    profile: {},
  }
}
