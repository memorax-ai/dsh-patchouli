import type {
  NativeContextModuleContext,
  NativeContextRetrieveModule,
} from '../types.js'

export const STANDARD_RETRIEVE_DEFAULT_MAX_SUBQUERIES = 4
export const STANDARD_RETRIEVE_MAX_SUBQUERIES = 8
export const STANDARD_RETRIEVE_DEFAULT_MAX_QUERY_CHARACTERS = 2_000
export const STANDARD_RETRIEVE_MAX_QUERY_CHARACTERS = 8_000

/** One planner-owned request for the injected fast retriever. */
export interface NativeContextAgentSubquery<TFastRequest> {
  /** Human-readable query used for budgeting and citation. */
  readonly text: string
  /** Concrete request passed to the fast retriever without reinterpretation. */
  readonly request: TFastRequest
}

/** Plans a small search fan-out from the caller's original request. */
export interface NativeContextAgentPlanner<TRequest, TFastRequest> {
  plan(
    request: TRequest,
    context: NativeContextModuleContext,
  ): Promise<readonly NativeContextAgentSubquery<TFastRequest>[]>
}

/** One completed fast retrieval, kept in planner order. */
export interface NativeContextAgentEvidence<TFastRequest, TFastResult> {
  readonly text: string
  readonly request: TFastRequest
  readonly result: TFastResult
}

/** A runner citation to a source found by one evidence item. */
export interface NativeContextAgentReference<TSource = unknown> {
  readonly queryIndex: number
  readonly source: TSource
}

export interface StandardRetrieveResult<TSource = unknown> {
  readonly answer: string
  readonly references: readonly NativeContextAgentReference<TSource>[]
}

/** Aggregates fast evidence into one answer with explicit source references. */
export interface NativeContextAgentRunner<
  TRequest,
  TFastRequest,
  TFastResult,
  TSource = unknown,
> {
  run(
    request: TRequest,
    evidence: readonly NativeContextAgentEvidence<TFastRequest, TFastResult>[],
    context: NativeContextModuleContext,
  ): Promise<StandardRetrieveResult<TSource>>
}

export interface StandardRetrieveOptions {
  readonly maxSubqueries?: number
  readonly maxQueryCharacters?: number
}

export interface StandardRetrieveDependencies<
  TRequest,
  TFastRequest,
  TFastResult,
  TSource = unknown,
> {
  readonly fast: NativeContextRetrieveModule<TFastRequest, TFastResult>
  readonly planner: NativeContextAgentPlanner<TRequest, TFastRequest>
  readonly runner?: NativeContextAgentRunner<TRequest, TFastRequest, TFastResult, TSource>
}

function boundedOption(
  value: number | undefined,
  fallback: number,
  maximum: number,
  name: string,
): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new RangeError(`${name} must be an integer from 1 to ${maximum}`)
  }
  return resolved
}

/** 10-second-class retrieval: bounded agent planning, fast fan-out, cited synthesis. */
export class StandardRetrieveModule<
  TRequest,
  TFastRequest,
  TFastResult,
  TSource = unknown,
> implements NativeContextRetrieveModule<TRequest, StandardRetrieveResult<TSource>> {
  readonly id = 'standard'
  readonly level = 'medium' as const

  private readonly maxSubqueries: number
  private readonly maxQueryCharacters: number

  constructor(
    private readonly fast: NativeContextRetrieveModule<TFastRequest, TFastResult>,
    private readonly planner: NativeContextAgentPlanner<TRequest, TFastRequest>,
    private readonly runner: NativeContextAgentRunner<
      TRequest,
      TFastRequest,
      TFastResult,
      TSource
    >,
    options: StandardRetrieveOptions = {},
  ) {
    this.maxSubqueries = boundedOption(
      options.maxSubqueries,
      STANDARD_RETRIEVE_DEFAULT_MAX_SUBQUERIES,
      STANDARD_RETRIEVE_MAX_SUBQUERIES,
      'standard retrieve maxSubqueries',
    )
    this.maxQueryCharacters = boundedOption(
      options.maxQueryCharacters,
      STANDARD_RETRIEVE_DEFAULT_MAX_QUERY_CHARACTERS,
      STANDARD_RETRIEVE_MAX_QUERY_CHARACTERS,
      'standard retrieve maxQueryCharacters',
    )
  }

  async retrieve(
    request: TRequest,
    context: NativeContextModuleContext,
  ): Promise<StandardRetrieveResult<TSource>> {
    context.signal?.throwIfAborted()
    const planned = await this.planner.plan(request, context)
    context.signal?.throwIfAborted()
    const subqueries = this.validatePlan(planned)
    const evidence = await Promise.all(subqueries.map(async (subquery) => {
      context.signal?.throwIfAborted()
      const result = await this.fast.retrieve(subquery.request, context)
      context.signal?.throwIfAborted()
      return { ...subquery, result }
    }))
    context.signal?.throwIfAborted()
    const aggregated = await this.runner.run(request, evidence, context)
    context.signal?.throwIfAborted()
    return this.validateResult(aggregated, evidence.length)
  }

  private validatePlan(
    planned: readonly NativeContextAgentSubquery<TFastRequest>[],
  ): readonly NativeContextAgentSubquery<TFastRequest>[] {
    if (!Array.isArray(planned) || planned.length === 0) {
      throw new Error('standard retrieve planner must return at least one subquery')
    }
    if (planned.length > this.maxSubqueries) {
      throw new RangeError(`standard retrieve planner exceeded ${this.maxSubqueries} subqueries`)
    }
    let totalCharacters = 0
    return planned.map((subquery, index) => {
      if (typeof subquery !== 'object' || subquery === null) {
        throw new TypeError(`standard retrieve subquery ${index} must be an object`)
      }
      const text = subquery.text.trim()
      if (text === '') throw new TypeError(`standard retrieve subquery ${index} text must be non-empty`)
      totalCharacters += text.length
      if (totalCharacters > this.maxQueryCharacters) {
        throw new RangeError(
          `standard retrieve planner exceeded ${this.maxQueryCharacters} total query characters`,
        )
      }
      return { text, request: subquery.request }
    })
  }

  private validateResult(
    result: StandardRetrieveResult<TSource>,
    evidenceCount: number,
  ): StandardRetrieveResult<TSource> {
    if (typeof result !== 'object' || result === null || typeof result.answer !== 'string') {
      throw new TypeError('standard retrieve runner must return a textual answer')
    }
    if (!Array.isArray(result.references)) {
      throw new TypeError('standard retrieve runner must return references')
    }
    for (const [index, reference] of result.references.entries()) {
      if (typeof reference !== 'object'
        || reference === null
        || !Number.isSafeInteger(reference.queryIndex)
        || reference.queryIndex < 0
        || reference.queryIndex >= evidenceCount
        || !Object.hasOwn(reference, 'source')) {
        throw new TypeError(`standard retrieve runner returned invalid reference ${index}`)
      }
    }
    return result
  }
}

/**
 * Construct the runtime module only when an actual agent runner is injected.
 * Callers can therefore skip registry registration when agent execution is unavailable.
 */
export function createStandardRetrieveModule<
  TRequest,
  TFastRequest,
  TFastResult,
  TSource = unknown,
>(
  dependencies: StandardRetrieveDependencies<TRequest, TFastRequest, TFastResult, TSource>,
  options: StandardRetrieveOptions = {},
): StandardRetrieveModule<TRequest, TFastRequest, TFastResult, TSource> | undefined {
  if (dependencies.runner === undefined) return undefined
  return new StandardRetrieveModule(
    dependencies.fast,
    dependencies.planner,
    dependencies.runner,
    options,
  )
}
