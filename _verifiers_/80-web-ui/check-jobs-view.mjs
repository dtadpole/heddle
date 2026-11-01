import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { fixtureDir, heddleCommand, isolatedHome, readTranscript, removeDir, repoRoot, runCli, scriptedConfig, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * The session header's background-jobs control (row A56), judged where a model starts a background job and a person
 * watches and stops it.
 *
 * The claim is DSH's (`dsh-client-ui-jobs/lib/client.js`): the header's actions carry a control that renders nothing
 * while the session sees no job (:407); its trigger reads `1 background job running` while a job is live (:408,
 * :569); its popover (`ul aria-label="Background jobs"`) lists the job under `Running` with the command as its label;
 * expanding the row streams the job's live output and collapsing it stops the stream (:359-368); watching never takes
 * output from the model, because the follow route does not move the model's cursor (the next `job_output` still
 * returns the early lines); the two-press stop arms `Click again to confirm` / `Confirm stop` and then kills
 * (:375-406); the killed row moves to `Finished` with the word `cancelled`; Escape closes the popover and gives the
 * trigger focus back (:417-425).
 *
 * A second test archives, from the row's quick action, a session whose background job still runs: the route refuses
 * it as active and names the job (DSH's job archive admission, `dsh-jobs/lib/index.js:19-43`), the page's
 * stop-and-archive dialog lists it, Cancel leaves the session and the job as they were, and Stop and archive archives the
 * session and kills the job with `session archived`.
 *
 * Every UI step is followed by a read of `/api/jobs` from Node, with the page's cookie: a view that repaints without the
 * server agreeing is the failure this exists to catch. The follow requests are counted through the page's own `fetch`.
 * The check is gated on the Web command and on a browser, **never** on the jobs capability, so a page or a server
 * without the control fails it rather than skipping it. Every model step comes from the offline scripted endpoint.
 */
const CAPABILITY = 'the Web UI'

/** About 60 s of one line every 0.3 s: long enough to watch, expand, collapse and stop while it runs. */
const LOOP = 'for i in $(seq 1 200); do echo "tick $i"; sleep 0.3; done'

async function startServer() {
  const home = isolatedHome('jobs-view')
  const work = fixtureDir('jobs-view-work')
  mkdirSync(work, { recursive: true })
  const { config, script } = scriptedConfig({ home, steps: [{ text: 'idle' }] })
  const child = spawn(
    ...heddleCommand(['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--endpoint', 'scripted', '--session-root', join(home, 'sessions')]),
    { cwd: work, env: { ...process.env, NO_COLOR: '1', HEDDLE_HOME: home, HEDDLE_CONFIG: config }, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let out = ''
  child.stdout.on('data', (chunk) => { out += chunk })
  child.stderr.on('data', (chunk) => { out += chunk })
  const url = await new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const match = /heddle web: (http:\/\/\S+)/.exec(out)
      if (match) {
        clearInterval(timer)
        clearTimeout(limit)
        resolve(match[1])
      }
    }, 50)
    const limit = setTimeout(() => {
      clearInterval(timer)
      child.kill('SIGKILL')
      reject(new Error('the server printed no URL within 15s\n' + out))
    }, 15_000)
    child.on('exit', (code) => {
      clearInterval(timer)
      clearTimeout(limit)
      reject(new Error(`the server exited ${code} before printing a URL\n${out}`))
    })
  })
  const handshake = await fetch(url, { redirect: 'manual' })
  const setCookie = handshake.headers.get('set-cookie')
  if (setCookie === null) throw new Error(`the handshake set no cookie (status ${handshake.status})`)
  const cookie = setCookie.split(';')[0]
  const api = async (path, init = {}) => {
    const response = await fetch(new URL(path, url), { ...init, headers: { cookie, 'content-type': 'application/json', ...(init.headers ?? {}) } })
    return { status: response.status, body: await response.json().catch(() => ({})) }
  }
  /** The scripted endpoint re-reads its script on every model request, so each turn gets its own steps. */
  const setScript = (steps) => writeFileSync(script, JSON.stringify({ steps }))
  const sessions = new Set()
  return {
    url,
    home,
    work,
    cookie,
    api,
    setScript,
    sessions,
    output: () => out,
    close: async () => {
      // A detached job outlives a killed server, so every live job is stopped first, through the kill route.
      for (const session of sessions) {
        try {
          const listed = await api(`/api/jobs?session=${encodeURIComponent(session)}`)
          for (const job of listed.body.jobs ?? []) {
            if (job.status === 'running') await api('/api/jobs/kill', { method: 'POST', body: JSON.stringify({ session, job: job.id }) })
          }
        } catch {
          // A server without the routes has nothing to stop.
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 300))
      child.kill('SIGKILL')
      removeDir(home)
      removeDir(work)
    },
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const toolTexts = (server, session, since) =>
  readTranscript(join(server.home, 'sessions', session))
    .slice(since)
    .filter((event) => event.type === 'message' && event.message?.role === 'tool')
    .map((event) => (event.message?.content ?? []).map((part) => part.text ?? '').join(''))
const transcriptLength = (server, session) => readTranscript(join(server.home, 'sessions', session)).length

test('the header jobs control shows a background job, streams its output while expanded, and stops it in two presses', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const server = await startServer()
  const browser = await openBrowser()
  try {
    await server.api('/api/workspaces', { method: 'POST', body: JSON.stringify({ path: server.work }) })
    const opened = await server.api('/api/folders/session', { method: 'POST', body: JSON.stringify({ folder: server.work }) })
    const session = opened.body.session?.id ?? opened.body.id
    assert.equal(typeof session, 'string', `a session was opened\nsaw: ${JSON.stringify(opened).slice(0, 300)}`)
    server.sessions.add(session)
    const quietOpened = await server.api('/api/folders/session', { method: 'POST', body: JSON.stringify({ folder: server.work, new: true }) })
    const quiet = quietOpened.body.session?.id ?? quietOpened.body.id
    assert.equal(typeof quiet, 'string', `a second session was opened\nsaw: ${JSON.stringify(quietOpened).slice(0, 300)}`)
    assert.notEqual(quiet, session, 'the second session is a fresh one')
    server.sessions.add(quiet)

    const jobsOf = async (id) => {
      const answer = await server.api(`/api/jobs?session=${encodeURIComponent(id)}`)
      assert.equal(answer.status, 200, `the jobs route answered (${answer.status} ${JSON.stringify(answer.body).slice(0, 200)})`)
      assert.ok(Array.isArray(answer.body.jobs), `the answer carries jobs\nsaw: ${JSON.stringify(answer.body).slice(0, 300)}`)
      return answer.body.jobs
    }
    const turn = async (id, steps) => {
      server.setScript(steps)
      const response = await fetch(new URL('/api/turn', server.url), {
        method: 'POST',
        headers: { cookie: server.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'jobs view probe', folder: server.work, session: id }),
      })
      assert.equal(response.status, 200, `the turn ran (${response.status})`)
      await response.text()
    }

    // The model starts the loop in the background inside a real turn, then answers.
    let mark = transcriptLength(server, session)
    await turn(session, [{ toolCall: { name: 'bash', arguments: { command: LOOP, run_in_background: true } } }, { text: 'started it, carrying on' }])
    const started = /^started background job (bash-[0-9a-f]{16})$/.exec(toolTexts(server, session, mark)[0] ?? '')
    assert.ok(started, `bash with run_in_background answered a job id\nsaw: ${JSON.stringify(toolTexts(server, session, mark))}`)
    const id = started[1]
    // The quiet session gets a plain turn of its own, so it is an ordinary listed session that simply has no job.
    await turn(quiet, [{ text: 'nothing to run here' }])
    server.setScript([{ text: 'noted' }])
    const first = await jobsOf(session)
    assert.deepEqual(first.map((job) => [job.id, job.status, job.label]), [[id, 'running', LOOP]], 'the service holds the one running job')

    const rowOf = (sessionId) => `document.querySelector('li[data-session-id=${JSON.stringify(sessionId)}]')`
    const openSessionRow = async (sessionId) => {
      await browser.waitFor(`${rowOf(sessionId)} !== null`, 20_000)
      if ((await browser.evaluate(`${rowOf(sessionId)}.getAttribute('aria-selected')`)) !== 'true') {
        await browser.evaluate(`(${rowOf(sessionId)}.querySelector('.row') || ${rowOf(sessionId)}).click()`)
      }
      await browser.waitFor(`${rowOf(sessionId)}?.getAttribute('aria-selected') === 'true'`, 10_000)
    }
    const triggerLabel = `document.getElementById('jobs-trigger')?.getAttribute('aria-label') ?? null`
    const item = `document.querySelector('#jobs-menu li.jobs-item[data-job-id=${JSON.stringify(id)}]')`

    /**
     * Opened on the quiet session by name: a first visit starts a fresh New session (#17), and among blank sessions only
     * the open one is a row (C2), so the quiet blank would otherwise not be drawn.
     */
    await browser.gotoSession(server.url, quiet)

    // 1. A session with no jobs shows no control at all.
    await openSessionRow(quiet)
    await sleep(1_000)
    assert.deepEqual(
      JSON.parse(await browser.evaluate(`JSON.stringify({ hidden: document.getElementById('session-jobs')?.hidden ?? null, trigger: document.getElementById('jobs-trigger') !== null })`)),
      { hidden: true, trigger: false },
      'the quiet session has no jobs control',
    )
    assert.deepEqual(await jobsOf(quiet), [], 'the quiet session sees no job')

    // 2. The session with the job: the trigger counts the one live job and carries the ongoing dot.
    await openSessionRow(session)
    try {
      await browser.waitFor(`${triggerLabel} === '1 background job running'`, 20_000)
    } catch (error) {
      const seen = await browser.evaluate(`JSON.stringify({ host: document.getElementById('session-jobs')?.outerHTML?.slice(0, 600) ?? null })`)
      throw new Error(`no "1 background job running" trigger\npage: ${seen}\n${error.message}`)
    }
    assert.deepEqual(
      JSON.parse(await browser.evaluate(`(() => {
        const trigger = document.getElementById('jobs-trigger')
        return JSON.stringify({ text: trigger.querySelector('.jobs-count')?.textContent ?? null, expanded: trigger.getAttribute('aria-expanded'), dot: trigger.querySelector('.jobs-dot[data-state="ongoing"]') !== null })
      })()`)),
      { text: '1 background job running', expanded: 'false', dot: true },
      'the trigger reads the live count, is collapsed and shows the ongoing dot',
    )
    assert.equal((await jobsOf(session)).find((job) => job.id === id)?.status, 'running', 'the job is still running')

    // Count the follow requests the page makes, through its own fetch.
    await browser.evaluate(`(() => {
      window.__jobsFollowRequests = 0
      const original = window.fetch
      window.fetch = function (input, init) {
        const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        if (String(target).includes('/api/jobs/follow')) window.__jobsFollowRequests += 1
        return original.call(this, input, init)
      }
      return true
    })()`)

    // 3. Open the popover: the Running section holds the row, labelled with the command.
    await browser.evaluate(`document.getElementById('jobs-trigger').click()`)
    await browser.waitFor(`document.querySelector('#jobs-menu ul#jobs-list[aria-label="Background jobs"]') !== null && ${item} !== null`, 10_000)
    const listed = JSON.parse(await browser.evaluate(`(() => {
      const row = ${item}
      return JSON.stringify({
        expanded: document.getElementById('jobs-trigger').getAttribute('aria-expanded'),
        section: document.querySelector('#jobs-menu li.jobs-section[data-section="live"]')?.textContent ?? null,
        label: row.querySelector('.jobs-label')?.textContent ?? null,
        kind: row.querySelector('.jobs-kind')?.textContent ?? null,
        status: row.dataset.jobStatus,
        duration: row.querySelector('.jobs-duration')?.getAttribute('title') ?? null,
        rowAria: row.querySelector('button.jobs-row')?.getAttribute('aria-label') ?? null,
        stopAria: row.querySelector('.jobs-stop')?.getAttribute('aria-label') ?? null,
        settled: document.querySelector('#jobs-menu .jobs-section-toggle') !== null,
      })
    })()`))
    assert.equal(listed.expanded, 'true', 'the trigger says the popover is open')
    assert.equal(listed.section, 'Running')
    assert.equal(listed.label, LOOP, 'the row is labelled with the command')
    assert.equal(listed.kind, 'bash')
    assert.equal(listed.status, 'running')
    assert.match(listed.duration ?? '', /^Running for \d+(s|m \d+s)$/, 'the duration is titled "Running for …"')
    assert.equal(listed.rowAria, `Show live output of ${LOOP}`)
    assert.equal(listed.stopAria, `Stop task ${LOOP}`)
    assert.equal(listed.settled, false, 'no Finished section while nothing has settled')
    assert.equal((await jobsOf(session)).find((job) => job.id === id)?.status, 'running', 'opening the popover changes nothing')

    // 4. Expand: the live output appears and grows.
    await browser.evaluate(`${item}.querySelector('button.jobs-row').click()`)
    const output = `(${item}?.querySelector('.jobs-panel .jobs-term-output')?.textContent ?? '')`
    try {
      await browser.waitFor(`${output}.includes('tick 1\\n')`, 10_000)
    } catch (error) {
      const seen = await browser.evaluate(`JSON.stringify({ panel: ${item}?.querySelector('.jobs-panel')?.outerHTML?.slice(0, 600) ?? null, follows: window.__jobsFollowRequests })`)
      throw new Error(`no live output in the expanded row\npage: ${seen}\n${error.message}`)
    }
    assert.equal(await browser.evaluate(`${item}.querySelector('button.jobs-row').getAttribute('aria-label')`), `Hide live output of ${LOOP}`)
    assert.equal(await browser.evaluate(`${item}.querySelector('button.jobs-row').getAttribute('aria-expanded')`), 'true')
    const linesAtFirst = await browser.evaluate(`${output}.split('\\n').filter(Boolean).length`)
    await browser.waitFor(`${output}.split('\\n').filter(Boolean).length >= ${linesAtFirst + 3}`, 10_000)
    assert.ok((await browser.evaluate('window.__jobsFollowRequests')) >= 2, 'the expanded row polls the follow route')
    assert.equal((await jobsOf(session)).find((job) => job.id === id)?.status, 'running', 'watching changes nothing')

    // 5. Collapse: the panel goes and no further follow request is made.
    await browser.evaluate(`${item}.querySelector('button.jobs-row').click()`)
    await browser.waitFor(`${item}?.querySelector('button.jobs-row')?.getAttribute('aria-expanded') === 'false' && ${item}.querySelector('.jobs-panel') === null`, 10_000)
    await sleep(500)
    const followsAtCollapse = await browser.evaluate('window.__jobsFollowRequests')
    await sleep(2_500)
    assert.equal(await browser.evaluate('window.__jobsFollowRequests'), followsAtCollapse, 'a collapsed row makes no follow request')
    assert.equal((await jobsOf(session)).find((job) => job.id === id)?.status, 'running', 'collapsing changes nothing')

    // 6. The model's next job_output still returns the early output: the page's reads consumed nothing.
    mark = transcriptLength(server, session)
    await turn(session, [{ toolCall: { name: 'job_output', arguments: { job_id: id } } }, { text: 'read it' }])
    const [read] = toolTexts(server, session, mark)
    assert.ok((read ?? '').startsWith('tick 1\ntick 2\n'), `job_output still returns the first lines\nsaw: ${JSON.stringify((read ?? '').slice(0, 200))}`)
    assert.match(read ?? '', /\[status: running\]$/, 'and the job is still running')
    assert.equal((await jobsOf(session)).find((job) => job.id === id)?.status, 'running')

    // 7. The two-press stop: the first press only arms it.
    server.setScript([{ purpose: 'jobs-notice', text: 'the user stopped it' }])
    await browser.waitFor(`${item}?.querySelector('.jobs-stop') !== null`, 10_000)
    await browser.evaluate(`${item}.querySelector('.jobs-stop').click()`)
    await browser.waitFor(`${item}?.querySelector('.jobs-stop')?.dataset.killState === 'armed'`, 5_000)
    assert.deepEqual(
      JSON.parse(await browser.evaluate(`(() => {
        const stop = ${item}.querySelector('.jobs-stop')
        return JSON.stringify({ aria: stop.getAttribute('aria-label'), title: stop.getAttribute('title'), text: stop.querySelector('.jobs-stop-label')?.textContent ?? null })
      })()`)),
      { aria: 'Click again to confirm', title: 'Click again to confirm', text: 'Confirm stop' },
      'the armed stop asks for the confirming press',
    )
    assert.equal((await jobsOf(session)).find((job) => job.id === id)?.status, 'running', 'arming kills nothing')

    // The second press kills; the service settles the job killed by the user.
    await browser.evaluate(`${item}.querySelector('.jobs-stop').click()`)
    let killed
    for (let attempt = 0; attempt < 50; attempt += 1) {
      killed = (await jobsOf(session)).find((job) => job.id === id)
      if (killed?.status === 'killed') break
      await sleep(200)
    }
    assert.equal(killed?.status, 'killed', `the service settled the job killed\nsaw: ${JSON.stringify(killed)}`)
    assert.match(killed.detail ?? '', /cancelled by the user/, 'with the person’s kill reason')

    // 8. The row moves to Finished, reads "cancelled", and loses its stop control; the trigger stops counting it live.
    try {
      await browser.waitFor(`${item}?.dataset.jobStatus === 'killed'`, 10_000)
    } catch (error) {
      const seen = await browser.evaluate(`JSON.stringify({ menu: document.getElementById('jobs-menu')?.outerHTML?.slice(0, 800) ?? null })`)
      throw new Error(`the row did not settle killed\npage: ${seen}\n${error.message}`)
    }
    const finished = JSON.parse(await browser.evaluate(`(() => {
      const row = ${item}
      return JSON.stringify({
        toggle: document.querySelector('#jobs-menu .jobs-section-toggle')?.textContent ?? null,
        toggleExpanded: document.querySelector('#jobs-menu .jobs-section-toggle')?.getAttribute('aria-expanded') ?? null,
        clear: document.querySelector('#jobs-menu .jobs-section-clear')?.textContent ?? null,
        live: document.querySelector('#jobs-menu li.jobs-section[data-section="live"]') !== null,
        status: row.querySelector('.jobs-status')?.textContent ?? null,
        duration: row.querySelector('.jobs-duration')?.getAttribute('title') ?? null,
        stop: row.querySelector('.jobs-stop') !== null,
        trigger: document.getElementById('jobs-trigger')?.getAttribute('aria-label') ?? null,
        dot: document.querySelector('#jobs-trigger .jobs-dot') !== null,
      })
    })()`))
    assert.equal(finished.toggle, 'Finished 1')
    assert.equal(finished.toggleExpanded, 'true', 'with nothing live the Finished section is open')
    assert.equal(finished.clear, 'Clear')
    assert.equal(finished.live, false, 'no Running section is left')
    assert.match(finished.status ?? '', /cancelled/, `the settled row reads "cancelled" (saw ${JSON.stringify(finished.status)})`)
    assert.match(finished.duration ?? '', /^Took \d+(s|m \d+s)$/, 'the settled duration is titled "Took …"')
    assert.equal(finished.stop, false, 'a settled row has no stop control')
    assert.equal(finished.trigger, '1 background job')
    assert.equal(finished.dot, false, 'no ongoing dot once nothing is live')
    assert.equal((await jobsOf(session)).find((job) => job.id === id)?.status, 'killed')

    // 9. Escape closes the popover and gives the trigger focus back.
    await browser.evaluate(`(() => {
      const toggle = document.querySelector('#jobs-menu .jobs-section-toggle')
      toggle.focus()
      toggle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      return true
    })()`)
    await browser.waitFor(`document.getElementById('jobs-menu') === null`, 5_000)
    assert.deepEqual(
      JSON.parse(await browser.evaluate(`JSON.stringify({ focused: document.activeElement?.id ?? null, expanded: document.getElementById('jobs-trigger')?.getAttribute('aria-expanded') ?? null })`)),
      { focused: 'jobs-trigger', expanded: 'false' },
      'Escape closed the popover and refocused the trigger',
    )
    assert.equal((await jobsOf(session)).length, 1, 'closing changes nothing')

    // 10. Back on the quiet session the control is gone again.
    await openSessionRow(quiet)
    await browser.waitFor(`document.getElementById('session-jobs')?.hidden === true && document.getElementById('jobs-trigger') === null`, 10_000)
    assert.deepEqual(await jobsOf(quiet), [], 'the quiet session still sees no job')
  } finally {
    await browser.close()
    await server.close()
  }
})

