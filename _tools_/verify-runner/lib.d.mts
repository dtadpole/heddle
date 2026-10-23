/**
 * Types for the shared check helpers, for the one TypeScript test that imports one of them.
 *
 * The helpers are deliberately plain JavaScript — a check file is JavaScript, and this repository's
 * check tooling ships no build step — so the few names a `.ts` test needs are declared here rather
 * than turning the library into two languages. Add a name when a TypeScript test imports one.
 */
export const repoRoot: string

/** The harness under test as `[file, argv]`: `node dist/cli.js` by default, or the binary named by `HEDDLE_BIN`. */
export function heddleCommand(args: readonly string[], env?: NodeJS.ProcessEnv | Record<string, string | undefined>): [string, string[]]

