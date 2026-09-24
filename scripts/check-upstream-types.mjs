import ts from 'typescript'
import { readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
const upstream = resolve(process.argv[2])
const upstreamPackages = new Set(Object.keys(JSON.parse(readFileSync(join(upstream, 'package.json'), 'utf8')).dependencies ?? {}))
const configs = ['tsconfig.json', ...['agent-loop', 'fleet', 'native-context-service', 'session-indexer', 'artifact-ingestor', 'workspace-indexer'].map(name => `packages/${name}/tsconfig.json`), 'packages/memory-ui/tsconfig.client.json']
let errors = 0
for (const path of configs) {
  const configPath = resolve(path)
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, resolve(configPath, '..'), { noEmit: true })
  parsed.options.configFilePath = configPath
  const host = ts.createCompilerHost(parsed.options)
  host.resolveModuleNames = (names, containing) => names.map(name => {
    const packageName = name.split('/').slice(0, 2).join('/')
    const source = upstreamPackages.has(packageName) ? join(upstream, 'probe.ts') : containing
    return ts.resolveModuleName(name, source, parsed.options, host).resolvedModule
  })
  const program = ts.createProgram(parsed.fileNames, parsed.options, host)
  const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)]
  errors += diagnostics.length
  console.log(`${path}: ${diagnostics.length} diagnostics`)
  if (diagnostics.length) console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCurrentDirectory: () => process.cwd(), getCanonicalFileName: name => name, getNewLine: () => '\n' }))
}
if (errors) process.exitCode = 1
