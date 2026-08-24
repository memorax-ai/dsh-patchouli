# patchouli-db

Platform-aware installer and launcher for the native Patchouli database daemon.
It downloads the binary matching the package version from the Patchouli GitHub
release, verifies its SHA-256 checksum, and caches it under `~/.patchouli/bin`.
No npm lifecycle scripts are required.

```bash
npx patchouli-db --help
```

Applications can resolve the native executable directly:

```js
import { resolvePatchouliDb } from 'patchouli-db'

const executable = await resolvePatchouliDb()
```
