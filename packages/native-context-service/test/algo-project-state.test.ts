import assert from 'node:assert/strict'
import test from 'node:test'

import { ProjectStateAlgorithm } from '../lib/algo/project-state.js'

function missing(): Error & { reason: string } {
  return Object.assign(new Error('missing'), { reason: 'NOT_FOUND' })
}

function projectIndex() {
  return {
    workspace: {
      id: 'workspace-1',
      path: '/work',
      title: 'work',
      updatedAt: '2026-08-26T00:00:00.000Z',
    },
    documents: [{
      kind: 'readme' as const,
      name: 'README.md',
      path: 'README.md',
      size: 18,
      version: 'readme-v1',
      text: 'Patchouli project',
      textTruncated: false,
      source: {
        kind: 'workspace-file' as const,
        workspaceId: 'workspace-1',
        workspacePath: '/work',
        path: 'README.md',
        uri: 'file:///work/README.md',
        version: 'readme-v1',
      },
    }],
    truncated: false,
  }
}

test('project state stores only explicit project documents and queries by kind', async () => {
  const values = new Map<string, { version: string; value: unknown }>()
  const creates: Array<{ id: string; value: any }> = []
  let queryInstruction: any
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
      values.set(request.data.id, { version: 'project-v1', value: request.data.value })
      creates.push({ id: request.data.id, value: request.data.value })
      return {
        data: {
          entity: {
            ref: { type: 'knowledge', id: request.data.id },
            version: 'project-v1',
            state: 'active',
            value: request.data.value,
          },
        },
        meta: {},
      }
    },
    update: async () => { throw new Error('unexpected') },
    query: async (_meta: unknown, instruction: unknown, options: unknown) => {
      queryInstruction = { instruction, options }
      const [id, entity] = [...values.entries()][0]!
      return {
        data: {
          hits: [{
            score: 1,
            variants: [{
              ref: { type: 'knowledge', id },
              version: 'project-v1',
              state: 'active',
              value: entity.value,
            }],
          }],
        },
        meta: {},
      }
    },
    queryPages: async function* () {
      yield { data: { hits: [] }, meta: {} }
    },
    delete: async () => { throw new Error('unexpected delete') },
  }
  const algorithm = new ProjectStateAlgorithm(storage)

  const ingested = await algorithm.ingest({ meta: {}, index: projectIndex() }, {})

  assert.equal(ingested.entities.length, 1)
  assert.equal(ingested.entities[0]?.documentKind, 'readme')
  assert.equal(creates.length, 1)
  assert.equal(creates[0]?.value.content.text, 'readme\nREADME.md\nPatchouli project')
  assert.equal(
    creates[0]?.value.metadata.extensions['dsh.native_context'].context_kind,
    'project-document',
  )
  assert.deepEqual(
    creates[0]?.value.metadata.extensions['dsh.native_context'].source,
    projectIndex().documents[0]?.source,
  )
  const unchanged = await algorithm.ingest({ meta: {}, index: projectIndex() }, {})
  assert.equal(unchanged.entities[0]?.operation, 'unchanged')
  assert.equal(creates.length, 1)

  const result = await algorithm.query({
    meta: {},
    workspaceId: 'workspace-1',
    kind: 'readme',
    order: 'id_asc',
  }, {})

  assert.equal(result.hits[0]?.documentKind, 'readme')
  assert.equal(result.hits[0]?.source.path, 'README.md')
  assert.deepEqual(queryInstruction, {
    instruction: {
      where: {
        '/metadata/extensions/dsh.native_context/context_kind': 'project-document',
        '/metadata/extensions/dsh.native_context/workspace_id': 'workspace-1',
        '/metadata/extensions/dsh.native_context/document_kind': 'readme',
      },
      order: 'id_asc',
    },
    options: { types: ['knowledge'], limit: 10 },
  })
})

test('project state deletes documents absent from a complete snapshot', async () => {
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
  const algorithm = new ProjectStateAlgorithm(storage)
  const first = projectIndex()
  const old = {
    ...first.documents[0]!,
    kind: 'tasks' as const,
    name: 'TASKS.md',
    path: 'TASKS.md',
    source: {
      ...first.documents[0]!.source,
      path: 'TASKS.md',
      uri: 'file:///work/TASKS.md',
    },
  }

  await algorithm.ingest({ meta: {}, index: { ...first, documents: [...first.documents, old] } }, {})
  const result = await algorithm.ingest({ meta: {}, index: first }, {})

  assert.equal(result.deleted, 1)
  assert.equal(deleted.length, 1)
  assert.match(deleted[0]!, /TASKS\.md/)
  assert.equal(values.size, 1)
})

test('project state stops before DB work when aborted', async () => {
  let read = false
  const algorithm = new ProjectStateAlgorithm({
    read: async () => {
      read = true
      throw missing()
    },
    create: async () => { throw new Error('unexpected') },
    update: async () => { throw new Error('unexpected') },
    delete: async () => { throw new Error('unexpected') },
    queryPages: async function* () { throw new Error('unexpected') },
    query: async () => { throw new Error('unexpected') },
  })
  const controller = new AbortController()
  controller.abort(new Error('stop'))

  await assert.rejects(algorithm.ingest({ meta: {}, index: projectIndex() }, {
    signal: controller.signal,
  }), /stop/)
  assert.equal(read, false)
})
