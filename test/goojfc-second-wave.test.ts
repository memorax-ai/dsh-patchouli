import assert from 'node:assert/strict'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import test from 'node:test'

import {
  createEngramoryAdapter,
  createGraphMemoryAdapter,
  createLingshuAdapter,
  createMemoryEvolveAdapter,
  createMemoryGateAdapter,
  type GraphMemoryNative,
  type LingshuBridge,
  type MemoryEvolveNative,
  type MemoryGateService,
} from '../lib/goojfc/index.js'

const require = createRequire(import.meta.url)
const meta = {
  source: { type: 'agent-loop', id: 'dsh-patchouli-agent-loop' },
  scope: '/workspace/project',
  requestId: 'request-1',
  attributes: {
    sessionId: 'session-1',
    workspaceRoot: '/workspace/project',
  },
} as const

test('pins all second-wave Harmony seams to exact published versions', () => {
  const expected = [
    ['memory-gate', 'dsh-memory-gate', '0.9.0', [1, 1, 1, 1]],
    ['lingshu', '@furongjun1999/dsh-memory', '0.2.8', [1, 1, 1, 1]],
    ['engramory', 'dsh-engramory', '0.2.0', [1, 1, 1]],
    ['memory-evolve', 'dsh-memory-evolve', '0.1.0', [1, 1, 1]],
  ] as const

  for (const [moduleName, packageName, version, counts] of expected) {
    const exported = require(`../patches/${moduleName}.patch.cjs`)
    const patches = Array.isArray(exported) ? exported : [exported]
    assert.deepEqual(patches.map(patch => patch.target.package),
      Array(patches.length).fill(packageName))
    assert.deepEqual(patches.map(patch => patch.target.version),
      Array(patches.length).fill(version))
    assert.deepEqual(patches.map(patch => patch.expect), counts)
  }

  const source = readFileSync(
    new URL('../patches/memory-evolve.patch.cjs', import.meta.url),
    'utf8',
  )
  assert.match(source, /ce7f0faa0e0240f117c29795e9224c0d9ed18183/)
  assert.match(source, /snapshot: \(agent\) => config\.injectMemory/)
  assert.match(source, /select: 'IfStatement:has\(PropertyAccessExpression/)
  assert.match(source, /protectedLog/)
  assert.match(source, /stripEntryId/)

  const cordisPatch = readFileSync(
    new URL('../cordis.patch.yml', import.meta.url),
    'utf8',
  )
  assert.doesNotMatch(
    cordisPatch,
    /patchouli-goojfc|dsh-memory-evolve/,
  )

  const graphSource = readFileSync(
    new URL('../src/goojfc/graph-memory.ts', import.meta.url),
    'utf8',
  )
  const graphLoader = require('../patches/graph-memory.patch.cjs')
  assert.equal(graphLoader.target.package, 'graph-memory')
  assert.equal(graphLoader.target.version, '1.5.8')
  assert.equal(graphLoader.target.file, 'index.ts')
  assert.equal(graphLoader.loader, 'typescript')
  assert.doesNotMatch(graphSource, /registerHooks|transpileModule/)
  assert.match(graphSource, /createGraphMemoryAdapter/)
  assert.match(graphSource, /syncEmbed\(result\.node\)\.catch/)
  assert.doesNotMatch(graphSource, /stripTypeScriptTypes/)

  const engramorySource = readFileSync(
    new URL('../patches/engramory.patch.cjs', import.meta.url),
    'utf8',
  )
  assert.match(engramorySource, /\["tools", "patchouliGoojfc"\]/)
  assert.doesNotMatch(engramorySource, /PropertyAssignment\[name\.name="required"\]/)
  assert.match(engramorySource, /disable-unsupported-skill-service/)

  const lingshuSource = readFileSync(
    new URL('../patches/lingshu.patch.cjs', import.meta.url),
    'utf8',
  )
  assert.match(lingshuSource, /goojfc-lingshu-fiber-owned-dispose/)
  assert.match(lingshuSource, /return \$\{returned\.getText\(sourceFile\)\}/)

  for (const moduleName of expected.map(([name]) => name)) {
    const patchSource = readFileSync(
      new URL(`../patches/${moduleName}.patch.cjs`, import.meta.url),
      'utf8',
    )
    assert.doesNotMatch(patchSource, /dsh-patchouli\/goojfc/)
  }
})

test('routes memory-gate through its native authority service', async () => {
  const calls: unknown[] = []
  const service: MemoryGateService = {
    config: { automaticExtraction: true },
    remember(content, options) {
      calls.push(['remember', content, options])
      return { created: true }
    },
    prepareRecall(context) {
      calls.push(['prepareRecall', context])
      return { runId: 'run-1', text: 'Use SQLite', claimIds: ['claim-1'] }
    },
    extractAndRemember() { return [] },
  }
  const adapter = createMemoryGateAdapter(service, {
    sessionScopeKey: id => `session:${id}`,
    workspaceScopeKey: path => `workspace:${path}`,
    recordInjection(recall, context) {
      calls.push(['recordInjection', recall, context])
    },
  })

  assert.deepEqual(await adapter.update({
    meta,
    data: { content: 'Use SQLite', kind: 'decision', tags: ['database'] },
  }, {}), { created: true })
  assert.deepEqual(await adapter.retrieve({
    meta,
    data: { query: 'database' },
  }, {}), 'Use SQLite')
  assert.deepEqual(calls, [
    ['remember', 'Use SQLite', {
      scope: 'workspace',
      scopeKey: 'workspace:/workspace/project',
      kind: 'fact',
      tags: ['database'],
      origin: 'explicit',
      sourceSessionId: 'session-1',
    }],
    ['prepareRecall', {
      query: 'database',
      sessionId: 'session-1',
      sessionScopeKey: 'session:session-1',
      workspaceKey: 'workspace:/workspace/project',
    }],
    ['recordInjection', {
      runId: 'run-1',
      text: 'Use SQLite',
      claimIds: ['claim-1'],
    }, {
      sessionId: 'session-1',
      injectionId: 'request-1',
    }],
  ])
})

test('routes Lingshu to one native MCP tool call per operation', async () => {
  const calls: unknown[] = []
  const bridge: LingshuBridge = {
    async callTool(name, args) {
      calls.push([name, args])
      return { content: [{ type: 'text', text: name }], isError: false }
    },
  }
  const adapter = createLingshuAdapter(bridge, {
    userMessage: true,
    assistantMessage: false,
    toolResult: false,
    importance: 0.6,
  })

  assert.deepEqual(await adapter.update({
    meta,
    data: { content: 'Use SQLite', importance: 0.8 },
  }, {}), 'remember')
  assert.deepEqual(await adapter.retrieve({
    meta,
    data: { query: 'database', tool: 'search', limit: 4 },
  }, {}), 'search')
  assert.deepEqual(calls, [
    ['remember', { content: 'Use SQLite', importance: 0.8 }],
    ['search', { query: 'database', limit: 4 }],
  ])
})

test('routes coordinated turn capture through Memory Gate and Lingshu', async () => {
  const gateCalls: unknown[] = []
  const gate = createMemoryGateAdapter({
    config: { automaticExtraction: true },
    remember() { throw new Error('unexpected remember') },
    prepareRecall() { return undefined },
    extractAndRemember(text, context) {
      gateCalls.push([text, context])
      return [{ id: 'claim-1' }]
    },
  }, {
    sessionScopeKey: id => `session:${id}`,
    workspaceScopeKey: path => `workspace:${path}`,
    recordInjection() { throw new Error('unexpected injection') },
  })
  const lingshuCalls: unknown[] = []
  const lingshu = createLingshuAdapter({
    async callTool(name, args) {
      lingshuCalls.push([name, args])
      return { result: { stored: true } }
    },
  }, { userMessage: true, assistantMessage: false, toolResult: false, importance: 0.6 })
  const turnMeta = {
    ...meta,
    attributes: { ...meta.attributes, point: 'session/turn-end' },
  }
  const event = {
    type: 'user/message',
    seq: 7,
    data: {
      content: [{ type: 'text', text: 'Remember SQLite' }],
      source: { kind: 'user' },
    },
  }

  assert.deepEqual(await gate.update({ meta: turnMeta, data: { events: [event] } }, {}), {
    claims: [{ id: 'claim-1' }],
  })
  assert.deepEqual(gateCalls, [['Remember SQLite', {
    sessionId: 'session-1',
    sessionScopeKey: 'session:session-1',
    workspaceKey: 'workspace:/workspace/project',
    sourceEventSeq: 7,
  }]])
  assert.deepEqual(await lingshu.update({ meta: turnMeta, data: { events: [event] } }, {}), {
    stored: [{ stored: true }],
  })
  assert.deepEqual(lingshuCalls, [[
    'remember',
    { content: 'Remember SQLite', importance: 0.6, tags: ['dsh', 'user'] },
  ]])
})

test('honors Memory Gate extraction and first-step recall semantics', async () => {
  const calls: string[] = []
  const service: MemoryGateService = {
    config: { automaticExtraction: false },
    remember() { throw new Error('unexpected remember') },
    extractAndRemember() {
      calls.push('extract')
      return []
    },
    prepareRecall() {
      calls.push('recall')
      return { runId: 'run-1', text: 'memory text', claimIds: ['claim-1'] }
    },
  }
  const adapter = createMemoryGateAdapter(service, {
    sessionScopeKey: id => `session:${id}`,
    workspaceScopeKey: path => `workspace:${path}`,
    recordInjection() { calls.push('audit') },
  })
  const turnEndMeta = {
    ...meta,
    attributes: { ...meta.attributes, point: 'session/turn-end' },
  }
  assert.equal(await adapter.update({ meta: turnEndMeta, data: { events: [] } }, {}), null)

  const preStepMeta = (step: number) => ({
    ...meta,
    attributes: { ...meta.attributes, point: 'agent/pre-step', turn: 1, step },
  })
  assert.equal(await adapter.retrieve({
    meta: preStepMeta(2),
    data: { query: 'database' },
  }, {}), null)
  assert.deepEqual(calls, [])
  assert.equal(await adapter.retrieve({
    meta: preStepMeta(1),
    data: { query: 'database' },
  }, {}), 'memory text')
  assert.deepEqual(calls, ['recall', 'audit'])
})

test('uses only the latest real user message as the automatic Lingshu query', async () => {
  const calls: unknown[] = []
  const adapter = createLingshuAdapter({
    async callTool(name, args) {
      calls.push([name, args])
      return { content: [] }
    },
  }, { userMessage: true, assistantMessage: false, toolResult: false, importance: 0.6 })
  const preStepMeta = {
    ...meta,
    attributes: { ...meta.attributes, point: 'agent/pre-step', step: 1 },
  }
  const result = await adapter.retrieve({
    meta: preStepMeta,
    data: {
      messages: [
        { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'old question' }] },
        { role: 'user', source: { kind: 'plugin' }, content: [{ type: 'text', text: 'injected memory' }] },
        { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'current question' }] },
      ],
    },
  }, {})
  assert.equal(result, null)
  assert.deepEqual(calls, [['recall', { query: 'current question' }]])
})

