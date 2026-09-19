import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionHistoryReader } from '../lib/session-compat.js'
const id = SessionId('fixture')
const header: SessionHeader = { id, version: 0, createdAt: 0 }
const events: SessionEvent[] = [{ type: 'turn/start', seq: 7, time: 0, data: { turn: 0 } }]
import { listSessionHeaders, readSessionHistory, sessionEvents } from '../lib/session-compat.js'

for (const outcome of ['success', 'failure', 'abort']) {
  test(`modern persistence closes its borrowed read handle on ${outcome}`, async () => {
    const controller = new AbortController()
    let closed = 0
    const persistence: Extract<SessionHistoryReader, { open: unknown }> = {
      async open(id, access, options) {
        assert.equal(id, 'fixture'); assert.equal(access, 'read'); assert.equal(options?.signal, controller.signal)
        return {
          header,
          async read(offset, length, options) {
            assert.equal(offset, 7); assert.equal(length, undefined); assert.equal(options?.signal, controller.signal)
            if (outcome === 'failure') throw new Error('read failed')
            if (outcome === 'abort') { controller.abort(); options?.signal.throwIfAborted() }
            return { events }
          },
          async close() { closed++ },
        }
      },
    }
    const read = readSessionHistory(persistence, id, 7, controller.signal)
    if (outcome === 'success') assert.deepEqual(await read, { meta: header, events })
    else await assert.rejects(read)
    assert.equal(closed, 1)
  })
}

test('list adapts modern snapshot headers and forwards cancellation in both APIs', async () => {
  const signal = new AbortController().signal
  const headers = [header]
  assert.deepEqual(await listSessionHeaders({ async open() { throw new Error('unused') }, async list(options?: { signal?: AbortSignal }) { assert.equal(options?.signal, signal); return headers.map(header => ({ header, revision: 'r1' })) } }, signal), headers)
  assert.deepEqual(await listSessionHeaders({ async readFrom() { throw new Error('unused') }, async list(actual?: AbortSignal) { assert.equal(actual, signal); return headers } }, signal), headers)
})

test('legacy reads preserve the requested offset and modern history uses immutable snapshots', async () => {
  const expected = { meta: header, events }
  assert.equal(await readSessionHistory({ async readFrom(id, offset) { assert.equal(id, 'fixture'); assert.equal(offset, 3); return expected } }, id, 3), expected)
  assert.equal(sessionEvents({ events: expected.events }), expected.events)
  assert.equal(sessionEvents({ snapshotEvents: () => expected.events }), expected.events)
})
