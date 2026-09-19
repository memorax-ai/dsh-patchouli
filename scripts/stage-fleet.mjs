import { cpSync } from 'node:fs'

// Ship the internal adapter with the root plugin instead of requiring an unpublished package.
cpSync(new URL('../packages/fleet/lib/', import.meta.url), new URL('../lib/fleet/', import.meta.url), { recursive: true })