test('routes graph-memory through native upsert and recall algorithms', async () => {
  const calls: unknown[] = []
  const native: GraphMemoryNative = {
    upsertNode(node, sessionId) {
      calls.push(['upsert', node, sessionId])
      return { node, isNew: true } as never
    },
    async recall(query) {
      calls.push(['recall', query])
      return { nodes: [{ name: 'sqlite' }], edges: [], tokenEstimate: 12 }
    },
    upsertEdge(edge, sessionId) {
      calls.push(['edge', edge, sessionId])
      return { edge, isNew: true } as never
    },
  }
  const adapter = createGraphMemoryAdapter(native)

  assert.deepEqual(await adapter.update({
    meta,
    data: {
      type: 'SKILL',
      name: 'sqlite',
      description: 'SQLite conventions',
      content: 'Use WAL mode.',
    },
  }, {}), { nodes: [{
    node: {
      type: 'SKILL',
      name: 'sqlite',
      description: 'SQLite conventions',
      content: 'Use WAL mode.',
    },
    isNew: true,
  }], edges: [] })
  assert.deepEqual(await adapter.retrieve({ meta, data: { query: 'database' } }, {}), {
    nodes: [{ name: 'sqlite' }], edges: [], tokenEstimate: 12,
  })
  assert.equal(calls.length, 2)
})

