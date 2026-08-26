import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  GIT_INDEX_MAX_COMMIT_LIMIT,
  GitIndexModule,
  LocalGitIndexReader,
  type GitIndexReader,
} from '../lib/index/git.js'

test('reads a registered local Git workspace without a separate host adapter', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'patchouli-git-index-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const run = (...args) => execFileSync('git', ['-C', root, ...args])
  run('init', '-b', 'main')
  run('config', 'user.name', 'Patchouli Test')
  run('config', 'user.email', 'patchouli@example.test')
  await writeFile(join(root, 'README.md'), 'first\n')
  run('add', 'README.md')
  run('commit', '-m', 'Initial context')
  await writeFile(join(root, 'README.md'), 'changed\n')

  const reader = new LocalGitIndexReader({
    get: id => id === 'workspace-1' ? { id, path: root } : undefined,
    async resolveByPath(path) {
      return path === root ? { id: 'workspace-1', path: root } : undefined
    },
  })
  const snapshot = await reader.snapshot({
    workspaceId: 'workspace-1', commitLimit: 2, pathLimit: 2,
  })

  assert.equal(snapshot?.status.branch, 'main')
  assert.equal(snapshot?.commits[0]?.subject, 'Initial context')
  assert.deepEqual(snapshot?.paths, [{ path: 'README.md', status: 'M', staged: false }])
})

function reader() {
  const calls: Array<{ readonly workspaceId?: string; readonly commitLimit: number; readonly pathLimit: number }> = []
  const signals: Array<AbortSignal | undefined> = []
  const value: GitIndexReader = {
    async snapshot(request, signal) {
      calls.push(request)
      signals.push(signal)
      return {
        workspace: { id: 'workspace-1', path: '/work' },
        repository: { root: '/work' },
        status: { branch: 'main', head: 'commit-3', clean: false },
        commits: [1, 2, 3].map(index => ({
          hash: `commit-${index}`,
          parents: index === 1 ? [] : [`commit-${index - 1}`],
          author: 'Developer',
          authoredAt: `2026-08-2${index}T00:00:00.000Z`,
          subject: `Commit ${index}`,
        })),
        paths: [
          { path: 'README.md', status: 'modified', staged: false },
          { path: 'src/index.ts', status: 'added', staged: true },
        ],
      }
    },
  }
  return { calls, reader: value, signals }
}

test('git index normalizes bounded status, recent commits, and changed paths from the read seam', async () => {
  const fixture = reader()
  const controller = new AbortController()
  const result = await new GitIndexModule(fixture.reader).index({
    workspaceId: 'workspace-1',
    fetchRemote: false,
    fetchIntervalMinutes: 15,
    commitLimit: 2,
    pathLimit: 1,
  }, { signal: controller.signal })

  assert.deepEqual(result.repository, { root: '/work', branch: 'main', head: 'commit-3' })
  assert.deepEqual(result.commits.map(commit => commit.hash), ['commit-1', 'commit-2'])
  assert.deepEqual(result.paths, [{ path: 'README.md', status: 'modified', staged: false }])
  assert.equal(result.clean, false)
  assert.equal(result.commitsTruncated, true)
  assert.equal(result.pathsTruncated, true)
  assert.equal(result.truncated, true)
  assert.deepEqual(fixture.calls, [{
    workspaceId: 'workspace-1',
    fetchRemote: false,
    fetchIntervalMinutes: 15,
    commitLimit: 2,
    pathLimit: 1,
  }])
  assert.equal(fixture.signals[0], controller.signal)
})

test('git index reports a visible workspace that is not a repository without inventing Git state', async () => {
  const index = new GitIndexModule({ snapshot: async () => null })
  const result = await index.index({ workspacePath: '/notes' }, {})
  assert.deepEqual(result, {
    workspace: { id: '', path: '/notes' },
    repository: null,
    commits: [],
    paths: [],
    clean: null,
    commitsTruncated: false,
    pathsTruncated: false,
    truncated: false,
  })
})

test('git index validates selectors, limits, and cancellation before calling the host seam', async () => {
  let called = false
  const index = new GitIndexModule({
    snapshot: async () => {
      called = true
      return null
    },
  })
  await assert.rejects(index.index({}, {}), /exactly one workspace selector/)
  await assert.rejects(index.index({
    workspaceId: 'workspace-1',
    commitLimit: GIT_INDEX_MAX_COMMIT_LIMIT + 1,
  }, {}), /commitLimit must be an integer/)
  const controller = new AbortController()
  const reason = new Error('stop git indexing')
  controller.abort(reason)
  await assert.rejects(index.index({ workspaceId: 'workspace-1' }, {
    signal: controller.signal,
  }), error => error === reason)
  assert.equal(called, false)
})
