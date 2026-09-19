import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'

export interface SessionHistory {
  readonly meta: SessionHeader
  readonly events: readonly SessionEvent[]
}

interface LegacyPersistence {
  readFrom(id: SessionId, offset: number, signal?: AbortSignal): Promise<SessionHistory>
  list(signal?: AbortSignal): Promise<readonly SessionHeader[]>
}

interface HandlePersistence {
  open(id: SessionId, access: 'read', options?: { signal?: AbortSignal }): Promise<{
    readonly header: SessionHeader
    read(offset?: number, length?: number, options?: { signal?: AbortSignal }): Promise<{ readonly events: readonly SessionEvent[] }>
    close(): Promise<void>
  }>
  list(options?: { signal?: AbortSignal }): Promise<readonly { readonly header: SessionHeader }[]>
}

export type SessionPersistenceReader = LegacyPersistence | HandlePersistence
export type SessionHistoryReader = Pick<LegacyPersistence, 'readFrom'> | Pick<HandlePersistence, 'open'>

/** Borrow a read handle only for the duration of the history read. */
export async function readSessionHistory(
  persistence: SessionHistoryReader,
  id: SessionId,
  offset: number,
  signal?: AbortSignal,
): Promise<SessionHistory> {
  if ('readFrom' in persistence) return persistence.readFrom(id, offset, signal)
  const handle = await persistence.open(id, 'read', { signal })
  try {
    const result = await handle.read(offset, undefined, { signal })
    return { meta: handle.header, events: result.events }
  } finally {
    await handle.close()
  }
}

export async function listSessionHeaders(
  persistence: SessionPersistenceReader,
  signal?: AbortSignal,
): Promise<readonly SessionHeader[]> {
  if ('readFrom' in persistence) return persistence.list(signal)
  return (await persistence.list({ signal })).map(snapshot => snapshot.header)
}

/** Preserve the existing history consumers across the Session log encapsulation. */
export function sessionEvents(session: {
  readonly events?: readonly SessionEvent[]
  snapshotEvents?(): readonly SessionEvent[]
}): readonly SessionEvent[] {
  if (session.snapshotEvents !== undefined) return session.snapshotEvents()
  if (session.events !== undefined) return session.events
  throw new TypeError('Unsupported Session history interface')
}
