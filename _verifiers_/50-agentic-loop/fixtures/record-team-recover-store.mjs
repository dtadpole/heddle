#!/usr/bin/env node
/**
 * Records the store [`check-teams.mjs`](../check-teams.mjs) boots a server on: a store a **previous process** left
 * behind, with one provisioning member that can resume, one that never got a child, and one queued message.
 *
 * Run once, against a TypeScript build, and commit the bytes beside this file:
 *
 *   npm run build
 *   node _verifiers_/50-agentic-loop/fixtures/record-team-recover-store.mjs
 *
 * It is not part of the suite: `verify.sh` runs `check*.mjs` only. It is kept so the recorded bytes have a stated
 * provenance rather than being a mysterious blob.
 *
 * The bytes are recorded from the TypeScript build at heddle commit a5b0c66 (2026-10-22). Re-running changes the
 * recording's `created` timestamps, and that is all it should change — the log frames are the store's format, not
 * this script's.
 */
import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { workspaceKey } from '../../../src/session/layout.ts'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../..')
const out = join(here, 'team-recover')
// A neutral path that need not exist when the store is replayed: the check rewrites each meta's `cwd` to its own
// fixture folder, and files the store under that folder's workspace key, because a store a process wrote always
// names the folder it ran in. The logs themselves are copied byte for byte.
const work = '/tmp/heddle-recorded-team-recover'
const root = join(here, '.recorded-root')

const { SessionStore } = await import(join(repoRoot, 'dist/session/store.js'))

rmSync(root, { recursive: true, force: true })
const sessions = new SessionStore(root)
const lead = sessions.create({ id: 'session-recover-lead', cwd: work, endpoint: 'scripted', model: 'scripted' })
const resumable = sessions.create({
  id: 'session-recover-active',
  cwd: work,
  parentSession: lead.id,
  origin: 'subagent',
  delegationDepth: 1,
  teamId: lead.id,
})
const ghost = sessions.create({
  id: 'session-recover-ghost',
  cwd: work,
  parentSession: lead.id,
  origin: 'subagent',
  delegationDepth: 1,
  teamId: lead.id,
})
sessions.message(resumable, { role: 'user', content: [{ type: 'text', text: 'the prompt that made it resumable' }] })

const version = 2
const teamId = lead.id
for (const [id, name] of [[resumable.id, 'alpha'], [ghost.id, 'ghost']]) {
  sessions.append(lead, {
    type: 'team/member',
    version,
    teamId,
    member: { id, name, description: 'left over', context: 'fresh', phase: 'provisioning' },
  })
}
sessions.append(lead, {
  type: 'team/message/queued',
  version,
  teamId,
  message: {
    id: 'team-message-left-1',
    senderId: lead.id,
    senderName: 'lead',
    targetId: resumable.id,
    content: [{ type: 'text', text: 'left over mail' }],
  },
})

mkdirSync(out, { recursive: true })
const folder = join(root, workspaceKey(work))
for (const name of readdirSync(folder)) {
  copyFileSync(join(folder, name), join(out, name))
  console.log(`recorded ${name}`)
}
rmSync(root, { recursive: true, force: true })
