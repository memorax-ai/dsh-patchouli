import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  patchouliDbAsset,
  patchouliDbVersion,
  resolvePatchouliDb,
} from '../lib/index.js'

test('maps supported release assets', () => {
  assert.equal(patchouliDbAsset('linux', 'x64'), 'patchouli-db-linux-x86_64')
  assert.equal(patchouliDbAsset('darwin', 'arm64'), 'patchouli-db-macos-aarch64')
  assert.equal(patchouliDbAsset('win32', 'x64'), 'patchouli-db-windows-x86_64.exe')
  assert.throws(() => patchouliDbAsset('win32', 'arm64'), /does not support win32\/arm64/)
})

test('downloads, verifies, and reuses a cached daemon', async () => {
  const cacheDirectory = await mkdtemp(join(tmpdir(), 'patchouli-db-test-'))
  const asset = patchouliDbAsset('linux', 'x64')
  const bytes = Buffer.from('test-patchouli-daemon')
  const checksum = createHash('sha256').update(bytes).digest('hex')
  let requests = 0
  const server = createServer((request, response) => {
    requests += 1
    if (request.url === `/v${patchouliDbVersion}/${asset}.sha256`) {
      response.end(`${checksum}  ${asset}\n`)
      return
    }
    if (request.url === `/v${patchouliDbVersion}/${asset}`) {
      response.end(bytes)
      return
    }
    response.writeHead(404).end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address === 'object')

  try {
    const options = {
      cacheDirectory,
      releaseBaseUrl: `http://127.0.0.1:${address.port}`,
      platform: 'linux' as const,
      arch: 'x64',
    }
    const first = await resolvePatchouliDb(options)
    const second = await resolvePatchouliDb(options)
    assert.equal(second, first)
    assert.deepEqual(await readFile(first), bytes)
    assert.equal(requests, 2)
  } finally {
    server.close()
    await rm(cacheDirectory, { recursive: true, force: true })
  }
})
