import assert from 'node:assert/strict'
import test from 'node:test'

import { ArtifactIndexModule } from '../lib/index/artifact.js'

const metadata = {
  core: {
    origin: { native_type: 'workspace-file', native_id: 'notes.txt' },
  },
  extensions: {
    'dsh.file': { requested_path: 'notes.txt', version: 'file-v1' },
  },
}

function artifact(id: string, mediaType: string) {
  return {
    ref: { type: 'artifact', id },
    version: `${id}-v1`,
    state: 'active',
    value: {
      media_type: mediaType,
      name: id,
      byte_length: mediaType.startsWith('text/') ? 11 : 4,
      digest: 'sha256:test',
      placement: { kind: 'managed', provider: 'local', key: `objects/${id}` },
      metadata,
    },
  }
}

test('artifact index reuses stored text and leaves non-text extraction untouched', async () => {
  const entities = new Map([
    ['notes.txt', artifact('notes.txt', 'text/plain')],
    ['scan.png', artifact('scan.png', 'image/png')],
  ])
  let downloadCalls = 0
  const bytes = new TextEncoder().encode('hello world')
  const storage = {
    read: async (request: { data: { ref: { id: string } } }) => ({
      data: {
        state: 'active',
        variants: [entities.get(request.data.ref.id)],
      },
      meta: {},
    }),
    downloadArtifactChunk: async (request: {
      data: { id: string; version: string; offset: number; max_bytes: number }
    }) => {
      downloadCalls += 1
      const entity = entities.get(request.data.id)
      assert.ok(entity)
      const chunk = bytes.subarray(
        request.data.offset,
        request.data.offset + request.data.max_bytes,
      )
      const nextOffset = request.data.offset + chunk.byteLength
      return {
        data: {
          entity,
          offset: request.data.offset,
          next_offset: nextOffset,
          eof: nextOffset === bytes.byteLength,
          bytes_base64: Buffer.from(chunk).toString('base64'),
        },
        meta: {},
      }
    },
  }
  const index = new ArtifactIndexModule(storage, {
    maxTextBytesPerArtifact: 8,
    chunkBytes: 5,
  })

  const result = await index.index({
    meta: { workspace_id: 'workspace-1' },
    artifacts: [
      { id: 'notes.txt', version: 'notes.txt-v1', role: 'source' },
      { id: 'scan.png', version: 'scan.png-v1', role: 'attachment' },
    ],
  }, {})

  assert.equal(result.artifacts[0]?.text, 'hello wo')
  assert.equal(result.artifacts[0]?.textTruncated, true)
  assert.equal(result.artifacts[0]?.source.role, 'source')
  assert.equal(result.artifacts[0]?.source.locator, 'objects/notes.txt')
  assert.deepEqual(result.artifacts[0]?.metadata, metadata)
  assert.equal(result.artifacts[1]?.text, null)
  assert.equal(result.artifacts[1]?.textTruncated, false)
  assert.equal(downloadCalls, 2)
  assert.equal(result.truncated, false)
})

test('artifact index observes an already aborted signal before storage access', async () => {
  let read = false
  const index = new ArtifactIndexModule({
    read: async () => {
      read = true
      throw new Error('unexpected')
    },
    downloadArtifactChunk: async () => {
      throw new Error('unexpected')
    },
  })
  const controller = new AbortController()
  controller.abort(new Error('stop'))

  await assert.rejects(index.index({ meta: {}, artifacts: [] }, {
    signal: controller.signal,
  }), /stop/)
  assert.equal(read, false)
})

