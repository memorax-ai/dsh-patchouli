import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { TimelineStore } from '../lib/timeline.js'

test('keeps an append-only native Session chain', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-patchouli-fleet-'))
  const store = new TimelineStore(root)

  await store.attach('member:theory', 'session-a', 10)
  await store.rotate('member:theory', 'session-a', 'session-b', 120, 20)
  await store.rotate('member:theory', 'session-b', 'session-c', 80, 30)

  assert.deepEqual(await store.require('member:theory'), {
    logicalId: 'member:theory',
    activeSessionId: 'session-c',
    segments: [
      { sessionId: 'session-a', openedAt: 10, closedAt: 20, eventCount: 120 },
      { sessionId: 'session-b', openedAt: 20, closedAt: 30, eventCount: 80 },
      { sessionId: 'session-c', openedAt: 30 },
    ],
  })

  const path = join(root, Buffer.from('member:theory').toString('base64url'), 'timeline.jsonl')
  assert.equal((await readFile(path, 'utf8')).trim().split('\n').length, 3)
})

test('rejects a branch that does not continue the active segment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-patchouli-fleet-'))
  const store = new TimelineStore(root)
  await store.attach('logical', 'session-a')
  await assert.rejects(store.rotate('logical', 'wrong', 'session-b', 1), /currently points/)
})
