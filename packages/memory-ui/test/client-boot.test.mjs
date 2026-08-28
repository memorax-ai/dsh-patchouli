import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'

const requireNode = createRequire(import.meta.url)
const packageRoots = [new URL('../', import.meta.url)]

test('boots the self-contained Memory UI bundle', async () => {
  const packages = await Promise.all(packageRoots.map(async (root) => ({
    root,
    manifest: JSON.parse(await readFile(new URL('package.json', root), 'utf8')),
  })))
  const factories = new Map()
  const cache = new Map()
  const sandbox = {
    console,
    window: {
      __ModuleLoader__: {
        load(handoff) {
          assert.equal(factories.has(handoff.id), false)
          factories.set(handoff.id, handoff.factory)
        },
      },
    },
  }

  async function arrive(pkg) {
    const source = await readFile(new URL('lib/client.js', pkg.root), 'utf8')
    vm.runInNewContext(source, sandbox, { filename: `${pkg.manifest.name}/client.js` })
  }

  const seeds = new Map([
    ['react', requireNode('react')],
    ['react/jsx-runtime', requireNode('react/jsx-runtime')],
    ['@deepseek-ai/dsh-client-ui-primitives', {}],
  ])
  function materialize(specifier) {
    if (seeds.has(specifier)) return seeds.get(specifier)
    const id = specifier.replace(/\/client$/, '')
    if (cache.has(id)) return cache.get(id)
    const factory = factories.get(id)
    assert.ok(factory, `client factory ${id} must arrive before synchronous require`)
    const exports = factory(materialize)
    cache.set(id, exports)
    return exports
  }

  for (const pkg of packages.filter(({ manifest }) => manifest.dsh.client.immediately === true)) {
    await arrive(pkg)
  }
  const memoryUi = packages.find(({ manifest }) => (
    manifest.name === 'dsh-patchouli-memory-ui'
  ))
  assert.ok(memoryUi)
  await arrive(memoryUi)

  const plugin = materialize('dsh-patchouli-memory-ui')

  assert.deepEqual([...factories.keys()], ['dsh-patchouli-memory-ui'])
  assert.equal(plugin.name, 'dsh-patchouli-memory-ui')
})
