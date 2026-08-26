import assert from 'node:assert/strict'
import test from 'node:test'

import { WorkspaceContextAlgorithm } from '../lib/algo/workspace-context.js'

function missing(): Error & { reason: string } {
  return Object.assign(new Error('missing'), { reason: 'NOT_FOUND' })
}

function workspaceIndex() {
  return {
    workspace: {
      id: 'workspace-1',
      path: '/work',
      title: 'work',
      updatedAt: '2026-08-26T00:00:00.000Z',
    },
    files: [{
      name: 'main.ts',
      path: 'src/main.ts',
      size: 24,
      version: 'file-v1',
      text: 'export const answer = 42',
      textTruncated: false,
      source: {
        kind: 'workspace-file' as const,
        workspaceId: 'workspace-1',
        workspacePath: '/work',
        path: 'src/main.ts',
        uri: 'file:///work/src/main.ts',
        version: 'file-v1',
      },
    }],
    truncated: false,
  }
}

test('workspace context upserts stable knowledge entities and queries DB filters', async () => {
  const values = new Map<string, { version: string; value: unknown }>()
  const mutations: Array<{ operation: string; id: string; value: unknown }> = []
  let queryCall: unknown
  const storage = {
    read: async (request: { data: { ref: { id: string } } }) => {
      const entity = values.get(request.data.ref.id)
      if (entity === undefined) throw missing()
      return {
        data: {
          state: 'active',
          variants: [{
            ref: { type: 'knowledge', id: request.data.ref.id },
            version: entity.version,
            state: 'active',
            value: entity.value,
          }],
        },
        meta: {},
      }
    },
    create: async (request: { data: { id: string; value: unknown } }) => {
      values.set(request.data.id, { version: 'knowledge-v1', value: request.data.value })
      mutations.push({ operation: 'create', id: request.data.id, value: request.data.value })
      return {
        data: {
          entity: {
            ref: { type: 'knowledge', id: request.data.id },
            version: 'knowledge-v1',
            state: 'active',
            value: request.data.value,
          },
        },
        meta: {},
      }
    },
    update: async (request: { data: { ref: { id: string }; value: unknown } }) => {
      values.set(request.data.ref.id, { version: 'knowledge-v2', value: request.data.value })
      mutations.push({ operation: 'update', id: request.data.ref.id, value: request.data.value })
      return {
        data: {
          entity: {
            ref: { type: 'knowledge', id: request.data.ref.id },
            version: 'knowledge-v2',
            state: 'active',
            value: request.data.value,
          },
        },
        meta: {},
      }
    },
    query: async (meta: unknown, instruction: unknown, options: unknown) => {
      queryCall = { meta, instruction, options }
      const [id, entity] = [...values.entries()][0]!
      return {
        data: {
          hits: [{
            score: 0.75,
            variants: [{
              ref: { type: 'knowledge', id },
              version: entity.version,
              state: 'active',
              value: entity.value,
            }],
          }],
        },
        meta: {},
      }
    },
    queryPages: async function* () {
      yield await storage.query({}, {}, {})
    },
    delete: async (request: { data: { ref: { id: string } } }) => {
      const entity = values.get(request.data.ref.id)!
      values.delete(request.data.ref.id)
      return {
        data: {
          entity: {
            ref: { type: 'knowledge', id: request.data.ref.id },
            version: entity.version,
            state: 'deleted',
            value: entity.value,
          },
        },
        meta: {},
      }
    },
  }
  const algorithm = new WorkspaceContextAlgorithm(storage)
  const request = { meta: { workspace_id: 'workspace-1' }, index: workspaceIndex() }

  const created = await algorithm.ingest(request, {})
  const unchanged = await algorithm.ingest(request, {})

  assert.equal(created.entities[0]?.operation, 'create')
  assert.equal(unchanged.entities[0]?.operation, 'unchanged')
  assert.equal(created.entities[0]?.id, unchanged.entities[0]?.id)
  assert.deepEqual(mutations.map(mutation => mutation.operation), ['create'])
  assert.equal(created.deleted, 0)
  assert.equal(unchanged.deleted, 0)
  const value = mutations[0]?.value as any
  assert.equal(value.content.text, 'src/main.ts\nexport const answer = 42')
  assert.deepEqual(
    value.metadata.extensions['dsh.native_context'].source,
    workspaceIndex().files[0]?.source,
  )

  const result = await algorithm.query({
    meta: { workspace_id: 'workspace-1' },
    text: 'answer',
    workspaceId: 'workspace-1',
    path: 'src/main.ts',
    limit: 5,
  }, {})

  assert.equal(result.hits[0]?.score, 0.75)
  assert.equal(result.hits[0]?.source.uri, 'file:///work/src/main.ts')
  assert.deepEqual(queryCall, {
    meta: { workspace_id: 'workspace-1' },
    instruction: {
      text: 'answer',
      where: {
        '/metadata/extensions/dsh.native_context/context_kind': 'workspace-file',
        '/metadata/extensions/dsh.native_context/workspace_id': 'workspace-1',
        '/metadata/extensions/dsh.native_context/path': 'src/main.ts',
      },
      order: 'relevance',
    },
    options: { types: ['knowledge'], limit: 5 },
  })
})

