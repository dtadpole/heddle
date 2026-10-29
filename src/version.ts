import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * heddle's release version: the `version` of its `package.json`.
 *
 * DSH reports its release in three places — `dsh -V` / `--version` prints it and exits, Settings General ends with
 * "Current version: {version}", and the host announces it to the page — and heddle reported it nowhere (DSH parity
 * S72 and S74). This is the one value the CLI's `--version`, `/healthz` and the page's Settings row read.
 *
 * Read from the package file rather than written here, so a release changes one place. The file is one directory up
 * from both `src/` and `dist/`, so the source and the build find the same file.
 */
export const HEDDLE_VERSION: string = (() => {
  try {
    const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as { version?: unknown }
    return typeof manifest.version === 'string' && manifest.version.length > 0 ? manifest.version : 'unknown'
  } catch {
    return 'unknown'
  }
})()
