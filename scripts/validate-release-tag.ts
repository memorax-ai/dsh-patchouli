import { readFileSync } from 'node:fs'

const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as {
  name: string
  version: string
  private?: boolean
}

const manifest = readFileSync(new URL('../Cargo.toml', import.meta.url), 'utf8')
const workspace = manifest.match(/\[workspace\.package\]([\s\S]*?)(?=\n\[|$)/)
const version = workspace?.[1]?.match(/^version\s*=\s*"([^"]+)"/m)?.[1]

if (!version) {
  throw new Error('workspace package version is missing')
}

const expected = `v${version}`
if (process.env.GITHUB_REF_NAME !== expected) {
  throw new Error(`release tag ${process.env.GITHUB_REF_NAME} must equal ${expected}`)
}

const manifests = [
  'package.json',
  'packages/protocol/package.json',
  'packages/db/package.json',
  'packages/agent-loop/package.json',
  'packages/artifact-ingestor/package.json',
  'packages/native-context-service/package.json',
  'packages/session-indexer/package.json',
  'packages/workspace-indexer/package.json',
]

for (const path of manifests) {
  const manifest = readJson(path)
  if (manifest.private) {
    throw new Error(`${manifest.name} must be publishable`)
  }
  if (manifest.version !== version) {
    throw new Error(`${manifest.name} version ${manifest.version} must equal ${version}`)
  }
}
