import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

test('records a multi-source GOOJFC recall through Agent Loop aggregation', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'patchouli-recall-demo-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const output = join(root, 'report.json')
  const html = join(root, 'report.html')
  const stdout = execFileSync(process.execPath, [
    new URL('../scripts/demo-multi-source-recall.ts', import.meta.url).pathname,
    '--output',
    output,
    '--html',
    html,
  ], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
  })
  const report = JSON.parse(readFileSync(output, 'utf8'))

  assert.match(stdout, /Patchouli recalled 3 sources/)
  assert.match(stdout, /Frontend:/)
  assert.equal(existsSync(html), true)
  assert.match(readFileSync(html, 'utf8'), /mneme/)
  assert.match(readFileSync(html, 'utf8'), /memory-gate/)
  assert.match(readFileSync(html, 'utf8'), /lingshu/)
  assert.equal(report.mode, 'deterministic-native-adapter-demo')
  assert.deepEqual(report.recall.sourceIds, ['mneme', 'memory-gate', 'lingshu'])
  assert.equal(report.recall.envelope.kind, 'patchouli-memory-results')
  assert.equal(report.recall.envelope.point, 'agent/pre-step')
  assert.equal(report.recall.envelope.results.length, 3)
  assert.equal(report.updates.length, 3)
  for (const update of report.updates) {
    assert.deepEqual(
      update.outcomes.map((outcome: { pluginId: string; ok: boolean }) => [outcome.pluginId, outcome.ok]),
      [['mneme', true], ['memory-gate', true], ['lingshu', true]],
    )
  }
})
