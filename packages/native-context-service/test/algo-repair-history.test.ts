import assert from 'node:assert/strict'
import test from 'node:test'

import { PatchouliRpcError } from 'dsh-patchouli/storage'

import { RepairHistoryAlgorithm } from '../lib/algo/repair-history.js'

test('extracts and retrieves a failed tool attempt followed by a successful repair', async () => {
  const created = []
  const storage = {
    async read() {
      throw new PatchouliRpcError(
        'patchouli.entity.read@1', -32003, 'not found', { reason: 'NOT_FOUND' },
      )
    },
    async create(request) {
      created.push(request)
      return { meta: {}, data: { entity: { ref: { type: 'knowledge', id: request.data.id } } } }
    },
    async query() {
      const item = created[0]
      return {
        meta: {},
        data: {
          hits: [{
            score: 0.91,
            variants: [{
              ref: { type: 'knowledge', id: item.data.id },
              version: 'v1',
              state: 'active',
              value: item.data.value,
            }],
          }],
        },
      }
    },
  }
  const source = (seq, callId) => ({
    type: 'session-event', sessionId: 'session-1', seq,
    time: 1_700_000_000_000 + seq, eventType: 'tool/result',
    surface: 'current', cwd: '/work', turn: 2, callId,
  })
  const algorithm = new RepairHistoryAlgorithm(storage)
  const result = await algorithm.ingest({
    meta: {},
    index: {
      session: { id: 'session-1', version: 0, createdAt: 1 },
      nextAfterSeq: 4,
      hasMore: false,
      records: [
        { id: '1', kind: 'tool-call', text: 'bash\nbad command', source: { ...source(1, 'a'), eventType: 'tool/call' }, data: {} },
        { id: '2', kind: 'tool-result', text: 'Error: missing file', source: source(2, 'a'), data: { error: { name: 'Error' } } },
        { id: '3', kind: 'tool-call', text: 'bash\nfixed command', source: { ...source(3, 'b'), eventType: 'tool/call' }, data: {} },
        { id: '4', kind: 'tool-result', text: 'all tests passed', source: source(4, 'b'), data: {} },
      ],
    },
  }, {})
  assert.deepEqual(result, { created: 1 })

  const recalled = await algorithm.query({ meta: {}, text: 'missing file' }, {})
  assert.equal(recalled.hits.length, 1)
  assert.match(recalled.hits[0].text, /fixed command/)
  assert.equal(recalled.hits[0].source.fromSeq, 2)
  assert.equal(recalled.hits[0].source.toSeq, 4)
})