test('routes memory-evolve reads through its native snapshot and guarded query seam', async () => {
  const calls: unknown[] = []
  const native: MemoryEvolveNative = {
    snapshot(agent) {
      calls.push(['snapshot', agent])
      return 'native snapshot'
    },
    query(target, agent, options) {
      calls.push(['query', target, agent, options])
      return ['[2026-08-17] Use SQLite']
    },
  }
  const adapter = createMemoryEvolveAdapter(native)

  await assert.rejects(adapter.update({
    meta, data: { target: 'key', content: 'Use SQLite' },
  }, {}), /native approval-aware memory tool/)
  assert.deepEqual(await adapter.retrieve({
    meta,
    data: { target: 'key', query: 'SQLite', limit: 2, recent: true },
  }, {}), ['[2026-08-17] Use SQLite'])
  assert.deepEqual((calls[0] as unknown[]).slice(0, 3), [
    'query', 'key', {
      id: 'session-1',
      session: { id: 'session-1', header: { cwd: '/workspace/project' } },
    },
  ])
  assert.deepEqual((calls[0] as unknown[])[3], {
    filter: 'SQLite', limit: 2, recent: true,
  })
  assert.equal(await adapter.retrieve({
    meta: { ...meta, attributes: { ...meta.attributes, point: 'agent/pre-step' } },
    data: { messages: [] },
  }, {}), 'native snapshot')
  assert.deepEqual((calls[1] as unknown[])[0], 'snapshot')
})

