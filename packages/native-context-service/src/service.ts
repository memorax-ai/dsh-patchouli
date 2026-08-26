import { Service, type Context } from '@deepseek-ai/cordis'

import type {
  NativeContextAlgorithmModule,
  NativeContextIndexModule,
  NativeContextModule,
  NativeContextRetrieveModule,
} from './types.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    nativeContext: NativeContextService
  }
}

/** Registry shared by the native context index, algorithm, and retrieval layers. */
export class NativeContextService extends Service {
  private readonly indexes = new Map<string, NativeContextIndexModule>()
  private readonly algorithms = new Map<string, NativeContextAlgorithmModule>()
  private readonly retrievers = new Map<string, NativeContextRetrieveModule>()

  constructor(ctx: Context) {
    super(ctx, 'nativeContext')
  }

  registerIndex(module: NativeContextIndexModule): () => void {
    return this.register(this.indexes, 'index', module)
  }

  registerAlgorithm(module: NativeContextAlgorithmModule): () => void {
    return this.register(this.algorithms, 'algorithm', module)
  }

  registerRetriever(module: NativeContextRetrieveModule): () => void {
    return this.register(this.retrievers, 'retriever', module)
  }

  getIndex(id: string): NativeContextIndexModule {
    return this.require(this.indexes, 'index', id)
  }

  hasIndex(id: string): boolean {
    return this.indexes.has(id)
  }

  getAlgorithm(id: string): NativeContextAlgorithmModule {
    return this.require(this.algorithms, 'algorithm', id)
  }

  hasAlgorithm(id: string): boolean {
    return this.algorithms.has(id)
  }

  getRetriever(id: string): NativeContextRetrieveModule {
    return this.require(this.retrievers, 'retriever', id)
  }

  hasRetriever(id: string): boolean {
    return this.retrievers.has(id)
  }

  private register<T extends NativeContextModule>(
    modules: Map<string, T>,
    kind: string,
    module: T,
  ): () => void {
    if (module.id.trim() === '') {
      throw new Error(`native context ${kind} id must be a non-empty string`)
    }
    if (modules.has(module.id)) {
      throw new Error(`native context ${kind} "${module.id}" is already registered`)
    }
    return this.ctx.effect(() => {
      modules.set(module.id, module)
      return () => {
        if (modules.get(module.id) === module) modules.delete(module.id)
      }
    }, `nativeContext.register(${JSON.stringify(kind)}, ${JSON.stringify(module.id)})`)
  }

  private require<T>(modules: ReadonlyMap<string, T>, kind: string, id: string): T {
    const module = modules.get(id)
    if (module === undefined) {
      throw new Error(`native context ${kind} "${id}" is not registered`)
    }
    return module
  }
}
