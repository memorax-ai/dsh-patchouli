export type DocumentRef = {
  uri: string
  title?: string
  mediaType?: string
  kind?: string
}

export type DocumentSnapshot = DocumentRef & {
  content: unknown
  revision?: string
  metadata?: Readonly<Record<string, unknown>>
}

export type DocumentResolveContext = {
  surfaceId: string
  sessionId: string
}

export type DocumentProvider = {
  scheme: string
  describe?: (uri: string) => DocumentRef | undefined
  resolve: (
    uri: string,
    context: DocumentResolveContext,
    signal: AbortSignal,
  ) => DocumentSnapshot | Promise<DocumentSnapshot>
  subscribe?: (
    uri: string,
    context: DocumentResolveContext,
    listener: () => void,
  ) => () => void
}

export type DocumentSessionHost = {
  open: (document: DocumentRef) => void
  close: (uri: string) => void
  reveal: (document: DocumentRef) => void
}

export type UiSurfaceDescriptor = {
  id: string
}

function schemeOf(uri: string): string {
  const match = /^([a-z][a-z0-9+.-]*):/i.exec(uri)
  if (!match?.[1]) throw new Error(`Document URI has no valid scheme: ${uri}`)
  return match[1].toLowerCase()
}

function normalizeProviderScheme(scheme: string): string {
  const normalized = scheme.toLowerCase()
  if (!/^[a-z][a-z0-9+.-]*$/.test(normalized)) {
    throw new Error(`Invalid document provider scheme: ${scheme}`)
  }
  return normalized
}

export class DocumentWorkbench {
  readonly #providers = new Map<string, DocumentProvider>()
  readonly #hosts = new Map<string, DocumentSessionHost>()
  readonly #listeners = new Set<() => void>()
  #version = 0

  registerProvider(provider: DocumentProvider): () => void {
    const scheme = normalizeProviderScheme(provider.scheme)
    if (this.#providers.has(scheme)) {
      throw new Error(`Document provider already registered for scheme: ${scheme}`)
    }
    this.#providers.set(scheme, provider)
    this.#emit()
    return () => {
      if (this.#providers.get(scheme) !== provider) return
      this.#providers.delete(scheme)
      this.#emit()
    }
  }

  listProviderSchemes(): readonly string[] {
    return [...this.#providers.keys()].sort()
  }

  registerSessionHost(surfaceId: string, sessionId: string, host: DocumentSessionHost): () => void {
    const key = `${surfaceId}\u0000${sessionId}`
    if (this.#hosts.has(key)) {
      throw new Error(`Document session host already registered: ${surfaceId}/${sessionId}`)
    }
    this.#hosts.set(key, host)
    return () => {
      if (this.#hosts.get(key) === host) this.#hosts.delete(key)
    }
  }

  describe(document: DocumentRef): DocumentRef {
    const described = this.#providers.get(schemeOf(document.uri))?.describe?.(document.uri)
    return described ? { ...document, ...described, uri: document.uri } : document
  }

  async resolve(
    document: DocumentRef,
    context: DocumentResolveContext,
    signal: AbortSignal,
  ): Promise<DocumentSnapshot> {
    const scheme = schemeOf(document.uri)
    const provider = this.#providers.get(scheme)
    if (!provider) throw new Error(`No document provider registered for scheme: ${scheme}`)
    const snapshot = await provider.resolve(document.uri, context, signal)
    if (snapshot.uri !== document.uri) {
      throw new Error(`Document provider returned a different URI: ${snapshot.uri}`)
    }
    return { ...document, ...snapshot, uri: document.uri }
  }

  subscribeDocument(
    document: DocumentRef,
    context: DocumentResolveContext,
    listener: () => void,
  ): () => void {
    return this.#providers.get(schemeOf(document.uri))?.subscribe?.(
      document.uri,
      context,
      listener,
    ) ?? (() => {})
  }

  open(surfaceId: string, sessionId: string, document: DocumentRef): void {
    this.#host(surfaceId, sessionId).open(this.describe(document))
  }

  close(surfaceId: string, sessionId: string, uri: string): void {
    this.#host(surfaceId, sessionId).close(uri)
  }

  reveal(surfaceId: string, sessionId: string, document: DocumentRef): void {
    this.#host(surfaceId, sessionId).reveal(this.describe(document))
  }

  unregisterSurface(surfaceId: string): void {
    const prefix = `${surfaceId}\u0000`
    for (const key of this.#hosts.keys()) {
      if (key.startsWith(prefix)) this.#hosts.delete(key)
    }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  getSnapshot = (): number => this.#version

  #host(surfaceId: string, sessionId: string): DocumentSessionHost {
    const host = this.#hosts.get(`${surfaceId}\u0000${sessionId}`)
    if (!host) throw new Error(`Workbench surface is not mounted: ${surfaceId}/${sessionId}`)
    return host
  }

  #emit(): void {
    this.#version += 1
    for (const listener of this.#listeners) listener()
  }
}

/** A frontend's scoped connection to the shared UI container. */
export class UiSurfaceConnection {
  readonly id: string
  readonly #documents: DocumentWorkbench

  constructor(descriptor: UiSurfaceDescriptor, documents: DocumentWorkbench) {
    if (!descriptor.id.trim()) throw new Error('UI surface id must not be empty')
    this.id = descriptor.id
    this.#documents = documents
  }

  registerSessionHost(sessionId: string, host: DocumentSessionHost): () => void {
    return this.#documents.registerSessionHost(this.id, sessionId, host)
  }

  describe(document: DocumentRef): DocumentRef {
    return this.#documents.describe(document)
  }

  resolve(document: DocumentRef, sessionId: string, signal: AbortSignal): Promise<DocumentSnapshot> {
    return this.#documents.resolve(document, { surfaceId: this.id, sessionId }, signal)
  }

  subscribeDocument(document: DocumentRef, sessionId: string, listener: () => void): () => void {
    return this.#documents.subscribeDocument(document, { surfaceId: this.id, sessionId }, listener)
  }

  open(sessionId: string, document: DocumentRef): void {
    this.#documents.open(this.id, sessionId, document)
  }

  close(sessionId: string, uri: string): void {
    this.#documents.close(this.id, sessionId, uri)
  }

  reveal(sessionId: string, document: DocumentRef): void {
    this.#documents.reveal(this.id, sessionId, document)
  }

  subscribe = (listener: () => void): (() => void) => this.#documents.subscribe(listener)
  getSnapshot = (): number => this.#documents.getSnapshot()
}

export type UiSurfaceHandle = {
  surface: UiSurfaceConnection
  disconnect: () => void
}

/** Shared container service. Frontend plugins connect one uniquely named surface. */
export class UiContainer {
  readonly documents = new DocumentWorkbench()
  readonly #surfaces = new Map<string, UiSurfaceConnection>()

  connectSurface(descriptor: UiSurfaceDescriptor): UiSurfaceHandle {
    if (this.#surfaces.has(descriptor.id)) {
      throw new Error(`UI surface already connected: ${descriptor.id}`)
    }
    const surface = new UiSurfaceConnection(descriptor, this.documents)
    this.#surfaces.set(surface.id, surface)
    return {
      surface,
      disconnect: () => {
        if (this.#surfaces.get(surface.id) !== surface) return
        this.#surfaces.delete(surface.id)
        this.documents.unregisterSurface(surface.id)
      },
    }
  }
}
