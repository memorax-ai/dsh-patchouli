import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SESSION_INDEX_MAX_LIMIT,
  SessionIndex,
  type SessionHeaderSnapshot,
  type SessionQueryReader,
} from '../lib/index.js'

const header: SessionHeaderSnapshot = {
  id: 'session-1',
  version: 0,
  createdAt: 1_700_000_000_000,
  cwd: '/workspace',
  agentPreset: 'coding',
}

const historicalHeader: SessionHeaderSnapshot = {
  id: 'session-older',
  version: 0,
  createdAt: 1_600_000_000_000,
  cwd: '/older-workspace',
}

const corruptHeader: SessionHeaderSnapshot = {
  id: 'session-corrupt',
  version: 0,
  createdAt: 1_500_000_000_000,
}

const events = [
  {
    type: 'turn/start', seq: 0, time: 100, surface: 'log-only' as const,
    data: { turn: 0 },
  },
  {
    type: 'user/message', seq: 1, time: 101, surface: 'current' as const,
    data: {
      id: 'message-user',
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: '  investigate auth  ' }],
    },
  },
  {
    type: 'assistant/message', seq: 2, time: 102, surface: 'shadowed' as const,
    data: {
      turn: 0,
      step: 0,
      message: {
        id: 'message-assistant',
        role: 'assistant',
        source: { kind: 'model', provider: 'fixture', model: 'fixture' },
        content: [
          { type: 'reasoning', text: 'private chain of thought' },
          { type: 'text', text: 'I found the handler.' },
        ],
      },
    },
  },
  {
    type: 'tool/call', seq: 3, time: 103, surface: 'log-only' as const,
    data: {
      turn: 0,
      step: 0,
      callId: 'call-1',
      name: 'read_file',
      arguments: '{"path":"src/auth.ts"}',
    },
  },
  {
    type: 'tool/result', seq: 4, time: 104, surface: 'current' as const,
    data: {
      turn: 0,
      step: 0,
      message: {
        id: 'message-tool',
        role: 'user',
        source: { kind: 'tool', callId: 'call-1' },
        content: [{
          type: 'tool-result',
          toolCallId: 'call-1',
          content: [{ type: 'text', text: 'export function authorize() {}' }],
        }],
      },
    },
  },
]

function createReader(searchDisabled = false) {
  const reads: Array<{ sessionId: string, seq: number, before?: number, after?: number }> = []
  const signals: Array<AbortSignal | undefined> = []
  let sessionReads = 0
  const reader: SessionQueryReader = {
    async searchSessions(request, exec) {
      exec?.signal?.throwIfAborted()
      if (searchDisabled) throw new Error('session search is disabled')
      return request.query.toLowerCase().includes('legacy') ? {
        items: [{
          header: historicalHeader,
          bestMatch: {
            seq: 7,
            type: 'assistant/message',
            time: 77,
            surface: 'current',
            snippet: 'legacy migration notes',
          },
        }],
      } : { items: [] }
    },
    async searchEvents(request, exec) {
      exec?.signal?.throwIfAborted()
      if (searchDisabled) throw new Error('session search is disabled')
      const needle = request.query.toLowerCase()
      const items = events.flatMap(event => {
        const text = JSON.stringify(event.data)
        return text.toLowerCase().includes(needle) ? [{
          seq: event.seq,
          type: event.type,
          time: event.time,
          surface: event.surface,
          snippet: text,
        }] : []
      }).slice(0, request.limit)
      return { session: header, items }
    },
    async filterEvents(sessionId, filters) {
      if (sessionId === corruptHeader.id) throw new Error('stored session is corrupt')
      const text = filters.find(filter => filter.kind === 'text')?.text.toLowerCase() ?? ''
      if (sessionId === historicalHeader.id) return 'legacy migration notes'.includes(text) ? [{
        sessionId: historicalHeader.id,
        seq: 7,
        type: 'assistant/message',
        time: 77,
        surface: 'current',
        text: 'legacy migration notes',
      }] : []
      assert.equal(sessionId, header.id)
      return events.flatMap(event => {
        const document = JSON.stringify(event.data)
        return document.toLowerCase().includes(text) ? [{
          sessionId: header.id,
          seq: event.seq,
          type: event.type,
          time: event.time,
          surface: event.surface,
          text: document,
        }] : []
      })
    },
    async listSessions(signal) {
      signal?.throwIfAborted()
      return [{ header }, { header: corruptHeader }, { header: historicalHeader }]
    },
    async listEvents(sessionId) {
      assert.equal(sessionId, header.id)
      return events.map(({ data: _data, ...record }) => record)
    },
    async readSession(sessionId) {
      assert.equal(sessionId, header.id)
      sessionReads += 1
      return { session: header, events }
    },
    async readEvent(request, signal) {
      reads.push(request)
      signals.push(signal)
      signal?.throwIfAborted()
      const target = events.find(event => event.seq === request.seq)
      if (target === undefined) throw new Error('missing fixture event')
      return { session: header, target }
    },
  }
  return { reader, reads, signals, get sessionReads() { return sessionReads } }
}

