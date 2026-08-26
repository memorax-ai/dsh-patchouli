/** Shared cancellation boundary for native context work. */
export interface NativeContextModuleContext {
  readonly signal?: AbortSignal
}

export interface NativeContextModule {
  readonly id: string
}

/** Obtains and normalizes data from one native source. */
export interface NativeContextIndexModule<
  TRequest = unknown,
  TResult = unknown,
> extends NativeContextModule {
  index(
    request: TRequest,
    context: NativeContextModuleContext,
  ): Promise<TResult>
}

/** Owns database ingestion and querying for one context algorithm block. */
export interface NativeContextAlgorithmModule<
  TInput = unknown,
  TIndexResult = unknown,
  TQuery = unknown,
  TQueryResult = unknown,
> extends NativeContextModule {
  ingest(
    input: TInput,
    context: NativeContextModuleContext,
  ): Promise<TIndexResult>
  query(
    request: TQuery,
    context: NativeContextModuleContext,
  ): Promise<TQueryResult>
}

export const NATIVE_CONTEXT_EFFORTS = ['low', 'medium', 'high'] as const
export type NativeContextRetrieveLevel = typeof NATIVE_CONTEXT_EFFORTS[number]

export interface NativeContextRetrieveMode {
  readonly effort: NativeContextRetrieveLevel
  readonly agent: boolean
}

/** Exposes a concrete retrieval policy to Patchouli or another local caller. */
export interface NativeContextRetrieveModule<
  TRequest = unknown,
  TResult = unknown,
> extends NativeContextModule {
  readonly level: NativeContextRetrieveLevel
  retrieve(
    request: TRequest,
    context: NativeContextModuleContext,
  ): Promise<TResult>
}
