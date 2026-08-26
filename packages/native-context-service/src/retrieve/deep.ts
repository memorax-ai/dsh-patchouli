import type {
  NativeContextModuleContext,
  NativeContextRetrieveModule,
} from '../types.js'

const defaultMaxInputChars = 1_000_000
const defaultMaxResultChars = 100_000
const defaultMaxSources = 256
const maximumBuildIdChars = 512

/** Opaque source identity supplied by an index or algorithm block. */
export type NativeContextDeepSourceRef = Readonly<Record<string, unknown>> & {
  readonly kind: string
}

export interface NativeContextDeepInput {
  readonly text: string
  readonly source: NativeContextDeepSourceRef
}

export interface NativeContextDeepRequest {
  readonly query: string
  /** Agent participation is independent from the high-effort retrieval tier. */
  readonly agent?: boolean
  /** Omit when asking the runner to reuse a prior build. */
  readonly inputs?: readonly NativeContextDeepInput[]
  /** Runner-owned reusable build identity; this module does not cache it. */
  readonly buildId?: string
}

export interface NativeContextDeepResult {
  readonly text: string
  readonly sources: readonly NativeContextDeepSourceRef[]
  readonly buildId?: string
  readonly truncated: boolean
}

export interface NativeContextDeepRunnerResult {
  readonly text: string
  readonly sources: readonly NativeContextDeepSourceRef[]
  readonly buildId?: string
}

/** Host-provided large-context understanding runner. It owns execution and build reuse. */
export interface NativeContextDeepRunner {
  run(
    request: NativeContextDeepRequest,
    signal?: AbortSignal,
  ): Promise<NativeContextDeepRunnerResult>
}

export interface NativeContextDeepOptions {
  readonly maxInputChars?: number
  readonly maxResultChars?: number
  readonly maxSources?: number
}

/** A bounded deep retrieval boundary; it never creates agents, schedules work, or caches builds. */
export class DeepRetrieveModule implements NativeContextRetrieveModule<
  NativeContextDeepRequest,
  NativeContextDeepResult
> {
  readonly id = 'deep'
  readonly level = 'high' as const

  private readonly maxInputChars: number
  private readonly maxResultChars: number
  private readonly maxSources: number

  constructor(
    private readonly runner: NativeContextDeepRunner,
    options: NativeContextDeepOptions = {},
  ) {
    this.maxInputChars = positiveLimit(
      options.maxInputChars,
      defaultMaxInputChars,
      'maxInputChars',
    )
    this.maxResultChars = positiveLimit(
      options.maxResultChars,
      defaultMaxResultChars,
      'maxResultChars',
    )
    this.maxSources = positiveLimit(
      options.maxSources,
      defaultMaxSources,
      'maxSources',
    )
  }

  async retrieve(
    request: NativeContextDeepRequest,
    context: NativeContextModuleContext,
  ): Promise<NativeContextDeepResult> {
    validateRequest(request, this.maxInputChars, this.maxSources)
    context.signal?.throwIfAborted()
    const result = await this.runner.run(request, context.signal)
    context.signal?.throwIfAborted()
    if (result.sources.length === 0) {
      throw new Error('deep retrieval result must include at least one source reference')
    }
    const text = result.text.slice(0, this.maxResultChars)
    const sources = result.sources.slice(0, this.maxSources)
    for (const source of sources) validateSource(source)
    if (result.buildId !== undefined) validateBuildId(result.buildId)
    return {
      text,
      sources,
      ...(result.buildId === undefined ? {} : { buildId: result.buildId }),
      truncated: text.length < result.text.length || sources.length < result.sources.length,
    }
  }
}

/** Missing optional runners leave the deep level unregistered. */
export function createDeepRetrieveModule(
  runner: NativeContextDeepRunner | undefined,
  options?: NativeContextDeepOptions,
): DeepRetrieveModule | undefined {
  return runner === undefined ? undefined : new DeepRetrieveModule(runner, options)
}

function validateRequest(
  request: NativeContextDeepRequest,
  maxInputChars: number,
  maxSources: number,
): void {
  if (request.query.trim().length === 0) {
    throw new TypeError('deep retrieval query must be non-empty')
  }
  if (request.buildId !== undefined) validateBuildId(request.buildId)
  const inputs = request.inputs ?? []
  if (request.buildId === undefined && inputs.length === 0) {
    throw new TypeError('deep retrieval requires inputs or a reusable buildId')
  }
  if (inputs.length > maxSources) {
    throw new RangeError(`deep retrieval accepts at most ${maxSources} inputs`)
  }
  let inputChars = request.query.length
  for (const input of inputs) {
    validateSource(input.source)
    inputChars += input.text.length
    if (inputChars > maxInputChars) {
      throw new RangeError(`deep retrieval input exceeds ${maxInputChars} characters`)
    }
  }
}

function validateSource(source: NativeContextDeepSourceRef): void {
  if (typeof source !== 'object' || source === null || Array.isArray(source)) {
    throw new TypeError('deep retrieval source must be an object')
  }
  if (typeof source.kind !== 'string' || source.kind.trim().length === 0) {
    throw new TypeError('deep retrieval source kind must be non-empty')
  }
}

function validateBuildId(buildId: string): void {
  if (buildId.length === 0 || buildId.length > maximumBuildIdChars) {
    throw new RangeError(`buildId must contain 1 to ${maximumBuildIdChars} characters`)
  }
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const limit = value ?? fallback
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError(`${name} must be a positive safe integer`)
  }
  return limit
}
