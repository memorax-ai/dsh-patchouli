import assert from 'node:assert/strict'
import test from 'node:test'

import { PatchouliRpcError } from 'dsh-patchouli/storage'
import { RepairHistoryAlgorithm, REPAIR_HISTORY_TEXT_LIMIT } from '../lib/algo/repair-history.js'

function fixture(initial = []) {
  const created = [...initial]
  const storage = {
    async read() {
      throw new PatchouliRpcError('patchouli.entity.read@1', -32003, 'not found', { reason: 'NOT_FOUND' })
    },
    async create(request) { created.push(request); return { meta: {}, data: {} } },
    async query() {
      return { meta: {}, data: { hits: created.map(item => ({ score: 0.91, variants: [{
        ref: { type: 'knowledge', id: item.data.id }, version: 'v1', state: 'active', value: item.data.value,
      }] })) } }
    },
  }
  const algorithm = new RepairHistoryAlgorithm(storage)
  return {
    created, algorithm,
    ingest: records => algorithm.ingest({ meta: {}, index: {
      session: { id: 'session-1', version: 0, createdAt: 1 },
      nextAfterSeq: records.at(-1)?.source.seq ?? 0, hasMore: false, records,
    } }, {}),
  }
}

function source(seq, callId) {
  return { type: 'session-event', sessionId: 'session-1', seq,
    time: 1_700_000_000_000 + seq, eventType: 'tool/result',
    surface: 'current', cwd: '/work', turn: 2, callId }
}

function call(seq, callId, name, args) {
  const raw = JSON.stringify(args)
  return { id: String(seq), kind: 'tool-call', text: `${name}\n${raw}`,
    source: { ...source(seq, callId), eventType: 'tool/call' }, data: { name, arguments: raw } }
}

function result(seq, callId, text, error = false) {
  return { id: String(seq), kind: 'tool-result', text, source: source(seq, callId),
    data: error ? { message: { isError: true } } : {} }
}

test('observes a related retry across batches without claiming a causal repair', async () => {
  const f = fixture()
  await f.ingest([call(1, 'a', 'read', { file_path: '/work/config.json' }), result(2, 'a', 'Error: missing file', true)])
  assert.deepEqual(await f.ingest([
    call(3, 'unrelated', 'glob', { path: '/work', pattern: '*.ts' }), result(4, 'unrelated', 'one.ts'),
    call(5, 'b', 'read', { file_path: '/work/config.json' }), result(6, 'b', '{"enabled":true}'),
  ]), { created: 1 })
  const value = f.created[0].data.value
  assert.equal(value.profile.abstraction, 'instance')
  assert.equal(value.content.value.observation.status, 'observed-unverified')
  assert.equal(value.metadata.extensions['dsh.repair-history'].policy, 'related-recovery-v2')
  const recalled = await f.algorithm.query({ meta: {}, text: 'missing file' }, {})
  assert.equal(recalled.hits.length, 1)
  assert.match(recalled.hits[0].text, /does not establish a causal repair/)
  assert.match(recalled.hits[0].text, /enabled/)
  assert.equal(recalled.hits[0].source.fromSeq, 2)
  assert.equal(recalled.hits[0].source.toSeq, 6)
})

test('does not infer a repair from another tool, target, command, or unidentifiable arguments', async () => {
  for (const [firstName, firstArgs, nextName, nextArgs] of [
    ['read', { file_path: '/work/a' }, 'glob', { file_path: '/work/a' }],
    ['read', { file_path: '/work/a' }, 'read', { file_path: '/work/b' }],
    ['bash', { command: 'cat missing' }, 'bash', { command: 'echo done' }],
    ['fleet_reply', { content: 'one' }, 'fleet_reply', { content: 'two' }],
    ['fleet_run', { id: 'run-1', action: 'start' }, 'fleet_run', { id: 'run-1', action: 'status' }],
    ['bash', { command: 'pnpm test', workdir: '/work/a' }, 'bash', { command: 'pnpm test', workdir: '/work/b' }],
    ['read', { path: 'config', scope: { run_id: 'one' } }, 'read', { path: 'config', scope: { run_id: 'two' } }],
  ]) {
    const f = fixture()
    assert.deepEqual(await f.ingest([
      call(1, 'a', firstName, firstArgs), result(2, 'a', 'Error: not ready', true),
      call(3, 'b', nextName, nextArgs), result(4, 'b', 'completed'),
    ]), { created: 0 })
  }
})

test('empty search output is not recovery, including the historical No files found example', async () => {
  for (const output of ['No files found', 'No matches', '0 results', '[]', '{}', 'null', '']) {
    const f = fixture()
    assert.deepEqual(await f.ingest([
      call(1, 'a', 'glob', { path: '/work', pattern: '*.ts' }), result(2, 'a', 'Error: search failed', true),
      call(3, 'b', 'glob', { path: '/work', pattern: '*.ts' }), result(4, 'b', output),
    ]), { created: 0 }, output)
  }
})

