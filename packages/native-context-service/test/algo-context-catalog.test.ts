import assert from 'node:assert/strict'
import test from 'node:test'

import { PatchouliRpcError } from 'dsh-patchouli/storage'

import { ContextCatalogAlgorithm } from '../lib/algo/context-catalog.js'

test('stores and retrieves navigable session catalog nodes', async () => {
  const created = []
  const storage = {
    async read() {
      throw new PatchouliRpcError(
        'patchouli.entity.read@1', -32003, 'not found', { reason: 'NOT_FOUND' },
      )
    },
    async create(request) {
      created.push(request)
      return { meta: {}, data: {} }
    },
    async update() { throw new Error('unexpected update') },
    async query() {
      return {
        meta: {},
        data: {
          hits: created.map(item => ({
            score: 0.8,
            variants: [{ state: 'active', value: item.data.value }],
          })),
        },
      }
    },
  }
  const catalog = new ContextCatalogAlgorithm(storage)
  assert.deepEqual(await catalog.ingest({
    kind: 'session',
    meta: {},
    index: {
      session: { id: 'session-1', version: 0, createdAt: 100, cwd: '/work', agentPreset: 'coder' },
      records: [], nextAfterSeq: 0, hasMore: false,
    },
  }, {}), { stored: 1 })

  const result = await catalog.query({ meta: {}, text: 'coder session' }, {})
  assert.equal(result.hits[0].source.node, 'session')
  assert.equal(result.hits[0].source.sessionId, 'session-1')
  assert.match(result.hits[0].text, /agent coder/)
})
