import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const memoryRoot = '../src/client/'

test('declares a self-contained DSH web client bundle', async () => {
  assert.equal(packageJson.dsh.plugin.schemaVersion, 1)
  assert.equal(packageJson.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(packageJson.exports['./package.json'], './package.json')
  assert.equal(packageJson.exports['./client'].default, './lib/client.js')
  assert.equal(packageJson.dsh.client.platform, 'web')
  assert.ok(packageJson.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-primitives'))
  assert.ok(!packageJson.dsh.client.inject.includes('@ch4acko3/dsh-ui-container'))
  assert.ok(!packageJson.dsh.client.inject.includes('@ch4acko3/dsh-ui-workspace'))

  const bundle = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(bundle, /window\.__ModuleLoader__\.load/)
  assert.match(bundle, /id:\s*["']dsh-patchouli-memory-ui["']/)
  assert.doesNotMatch(bundle, /require\(["']@memorax-agent\//)
  assert.doesNotMatch(bundle, /@ch4acko3\/dsh-ui-(?:container|workspace)/)
})

test('mounts the memory page inside recursive visual surface boundaries', async () => {
  const memory = await readFile(new URL(`${memoryRoot}KnowledgeView.tsx`, import.meta.url), 'utf8')

  assert.match(memory, /<SurfaceHost/)
  assert.match(memory, /id="workspace"/)
  assert.match(memory, /id="explorer"/)
  assert.match(memory, /id="editor"/)
})

test('owns its document container and workspace modules', async () => {
  const memory = await readFile(new URL(`${memoryRoot}index.tsx`, import.meta.url), 'utf8')

  assert.equal(packageJson.peerDependencies['@ch4acko3/dsh-ui-container'], undefined)
  assert.equal(packageJson.peerDependencies['@ch4acko3/dsh-ui-workspace'], undefined)
  assert.equal(packageJson.devDependencies['@ch4acko3/dsh-ui-container'], undefined)
  assert.equal(packageJson.devDependencies['@ch4acko3/dsh-ui-workspace'], undefined)
  assert.match(memory, /installUiContainer\(ctx\)/)
  assert.match(memory, /connectSurface\(\{ id: 'patchouli\.memory' \}\)/)
  assert.match(memory, /name: 'conversation\.view'/)
})

test('publishes Patchouli-specific filter and renderer registries', async () => {
  const filters = await readFile(new URL(`${memoryRoot}filters.tsx`, import.meta.url), 'utf8')
  const slots = await readFile(new URL(`${memoryRoot}document-slots.ts`, import.meta.url), 'utf8')

  assert.match(filters, /class FilterRegistry/)
  assert.match(slots, /'patchouli\.document\.renderer'/)
})

test('binds cached memory UI layout to the Harness session id', async () => {
  const cache = await readFile(new URL(`${memoryRoot}session-layout.ts`, import.meta.url), 'utf8')
  const view = await readFile(new URL(`${memoryRoot}KnowledgeView.tsx`, import.meta.url), 'utf8')

  assert.match(cache, /STORAGE_PREFIX.*session-layout/)
  assert.match(cache, /STORAGE_PREFIX}\$\{sessionId}/)
  assert.match(cache, /openDocuments/)
  assert.match(cache, /openDocumentUris/)
  assert.match(cache, /previewDocumentUri/)
  assert.match(cache, /agentWidth/)
  assert.match(cache, /explorerPanes/)
  assert.match(cache, /treeExpanded/)
  assert.match(cache, /searchHistory/)
  assert.match(view, /SessionKnowledgeView key=\{String\(props\.sessionId\)}/)
})

test('cascades main pane resizing across adjacent minimum widths', async () => {
  const view = await readFile(new URL(`${memoryRoot}KnowledgeView.tsx`, import.meta.url), 'utf8')
  const styles = await readFile(new URL(`${memoryRoot}styles.ts`, import.meta.url), 'utf8')

  assert.match(view, /function resizeExplorerPanes/)
  assert.match(view, /start\.editor - EDITOR_MIN/)
  assert.match(view, /start\.agent - AGENT_MIN/)
  assert.match(view, /start\.explorer - EXPLORER_MIN/)
  assert.match(styles, /@container \(max-width: 740px\)/)
  assert.match(styles, /flex-direction: column/)
  assert.match(styles, /overflow-y: auto/)
})

test('keeps the custom filter popover keyboard accessible', async () => {
  const view = await readFile(new URL(`${memoryRoot}KnowledgeView.tsx`, import.meta.url), 'utf8')

  assert.match(view, /position\.visibility === 'hidden'/)
  assert.match(view, /closeButtonRef\.current\?\.focus\(\)/)
  assert.match(view, /event\.key !== 'Escape'/)
  assert.match(view, /anchorRef\.current\?\.focus\(\)/)
})

test('provides a localized search field with session history', async () => {
  const search = await readFile(new URL(`${memoryRoot}KnowledgeSearch.tsx`, import.meta.url), 'utf8')
  const locales = await readFile(new URL(`${memoryRoot}locales.ts`, import.meta.url), 'utf8')

  assert.match(search, /role="search"/)
  assert.match(search, /patchouli-search-history/)
  assert.match(search, /HISTORY_LIMIT = 8/)
  assert.match(search, /event\.key !== 'Escape'/)
  assert.match(locales, /'search\.history': '搜索历史'/)
  assert.match(locales, /'search\.history': 'Search history'/)
})

test('publishes scoped theme configuration', async () => {
  const theme = await readFile(new URL(`${memoryRoot}theme.ts`, import.meta.url), 'utf8')
  const styles = await readFile(new URL(`${memoryRoot}styles.ts`, import.meta.url), 'utf8')

  assert.match(theme, /patchouliTheme/)
  assert.match(theme, /PatchouliThemeConfig/)
  assert.match(theme, /browse\?: PatchouliTheme/)
  assert.match(theme, /edit\?: PatchouliTheme/)
  assert.match(theme, /surfaceRaised/)
  assert.match(theme, /accentMuted/)
  assert.match(theme, /reset\(\): void/)
  assert.match(theme, /\.\.\.config\.browse, \.\.\.config\.edit/)
  assert.doesNotMatch(styles, /data-mode='browse'/)
})

test('guards the first edit-mode activation for each plugin version', async () => {
  const consent = await readFile(new URL(`${memoryRoot}edit-mode-consent.ts`, import.meta.url), 'utf8')
  const toggle = await readFile(new URL(`${memoryRoot}EditModeSwitch.tsx`, import.meta.url), 'utf8')
  const buildInfo = await readFile(new URL(`${memoryRoot}build-info.ts`, import.meta.url), 'utf8')
  const version = buildInfo.match(/PATCHOULI_VERSION = '([^']+)'/)?.[1]

  assert.equal(version, packageJson.version)
  assert.match(consent, /edit-mode-consent\/\$\{PATCHOULI_VERSION}/)
  assert.match(toggle, /role="switch"/)
  assert.match(toggle, /aria-checked=\{enabled}/)
  assert.match(toggle, /<Modal/)
})

test('keeps preview display text in the locale dictionaries', async () => {
  const data = await readFile(new URL(`${memoryRoot}preview-data.ts`, import.meta.url), 'utf8')
  const locales = await readFile(new URL(`${memoryRoot}locales.ts`, import.meta.url), 'utf8')

  assert.doesNotMatch(data, /title:\s*['"]/)
  assert.doesNotMatch(data, /summary:\s*['"]/)
  assert.match(locales, /'preview\.document\.uiFramework\.title'/)
  assert.match(locales, /'preview\.tree\.productDesign'/)
})