test('unrelated success does not consume the pending failure and exact command retries remain observations', async () => {
  const f = fixture()
  assert.deepEqual(await f.ingest([
    call(1, 'a', 'bash', { command: 'pnpm test', description: 'check' }), result(2, 'a', 'Error: dependency unavailable', true),
    call(3, 'b', 'read', { path: '/work/readme' }), result(4, 'b', 'documentation'),
    call(5, 'c', 'bash', { description: 'check', command: 'pnpm test' }), result(6, 'c', 'all tests passed'),
  ]), { created: 1 })
  const observation = f.created[0].data.value.content.value.observation
  assert.equal(observation.target, 'same exact command and parameters (see source events)')
  assert.equal(observation.status, 'observed-unverified')
})

test('does not join retries outside the time/sequence window or across working directories', async () => {
  for (const override of [{ seq: 103 }, { time: 1_700_000_000_000 + 31 * 60_000 }, { cwd: '/other' }, { time: 1 }]) {
    const f = fixture()
    const next = result(4, 'b', 'file contents')
    Object.assign(next.source, override)
    assert.deepEqual(await f.ingest([
      call(1, 'a', 'read', { path: 'config' }), result(2, 'a', 'Error: missing file', true),
      call(3, 'b', 'read', { path: 'config' }), next,
    ]), { created: 0 })
  }
})

test('stores bounded structured evidence and source references rather than raw output', async () => {
  const f = fixture()
  const longFailure = `Error: missing dependency\n${'x'.repeat(50_000)}\nThis does not identify the root cause.`
  const longOutput = `Tests returned\n${'y'.repeat(50_000)}\nThe deployment remains unverified.`
  await f.ingest([
    call(1, 'a', 'bash', { command: 'pnpm test' }), result(2, 'a', longFailure, true),
    call(3, 'b', 'bash', { command: 'pnpm test' }), result(4, 'b', longOutput),
  ])
  const payload = f.created[0].data.value.content.value
  assert(payload.text.length <= REPAIR_HISTORY_TEXT_LIMIT)
  assert(JSON.stringify(payload).length < 3_000)
  assert.match(payload.text, /does not identify the root cause/)
  assert.match(payload.text, /deployment remains unverified/)
  assert.match(payload.text, /excerpt truncated/)
  assert.equal(payload.source.fromSeq, 2)
  assert.equal(payload.source.toSeq, 4)
  assert(!JSON.stringify(payload).includes('x'.repeat(500)))
  const recalled = await f.algorithm.query({ meta: {}, text: 'dependency' }, {})
  assert.equal(recalled.truncated, true)
  assert.equal(recalled.hits[0].truncated, true)
})

test('projects legacy raw records compactly with a warning without rewriting storage', async () => {
  const raw = `Failure:\nread\nError: missing path\nRepair:\nglob\nSuccessful result:\n${'source line\n'.repeat(5_000)}No files found`
  const original = { data: { id: 'legacy', value: { content: { kind: 'structured', value: {
    text: raw, source: { kind: 'repair-history', sessionId: 'old-session', fromSeq: 1, toSeq: 5, time: 1 },
  } } } } }
  const before = JSON.stringify(original)
  const f = fixture([original])
  const recalled = await f.algorithm.query({ meta: {}, text: 'missing path' }, {})
  assert.equal(recalled.hits.length, 1)
  assert(recalled.hits[0].text.length <= REPAIR_HISTORY_TEXT_LIMIT)
  assert.match(recalled.hits[0].text, /Legacy recovery observation \(unverified\)/)
  assert.match(recalled.hits[0].text, /No files found/)
  assert.doesNotMatch(recalled.hits[0].text, /Successful result:/)
  assert.equal(JSON.stringify(original), before)
  assert.equal(f.created.length, 1)
  assert.equal(recalled.truncated, true)
  assert.equal(recalled.hits[0].truncated, true)
})

test('compares complete target identifiers before truncating the displayed target', async () => {
  const f = fixture()
  const prefix = '/work/' + 'a'.repeat(500)
  assert.deepEqual(await f.ingest([
    call(1, 'a', 'read', { path: prefix + 'one' }), result(2, 'a', 'Error: missing file', true),
    call(3, 'b', 'read', { path: prefix + 'two' }), result(4, 'b', 'file contents'),
  ]), { created: 0 })
})

test('caps retained tool calls even when duplicate sequence numbers prevent age pruning', async () => {
  const f = fixture()
  await f.ingest([
    call(1, 'a', 'read', { path: '/work/config' }), result(2, 'a', 'Error: missing file', true),
    ...Array.from({ length: 300 }, (_, i) => call(3, `noise-${i}`, 'read', { path: `/work/noise-${i}` })),
  ])
  assert.deepEqual(await f.ingest([
    call(4, 'b', 'read', { path: '/work/config' }), result(5, 'b', 'contents'),
  ]), { created: 0 })
})
