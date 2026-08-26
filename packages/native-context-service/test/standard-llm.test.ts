import assert from 'node:assert/strict'
import test from 'node:test'

import type { LlmRuntime } from '@deepseek-ai/dsh-llm'

import {
  DEFAULT_NATIVE_CONTEXT_SETTINGS,
  StandardLlmRunner,
  StandardRetrieveModule,
} from '../lib/index.js'

test('Standard LLM runner plans Fast queries and synthesizes cited evidence', async () => {
  const outputs = [
    '["auth handler", "token refresh"]',
    'The handler refreshes expired tokens [1] and records the result [2].',
  ]
  const calls: Array<{ provider: string; model: string; reasoningEffort?: string; maxTokens?: number; prompt: string }> = []
  const llm = {
    async prepareCall(config: { provider: string; model: string; reasoningEffort?: string; maxTokens?: number }) {
      return {
        config,
        async *stream(request: { messages: Array<{ content: Array<{ type: string; text?: string }> }> }) {
          const output = outputs.shift()
          if (output === undefined) throw new Error('unexpected model call')
          calls.push({
            provider: config.provider,
            model: config.model,
            ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
            ...(config.maxTokens === undefined ? {} : { maxTokens: config.maxTokens }),
            prompt: request.messages[0]?.content[0]?.text ?? '',
          })
          yield { type: 'text-delta' as const, index: 0, text: output }
          yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
        },
      }
    },
  } as unknown as LlmRuntime
  const settings = {
    ...DEFAULT_NATIVE_CONTEXT_SETTINGS,
    standardProvider: 'memorax',
    standardModel: 'deepseek-v4',
    standardReasoningEffort: 'max',
  }
  const runner = new StandardLlmRunner(llm, () => settings)
  const fast = {
    id: 'fast',
    level: 'low' as const,
    async retrieve(request: { query: string }) {
      return {
        hits: [{
          sourceId: 'session-history' as const,
          score: 1,
          text: `${request.query} evidence`,
          source: {
            type: 'session-event' as const,
            sessionId: 'session-1',
            seq: request.query === 'auth handler' ? 1 : 2,
            time: 1,
            eventType: 'assistant/message',
            surface: 'current' as const,
          },
        }],
        truncated: false,
      }
    },
  }
  const standard = new StandardRetrieveModule(fast, runner, runner)
  const result = await standard.retrieve({
    meta: {
      source: { type: 'agent-loop', id: 'test' },
      scope: '/work',
    },
    query: 'How was authentication repaired?',
    maxCharacters: 8_000,
  }, {})

  assert.deepEqual(calls.map(({ provider, model, reasoningEffort, maxTokens }) => ({
    provider, model, reasoningEffort, maxTokens,
  })), [
    { provider: 'memorax', model: 'deepseek-v4', reasoningEffort: 'max', maxTokens: undefined },
    { provider: 'memorax', model: 'deepseek-v4', reasoningEffort: 'max', maxTokens: undefined },
  ])
  assert.deepEqual(calls[0]?.prompt, 'User query:\nHow was authentication repaired?')
  assert.match(calls[1]?.prompt ?? '', /\[1\] auth handler evidence/)
  assert.equal(result.answer, 'The handler refreshes expired tokens [1] and records the result [2].')
  assert.deepEqual(result.references.map(reference => reference.queryIndex), [0, 1])
})
