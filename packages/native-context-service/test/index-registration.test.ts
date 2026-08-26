import assert from 'node:assert/strict'
import test from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import * as patchouli from 'dsh-patchouli'
import type { PatchouliStorageService } from 'dsh-patchouli/storage'

import {
  ArtifactIndexModule,
  GitIndexModule,
  ProjectIndexModule,
  SessionIndex,
  StandardRetrieveModule,
  WorkspaceIndexModule,
  inject,
} from '../lib/index.js'
import * as nativeContext from '../lib/index.js'

test('declares only Patchouli as a required service', () => {
  assert.deepEqual(inject, ['patchouli'])
})

test('loads without optional source services and leaves their indexes absent', async (t) => {
  const ctx = new Context()
  const patchouliFiber = await ctx.plugin(patchouli)
  const nativeFiber = await ctx.plugin(nativeContext)
  t.after(async () => {
    await nativeFiber.dispose()
    await patchouliFiber.dispose()
  })

  for (const id of ['session', 'workspace', 'project', 'artifact', 'git']) {
    assert.throws(() => ctx.nativeContext.getIndex(id), /is not registered/)
  }
})

test('registers indexes from available services and removes coupled indexes with their source', async (t) => {
  const ctx = new Context()
  const patchouliFiber = await ctx.plugin(patchouli)
  const disposeSessionQuery = ctx.provide('sessionQuery', {} as SessionQueryEngine)
  const disposeFs = ctx.provide('fs', {} as FileSystem)
  const disposeWorkspaceRegistry = ctx.provide('workspaceRegistry', {} as WorkspaceRegistry)
  const disposeStorage = ctx.provide('patchouliStorage', {} as PatchouliStorageService)
  const disposeLlm = ctx.provide('llm', {} as LlmRuntime)
  const nativeFiber = await ctx.plugin(nativeContext)
  t.after(async () => {
    await nativeFiber.dispose()
    await disposeLlm()
    await disposeStorage()
    await disposeWorkspaceRegistry()
    await disposeFs()
    await disposeSessionQuery()
    await patchouliFiber.dispose()
  })

  assert.ok(ctx.nativeContext.getIndex('session') instanceof SessionIndex)
  assert.ok(ctx.nativeContext.getIndex('workspace') instanceof WorkspaceIndexModule)
  assert.ok(ctx.nativeContext.getIndex('project') instanceof ProjectIndexModule)
  assert.ok(ctx.nativeContext.getIndex('artifact') instanceof ArtifactIndexModule)
  assert.ok(ctx.nativeContext.getIndex('git') instanceof GitIndexModule)
  assert.ok(ctx.nativeContext.getRetriever('standard') instanceof StandardRetrieveModule)

  await disposeWorkspaceRegistry()
  assert.throws(() => ctx.nativeContext.getIndex('workspace'), /is not registered/)
  assert.throws(() => ctx.nativeContext.getIndex('project'), /is not registered/)
  assert.throws(() => ctx.nativeContext.getIndex('git'), /is not registered/)
  assert.ok(ctx.nativeContext.getIndex('session') instanceof SessionIndex)
  assert.ok(ctx.nativeContext.getIndex('artifact') instanceof ArtifactIndexModule)
})
