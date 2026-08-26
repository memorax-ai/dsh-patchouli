import assert from 'node:assert/strict'
import test from 'node:test'

import { PatchouliRpcError } from 'dsh-patchouli/storage'

import { GitContextAlgorithm } from '../lib/algo/git-context.js'

function gitIndex(overrides = {}) {
  return {
    workspace: { id: 'workspace-1', path: '/work/project' },
    repository: { root: '/work/project', branch: 'main', head: 'abc123' },
    commits: [{
      hash: 'abc123',
      parents: ['parent'],
      author: 'Ada',
      authoredAt: '2026-08-25T10:00:00Z',
      subject: 'Fix scheduler race',
    }],
    paths: [{ path: 'src/run.ts', status: 'modified', staged: true }],
    clean: false,
    commitsTruncated: false,
    pathsTruncated: false,
    truncated: false,
    ...overrides,
  }
}

function storageFixture() {
  const entities = new Map()
  const creates = []
  const updates = []
  const deletes = []
  const queries = []
  return {
    entities,
    creates,
    updates,
    deletes,
    queries,
    storage: {
      async read(request) {
        if (request.data.ref.type !== 'knowledge') throw new Error('unknown entity type')
        const value = entities.get(`${request.data.ref.type}:${request.data.ref.id}`)
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
      async delete(request) {
        deletes.push(request)
        entities.delete(`${request.data.ref.type}:${request.data.ref.id}`)
        return { meta: {}, data: { entity: {} } }
      },
      async query(meta, instruction, options) {
        queries.push({ meta, instruction, options })
        const value = [...entities.values()].find(entity => (
          entity.metadata.extensions['dsh.native_context'].context_kind === 'git-commit'
        ))
        return {
          meta: {},
          data: {
            hits: value === undefined ? [] : [{
              score: 0.9,
              variants: [{
                ref: { type: 'knowledge', id: 'commit' },
                version: 'v1',
                state: 'active',
                value,
              }],
            }],
          },
        }
      },
      async *queryPages(meta, instruction, options) {
        const hits = [...entities.entries()].flatMap(([key, value]) => {
          const extension = value.metadata.extensions['dsh.native_context']
          const expectedKind = instruction.where?.['/metadata/extensions/dsh.native_context/context_kind']
          const expectedWorkspace = instruction.where?.['/metadata/extensions/dsh.native_context/workspace_id']
          if (extension.context_kind !== expectedKind || extension.workspace_id !== expectedWorkspace) return []
          return [{
            score: 1,
            variants: [{
              ref: { type: 'knowledge', id: key.slice('knowledge:'.length) },
              version: 'v1',
              state: 'active',
              value,
            }],
          }]
        })
        yield { meta: {}, data: { hits } }
      },
    },
  }
}

test('stores repository, commit, and changed path as stable entities', async () => {
  const fixture = storageFixture()
  const algorithm = new GitContextAlgorithm(fixture.storage)
  const input = { meta: { workspace: 'alpha' }, index: gitIndex() }

  assert.deepEqual(await algorithm.ingest(input, {}), { stored: 3 })
  assert.equal(fixture.creates.length, 3)
  assert.deepEqual(fixture.creates.map(call => call.data.type), [
    'knowledge',
    'knowledge',
    'knowledge',
  ])
  assert.deepEqual(fixture.creates.map(call => (
    call.data.value.metadata.extensions['dsh.native_context'].context_kind
  )), ['git-repository', 'git-commit', 'git-path'])
  assert.equal(fixture.creates[1].data.value.content.text.includes('Fix scheduler race'), true)
  assert.deepEqual(fixture.creates[2].data.value.metadata.extensions['dsh.native_context'].source, {
    kind: 'git',
    workspace_id: 'workspace-1',
    workspace_path: '/work/project',
    repository_root: '/work/project',
    entity: 'path',
    path: 'src/run.ts',
  })

  assert.deepEqual(await algorithm.ingest(input, {}), { stored: 0 })
  assert.equal(fixture.creates.length, 3)
  assert.equal(fixture.updates.length, 0)
})

test('does not invent Git entities when the index has no repository', async () => {
  const fixture = storageFixture()
  const algorithm = new GitContextAlgorithm(fixture.storage)
  assert.deepEqual(await algorithm.ingest({
    meta: {},
    index: gitIndex({ repository: null, commits: [], paths: [], clean: null }),
  }, {}), { stored: 0 })
  assert.equal(fixture.creates.length, 0)
})

test('removes changed paths that disappear from a complete Git snapshot', async () => {
  const fixture = storageFixture()
  const algorithm = new GitContextAlgorithm(fixture.storage)
  const input = { meta: { workspace: 'alpha' }, index: gitIndex() }
  await algorithm.ingest(input, {})
  await algorithm.ingest({
    ...input,
    index: gitIndex({ paths: [], clean: true }),
  }, {})

  assert.equal(fixture.deletes.length, 1)
  assert.equal(fixture.deletes[0].data.ref.id.includes('git-path'), true)
})

test('queries bounded Git context through Patchouli retrieval', async () => {
  const fixture = storageFixture()
  const algorithm = new GitContextAlgorithm(fixture.storage)
  await algorithm.ingest({ meta: { workspace: 'alpha' }, index: gitIndex() }, {})
  const result = await algorithm.query({
    meta: { workspace: 'alpha' },
    text: 'scheduler',
    workspaceId: 'workspace-1',
    limit: 4,
  }, {})

  assert.deepEqual(fixture.queries.map(call => call.instruction.where), [
    {
      '/metadata/extensions/dsh.native_context/context_kind': 'git-repository',
      '/metadata/extensions/dsh.native_context/workspace_id': 'workspace-1',
    },
    {
      '/metadata/extensions/dsh.native_context/context_kind': 'git-commit',
      '/metadata/extensions/dsh.native_context/workspace_id': 'workspace-1',
    },
    {
      '/metadata/extensions/dsh.native_context/context_kind': 'git-path',
      '/metadata/extensions/dsh.native_context/workspace_id': 'workspace-1',
    },
  ])
  assert.deepEqual(fixture.queries.map(call => call.options), [
    { types: ['knowledge'], limit: 4 },
    { types: ['knowledge'], limit: 4 },
    { types: ['knowledge'], limit: 4 },
  ])
  assert.equal(result.hits[0].score, 0.9)
  assert.equal(result.hits[0].source.commit, 'abc123')
})
