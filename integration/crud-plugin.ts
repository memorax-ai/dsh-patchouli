import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import {
  execFile,
  spawn,
  type ChildProcessByStdio,
} from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { Readable } from 'node:stream'
import { promisify } from 'node:util'
import test from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef, StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { FsInfo, FsTarget } from '@deepseek-ai/dsh-fs'
import type { JsonObject, JsonValue } from 'dsh-patchouli-protocol'

import * as artifactIngestor from '../packages/artifact-ingestor/lib/index.js'
import * as crudTestPlugin from '../packages/crud-test-plugin/lib/index.js'
import * as patchouli from '../lib/index.js'
import type { MemoryCallMeta, MemoryPluginOutcome } from '../lib/index.js'
import * as storage from '../lib/storage.js'

type DaemonProcess = ChildProcessByStdio<null, null, Readable>

interface ArtifactIngestionValue extends JsonObject {
  artifacts: Array<{
    ref: { type: 'artifact'; id: string }
    role: 'source' | 'attachment'
  }>
}

interface CrudResponse {
  data: Record<string, any>
}

const run = promisify(execFile)
const binary = resolve(
  'target',
  'debug',
  process.platform === 'win32' ? 'patchouli-db.exe' : 'patchouli-db',
)

function callMeta(operation: string): MemoryCallMeta {
  return {
    source: { type: 'crud-test', id: 'database-loop' },
    scope: 'workspace-1',
    attributes: { operation },
  }
}

function valueOf(outcomes: readonly MemoryPluginOutcome<JsonValue>[]): CrudResponse {
  assert.equal(outcomes.length, 1)
  const outcome = outcomes[0]
  assert.ok(outcome)
  assert.equal(outcome.pluginId, 'crud-test')
  if (!outcome.ok) assert.fail(outcome.error)
  return outcome.value as unknown as CrudResponse
}

function successfulValue<T extends JsonValue>(
  outcomes: readonly MemoryPluginOutcome<JsonValue>[],
  pluginId: string,
): T {
  assert.equal(outcomes.length, 1)
  const outcome = outcomes[0]
  assert.ok(outcome)
  assert.equal(outcome.pluginId, pluginId)
  if (!outcome.ok) assert.fail(outcome.error)
  return outcome.value as T
}

async function waitForDaemon(child: DaemonProcess, endpoint: string): Promise<void> {
  let stderr = ''
  child.stderr.setEncoding('utf8')
  await new Promise<void>((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => {
      rejectReady(new Error(`Patchouli daemon did not start at ${endpoint}: ${stderr}`))
    }, 10_000)
    const settle = (callback: () => void): void => {
      clearTimeout(timeout)
      callback()
    }
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
      if (stderr.includes(`Patchouli daemon listening on ${endpoint}`)) {
        settle(resolveReady)
      }
    })
    child.once('error', error => settle(() => rejectReady(error)))
    child.once('exit', code => settle(() => rejectReady(
      new Error(`Patchouli daemon exited before startup with code ${code}: ${stderr}`),
    )))
  })
}

test('storage auto-start initializes a missing default database home', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'patchouli-auto-start-'))
  const endpoint = process.platform === 'win32'
    ? String.raw`\\.\pipe\patchouli-auto-${process.pid}-${randomUUID()}`
    : join(root, 'run', 'patchouli.sock')
  const ctx = new Context()

  t.after(async () => {
    try {
      await run(binary, ['stop', '--endpoint', endpoint])
    } catch {
      // The daemon may already have stopped after a failed assertion.
    }
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })

  await ctx.plugin(storage, {
    endpoint,
    command: binary,
    providerConfigPath: join(root, 'providers.json'),
    backendConfigPath: join(root, 'config.json'),
    artifactRootPath: join(root, 'data', 'artifacts'),
    autoStart: true,
    startupTimeoutMs: 10_000,
  })

  assert.equal(ctx.patchouliStorage.server?.server.version, '0.1.4')
  await assert.doesNotReject(() => readFile(join(root, 'config.json'), 'utf8'))
  await assert.doesNotReject(() => readFile(join(root, 'providers.json'), 'utf8'))
})

