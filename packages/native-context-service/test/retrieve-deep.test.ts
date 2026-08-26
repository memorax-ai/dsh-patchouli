import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createDeepRetrieveModule,
  DeepRetrieveModule,
} from '../lib/retrieve/deep.js'

const source = { kind: 'workspace-file', path: '/work/README.md' }

test('runs one bounded deep understanding pass with source references', async () => {
  const calls = []
  const runner = {
    async run(request, signal) {
      calls.push({ request, signal })
      return {
        text: 'A long synthesis',
        sources: [source],
        buildId: 'build-1',
      }
    },
  }
  const algorithm = new DeepRetrieveModule(runner)
  const controller = new AbortController()
  const request = {
    query: 'What changed?',
    inputs: [{ text: 'Release notes', source }],
  }

  assert.deepEqual(await algorithm.retrieve(request, { signal: controller.signal }), {
    text: 'A long synthesis',
    sources: [source],
    buildId: 'build-1',
    truncated: false,
  })
  assert.deepEqual(calls, [{ request, signal: controller.signal }])
  assert.equal(algorithm.level, 'high')
})

test('passes a reusable buildId to the runner without maintaining a local cache', async () => {
  const calls = []
  const algorithm = new DeepRetrieveModule({
    async run(request) {
      calls.push(request)
      return { text: 'Follow-up', sources: [source], buildId: request.buildId }
    },
  })
  const request = { query: 'What remains?', buildId: 'build-1' }
  const first = await algorithm.retrieve(request, {})
  const second = await algorithm.retrieve(request, {})

  assert.equal(first.buildId, 'build-1')
  assert.equal(second.buildId, 'build-1')
  assert.deepEqual(calls, [request, request])
})

test('bounds result text and sources and rejects unreferenced output', async () => {
  const algorithm = new DeepRetrieveModule({
    async run() {
      return {
        text: '123456789',
        sources: [source, { kind: 'git', commit: 'abc' }],
      }
    },
  }, { maxResultChars: 5, maxSources: 1 })
  assert.deepEqual(await algorithm.retrieve({
    query: 'summarize',
    inputs: [{ text: 'input', source }],
  }, {}), {
    text: '12345',
    sources: [source],
    truncated: true,
  })

  const invalid = new DeepRetrieveModule({
    async run() { return { text: 'unsupported', sources: [] } },
  })
  await assert.rejects(
    invalid.retrieve({ query: 'summarize', inputs: [{ text: 'input', source }] }, {}),
    /at least one source reference/,
  )
})

test('does not construct without a runner and enforces input and cancellation limits', async () => {
  assert.equal(createDeepRetrieveModule(undefined), undefined)
  const calls = []
  const module = createDeepRetrieveModule({
    async run() {
      calls.push('run')
      return { text: 'result', sources: [source] }
    },
  }, { maxInputChars: 10 })
  assert.ok(module)
  await assert.rejects(
    module.retrieve({ query: '12345', inputs: [{ text: '678901', source }] }, {}),
    /input exceeds 10 characters/,
  )

  const controller = new AbortController()
  controller.abort(new Error('cancelled'))
  await assert.rejects(
    module.retrieve({ query: 'q', inputs: [{ text: 'x', source }] }, {
      signal: controller.signal,
    }),
    /cancelled/,
  )
  assert.deepEqual(calls, [])
})
