import { appendFile, mkdir, open, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export interface ArchiveSegment {
  readonly sessionId: string
  readonly openedAt: number
  readonly closedAt?: number
  readonly eventCount?: number
}

export interface ArchiveTimeline {
  readonly logicalId: string
  readonly activeSessionId: string
  readonly segments: readonly ArchiveSegment[]
}

type TimelineRecord = {
  readonly version: 1
  readonly type: 'attached'
  readonly logicalId: string
  readonly sessionId: string
  readonly time: number
} | {
  readonly version: 1
  readonly type: 'rotated'
  readonly logicalId: string
  readonly previousSessionId: string
  readonly sessionId: string
  readonly previousEventCount: number
  readonly time: number
}

function directoryName(logicalId: string): string {
  return Buffer.from(logicalId, 'utf8').toString('base64url') || '_'
}

export class TimelineStore {
  constructor(private readonly root: string) {}

  async attach(logicalId: string, sessionId: string, time = Date.now()): Promise<ArchiveTimeline> {
    const existing = await this.read(logicalId)
    if (existing !== undefined) {
      if (existing.activeSessionId !== sessionId) {
        throw new Error(`logical Session ${logicalId} is already attached to ${existing.activeSessionId}`)
      }
      return existing
    }
    await this.append(logicalId, { version: 1, type: 'attached', logicalId, sessionId, time })
    return this.require(logicalId)
  }

  async rotate(
    logicalId: string,
    previousSessionId: string,
    sessionId: string,
    previousEventCount: number,
    time = Date.now(),
  ): Promise<ArchiveTimeline> {
    const current = await this.require(logicalId)
    if (current.activeSessionId !== previousSessionId) {
      throw new Error(`logical Session ${logicalId} currently points to ${current.activeSessionId}`)
    }
    await this.append(logicalId, {
      version: 1,
      type: 'rotated',
      logicalId,
      previousSessionId,
      sessionId,
      previousEventCount,
      time,
    })
    return this.require(logicalId)
  }

  async read(logicalId: string): Promise<ArchiveTimeline | undefined> {
    let content: string
    try {
      content = await readFile(this.path(logicalId), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    const records = content.split('\n').filter(Boolean).map((line, index) => {
      let value: unknown
      try {
        value = JSON.parse(line)
      } catch (error) {
        throw new Error(`invalid timeline record ${index}: ${String(error)}`)
      }
      return this.record(value, logicalId, index)
    })
    if (records.length === 0 || records[0]?.type !== 'attached') {
      throw new Error(`logical Session ${logicalId} has no attachment record`)
    }
    const first = records[0]
    const segments: ArchiveSegment[] = [{ sessionId: first.sessionId, openedAt: first.time }]
    for (const [index, record] of records.slice(1).entries()) {
      if (record.type !== 'rotated') throw new Error(`unexpected attachment record ${index + 1}`)
      const current = segments.at(-1)
      if (current === undefined || current.sessionId !== record.previousSessionId) {
        throw new Error(`timeline record ${index + 1} does not continue ${current?.sessionId ?? 'nothing'}`)
      }
      segments[segments.length - 1] = {
        ...current,
        closedAt: record.time,
        eventCount: record.previousEventCount,
      }
      segments.push({ sessionId: record.sessionId, openedAt: record.time })
    }
    return {
      logicalId,
      activeSessionId: segments.at(-1)?.sessionId ?? first.sessionId,
      segments,
    }
  }

  async require(logicalId: string): Promise<ArchiveTimeline> {
    const timeline = await this.read(logicalId)
    if (timeline === undefined) throw new Error(`logical Session ${logicalId} is not attached`)
    return timeline
  }

  private path(logicalId: string): string {
    return join(this.root, directoryName(logicalId), 'timeline.jsonl')
  }

  private async append(logicalId: string, record: TimelineRecord): Promise<void> {
    const path = this.path(logicalId)
    await mkdir(dirname(path), { recursive: true })
    await appendFile(path, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 })
    // Windows rejects fsync on a read-only handle. The timeline is writable by
    // construction, so open it read/write before forcing the append to disk.
    const file = await open(path, 'r+')
    try {
      await file.sync()
    } finally {
      await file.close()
    }
  }

  private record(value: unknown, logicalId: string, index: number): TimelineRecord {
    if (typeof value !== 'object' || value === null) throw new Error(`invalid timeline record ${index}`)
    const record = value as Partial<TimelineRecord>
    if (record.version !== 1 || record.logicalId !== logicalId || typeof record.sessionId !== 'string'
      || typeof record.time !== 'number') {
      throw new Error(`invalid timeline record ${index}`)
    }
    if (record.type === 'attached') return record as TimelineRecord
    if (record.type === 'rotated' && typeof record.previousSessionId === 'string'
      && Number.isSafeInteger(record.previousEventCount) && (record.previousEventCount ?? -1) >= 0) {
      return record as TimelineRecord
    }
    throw new Error(`invalid timeline record ${index}`)
  }
}