test('memory-evolve can disable automatic snapshots without disabling explicit retrieval', async () => {
  const calls: unknown[] = []
  const adapter = createMemoryEvolveAdapter({
    snapshot() { return null },
    query(target, _agent, options) {
      calls.push([target, options])
      return ['explicit result']
    },
  })

  assert.equal(await adapter.retrieve({
    meta: { ...meta, attributes: { ...meta.attributes, point: 'agent/pre-step' } },
    data: { messages: [] },
  }, {}), null)
  assert.deepEqual(await adapter.retrieve({
    meta,
    data: { target: 'project', query: 'SQLite', limit: 3 },
  }, {}), ['explicit result'])
  assert.deepEqual(calls, [['project', { filter: 'SQLite', limit: 3 }]])
})

test('completes Engramory storage without bypassing its native cap guard', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'patchouli-engramory-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const validations: unknown[] = []
  const adapter = createEngramoryAdapter({
    memoryRoot: root,
    indexName: 'MEMORY.md',
    validateIndex(content, path) {
      validations.push([content, path])
      return undefined
    },
  })
  assert.equal(adapter.filter?.({
    operation: 'retrieve',
    meta: { ...meta, attributes: { ...meta.attributes, point: 'agent/pre-step' } },
  }), true)
  const requestMeta = {
    ...meta,
    scope: root,
    attributes: { ...meta.attributes, workspaceRoot: root },
  }

  const stored = await adapter.update({
    meta: requestMeta,
    data: {
      name: 'sqlite-wal',
      description: 'Use WAL for local concurrency',
      type: 'project',
      content: 'Enable PRAGMA journal_mode=WAL.',
    },
  }, {}) as Record<string, string>
  const notePath = stored.notePath
  const indexPath = stored.indexPath
  assert.ok(notePath)
  assert.ok(indexPath)
  assert.equal(existsSync(notePath), true)
  assert.match(readFileSync(notePath, 'utf8'), /journal_mode=WAL/)
  assert.match(readFileSync(indexPath, 'utf8'), /\[sqlite-wal\]\(sqlite-wal\.md\)/)
  assert.equal(validations.length, 1)
  writeFileSync(join(root, 'unrelated.md'), 'unrelated private note', 'utf8')
  writeFileSync(
    indexPath,
    `${readFileSync(indexPath, 'utf8')}- Unrelated preference [unrelated](unrelated.md)\n`,
    'utf8',
  )

  assert.deepEqual(await adapter.retrieve({
    meta: requestMeta,
    data: {
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: 'How should WAL be configured?' }],
        source: { kind: 'user' },
      }],
    },
  }, {}), {
    index: ['- Use WAL for local concurrency [sqlite-wal](sqlite-wal.md)'],
    notes: [{ path: join(root, 'sqlite-wal.md'), content: readFileSync(notePath, 'utf8') }],
  })
  assert.deepEqual(await adapter.retrieve({
    meta: requestMeta,
    data: { query: 'journal_mode=WAL' },
  }, {}), {
    index: ['- Use WAL for local concurrency [sqlite-wal](sqlite-wal.md)'],
    notes: [{ path: join(root, 'sqlite-wal.md'), content: readFileSync(notePath, 'utf8') }],
  })
  assert.equal(await adapter.retrieve({
    meta: requestMeta,
    data: {
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: 'old plugin context' }],
        source: { kind: 'plugin', plugin: 'fixture' },
      }],
    },
  }, {}), null)
})