test('archiving from the row with a background job running opens DSH\'s stop-and-archive dialog listing it; Cancel keeps both, Stop and archive archives and kills the job', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const server = await startServer()
  const browser = await openBrowser()
  try {
    await server.api('/api/workspaces', { method: 'POST', body: JSON.stringify({ path: server.work }) })
    const opened = await server.api('/api/folders/session', { method: 'POST', body: JSON.stringify({ folder: server.work }) })
    const session = opened.body.session?.id ?? opened.body.id
    assert.equal(typeof session, 'string', `a session was opened\nsaw: ${JSON.stringify(opened).slice(0, 300)}`)
    server.sessions.add(session)
    server.setScript([{ toolCall: { name: 'bash', arguments: { command: LOOP, run_in_background: true } } }, { text: 'started it' }])
    const response = await fetch(new URL('/api/turn', server.url), {
      method: 'POST',
      headers: { cookie: server.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'archive probe', folder: server.work, session }),
    })
    assert.equal(response.status, 200)
    await response.text()
    // Were a notice to start a turn in the archived session, this step would answer it.
    server.setScript([{ purpose: 'jobs-notice', text: 'woken in an archived session' }])
    const jobOf = async () => (await server.api(`/api/jobs?session=${encodeURIComponent(session)}`)).body.jobs?.[0]
    const metaOf = async () => (await server.api('/api/sessions')).body.find((entry) => entry.id === session)
    assert.equal((await jobOf())?.status, 'running', 'the background job runs')

    /** Opened by name: a first visit opens no one's newest session, it starts a fresh one (#17). */
    await browser.gotoSession(server.url, session)
    const row = `document.querySelector('li[data-session-id=${JSON.stringify(session)}]')`
    const archive = `${row}?.querySelector('button[aria-label="Archive session"]')`
    await browser.waitFor(`${archive} != null`, 20_000)

    /**
     * The refusal names the job in DSH's activity list, so the page opens DSH's SessionArchiveConfirmDialog (the
     * stop-and-archive dialog, archive R-developer-eight-13), not a native confirm. Its list says the job's family, count
     * and label, as DSH's activity line does.
     */
    const dialog = `(() => { const d = document.getElementById('session-archive'); return JSON.stringify({ open: d?.open === true, items: [...(d?.querySelectorAll('#session-archive-activity li') ?? [])].map((li) => li.textContent) }) })()`
    // Cancel: the dialog names the job, and nothing changes.
    await browser.evaluate(`${archive}.click()`)
    await browser.waitFor(`document.getElementById('session-archive')?.open === true`, 10_000)
    assert.deepEqual(JSON.parse(await browser.evaluate(dialog)), { open: true, items: [`1 background job: ${LOOP}`] }, 'the dialog lists the job')
    await browser.evaluate(`[...document.querySelectorAll('#session-archive [data-ws-close]')].find((button) => button.textContent.trim() === 'Cancel').click()`)
    await browser.waitFor(`document.getElementById('session-archive')?.open === false`, 10_000)
    await sleep(500)
    assert.notEqual((await metaOf())?.archived, true, 'cancelling leaves the session unarchived')
    assert.equal((await jobOf())?.status, 'running', 'cancelling leaves the job running')
    assert.equal(await browser.evaluate(`${row} !== null`), true, 'the row stays')

    // Stop and archive: archived, the row leaves the tree, and the job is killed with "session archived".
    await browser.evaluate(`${archive}.click()`)
    await browser.waitFor(`document.getElementById('session-archive')?.open === true`, 10_000)
    await browser.evaluate(`document.getElementById('session-archive-confirm').click()`)
    let job
    for (let attempt = 0; attempt < 50; attempt += 1) {
      job = await jobOf()
      if (job?.status === 'killed') break
      await sleep(200)
    }
    assert.equal(job?.status, 'killed', `the job was killed\nsaw: ${JSON.stringify(job)}`)
    assert.equal(job.detail, 'signal: SIGTERM; session archived')
    assert.equal((await metaOf())?.archived, true, 'the session is archived')
    await browser.waitFor(`${row} === null`, 10_000)
    assert.equal(await browser.evaluate(`document.getElementById('tree-note')?.textContent ?? ''`), '', 'no refusal sentence is left in the note line')
  } finally {
    await browser.close()
    await server.close()
  }
})