test('indexes current agent-loop session with one complete log read', async () => {
  const fixture = createReader()
  const { reader, reads, signals } = fixture
  const controller = new AbortController()
  const result = await new SessionIndex(reader).index({
    meta: {
      attributes: {
        point: 'agent/pre-step',
        sessionId: header.id,
      },
    },
  }, { signal: controller.signal })

  assert.deepEqual(result.records.map(record => record.kind), [
    'user-message',
    'assistant-message',
    'tool-call',
    'tool-result',
  ])
  assert.deepEqual(result.records.map(record => record.text), [
    'investigate auth',
    'I found the handler.',
    'read_file\n{"path":"src/auth.ts"}',
    'export function authorize() {}',
  ])
  assert.deepEqual(result.records[1]?.source, {
    type: 'session-event',
    sessionId: header.id,
    seq: 2,
    time: 102,
    eventType: 'assistant/message',
    surface: 'shadowed',
    cwd: '/workspace',
    turn: 0,
    step: 0,
    messageId: 'message-assistant',
  })
  assert.equal(result.records[0]?.source.messageId, 'message-user')
  assert.equal(result.records[2]?.source.callId, 'call-1')
  assert.equal(result.records[3]?.source.callId, 'call-1')
  assert.equal(result.nextAfterSeq, 4)
  assert.equal(result.hasMore, false)
  assert.equal(fixture.sessionReads, 1)
  assert.deepEqual(reads, [])
  assert.deepEqual(signals, [])
})

test('searches Session history directly without a Patchouli copy', async () => {
  const { reader } = createReader()
  const result = await new SessionIndex(reader).search({
    sessionId: header.id,
    query: 'authorize',
    limit: 5,
  }, {})

  assert.equal(result.hits.length, 1)
  assert.equal(result.hits[0]?.source.seq, 4)
  assert.match(result.hits[0]?.text ?? '', /authorize/u)
})

test('falls back to the official literal Session scan when full-text search is disabled', async () => {
  const { reader } = createReader(true)
  const result = await new SessionIndex(reader).search({
    sessionId: header.id,
    query: 'authorize',
    limit: 5,
  }, {})

  assert.equal(result.hits.length, 1)
  assert.equal(result.hits[0]?.source.seq, 4)
  assert.match(result.hits[0]?.text ?? '', /authorize/u)
})

test('searches matching events across historical Sessions', async () => {
  const { reader } = createReader()
  const result = await new SessionIndex(reader).searchAll({ query: 'legacy', limit: 5 }, {})

  assert.equal(result.hits.length, 1)
  assert.equal(result.hits[0]?.source.sessionId, historicalHeader.id)
  assert.equal(result.hits[0]?.source.cwd, historicalHeader.cwd)
})

test('scans all Sessions when cross-Session full-text search is disabled', async () => {
  const { reader } = createReader(true)
  const result = await new SessionIndex(reader).searchAll({ query: 'legacy', limit: 5 }, {})

  assert.equal(result.hits.length, 1)
  assert.equal(result.hits[0]?.source.sessionId, historicalHeader.id)
})

test('uses explicit session id and exposes a bounded resume cursor', async () => {
  const fixture = createReader()
  const { reader, reads } = fixture
  const result = await new SessionIndex(reader).index({
    sessionId: header.id,
    meta: { attributes: { sessionId: 'ignored-session' } },
    afterSeq: 1,
    limit: 2,
  }, {})

  assert.deepEqual(result.records.map(record => record.source.seq), [2, 3])
  assert.equal(result.nextAfterSeq, 3)
  assert.equal(result.hasMore, true)
  assert.equal(fixture.sessionReads, 1)
  assert.equal(reads.length, 0)
})

test('honors cancellation and rejects oversized reads before querying', async () => {
  const { reader, reads } = createReader()
  const index = new SessionIndex(reader)
  const controller = new AbortController()
  const reason = new Error('stop session indexing')
  controller.abort(reason)

  await assert.rejects(
    index.index({ sessionId: header.id }, { signal: controller.signal }),
    error => error === reason,
  )
  await assert.rejects(
    index.index({ sessionId: header.id, limit: SESSION_INDEX_MAX_LIMIT + 1 }, {}),
    /limit must be an integer/,
  )
  assert.equal(reads.length, 0)
})
