// The endpoint list a signed-in page reads (GET /api/endpoints) tells it what it needs to list and pick models, and
// never a key file's path, the gateway address, a proxy or a project: a key file's path names the account that holds
// it, and DSH lets only declared credential metadata cross (live-testing issue developer-two-4). The operator's own
// CLI listing (models --json) keeps the gateway but never the path. Runs against whichever harness HEDDLE_BIN names,
// or the TypeScript build.
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { heddleCommand, isolatedHome, removeDir, repoRoot, runCli } from '../../_tools_/verify-runner/lib.mjs'

function scratchProfile(home) {
  const profile = join(home, 'endpoints-page-profile')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'cordis.yml'), '[]\n')
  const tree = readFileSync(join(repoRoot, 'heddle.patch.yml'), 'utf8').replaceAll('name: ./src/', `name: ${repoRoot}/src/`)
  writeFileSync(join(profile, 'heddle.patch.yml'), tree)
  return profile
}

function startServer(args, env) {
  return new Promise((resolvePromise, reject) => {
    void (async () => {
      const { spawn } = await import('node:child_process')
      const child = spawn(...heddleCommand(['web', '--port', '0', ...args]), {
        cwd: env.HOME,
        env: { ...process.env, NO_COLOR: '1', ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      let settled = false
      const onData = (chunk) => {
        output += chunk.toString()
        const match = /(http:\/\/127\.0\.0\.1:\d+)\/\?token=([A-Za-z0-9_-]+)/.exec(output)
        if (match && !settled) {
          settled = true
          resolvePromise({ base: match[1], token: match[2], kill: () => child.kill('SIGKILL'), output: () => output })
        }
      }
      child.stdout.on('data', onData)
      child.stderr.on('data', onData)
      child.on('exit', (code) => {
        if (!settled) {
          settled = true
          reject(new Error(`the server exited ${code} before printing a URL\n${output}`))
        }
      })
      setTimeout(() => {
        if (!settled) {
          settled = true
          child.kill('SIGKILL')
          reject(new Error(`the server printed no URL within 20s\n${output}`))
        }
      }, 20_000).unref()
    })()
  })
}

async function call(server, method, path, body) {
  const response = await fetch(`${server.base}${path}?token=${server.token}`, {
    method,
    ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  })
  const text = await response.text()
  let parsed = text
  try {
    parsed = JSON.parse(text)
  } catch {}
  return { status: response.status, body: parsed }
}

test('the page is told how to pick a model, and not where the key or the gateway is', async () => {
  const home = isolatedHome('endpoints-page')
  let server
  try {
    const keyFile = join(home, '.keys', 'gateway.key')
    mkdirSync(join(home, '.keys'), { recursive: true })
    writeFileSync(keyFile, 'sk-not-a-real-key\n')
    const config = join(home, 'heddle.json')
    writeFileSync(config, JSON.stringify({
      default: 'gateway',
      exclude: ['scripted'],
      endpoints: [{ name: 'gateway', kind: 'openai-chat', baseUrl: 'http://gw.internal.example:8443/v1', model: 'm', apiKeyFile: keyFile, proxy: 'http://proxy.internal.example:3128', project: 'acct-project', headers: { 'X-Tenant': 't' }, contextWindow: 1000 }],
    }))
    const env = { HOME: home, HEDDLE_HOME: join(home, '.heddle'), HEDDLE_CONFIG: config }
    server = await startServer(['--profile', scratchProfile(home), '--sandbox-root', home], env)
    const listing = await call(server, 'GET', '/api/endpoints')
    assert.equal(listing.status, 200)
    const gateway = listing.body.endpoints.find((endpoint) => endpoint.name === 'gateway')
    assert.ok(gateway, `the endpoint is listed\n${JSON.stringify(listing.body).slice(0, 300)}`)
    assert.equal(gateway.credential, 'set', 'the page learns a credential is set')
    assert.equal(gateway.model, 'm')
    const text = JSON.stringify(listing.body)
    for (const [label, value] of [['key file path', keyFile], ['key value', 'sk-not-a-real-key'], ['gateway address', 'gw.internal.example'], ['proxy', 'proxy.internal.example'], ['project', 'acct-project'], ['header name', 'X-Tenant']]) {
      assert.equal(text.includes(value), false, `no ${label} reaches the page`)
    }
    assert.equal('credentialFile' in gateway, false)

    const cli = await runCli(['models', '--json'], { env })
    assert.equal(cli.code, 0, cli.stderr)
    assert.equal(cli.stdout.includes(keyFile), false, 'the CLI listing never prints the key file path either')
    const described = JSON.parse(cli.stdout).find((endpoint) => endpoint.name === 'gateway')
    assert.equal(described.baseUrl, 'http://gw.internal.example:8443/v1', 'the operator still sees the gateway')
    assert.equal(described.credential, 'set')
  } finally {
    server?.kill()
    removeDir(home)
  }
})
