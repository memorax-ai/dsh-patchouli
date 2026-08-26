import {
  BlockAssembler,
  ReasoningEffortId,
  createUserMessage,
  type LlmRuntime,
} from '@deepseek-ai/dsh-llm'

import type { NativeContextSettings } from '../settings.js'
import type { NativeContextModuleContext } from '../types.js'
import type {
  FastRetrieveRequest,
  FastRetrieveResult,
  FastRetrieveSource,
} from './fast.js'
import type {
  NativeContextAgentEvidence,
  NativeContextAgentPlanner,
  NativeContextAgentRunner,
  NativeContextAgentSubquery,
  StandardRetrieveResult,
} from './standard.js'

const plannerSystem = `You plan local context retrieval. Return only a JSON array of 1 to 4 concise search queries. Preserve important names, paths, errors, and identifiers. Do not explain the array.`

const synthesisSystem = `Answer the user's question using only the supplied local evidence. Cite supporting evidence with square-bracket numbers such as [1]. Say when the evidence is insufficient. Do not invent files, events, commits, or conclusions.`

/** DSH-native model execution for Standard retrieval planning and synthesis. */
export class StandardLlmRunner implements
  NativeContextAgentPlanner<FastRetrieveRequest, FastRetrieveRequest>,
  NativeContextAgentRunner<
    FastRetrieveRequest,
    FastRetrieveRequest,
    FastRetrieveResult,
    FastRetrieveSource
  > {
  constructor(
    private readonly llm: LlmRuntime,
    private readonly settings: () => NativeContextSettings,
  ) {}

  async plan(
    request: FastRetrieveRequest,
    context: NativeContextModuleContext,
  ): Promise<readonly NativeContextAgentSubquery<FastRetrieveRequest>[]> {
    const output = await this.complete(
      plannerSystem,
      `User query:\n${request.query}`,
      context.signal,
    )
    const queries = parseQueries(output)
    const maxCharacters = request.maxCharacters === undefined
      ? undefined
      : Math.max(1, Math.floor(request.maxCharacters / queries.length))
    return queries.map(query => ({
      text: query,
      request: {
        ...request,
        query,
        ...(maxCharacters === undefined ? {} : { maxCharacters }),
      },
    }))
  }

  async run(
    request: FastRetrieveRequest,
    evidence: readonly NativeContextAgentEvidence<FastRetrieveRequest, FastRetrieveResult>[],
    context: NativeContextModuleContext,
  ): Promise<StandardRetrieveResult<FastRetrieveSource>> {
    const references: Array<{ queryIndex: number; source: FastRetrieveSource }> = []
    let citation = 0
    const sections = evidence.flatMap((item, queryIndex) => {
      if (item.result.hits.length === 0) return []
      const hits = item.result.hits.map((hit) => {
        references.push({ queryIndex, source: hit.source })
        citation += 1
        return `[${citation}] ${hit.text}`
      })
      return [`Search ${queryIndex + 1}: ${item.text}\n${hits.join('\n\n')}`]
    })
    if (sections.length === 0) return { answer: '', references: [] }
    const answer = await this.complete(
      synthesisSystem,
      `Question:\n${request.query}\n\nEvidence:\n${sections.join('\n\n')}`,
      context.signal,
    )
    return { answer, references }
  }

  private async complete(system: string, prompt: string, signal?: AbortSignal): Promise<string> {
    const settings = this.settings()
    const config = {
      provider: settings.standardProvider.trim(),
      model: settings.standardModel.trim(),
      ...(settings.standardMaxTokens === null ? {} : { maxTokens: settings.standardMaxTokens }),
      ...(settings.standardReasoningEffort.trim() === '' ? {} : {
        reasoningEffort: ReasoningEffortId(settings.standardReasoningEffort.trim()),
      }),
    }
    const prepared = await this.llm.prepareCall(config, signal)
    const assembler = new BlockAssembler()
    for await (const chunk of prepared.stream({
      ...prepared.config,
      system,
      signal,
      messages: [createUserMessage({
        source: { kind: 'plugin', plugin: 'dsh-patchouli-native-context-service' },
        content: [{ type: 'text', text: prompt }],
      })],
    })) assembler.push(chunk)
    const finish = assembler.finish
    if (finish.kind === 'error' || finish.kind === 'aborted') {
      throw new Error(`Standard retrieval model failed: ${finish.failure.message}`)
    }
    const text = assembler.blocks().flatMap(block => block.type === 'text' ? [block.text] : []).join('\n').trim()
    if (text === '') throw new Error('Standard retrieval model returned no text')
    return text
  }
}

function parseQueries(output: string): readonly string[] {
  const start = output.indexOf('[')
  const end = output.lastIndexOf(']')
  if (start < 0 || end <= start) throw new Error('Standard retrieval planner returned invalid JSON')
  let parsed: unknown
  try {
    parsed = JSON.parse(output.slice(start, end + 1))
  } catch {
    throw new Error('Standard retrieval planner returned invalid JSON')
  }
  if (!Array.isArray(parsed)) throw new Error('Standard retrieval planner must return a JSON array')
  const queries = parsed.map(value => typeof value === 'string' ? value.trim() : '').filter(Boolean)
  if (queries.length === 0 || queries.length > 4 || queries.length !== parsed.length) {
    throw new Error('Standard retrieval planner must return 1 to 4 non-empty queries')
  }
  return queries
}
