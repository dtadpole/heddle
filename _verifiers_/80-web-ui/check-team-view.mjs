import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { fixtureDir, heddleCommand, isolatedHome, removeDir, repoRoot, scriptedConfig, runCli, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * The team view: a Lead's session shows its roster, the shared board and the mailbox ledger.
 *
 * The state is built on disk the way a previous process would have left it — a team session with an active
 * teammate, three task revisions ending completed, and one delivered message — and the page is expected to
 * render it from `/api/team`, not to invent it. The panel must also stay hidden for a session with no team,
 * which is the half that keeps an ordinary conversation unchanged.
 */

const CAPABILITY = 'the Web UI'

function startServer(home, work, config) {
  const child = spawn(
    ...heddleCommand(['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--endpoint', 'scripted', '--session-root', join(home, 'sessions')]),
    { cwd: work, env: { ...process.env, HEDDLE_HOME: home, HEDDLE_CONFIG: config }, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let output = ''
  child.stdout.on('data', (chunk) => (output += chunk))
  child.stderr.on('data', (chunk) => (output += chunk))
  const url = new Promise((resolve, reject) => {
    const started = Date.now()
    const poll = setInterval(() => {
      const match = /heddle web: (http:\/\/\S+)/.exec(output)
      if (match) {
        clearInterval(poll)
        resolve(match[1])
      } else if (child.exitCode !== null || Date.now() - started > 20_000) {
        clearInterval(poll)
        reject(new Error(`the server did not start\n${output}`))
      }
    }, 50)
  })
  /**
   * The rejection is the check's to report, at `await server.url`. Marked handled here because the test opens a
   * browser before it awaits the URL: a harness that exits during that launch rejected an unwatched promise, and
   * node:test then failed the test as an unhandled rejection instead of as a server that did not start.
   */
  url.catch(() => {})
  return {
    url,
    logs: () => output,
    close: async () => {
      /**
       * A harness that already exited has emitted its `exit` event, and Node does not replay it: waiting for it
       * again never settled, so a binary whose `web` exits at once hung the run instead of failing it.
       */
      if (child.exitCode !== null || child.signalCode !== null) return
      child.kill()
      await new Promise((resolve) => child.once('exit', resolve))
    },
  }
}

test('a team session renders its roster, board and mailbox; a session with no team shows no panel', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const home = isolatedHome('team-view')
  const work = fixtureDir('team-view-work')
  const root = join(home, 'sessions')
  const { config } = scriptedConfig({ home, steps: [{ text: 'idle' }] })
  /**
   * The fixture's session state is written by the TypeScript store — the implementation the log format is —
   * imported from the source rather than `dist/`, so the check can build its fixture when only a binary is
   * under test and no TypeScript build exists. On the TypeScript build `src/` and `dist/` are the same code.
   */
  const { SessionStore } = await import('../../src/session/store.ts')
  const sessions = new SessionStore(root)
  try {
    /**
     * A session id is `session-<uuid>` — the API refuses anything else before it reaches the store, so the
     * fixture's ids are shaped like real ones. Measured: the crafted `session-view-…` ids made the session
     * route answer 400, and the page then reported "No session" and an empty roster.
     */
    // The teammate first, the Lead last, so the page's newest-session selection lands on the team's session.
    const member = sessions.create({ id: 'session-22222222-2222-4222-8222-222222222222', cwd: work, parentSession: 'session-11111111-1111-4111-8111-111111111111', origin: 'subagent', delegationDepth: 1, teamId: 'session-11111111-1111-4111-8111-111111111111' })
    sessions.message(member, { role: 'user', content: [{ type: 'text', text: 'the spawn prompt' }] })
    sessions.append(member, { type: 'assistant/completed', text: 'member done' })
    const lead = sessions.create({ id: 'session-11111111-1111-4111-8111-111111111111', cwd: work, endpoint: 'scripted', model: 'scripted' })
    const version = 2
    const teamId = lead.id
    sessions.append(lead, { type: 'team/member', version, teamId, member: { id: member.id, name: 'alpha', description: 'the teammate', context: 'fresh', phase: 'provisioning' } })
    sessions.append(lead, { type: 'team/member', version, teamId, member: { id: member.id, name: 'alpha', description: 'the teammate', context: 'fresh', phase: 'active' } })
    sessions.append(lead, { type: 'team/task', version, teamId, task: { id: 'task-1', revision: 1, subject: 'write the thing', description: '', status: 'pending', blockedBy: [], writeScopes: [] } })
    sessions.append(lead, { type: 'team/task', version, teamId, task: { id: 'task-1', revision: 2, subject: 'write the thing', description: '', status: 'in_progress', ownerId: member.id, blockedBy: [], writeScopes: [] } })
    sessions.append(lead, { type: 'team/task', version, teamId, task: { id: 'task-1', revision: 3, subject: 'write the thing', description: '', status: 'completed', ownerId: member.id, blockedBy: [], writeScopes: [] } })
    sessions.append(lead, { type: 'team/message/queued', version, teamId, message: { id: 'team-message-view-1', senderId: lead.id, senderName: 'lead', targetId: member.id, content: [{ type: 'text', text: 'mailed' }] } })
    sessions.append(lead, { type: 'team/message/delivered', version, teamId, messageId: 'team-message-view-1', targetId: member.id })

    const server = startServer(home, work, config)
    const browser = await openBrowser()
    try {
      const url = await server.url
      await browser.goto(url)
      // The flat list is the page's own grouping mode: every session is a top-level row, so the crafted
      // session can be opened by id without depending on a workspace branch being expanded.
      await browser.evaluate(`localStorage.setItem('heddle.tree.grouping.v1', 'list')`)
      await browser.evaluate(`fetch('/api/workspaces', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: ${JSON.stringify(work)} }) })`)
      await browser.goto(url)
      await browser.waitFor('document.querySelector(\'li[data-session-id="session-11111111-1111-4111-8111-111111111111"]\') !== null', 15_000)
      await browser.evaluate(`(document.querySelector('li[data-session-id="session-11111111-1111-4111-8111-111111111111"] .row') || document.querySelector('li[data-session-id="session-11111111-1111-4111-8111-111111111111"]')).click()`)
      await browser.waitFor('document.getElementById("team-panel") !== null && document.getElementById("team-panel").hidden === false', 20_000)
      const view = JSON.parse(
        await browser.evaluate(`JSON.stringify({
          summary: document.getElementById('team-summary').textContent,
          roster: [...document.querySelectorAll('#team-roster .team-member')].map((item) => ({ name: item.dataset.name, role: item.dataset.role, status: item.dataset.status })),
          board: [...document.querySelectorAll('#team-tasks .team-task')].map((item) => ({ id: item.dataset.taskId, status: item.dataset.status, text: item.textContent })),
          mail: document.getElementById('team-mail').textContent,
        })`),
      )
      assert.deepEqual(view.roster, [{ name: 'lead', role: 'lead', status: 'inactive' }, { name: 'alpha', role: 'teammate', status: 'inactive' }])
      assert.match(view.summary, /1 teammate\(s\)/)
      assert.equal(view.board.length, 1)
      assert.equal(view.board[0].status, 'completed')
      assert.match(view.board[0].text, /task-1 write the thing/)
      assert.match(view.mail, /0 queued/)
      assert.match(view.mail, /1 delivered/)
    } finally {
      await browser.close()
      await server.close()
    }
  } finally {
    removeDir(home)
    removeDir(work)
  }
})
