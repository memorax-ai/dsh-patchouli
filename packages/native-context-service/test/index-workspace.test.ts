import assert from 'node:assert/strict'
import test from 'node:test'

import { FsError } from '@deepseek-ai/dsh-fs'

import { WorkspaceIndexModule } from '../lib/index/workspace.js'

function target(path: string) {
  return { targetKey: path, displayPath: path }
}

test('workspace index walks registered files with bounded text and stable sources', async () => {
  const root = target('/work')
  const src = target('/work/src')
  const readme = target('/work/README.md')
  const code = target('/work/src/index.ts')
  const binary = target('/work/image.bin')
  const outside = target('/outside/secret.txt')
  const textReads: string[] = []
  const fs = {
    resolve: async () => root,
    stat: async () => ({ type: 'directory', version: 'root-v1' }),
    contains: (_parent: unknown, child: { displayPath: string }) => child.displayPath.startsWith('/work/'),
    fileUrl: (value: { displayPath: string }) => `file://${value.displayPath}`,
    listDir: async (value: { displayPath: string }) => value.displayPath === '/work'
      ? [
          { name: 'README.md', type: 'file', target: readme, size: 9, version: 'readme-v1' },
          { name: 'image.bin', type: 'file', target: binary, size: 4, version: 'binary-v1' },
          { name: 'outside', type: 'file', target: outside, size: 6, version: 'outside-v1' },
          { name: 'src', type: 'directory', target: src, version: 'src-v1' },
        ]
      : [{ name: 'index.ts', type: 'file', target: code, size: 18, version: 'code-v1' }],
    streamText: async (value: { displayPath: string }) => {
      textReads.push(value.displayPath)
      if (value.displayPath.endsWith('.bin')) {
        throw new FsError('binary', 'FS_NOT_TEXT')
      }
      return (async function* () {
        yield value.displayPath.endsWith('README.md') ? 'Patchouli' : 'export const value = 1'
      })()
    },
  }
  const registry = {
    get: (id: string) => id === 'workspace-1'
      ? {
          id,
          path: '/work',
          title: 'work',
          updatedAt: '2026-08-26T00:00:00.000Z',
        }
      : undefined,
    resolveByPath: async () => undefined,
  }
  const index = new WorkspaceIndexModule(fs, registry, {
    maxTextCharactersPerFile: 8,
    maxTotalTextCharacters: 16,
  })

  const result = await index.index({ workspaceId: 'workspace-1' }, {})

  assert.deepEqual(result.files.map(file => file.path), [
    'README.md',
    'image.bin',
    'src/index.ts',
  ])
  assert.equal(result.files[0]?.text, 'Patchoul')
  assert.equal(result.files[0]?.textTruncated, true)
  assert.equal(result.files[0]?.source.uri, 'file:///work/README.md')
  assert.equal(result.files[1]?.text, null)
  assert.equal(result.files[2]?.text, 'export c')
  assert.deepEqual(textReads, ['/work/README.md', '/work/image.bin', '/work/src/index.ts'])
  assert.equal(result.truncated, false)
})

test('workspace index observes an already aborted signal before filesystem access', async () => {
  let resolved = false
  const index = new WorkspaceIndexModule({
    resolve: async () => {
      resolved = true
      return target('/work')
    },
    stat: async () => undefined,
    contains: () => true,
    fileUrl: () => 'file:///work',
    listDir: async () => [],
    streamText: async () => (async function* () {})(),
  }, {
    get: () => undefined,
    resolveByPath: async () => undefined,
  })
  const controller = new AbortController()
  controller.abort(new Error('stop'))

  await assert.rejects(index.index({ workspaceId: 'workspace-1' }, {
    signal: controller.signal,
  }), /stop/)
  assert.equal(resolved, false)
})

