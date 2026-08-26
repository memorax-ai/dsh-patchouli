import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'

import { SessionArchive, type SessionArchiveRuntime } from '../lib/archive.js'
import { TimelineStore } from '../lib/timeline.js'

function event(seq: number): SessionEvent {
  return { type: 'turn/start', seq, time: seq, data: { turn: seq } } as SessionEvent
}

function session(id: string): Session {
  const events: SessionEvent[] = []
  return {
    events,
    surface: { get nodes() { return events.map(value => value.seq) } },
    header: { id: id as SessionId, createdAt: 0, version: 0 },
    append(type: string, data: unknown, options: { readonly surfaceOp?: 'append' } = {}) {
      const value = {
        type,
        data,
        seq: events.length,
        time: Date.now(),
        surfaceOp: options.surfaceOp ?? 'append',
      } as SessionEvent
      events.push(value)
      return value
    },
  } as unknown as Session
}

test('reads cold history backward one bounded segment at a time', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-patchouli-fleet-'))
  const histories = new Map([
    ['session-a', [event(0), event(1), event(2)]],
    ['session-b', [event(0), event(1)]],
  ])
  const runtime = {
    persistence: {
      async readFrom(id: string) {
        return {
          meta: { version: 0, id, createdAt: 0 },
          events: histories.get(id) ?? [],
        }
      },
    },
  } as unknown as SessionArchiveRuntime
  const archive = new SessionArchive(root, runtime)
  await archive.attach('logical', 'session-a')
  await new TimelineStore(root).rotate('logical', 'session-a', 'session-b', 3, 20)

  const latest = await archive.readPage('logical', { limit: 1 })
  assert.deepEqual(latest.items.map(item => item.event.seq), [1])
  assert.deepEqual(latest.previous, { segment: 1, beforeSeq: 1 })

  const startOfLatest = await archive.readPage('logical', { cursor: latest.previous, limit: 1 })
  assert.deepEqual(startOfLatest.items.map(item => item.event.seq), [0])
  assert.deepEqual(startOfLatest.previous, { segment: 0, beforeSeq: 3 })
})

test('compacts and continues from a rebased native checkpoint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-patchouli-fleet-'))
  const activeSession = session('session-a')
  activeSession.append('user/message', {
    id: 'message-a',
    role: 'user',
    content: [{ type: 'text', text: 'checkpoint' }],
    source: { kind: 'user' },
  }, { surfaceOp: 'append' })

  let disposed = false
  const handle = {
    agent: {
      id: 'session-a' as SessionId,
      status: 'idle',
      session: activeSession,
      options: { provider: 'test', model: 'model' },
    },
    async dispose() { disposed = true },
  } as unknown as AgentHandle
  const successor = {
    agent: { id: 'session-b' as SessionId },
    async dispose() {},
  } as unknown as AgentHandle
  const runtime: SessionArchiveRuntime = {
    compaction: { async compactRegion() {} } as never,
    persistence: { async readFrom() { throw new Error('not used') } } as never,
    sessions: { async flush() { return true } },
    async create(options) {
      assert.equal(options.sessionId, 'session-b')
      assert.equal(options.seed?.length, 1)
      assert.deepEqual(options.meta, {
        parentSession: 'session-a',
        seedLength: 1,
      })
      return successor
    },
    async resume() { throw new Error('not used') },
  }
  const archive = new SessionArchive(root, runtime)

  assert.equal(
    await archive.rotate('logical', handle, { sessionId: 'session-b' as SessionId }),
    successor,
  )
  assert.equal(disposed, true)
  const timeline = await archive.timeline('logical')
  assert.equal(timeline.logicalId, 'logical')
  assert.equal(timeline.activeSessionId, 'session-b')
  assert.deepEqual(timeline.segments.map(segment => ({
    sessionId: segment.sessionId,
    eventCount: segment.eventCount,
  })), [
    { sessionId: 'session-a', eventCount: 1 },
    { sessionId: 'session-b', eventCount: undefined },
  ])
})

test('merges a persistent logical-Session policy override with the global preset', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-patchouli-fleet-'))
  const global = { enabled: true, maxEvents: 2_000, maxMegabytes: 64, maxAgeHours: 24 }
  const archive = new SessionArchive(root, {} as SessionArchiveRuntime, global)

  assert.deepEqual(await archive.setPolicyOverride('fleet/team/member', {
    maxEvents: 400,
    maxAgeHours: 0,
  }), {
    global,
    override: { maxEvents: 400, maxAgeHours: 0 },
    effective: { enabled: true, maxEvents: 400, maxMegabytes: 64, maxAgeHours: 0 },
  })
})