test('third-party plugin passes CRUD through the core service to SQLite', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'patchouli-crud-plugin-'))
  const endpoint = process.platform === 'win32'
    ? String.raw`\\.\pipe\patchouli-crud-${process.pid}-${randomUUID()}`
    : join(root, 'run', 'patchouli.sock')
  const config = join(root, 'config.json')
  const providers = join(root, 'providers.json')
  let daemon: DaemonProcess | undefined
  let ctx: Context | undefined

  t.after(async () => {
    await ctx?.fiber.dispose()
    if (daemon?.exitCode === null) {
      try {
        await run(binary, ['stop', '--endpoint', endpoint])
        if (daemon.exitCode === null) await once(daemon, 'exit')
      } catch {
        if (daemon.exitCode === null) {
          daemon.kill()
          await once(daemon, 'exit')
        }
      }
    }
    await rm(root, { recursive: true })
  })

  await run(binary, ['init', '--root', root])
  daemon = spawn(binary, [
    'serve',
    '--endpoint', endpoint,
    '--artifacts', join(root, 'data', 'artifacts'),
    '--providers', providers,
    '--config', config,
  ], {
    cwd: dirname(config),
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  await waitForDaemon(daemon, endpoint)

  ctx = new Context()
  const workspaceRoot = join(root, 'workspace')
  const workspaceBytes = new TextEncoder().encode('workspace artifact through the DSH filesystem')
  const imageBytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])
  const attachments = {
    async readImage(ref: ImageAttachmentRef): Promise<StoredImageAttachment> {
      assert.equal(ref.attachmentId, 'image-e2e-1')
      return { ref, data: imageBytes }
    },
  } as unknown as Context['attachments']
  ctx.provide('attachments', attachments)
  const fs = {
    async resolve(path: string, options: { cwd?: string } = {}): Promise<FsTarget> {
      const displayPath = isAbsolute(path) ? path : join(options.cwd ?? process.cwd(), path)
      return { targetKey: displayPath as FsTarget['targetKey'], displayPath }
    },
    contains(parent: FsTarget, child: FsTarget): boolean {
      const relativePath = relative(parent.targetKey, child.targetKey)
      return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))
    },
    async stat(target: FsTarget): Promise<FsInfo> {
      return target.targetKey === join(workspaceRoot, 'docs', 'design.bin')
        ? {
            type: 'file',
            size: workspaceBytes.byteLength,
            version: 'file-version-1' as FsInfo['version'],
          }
        : { type: 'directory', version: 'directory-version-1' as FsInfo['version'] }
    },
    async readBytes(
      target: FsTarget,
      _signal: AbortSignal | undefined,
      maxBytes: number,
    ): Promise<Uint8Array> {
      assert.equal(target.targetKey, join(workspaceRoot, 'docs', 'design.bin'))
      assert.ok(workspaceBytes.byteLength <= maxBytes)
      return workspaceBytes
    },
  } as unknown as Context['fs']
  ctx.provide('fs', fs)
  await ctx.plugin(patchouli)
  await ctx.plugin(storage, {
    endpoint,
    command: binary,
    providerConfigPath: providers,
    backendConfigPath: config,
    artifactRootPath: join(root, 'data', 'artifacts'),
    autoStart: false,
    startupTimeoutMs: 1_000,
  })
  await ctx.plugin(artifactIngestor, { maxFileBytes: 1_024 * 1_024 })
  await ctx.plugin(crudTestPlugin)

  const knowledge = JSON.parse(await readFile(
    resolve('packages/protocol/schemas/examples/knowledge@1.json'),
    'utf8',
  ))
  const knowledgeRelation = JSON.parse(await readFile(
    resolve('packages/protocol/schemas/examples/knowledge-relation@1.json'),
    'utf8',
  ))
  const artifactFixture = JSON.parse(await readFile(
    resolve('packages/protocol/schemas/examples/artifact-managed@1.json'),
    'utf8',
  ))
  const databaseMeta = {
    workspace_id: 'workspace-1',
    user_id: 'user-1',
    channel_id: 'channel-1',
  }

  const workKnowledgeRef = { type: 'knowledge', id: 'work-knowledge-1' }
  const workRelationRef = { type: 'knowledge_relation', id: 'work-relation-1' }
  const workKnowledge = structuredClone(knowledge)
  workKnowledge.content.text = 'cross-RPC transaction fixture'
  const relation = structuredClone(knowledgeRelation)
  relation.from = [workKnowledgeRef]
  relation.to = [{ type: 'knowledge', id: 'work-source-1' }]
  await ctx.patchouliStorage.runWorkUnit(
    { ...databaseMeta, transaction_id: 'work-unit-e2e-1' },
    { transaction_state: 'commit' },
    [
      meta => ctx.patchouliStorage.create({
        meta,
        data: { ...workKnowledgeRef, value: workKnowledge },
      }),
      async (meta) => {
        await assert.rejects(
          ctx.patchouliStorage.read({ meta: databaseMeta, data: { ref: workKnowledgeRef } }),
          (error) => {
            assert.ok(error instanceof storage.PatchouliRpcError)
            assert.equal(error.reason, 'NOT_FOUND')
            return true
          },
        )
        return ctx.patchouliStorage.create({
          meta,
          data: { ...workRelationRef, value: relation },
        })
      },
    ],
  )
  const [publishedKnowledge, publishedRelation] = await Promise.all([
    ctx.patchouliStorage.read({ meta: databaseMeta, data: { ref: workKnowledgeRef } }),
    ctx.patchouliStorage.read({ meta: databaseMeta, data: { ref: workRelationRef } }),
  ])
  assert.equal(publishedKnowledge.data.state, 'active')
  assert.equal(publishedRelation.data.state, 'active')

  const ref = { type: 'knowledge', id: 'crud-loop-1' }

  const artifactBytes = Uint8Array.from(
    { length: 600_000 },
    (_, index) => index % 251,
  )
  const uploadedArtifact = await ctx.patchouliStorage.uploadArtifact({
    meta: databaseMeta,
    data: {
      id: 'artifact-e2e-1',
      media_type: 'application/octet-stream',
      name: 'artifact.bin',
      expected_byte_length: artifactBytes.byteLength,
      expected_digest: null,
      metadata: artifactFixture.metadata,
    },
  }, artifactBytes)
  assert.equal(uploadedArtifact.data.entity.ref.type, 'artifact')
  assert.equal(uploadedArtifact.data.entity.ref.id, 'artifact-e2e-1')
  if (uploadedArtifact.data.entity.state !== 'active') assert.fail('uploaded artifact is deleted')
  assert.equal(uploadedArtifact.data.entity.value.placement.kind, 'managed')
  const downloadedArtifact = await ctx.patchouliStorage.downloadArtifact(databaseMeta, 'artifact-e2e-1')
  assert.equal(downloadedArtifact.byteLength, artifactBytes.byteLength)
  assert.equal(Buffer.compare(Buffer.from(downloadedArtifact), Buffer.from(artifactBytes)), 0)

  const ingestorCallMeta = {
    source: { type: 'agent-loop', id: 'dsh-patchouli-agent-loop' },
    scope: workspaceRoot,
    attributes: {
      point: 'tool/memory-update',
      sessionId: 'session-file-e2e',
      workspaceRoot,
    },
  }
  const ingestedFile = await ctx.patchouli.update({
    meta: ingestorCallMeta,
    data: {
      resources: [{
        kind: 'workspace-file',
        path: 'docs/design.bin',
        mediaType: 'application/octet-stream',
        role: 'source',
      }],
    },
  })
  const ingestedFileValue = successfulValue<ArtifactIngestionValue>(
    ingestedFile,
    'artifact-ingestor',
  )
  const fileArtifact = ingestedFileValue.artifacts[0]
  assert.ok(fileArtifact)
  assert.equal(fileArtifact.role, 'source')

  const ingestorDatabaseMeta = {
    workspace_id: workspaceRoot,
    user_id: 'agent-loop:dsh-patchouli-agent-loop',
    channel_id: 'session-file-e2e',
  }
  const fileArtifactId = fileArtifact.ref.id
  const downloadedFile = await ctx.patchouliStorage.downloadArtifact(ingestorDatabaseMeta, fileArtifactId)
  assert.equal(Buffer.compare(Buffer.from(downloadedFile), Buffer.from(workspaceBytes)), 0)

  const rejectedFile = await ctx.patchouli.update({
    meta: ingestorCallMeta,
    data: {
      resources: [{ kind: 'workspace-file', path: '/outside/secret.bin' }],
    },
  })
  assert.equal(rejectedFile.length, 1)
  const rejectedOutcome = rejectedFile[0]
  assert.ok(rejectedOutcome)
  if (rejectedOutcome.ok) assert.fail('outside file was unexpectedly ingested')
  assert.match(rejectedOutcome.error, /outside the session workspace/)

  const imageRef = {
    attachmentId: 'image-e2e-1',
    mediaType: 'image/png',
    bytes: imageBytes.byteLength,
    width: 2,
    height: 2,
    name: 'image.png',
  }
  const ingestedImage = await ctx.patchouli.update({
    meta: {
      ...ingestorCallMeta,
      attributes: {
        ...ingestorCallMeta.attributes,
        point: 'session/turn-end',
      },
    },
    data: {
      events: [{
        type: 'user/message',
        data: { content: [{ type: 'image', attachment: imageRef }] },
      }],
    },
  })
  const ingestedImageValue = successfulValue<ArtifactIngestionValue>(
    ingestedImage,
    'artifact-ingestor',
  )
  const imageArtifact = ingestedImageValue.artifacts[0]
  assert.ok(imageArtifact)
  const imageArtifactId = imageArtifact.ref.id
  const downloadedImage = await ctx.patchouliStorage.downloadArtifact(ingestorDatabaseMeta, imageArtifactId)
  assert.equal(Buffer.compare(Buffer.from(downloadedImage), Buffer.from(imageBytes)), 0)

  const created = valueOf(await ctx.patchouli.update({
    meta: callMeta('create'),
    data: {
      meta: databaseMeta,
      data: { type: ref.type, id: ref.id, value: knowledge },
    },
  }))
  assert.equal(created.data.entity.state, 'active')
  assert.deepEqual(created.data.entity.value, knowledge)

  const read = valueOf(await ctx.patchouli.retrieve({
    meta: callMeta('read'),
    data: { meta: databaseMeta, data: { ref } },
  }))
  assert.equal(read.data.state, 'active')
  assert.deepEqual(read.data.variants[0].value, knowledge)

  const retrieved = valueOf(await ctx.patchouli.retrieve({
    meta: callMeta('retrieve'),
    data: {
      meta: databaseMeta,
      data: { query: JSON.stringify({ text: '代码审查' }), types: ['knowledge'], limit: 10 },
    },
  }))
  assert.equal(retrieved.data.hits.length, 1)
  assert.equal(retrieved.data.hits[0].variants[0].ref.id, ref.id)

  const updatedKnowledge = structuredClone(knowledge)
  updatedKnowledge.content.text = '用户偏好直接、简洁的代码审查意见'
  const updated = valueOf(await ctx.patchouli.update({
    meta: callMeta('update'),
    data: {
      meta: { ...databaseMeta, base_versions: [created.data.entity.version] },
      data: { ref, value: updatedKnowledge },
    },
  }))
  assert.equal(updated.data.entity.state, 'active')
  assert.deepEqual(updated.data.entity.value, updatedKnowledge)

  const deleted = valueOf(await ctx.patchouli.update({
    meta: callMeta('delete'),
    data: {
      meta: { ...databaseMeta, base_versions: [updated.data.entity.version] },
      data: { ref },
    },
  }))
  assert.equal(deleted.data.entity.state, 'deleted')

  const readDeleted = valueOf(await ctx.patchouli.retrieve({
    meta: callMeta('read'),
    data: { meta: databaseMeta, data: { ref } },
  }))
  assert.equal(readDeleted.data.state, 'deleted')
  assert.equal(readDeleted.data.variants[0].state, 'deleted')
})
