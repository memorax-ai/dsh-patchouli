import assert from 'node:assert/strict'
import test from 'node:test'

import { PatchouliRpcError } from 'dsh-patchouli/storage'

import { ArtifactContextAlgorithm } from '../lib/algo/artifact-context.js'

function artifact(overrides = {}) {
  return {
    id: 'artifact-1',
    version: 'version-1',
    mediaType: 'application/octet-stream',
    name: 'weights.bin',
    byteLength: 4096,
    digest: 'sha256:abc',
    metadata: {
      description: 'trained checkpoint',
      bytes_base64: 'must-not-be-copied',
    },
    text: null,
    textTruncated: false,
    source: {
      kind: 'patchouli-artifact',
      id: 'artifact-1',
      version: 'version-1',
      role: 'attachment',
      provider: 'filesystem',
      locator: 'objects/abc',
    },
    ...overrides,
  }
}

function storageFixture() {
  const entities = new Map()
  const creates = []
  const updates = []
  const queries = []
  return {
    entities,
    creates,
    updates,
    queries,
    storage: {
      async read(request) {
        if (request.data.ref.type !== 'knowledge') throw new Error('unknown entity type')
        const key = `${request.data.ref.type}:${request.data.ref.id}`
        const value = entities.get(key)
        if (value === undefined) {
          throw new PatchouliRpcError(
            'patchouli.entity.read@1',
            -32001,
            'missing',
            { reason: 'NOT_FOUND' },
          )
        }
        return {
          meta: {},
          data: {
            state: value === undefined ? 'deleted' : 'active',
            variants: value === undefined ? [] : [{
              ref: request.data.ref,
              version: 'v1',
              state: 'active',
              value,
            }],
          },
        }
      },
      async create(request) {
        if (request.data.type !== 'knowledge') throw new Error('unknown entity type')
        creates.push(request)
        entities.set(`${request.data.type}:${request.data.id}`, request.data.value)
        return { meta: {}, data: { entity: {} } }
      },
      async update(request) {
        if (request.data.ref.type !== 'knowledge') throw new Error('unknown entity type')
        updates.push(request)
        entities.set(`${request.data.ref.type}:${request.data.ref.id}`, request.data.value)
        return { meta: {}, data: { entity: {} } }
      },
      async query(meta, instruction, options) {
        queries.push({ meta, instruction, options })
        const value = [...entities.values()][0]
        return {
          meta: {},
          data: {
            hits: value === undefined ? [] : [{
              score: 0.75,
              variants: [{
                ref: { type: 'knowledge', id: 'stored' },
                version: 'v1',
                state: 'active',
                value,
              }],
            }],
          },
        }
      },
    },
  }
}

test('stores only artifact description, visible text, and source reference', async () => {
  const fixture = storageFixture()
  const algorithm = new ArtifactContextAlgorithm(fixture.storage)
  const input = {
    meta: { workspace: 'alpha' },
    index: { artifacts: [artifact()], truncated: false },
  }

  assert.deepEqual(await algorithm.ingest(input, {}), { stored: 1 })
  assert.equal(fixture.creates.length, 1)
  const value = fixture.creates[0].data.value
  assert.equal(fixture.creates[0].data.type, 'knowledge')
  assert.equal(
    value.content.value.description,
    'weights.bin · trained checkpoint · application/octet-stream',
  )
  assert.equal(value.content.value.visible_text, null)
  assert.equal(value.metadata.extensions['dsh.native_context'].context_kind, 'artifact')
  assert.deepEqual(value.metadata.extensions['dsh.native_context'].source, artifact().source)
  assert.equal(JSON.stringify(value).includes('must-not-be-copied'), false)

  await algorithm.ingest(input, {})
  assert.equal(fixture.creates.length, 1)
  assert.equal(fixture.updates.length, 1)
  assert.deepEqual(fixture.updates[0].meta.base_versions, ['v1'])
})

test('queries bounded artifact entities through Patchouli retrieval', async () => {
  const fixture = storageFixture()
  const algorithm = new ArtifactContextAlgorithm(fixture.storage)
  await algorithm.ingest({
    meta: { workspace: 'alpha' },
    index: {
      artifacts: [artifact({
        mediaType: 'text/plain',
        name: 'plan.md',
        text: 'Ship the release plan.',
      })],
      truncated: false,
    },
  }, {})

  const result = await algorithm.query({
    meta: { workspace: 'alpha' },
    text: ' release ',
    limit: 3,
  }, {})
  assert.deepEqual(fixture.queries, [{
    meta: { workspace: 'alpha' },
    instruction: {
      text: 'release',
      where: { '/metadata/extensions/dsh.native_context/context_kind': 'artifact' },
      order: 'relevance',
    },
    options: { types: ['knowledge'], limit: 3 },
  }])
  assert.equal(result.hits[0].score, 0.75)
  assert.equal(result.hits[0].text, 'Ship the release plan.')
  assert.deepEqual(result.hits[0].source, artifact().source)
})

test('honors cancellation before artifact storage work', async () => {
  const fixture = storageFixture()
  const algorithm = new ArtifactContextAlgorithm(fixture.storage)
  const controller = new AbortController()
  controller.abort(new Error('stop'))
  await assert.rejects(
    algorithm.ingest({
      meta: {},
      index: { artifacts: [artifact()], truncated: false },
    }, { signal: controller.signal }),
    /stop/,
  )
  assert.equal(fixture.creates.length, 0)
})
