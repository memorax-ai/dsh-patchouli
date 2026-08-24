import { createHash, randomUUID } from 'node:crypto'
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

const repository = 'memorax-ai/dsh-patchouli'
const manifest = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
) as { readonly version: string }

export const patchouliDbVersion = manifest.version

export interface ResolvePatchouliDbOptions {
  /** Override the persistent binary cache. */
  readonly cacheDirectory?: string
  /** Override the GitHub release download root, primarily for mirrors and tests. */
  readonly releaseBaseUrl?: string
  /** Override platform detection, primarily for tests. */
  readonly platform?: NodeJS.Platform
  /** Override architecture detection, primarily for tests. */
  readonly arch?: string
  /** Override the Fetch implementation, primarily for tests. */
  readonly fetch?: typeof globalThis.fetch
}

/** Return the GitHub release asset for one supported Node platform pair. */
export function patchouliDbAsset(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const key = `${platform}-${arch}`
  const assets: Readonly<Record<string, string>> = {
    'linux-x64': 'patchouli-db-linux-x86_64',
    'linux-arm64': 'patchouli-db-linux-aarch64',
    'darwin-x64': 'patchouli-db-macos-x86_64',
    'darwin-arm64': 'patchouli-db-macos-aarch64',
    'win32-x64': 'patchouli-db-windows-x86_64.exe',
  }
  const asset = assets[key]
  if (!asset) {
    throw new Error(`dsh-patchouli-db does not support ${platform}/${arch}`)
  }
  return asset
}

/** Download, verify, cache, and return the native Patchouli daemon path. */
export async function resolvePatchouliDb(
  options: ResolvePatchouliDbOptions = {},
): Promise<string> {
  const asset = patchouliDbAsset(options.platform, options.arch)
  const executableName = asset.endsWith('.exe') ? 'patchouli-db.exe' : 'patchouli-db'
  const cacheDirectory = options.cacheDirectory
    ?? join(homedir(), '.patchouli', 'bin', `v${patchouliDbVersion}`)
  const executablePath = join(cacheDirectory, executableName)
  const checksumPath = `${executablePath}.sha256`

  const cachedChecksum = await readChecksum(checksumPath)
  if (cachedChecksum && await matchesChecksum(executablePath, cachedChecksum)) {
    return executablePath
  }

  const baseUrl = (options.releaseBaseUrl
    ?? `https://github.com/${repository}/releases/download`).replace(/\/$/, '')
  const assetUrl = `${baseUrl}/v${patchouliDbVersion}/${asset}`
  const fetcher = options.fetch ?? globalThis.fetch
  const checksum = await downloadChecksum(fetcher, `${assetUrl}.sha256`, asset)
  const response = await fetcher(assetUrl)
  if (!response.ok) {
    throw new Error(`failed to download ${assetUrl}: HTTP ${response.status}`)
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  const actualChecksum = createHash('sha256').update(bytes).digest('hex')
  if (actualChecksum !== checksum) {
    throw new Error(
      `checksum mismatch for ${asset}: expected ${checksum}, received ${actualChecksum}`,
    )
  }

  await mkdir(cacheDirectory, { recursive: true, mode: 0o700 })
  const temporaryPath = `${executablePath}.${randomUUID()}.tmp`
  const temporaryChecksumPath = `${checksumPath}.${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, bytes, { mode: 0o700, flag: 'wx' })
    if (process.platform !== 'win32') await chmod(temporaryPath, 0o700)
    await installCacheFile(
      temporaryPath,
      executablePath,
      () => matchesChecksum(executablePath, checksum),
    )
    await writeFile(temporaryChecksumPath, `${checksum}\n`, { mode: 0o600, flag: 'wx' })
    await installCacheFile(
      temporaryChecksumPath,
      checksumPath,
      async () => await readChecksum(checksumPath) === checksum,
    )
  } finally {
    await Promise.all([
      rm(temporaryPath, { force: true }),
      rm(temporaryChecksumPath, { force: true }),
    ])
  }
  return executablePath
}

async function downloadChecksum(
  fetcher: typeof globalThis.fetch,
  url: string,
  asset: string,
): Promise<string> {
  const response = await fetcher(url)
  if (!response.ok) {
    throw new Error(`failed to download ${url}: HTTP ${response.status}`)
  }
  const input = await response.text()
  const match = input.match(/^([a-fA-F0-9]{64})(?:\s+\*?(.+))?\s*$/)
  if (!match?.[1]) throw new Error(`invalid checksum response from ${url}`)
  if (match[2] && match[2] !== asset) {
    throw new Error(`checksum response from ${url} names unexpected asset ${match[2]}`)
  }
  return match[1].toLowerCase()
}

async function readChecksum(path: string): Promise<string | undefined> {
  try {
    const value = (await readFile(path, 'utf8')).trim().toLowerCase()
    return /^[a-f0-9]{64}$/.test(value) ? value : undefined
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return
    throw error
  }
}

async function matchesChecksum(path: string, checksum: string): Promise<boolean> {
  try {
    const bytes = await readFile(path)
    return createHash('sha256').update(bytes).digest('hex') === checksum
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return false
    throw error
  }
}

async function installCacheFile(
  temporaryPath: string,
  destinationPath: string,
  destinationIsValid: () => Promise<boolean>,
): Promise<void> {
  try {
    await rename(temporaryPath, destinationPath)
  } catch (error) {
    if (!hasCode(error, 'EEXIST') && !hasCode(error, 'EPERM')) throw error
    if (await destinationIsValid()) return
    await rm(destinationPath, { force: true })
    await rename(temporaryPath, destinationPath)
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error
    && 'code' in error
    && String(error.code) === code
}
