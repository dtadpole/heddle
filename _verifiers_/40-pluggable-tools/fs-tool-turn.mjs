// Shared by this part's filesystem-tool checks (check-list-errors, check-list-links, check-read-errors and
// check-write-errors): a self-contained profile that allows one built-in tool with the sandbox open and approvals on
// allow, and one scripted turn whose model calls that tool once. It is not a check itself; verify.sh runs check*.mjs.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { isolatedHome, readTranscript, removeDir, repoRoot, runCli, scriptedConfig, sessionsUnder } from '../../_tools_/verify-runner/lib.mjs'

/** Write a profile under `home` whose tools row allows only `tool`; return its folder. */
export function toolProfile(home, label, tool) {
  const dir = join(home, `${label}-profile`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  writeFileSync(
    join(dir, 'heddle.patch.yml'),
    `- insert:
    - id: console
      name: ${repoRoot}/src/plugins/console-exporter.ts
    - id: session
      name: ${repoRoot}/src/plugins/session.ts
      config:
        root: ${join(home, 'sessions')}
    - id: model
      name: ${repoRoot}/src/plugins/model.ts
    - id: context
      name: ${repoRoot}/src/context/service.ts
      inject: [model, session]
      config:
        contextWindow: 200000
    - id: sandbox
      name: ${repoRoot}/src/sandbox/service.ts
      config:
        mode: danger-full-access
        workspaceRoot: ${home}
    - id: approvals
      name: ${repoRoot}/src/approvals/service.ts
      config:
        mode: allow
    - id: tools
      name: ${repoRoot}/src/plugins/tools.ts
      inject: [approvals, sandbox]
      config:
        allow: [${tool}]
`,
  )
  return dir
}

/**
 * Run one turn in a fresh isolated home whose model calls `tool` once with `args(home)`, after `layout(home)` shapes the
 * home. Return the tool results as text, the arguments the model sent, and what `inspect(home)` saw on disk afterwards,
 * before the home is removed.
 *
 * A refused call is a denial, which a `--turn` run reports with exit 1, so by default exit 0 or 1 is accepted and the
 * transcript is the verdict; `exits` narrows that for a check whose call must succeed.
 */
export async function oneToolCall({ label, tool, args, layout = () => {}, inspect = () => undefined, exits = [0, 1] }) {
  const home = isolatedHome(label)
  try {
    layout(home)
    const sent = args(home)
    const { config } = scriptedConfig({ home, steps: [{ toolCall: { name: tool, arguments: sent } }, { text: 'done' }] })
    const run = await runCli(['--profile', toolProfile(home, label, tool), '--sandbox-root', home, '--turn', `call ${tool}`], {
      env: { HOME: home, HEDDLE_HOME: join(home, '.heddle'), HEDDLE_CONFIG: config },
    })
    assert.ok(exits.includes(run.code), `the turn ran (exit ${run.code}, expected ${exits.join(' or ')})\n${run.stdout}${run.stderr}`)
    const session = sessionsUnder(join(home, 'sessions'))[0]
    const results = readTranscript(join(home, 'sessions', session))
      .filter((event) => event.type === 'message' && event.message?.role === 'tool')
      .map((event) => (event.message.content ?? []).map((part) => part.text ?? '').join(''))
    return { results, args: sent, disk: inspect(home) }
  } finally {
    removeDir(home)
  }
}
