import assert from 'node:assert/strict'
import test from 'node:test'

import {
  StandardRetrieveModule,
  createStandardRetrieveModule,
} from '../lib/retrieve/standard.js'

test('standard retriever plans bounded queries, runs fast, and synthesizes references', async () => {
  const fastCalls: Array<{ query: string; signal: AbortSignal | undefined }> = []
  let runnerEvidence: readonly unknown[] = []
  const fast = {
    id: 'fast',
    level: 'low' as const,
    async retrieve(request: { query: string }, context: { signal?: AbortSignal }) {
      fastCalls.push({ query: request.query, signal: context.signal })
      return { hits: [{ source: `file://${request.query}`, text: request.query }] }
    },
  }
  const planner = {
    async plan(request: { question: string }) {
      return [
        { text: `${request.question} implementation`, request: { query: 'implementation' } },
        { text: `${request.question} tests`, request: { query: 'tests' } },
      ]
    },
  }
  const runner = {
    async run(
      _request: { question: string },
      evidence: readonly Array<{ result: { hits: Array<{ source: string }> } }>,
    ) {
      runnerEvidence = evidence
      return {
        answer: 'The implementation and tests are both present.',
        references: evidence.map((item, queryIndex) => ({
          queryIndex,
          source: item.result.hits[0]!.source,
        })),
      }
    },
  }
  const controller = new AbortController()
  const retriever = new StandardRetrieveModule(fast, planner, runner)

  const result = await retriever.retrieve({ question: 'native context' }, {
    signal: controller.signal,
  })

  assert.equal(retriever.level, 'medium')
  assert.deepEqual(fastCalls.map(call => call.query), ['implementation', 'tests'])
  assert.ok(fastCalls.every(call => call.signal === controller.signal))
  assert.equal(runnerEvidence.length, 2)
  assert.deepEqual(result, {
    answer: 'The implementation and tests are both present.',
    references: [
      { queryIndex: 0, source: 'file://implementation' },
      { queryIndex: 1, source: 'file://tests' },
    ],
  })
})

test('standard retriever rejects planner count and character budget before fast retrieval', async () => {
  let fastCalls = 0
  const fast = {
    id: 'fast',
    level: 'low' as const,
    async retrieve() {
      fastCalls += 1
      return { hits: [] }
    },
  }
  const runner = {
    async run() {
      return { answer: 'none', references: [] }
    },
  }
  const tooMany = new StandardRetrieveModule(fast, {
    async plan() {
      return [
        { text: 'one', request: {} },
        { text: 'two', request: {} },
        { text: 'three', request: {} },
      ]
    },
  }, runner, { maxSubqueries: 2 })
  await assert.rejects(tooMany.retrieve({}, {}), /exceeded 2 subqueries/)

  const tooLong = new StandardRetrieveModule(fast, {
    async plan() {
      return [
        { text: '1234', request: {} },
        { text: '5678', request: {} },
      ]
    },
  }, runner, { maxQueryCharacters: 7 })
  await assert.rejects(tooLong.retrieve({}, {}), /exceeded 7 total query characters/)
  assert.equal(fastCalls, 0)
})

test('standard retriever stops after planner cancellation and validates runner citations', async () => {
  const controller = new AbortController()
  let fastCalls = 0
  const fast = {
    id: 'fast',
    level: 'low' as const,
    async retrieve() {
      fastCalls += 1
      return {}
    },
  }
  const cancelled = new StandardRetrieveModule(fast, {
    async plan() {
      controller.abort(new Error('stop'))
      return [{ text: 'query', request: {} }]
    },
  }, {
    async run() {
      return { answer: 'unexpected', references: [] }
    },
  })
  await assert.rejects(cancelled.retrieve({}, { signal: controller.signal }), /stop/)
  assert.equal(fastCalls, 0)

  const invalidCitation = new StandardRetrieveModule(fast, {
    async plan() {
      return [{ text: 'query', request: {} }]
    },
  }, {
    async run() {
      return { answer: 'answer', references: [{ queryIndex: 1, source: 'missing' }] }
    },
  })
  await assert.rejects(invalidCitation.retrieve({}, {}), /invalid reference 0/)
})

test('standard retriever factory omits the module when no runner is installed', () => {
  const module = createStandardRetrieveModule({
    fast: {
      id: 'fast',
      level: 'low',
      async retrieve() { return {} },
    },
    planner: {
      async plan() { return [{ text: 'query', request: {} }] },
    },
  })

  assert.equal(module, undefined)
})
