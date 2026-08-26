import assert from 'node:assert/strict'
import test from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import {
  NativeContextRuntime,
  NativeContextService,
} from '../lib/index.js'

const request = (effort, agent) => ({
  meta: {
    source: { type: 'agent-loop', id: 'dsh-agent-loop' },
    scope: '/work',
    attributes: { point: 'tool/memory-retrieve', sessionId: 'session-1' },
  },
  data: { query: 'auth handler', metadata: { effort, agent } },
})

const hit = {
  sourceId: 'session-history',
  score: 0.9,
  text: 'auth handler evidence',
  source: {
    type: 'session-event',
    sessionId: 'session-1',
    seq: 1,
    time: 1,
    eventType: 'user/message',
    surface: 'current',
  },
}

function setup({ standard = true, deep = true } = {}) {
  const service = new NativeContextService(new Context())
  const runtime = new NativeContextRuntime(service)
  const calls = []
  service.registerRetriever({
    id: 'fast',
    level: 'low',
    async retrieve(input) {
      calls.push({ id: 'fast', input })
      return { hits: [hit], truncated: false }
    },
  })
  if (standard) {
    service.registerRetriever({
      id: 'standard',
      level: 'medium',
      async retrieve(input) {
        calls.push({ id: 'standard', input })
        return { answer: 'standard answer', references: [] }
      },
    })
  }
  if (deep) {
    service.registerRetriever({
      id: 'deep',
      level: 'high',
      async retrieve(input) {
        calls.push({ id: 'deep', input })
        return { text: 'deep answer', sources: input.inputs.map(item => item.source), truncated: false }
      },
    })
  }
  return { runtime, calls }
}

test('routes low to fast and medium Agent assistance to standard', async () => {
  const { runtime, calls } = setup()

  const low = await runtime.retrieve(request('low', true), {})
  assert.equal(low.effort, 'low')
  assert.deepEqual(calls.map(call => call.id), ['fast'])

  calls.length = 0
  const medium = await runtime.retrieve(request('medium', true), {})
  assert.equal(medium.answer, 'standard answer')
  assert.equal(medium.agent, true)
  assert.deepEqual(calls.map(call => call.id), ['standard'])
})

test('routes high to deep independently of Agent assistance', async () => {
  const { runtime, calls } = setup()

  const result = await runtime.retrieve(request('high', false), {})

  assert.equal(result.answer, 'deep answer')
  assert.equal(result.references[0]?.source.kind, 'session-history')
  assert.equal(result.agent, false)
  assert.deepEqual(calls.map(call => call.id), ['fast', 'deep'])
  assert.equal(calls[1].input.agent, false)
  assert.equal(calls[1].input.inputs[0].source.kind, 'session-history')
})

test('falls back only when the requested retriever is unavailable', async () => {
  const medium = setup({ deep: false })
  await medium.runtime.retrieve(request('high', true), {})
  assert.deepEqual(medium.calls.map(call => call.id), ['standard'])

  const fast = setup({ standard: false, deep: false })
  await fast.runtime.retrieve(request('high', true), {})
  assert.deepEqual(fast.calls.map(call => call.id), ['fast'])

  const withoutAgent = setup({ deep: false })
  await withoutAgent.runtime.retrieve(request('medium', false), {})
  assert.deepEqual(withoutAgent.calls.map(call => call.id), ['fast'])
})

test('does not hide errors from an installed retriever', async () => {
  const service = new NativeContextService(new Context())
  const runtime = new NativeContextRuntime(service)
  service.registerRetriever({
    id: 'fast',
    level: 'low',
    async retrieve() { return { hits: [], truncated: false } },
  })
  service.registerRetriever({
    id: 'standard',
    level: 'medium',
    async retrieve() { throw new Error('runner failed') },
  })

  await assert.rejects(runtime.retrieve(request('medium', true), {}), /runner failed/)
})
