import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PROJECT_INDEX_MAX_LIMIT,
  ProjectIndexModule,
} from '../lib/index/project.js'
import type { WorkspaceIndexResult } from '../lib/index/workspace.js'

function file(path: string, text: string) {
  const name = path.slice(path.lastIndexOf('/') + 1)
  return {
    name,
    path,
    size: text.length,
    version: 'v1',
    text,
    textTruncated: false,
    source: {
      kind: 'workspace-file' as const,
      workspaceId: 'workspace-1',
      workspacePath: '/work',
      path,
      uri: `file:///work/${path}`,
      version: 'v1',
    },
  }
}

const indexed: WorkspaceIndexResult = {
  workspace: {
    id: 'workspace-1',
    path: '/work',
    title: 'work',
    updatedAt: '2026-08-26T00:00:00.000Z',
  },
  files: [
    file('README.md', '# Project'),
    file('docs/release-plan.md', '# Plan'),
    file('CHECKLIST.txt', '- [ ] Verify'),
    file('src/index.ts', 'export {}'),
    file('notes/planning-notes.md', 'not an explicit project document'),
  ],
  truncated: false,
}

test('project index selects explicit visible project material without summarizing it', async () => {
  const calls: unknown[] = []
  const index = new ProjectIndexModule({
    async index(request) {
      calls.push(request)
      return indexed
    },
    id: 'workspace',
  })
  const result = await index.index({ workspaceId: 'workspace-1' }, {})

  assert.deepEqual(result.documents.map(document => [document.kind, document.path]), [
    ['readme', 'README.md'],
    ['plan', 'docs/release-plan.md'],
    ['checklist', 'CHECKLIST.txt'],
  ])
  assert.equal(result.documents[1]?.text, '# Plan')
  assert.deepEqual(calls, [{ workspaceId: 'workspace-1' }])
  assert.equal(result.truncated, false)
})

test('project index preserves workspace truncation and applies its own document limit', async () => {
  const index = new ProjectIndexModule({
    id: 'workspace',
    index: async () => ({ ...indexed, truncated: true }),
  })
  const result = await index.index({ workspacePath: '/work', limit: 1 }, {})
  assert.deepEqual(result.documents.map(document => document.path), ['README.md'])
  assert.equal(result.truncated, true)
})

test('project index validates limits and cancellation before workspace acquisition', async () => {
  let called = false
  const index = new ProjectIndexModule({
    id: 'workspace',
    index: async () => {
      called = true
      return indexed
    },
  })
  await assert.rejects(index.index({
    workspaceId: 'workspace-1',
    limit: PROJECT_INDEX_MAX_LIMIT + 1,
  }, {}), /project index limit must be an integer/)
  const controller = new AbortController()
  const reason = new Error('stop project indexing')
  controller.abort(reason)
  await assert.rejects(index.index({ workspaceId: 'workspace-1' }, {
    signal: controller.signal,
  }), error => error === reason)
  assert.equal(called, false)
})
