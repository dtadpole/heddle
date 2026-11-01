import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { fixtureDir, heddleCommand, isolatedHome, removeDir, repoRoot, scriptedConfig } from '../../_tools_/verify-runner/lib.mjs'

/**
 * The interface language (issue #80), slice 1: DSH's dsh-client-locale selection and its stored preference.
 *
 * DSH ships English and Chinese. With no stored choice, a browser gets the first supported language it asks for (full
 * tag, then primary subtag), else English, and `<html lang>` names it (`zh-CN` for Chinese). A person's choice is the
 * `locale.preference` setting, which wins over the browser; here it is the shipped `locale` row's `preference`, `en`
 * or `zh`. Both builds serve the page from the same file, so the check reads the served `<html lang>`.
 */
const overlay = (home, preference) => {
  const file = join(home, `locale-${preference}.yml`)
  writeFileSync(file, `- patch:\n    - id: locale\n      config:\n        preference: ${preference}\n`)
  return file
}

function cli(home, args) {
  const env = { ...process.env, NO_COLOR: '1', HEDDLE_HOME: home }
  delete env.HEDDLE_CONFIG
  const [command, argv] = heddleCommand(args)
  const result = spawnSync(command, argv, { cwd: repoRoot, env, encoding: 'utf8', timeout: 60_000 })
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

async function startServer(label, patches = []) {
  const home = isolatedHome(`locale-${label}`)
  const work = fixtureDir(`locale-${label}-work`)
  const { config } = scriptedConfig({ home, steps: [{ text: 'idle' }] })
  const layers = ['--config', join(repoRoot, 'cordis.yml'), '--patch', join(repoRoot, 'heddle.patch.yml'), ...patches.flatMap((file) => ['--patch', file])]
  const child = spawn(...heddleCommand(['web', '--host', '127.0.0.1', '--port', '0', ...layers, '--session-root', join(home, 'sessions')]), {
    cwd: work,
    env: { ...process.env, NO_COLOR: '1', HEDDLE_HOME: home, HEDDLE_CONFIG: config },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  const close = () => {
    child.kill('SIGKILL')
    removeDir(home)
    removeDir(work)
  }
  try {
    const url = await new Promise((resolvePromise, reject) => {
      const onData = (chunk) => {
        output += chunk.toString()
        const match = /heddle web: (http:\/\/\S+)/.exec(output)
        if (match) resolvePromise(match[1])
      }
      child.stdout.on('data', onData)
      child.stderr.on('data', onData)
      child.on('exit', (code) => reject(new Error(`the server exited ${code} before printing a URL\n${output}`)))
      setTimeout(() => reject(new Error(`the server printed no URL within 15s\n${output}`)), 15_000).unref()
    })
    const handshake = await fetch(url, { redirect: 'manual' })
    const cookie = handshake.headers.get('set-cookie')?.split(';')[0]
    if (cookie === undefined) throw new Error(`the handshake set no cookie (status ${handshake.status})`)
    return { home, url, cookie, close }
  } catch (error) {
    close()
    throw error
  }
}

/** The served page's `<html lang>`, for a browser asking in `acceptLanguage`. */
async function servedLanguage(server, acceptLanguage) {
  const response = await fetch(new URL('/', server.url), { headers: { cookie: server.cookie, 'accept-language': acceptLanguage } })
  assert.equal(response.status, 200)
  return /<html lang="([^"]+)">/.exec(await response.text())?.[1]
}

test('with no stored choice, the page is in the first supported language the browser asks for, else English', async () => {
  const server = await startServer('browser')
  try {
    assert.equal(await servedLanguage(server, 'zh-CN,zh;q=0.9,en;q=0.8'), 'zh-CN', 'a Chinese browser gets Chinese, tagged as DSH tags it')
    assert.equal(await servedLanguage(server, 'en-US,en;q=0.9'), 'en')
    assert.equal(await servedLanguage(server, 'fr-FR,fr;q=0.9'), 'en', 'an unsupported language falls back to English')
    // Only a shipped tag is ever written into the document; the header's own text never reaches it.
    assert.equal(await servedLanguage(server, '"><script>alert(1)</script>'), 'en', 'a hostile header writes nothing of its own')
  } finally {
    server.close()
  }
})

test('a stored preference wins over the browser', async () => {
  const home = isolatedHome('locale-stored-overlay')
  const server = await startServer('stored', [overlay(home, 'en')])
  try {
    assert.equal(await servedLanguage(server, 'zh-CN,zh;q=0.9'), 'en', 'the person chose English')
  } finally {
    server.close()
    removeDir(home)
  }
})

test('the locale row takes en or zh: zh composes, fr is refused by --validate', () => {
  const home = isolatedHome('locale-validate')
  try {
    const base = ['--config', join(repoRoot, 'cordis.yml'), '--patch', join(repoRoot, 'heddle.patch.yml')]
    const composed = cli(home, [...base, '--patch', overlay(home, 'zh'), 'config', '--json'])
    assert.equal(composed.code, 0, composed.stderr)
    const row = JSON.parse(composed.stdout).find((entry) => entry.id === 'locale')
    assert.deepEqual(row?.config, { preference: 'zh' }, 'the shipped tree has a locale row, and the preference composes')

    const refused = cli(home, [...base, '--patch', overlay(home, 'fr'), 'config', '--validate'])
    assert.equal(refused.code, 1, `${refused.stdout}\n${refused.stderr}`)
    assert.match(`${refused.stdout}${refused.stderr}`, /locale/, 'the problem names the locale row')
  } finally {
    removeDir(home)
  }
})