test('workspace context deletes entities absent from a complete snapshot', async () => {
  const values = new Map<string, { version: string; value: unknown }>()
  const deleted: string[] = []
  const hits = () => [...values.entries()].map(([id, entity]) => ({
    score: 1,
    variants: [{
      ref: { type: 'knowledge', id },
      version: entity.version,
      state: 'active',
      value: entity.value,
    }],
  }))
  const storage = {
    read: async (request: { data: { ref: { id: string } } }) => {
      const entity = values.get(request.data.ref.id)
      if (entity === undefined) throw missing()
      return { data: { state: 'active', variants: hits()
        .find(hit => hit.variants[0]?.ref.id === request.data.ref.id)!.variants }, meta: {} }
    },
    create: async (request: { data: { id: string; value: unknown } }) => {
      const entity = { version: `${request.data.id}-v1`, value: request.data.value }
      values.set(request.data.id, entity)
      return { data: { entity: { ref: { type: 'knowledge', id: request.data.id }, state: 'active', ...entity } }, meta: {} }
    },
    update: async () => { throw new Error('unexpected update') },
    query: async () => ({ data: { hits: hits() }, meta: {} }),
    queryPages: async function* () {
      yield { data: { hits: hits() }, meta: {} }
    },
    delete: async (request: { data: { ref: { id: string } } }) => {
      const entity = values.get(request.data.ref.id)!
      deleted.push(request.data.ref.id)
      values.delete(request.data.ref.id)
      return { data: { entity: { ref: { type: 'knowledge', id: request.data.ref.id }, state: 'deleted', ...entity } }, meta: {} }
    },
  }
  const algorithm = new WorkspaceContextAlgorithm(storage)
  const first = workspaceIndex()
  const old = {
    ...first.files[0]!,
    name: 'old.ts',
    path: 'src/old.ts',
    source: {
      ...first.files[0]!.source,
      path: 'src/old.ts',
      uri: 'file:///work/src/old.ts',
    },
  }

  await algorithm.ingest({ meta: {}, index: { ...first, files: [...first.files, old] } }, {})
  const result = await algorithm.ingest({ meta: {}, index: first }, {})

  assert.equal(result.deleted, 1)
  assert.equal(deleted.length, 1)
  assert.match(deleted[0]!, /src\/old\.ts/)
  assert.equal(values.size, 1)
})

test('workspace context enforces the query cap before DB access', async () => {
  let queried = false
  const algorithm = new WorkspaceContextAlgorithm({
    read: async () => { throw missing() },
    create: async () => { throw new Error('unexpected') },
    update: async () => { throw new Error('unexpected') },
    delete: async () => { throw new Error('unexpected') },
    queryPages: async function* () { throw new Error('unexpected') },
    query: async () => {
      queried = true
      throw new Error('unexpected')
    },
  })

  await assert.rejects(algorithm.query({
    meta: {},
    workspaceId: 'workspace-1',
    limit: 51,
  }, {}), /1 to 50/)
  assert.equal(queried, false)
})