test('Engramory refuses index pointers that traverse a symlink', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'patchouli-engramory-root-'))
  const outside = mkdtempSync(join(tmpdir(), 'patchouli-engramory-outside-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  t.after(() => rmSync(outside, { recursive: true, force: true }))
  const secret = join(outside, 'secret.md')
  writeFileSync(secret, 'must not be recalled', 'utf8')
  try {
    symlinkSync(secret, join(root, 'secret.md'))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EPERM' || code === 'EACCES') {
      t.skip('file symlinks are unavailable on this platform')
      return
    }
    throw error
  }
  writeFileSync(join(root, 'MEMORY.md'), '- Secret [secret](secret.md)\n', 'utf8')
  const adapter = createEngramoryAdapter({
    memoryRoot: root,
    indexName: 'MEMORY.md',
    validateIndex: () => undefined,
  })

  assert.equal(await adapter.retrieve({
    meta,
    data: { query: 'secret' },
  }, {}), null)
})

test('propagates native failures without fallback writes', async () => {
  const adapter = createLingshuAdapter({
    async callTool() {
      throw new Error('AEIS offline')
    },
  }, { userMessage: true, assistantMessage: false, toolResult: false, importance: 0.6 })
  await assert.rejects(adapter.update({ meta, data: 'remember this' }, {}), /AEIS offline/)

  const protocolError = createLingshuAdapter({
    async callTool() {
      return {
        content: [{ type: 'text', text: 'invalid memory' }],
        isError: true,
      }
    },
  }, { userMessage: true, assistantMessage: false, toolResult: false, importance: 0.6 })
  await assert.rejects(
    protocolError.update({ meta, data: { content: 'remember this' } }, {}),
    /invalid memory/,
  )
})

test('rejects unsupported graph and memory-evolve calls instead of guessing', async () => {
  const graph = createGraphMemoryAdapter({
    async recall() { return [] },
    upsertNode() { throw new Error('unexpected') },
    upsertEdge() { throw new Error('unexpected') },
  })
  await assert.rejects(
    graph.update({ meta, data: { arbitrary: 'observation' } }, {}),
    /node or edge/,
  )

  const evolve = createMemoryEvolveAdapter({
    snapshot() { throw new Error('unexpected') },
    query() { throw new Error('unexpected') },
  })
  await assert.rejects(
    evolve.update({ meta, data: { content: 'no implicit target' } }, {}),
    /native approval-aware memory tool/,
  )
  assert.equal(evolve.filter?.({
    operation: 'update',
    meta: { ...meta, attributes: { ...meta.attributes, point: 'tool/memory-update' } },
  }), false)
  assert.equal(evolve.filter?.({ operation: 'update', meta }), false)
  assert.equal(graph.filter?.({
    operation: 'retrieve',
    meta: { ...meta, attributes: { ...meta.attributes, point: 'agent/pre-step' } },
  }), true)

  const evolveCalls: string[] = []
  const coordinatedEvolve = createMemoryEvolveAdapter({
    snapshot() {
      return 'filtered native snapshot'
    },
    query(target) {
      evolveCalls.push(target)
      return [target]
    },
  })
  assert.equal(await coordinatedEvolve.retrieve({
    meta: { ...meta, attributes: { ...meta.attributes, point: 'agent/pre-step' } },
    data: { query: 'SQLite' },
  }, {}), 'filtered native snapshot')
  assert.deepEqual(evolveCalls, [])
})
