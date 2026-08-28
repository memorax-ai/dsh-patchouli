import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const memoryUi = JSON.parse(await readFile(
  new URL('../packages/memory-ui/package.json', import.meta.url),
  'utf8',
))
const protocol = JSON.parse(await readFile(
  new URL('../packages/protocol/package.json', import.meta.url),
  'utf8',
))

test('keeps DSH plugin manifests at their owning package boundaries', () => {
  assert.equal(root.dsh.plugin.schemaVersion, 1)
  assert.equal(root.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(root.dsh.client, undefined)
  assert.equal(root.exports['./client'], undefined)

  assert.equal(memoryUi.private, undefined)
  assert.equal(memoryUi.dsh.plugin.schemaVersion, 1)
  assert.equal(memoryUi.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(memoryUi.exports['./client'].default, './lib/client.js')
})

test('does not advertise ordinary libraries as DSH plugins', () => {
  assert.equal(protocol.dsh, undefined)
})
