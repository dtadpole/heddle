import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import {
  SandboxUnavailableError,
  classifyOutcome,
  selectBackend,
} from '../src/sandbox/backend.ts'
import { canonical } from '../src/sandbox/paths.ts'
import { sandboxPolicyStatement, writableRoots } from '../src/sandbox/policy.ts'
import { bwrapProfileArgs, landlockBackend, landlockGrantArgs, selectLinuxBackend } from '../src/sandbox/linux.ts'
import { ContextService } from '../src/context/service.ts'
import { SessionStore } from '../src/session/store.ts'
import { seatbeltBackend, seatbeltProfileArgs } from '../src/sandbox/seatbelt.ts'
import { SandboxService } from '../src/sandbox/service.ts'

/**
 * The sandbox backend: one policy→profile seam, one platform runner, one classification.
 *
 * DSH's split is the model — a per-call policy, a backend that turns it into a kernel profile and reports what
 * it actually enforced, and a consumer that reports the fact. These tests judge the pieces that can be wrong
 * without anyone noticing: the writable-root list the fence and the profile share, the profile text (Seatbelt
 * matches resolved paths, so `/tmp` is `/private/tmp`), selection and fail-closed behaviour, and the
 * classification order — a runner failure means the command did not run, so it must outrank a denial; and a
 * command that merely prints a denial signature must not be reported as denied.
 *
 * The kernel itself is judged too, on macOS only: the profile is applied for real around `sh` and a descendant.
 */

const scratch = mkdtempSync(join(tmpdir(), 'heddle-sandbox-backend-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

function workspace(label: string): string {
  const dir = join(scratch, label)
  mkdirSync(dir, { recursive: true })
  return dir
}

test('the writable roots are one list: none outside workspace-write, canonical inside it', () => {
  const root = workspace('roots-workspace')
  const extra = canonical(workspace('roots-extra'))

  assert.deepEqual(writableRoots({ mode: 'read-only', workspaceRoot: root, extraWritableRoots: [] }), [], 'read-only has no writable roots')
  assert.deepEqual(
    writableRoots({ mode: 'danger-full-access', workspaceRoot: root, extraWritableRoots: [] }),
    [],
    'full access is not a root set — the provider is not consulted at all',
  )
  /**
   * DSH's set for `workspace-write` is the workspace **plus the host temp areas** (`/tmp`, `tmpdir()`),
   * canonicalised because Seatbelt matches resolved paths; heddle adds its named extra roots to the same list.
   */
  const roots = writableRoots({ mode: 'workspace-write', workspaceRoot: root, extraWritableRoots: [extra] })
  assert.ok(roots.includes(canonical(root)), 'the workspace is a root')
  assert.ok(roots.includes(extra), 'a configured extra root is a root')
  assert.ok(roots.includes(canonical('/tmp')), '/tmp is a root, as in DSH')
  assert.ok(roots.some((entry) => entry === canonical(process.env.TMPDIR ?? tmpdir()) || entry === canonical(tmpdir())), 'the host temp directory is a root')
})

test('the Seatbelt profile is DSH’s: deny writes, /dev/null literal, one subpath per writable root', () => {
  const root = canonical(workspace('seatbelt-workspace'))
  const profile = seatbeltProfileArgs({ mode: 'workspace-write', workspaceRoot: root, extraWritableRoots: [] }).join(' ')
  assert.match(profile, /\(version 1\)/, 'the profile declares a version')
  assert.match(profile, /\(allow default\)/, 'allow-default, as the reference builds it')
  assert.match(profile, /\(deny file-write\*\)/, 'writes are denied by default')
  assert.match(profile, /\(allow file-write\* \(literal "\/dev\/null"\)\)/, '/dev/null stays writable, which is what every shell expects')
  assert.ok(profile.includes(`(subpath "${root}")`), `the workspace is granted by canonical subpath (${profile})`)

  const readOnly = seatbeltProfileArgs({ mode: 'read-only', workspaceRoot: root, extraWritableRoots: [] }).join(' ')
  assert.ok(!readOnly.includes('(subpath'), 'read-only grants no writable subpath')
  assert.match(readOnly, /literal "\/dev\/null"/, 'and keeps the /dev/null exception')

  /** A path with a quote or a backslash must not be able to end the SBPL string early. */
  const quoted = seatbeltProfileArgs({ mode: 'workspace-write', workspaceRoot: '/tmp/a"b\\c', extraWritableRoots: [] }).join(' ')
  assert.ok(quoted.includes('/tmp/a\\"b\\\\c'), `a hostile path is escaped (${quoted})`)
})

test('selection is by platform, and a confined call fails closed when no backend is usable', () => {
  const darwin = selectBackend('darwin')
  if (process.platform === 'darwin') {
    assert.equal(darwin?.name, 'seatbelt', 'macOS selects the Seatbelt rung')
  }
  assert.equal(selectBackend('freebsd'), undefined, 'a platform with no runner has no backend')

  const root = workspace('fail-closed')
  const forcedNone = new SandboxService(new Context(), { mode: 'workspace-write', workspaceRoot: root, backend: 'none' })
  assert.throws(
    () => forcedNone.confine(['/bin/sh', '-c', 'true'], 'workspace-write'),
    (error: unknown) => error instanceof SandboxUnavailableError && /no sandbox backend is usable/i.test((error as Error).message),
    'a confined mode with no runner refuses to run rather than running unconfined',
  )

  /** `danger-full-access` never consults a provider, even when there is none. */
  const argv = ['/bin/sh', '-c', 'true']
  const bypass = forcedNone.confine(argv, 'danger-full-access')
  assert.deepEqual([...bypass.argv], argv, 'full access returns the original argv')
})

test('classification: runner failure first, denial only on a failed command, false signatures ignored', () => {
  const confined = seatbeltBackend().confine(['/bin/sh', '-c', 'true'], { mode: 'workspace-write', workspaceRoot: '/', extraWritableRoots: [] })
  const facts = { mode: 'workspace-write' as const, ...confined }

  assert.equal(classifyOutcome({ exitCode: 1, stderr: '/bin/sh: /tmp/x: Operation not permitted\n', confined: facts }).kind, 'denied', 'a failed command whose stderr speaks the denial dialect is a denial')
  assert.equal(classifyOutcome({ exitCode: 0, stderr: 'Operation not permitted\n', confined: facts }).kind, 'exited', 'a command that merely PRINTS the denial sentence succeeded, and is not a denial')
  assert.equal(
    classifyOutcome({ exitCode: 1, stderr: 'sandbox-exec: Invalid profile syntax\n', confined: facts }).kind,
    'runner-failure',
    'the runner refusing its profile is a sandbox problem, and outranks any denial signature',
  )
  assert.equal(classifyOutcome({ exitCode: 2, stderr: 'command not found\n', confined: facts }).kind, 'exited', 'an ordinary command failure is neither')
  assert.equal(classifyOutcome({ exitCode: 1, stderr: 'Operation not permitted\n', confined: null }).kind, 'exited', 'an unconfined call cannot be denied')
})

test('a workspace-write policy wraps with the real profile, and the kernel enforces it', { skip: process.platform !== 'darwin' ? 'macOS Seatbelt is the rung under test' : false }, () => {
  const root = workspace('kernel-workspace')
  const outside = join(homedir(), '.heddle-sandbox-kernel-outside.txt')
  const service = new SandboxService(new Context(), { mode: 'workspace-write', workspaceRoot: root })

  const inside = service.confine(['/bin/sh', '-c', `echo hi > ${JSON.stringify(join(root, 'inside.txt'))}`], 'workspace-write')
  assert.equal(inside.argv[0], '/usr/bin/sandbox-exec', 'the spawn goes through sandbox-exec directly, never a shell wrapper')
  assert.equal(inside.enforcement, 'full', 'the Seatbelt rung governs every promised file effect')
  const ranInside = spawnSync(inside.argv[0] as string, [...inside.argv.slice(1)] as string[], { encoding: 'utf8' })
  assert.equal(ranInside.status, 0, `the inside write runs (${ranInside.stderr})`)
  assert.equal(existsSync(join(root, 'inside.txt')), true, 'and lands')

  const denied = service.confine(['/bin/sh', '-c', `echo hi > ${JSON.stringify(outside)}`], 'workspace-write')
  const ranOutside = spawnSync(denied.argv[0] as string, [...denied.argv.slice(1)] as string[], { encoding: 'utf8' })
  assert.notEqual(ranOutside.status, 0, 'the outside write is denied by the kernel')
  assert.equal(existsSync(outside), false, 'and nothing landed')
  assert.equal(classifyOutcome({ exitCode: ranOutside.status ?? 1, stderr: ranOutside.stderr, confined: denied }).kind, 'denied', 'the result is reported as a denial, not a command failure')

  /** A descendant shell is confined with its parent — the reason this is a process profile, not a command check. */
  const descendant = spawnSync(
    denied.argv[0] as string,
    [...denied.argv.slice(1, -1), '/bin/sh', '-c', `sh -c 'echo hi > ${JSON.stringify(join(homedir(), '.heddle-sandbox-kernel-child.txt'))}'`] as string[],
    { encoding: 'utf8' },
  )
  assert.equal(existsSync(join(homedir(), '.heddle-sandbox-kernel-child.txt')), false, 'a grandchild write is denied too')

  /** read-only keeps a shell and denies its writes; /dev/null is the one sink every shell expects. */
  const readOnly = new SandboxService(new Context(), { mode: 'read-only', workspaceRoot: root })
  const devnull = readOnly.confine(['/bin/sh', '-c', 'echo ok > /dev/null'], 'read-only')
  assert.equal(spawnSync(devnull.argv[0] as string, [...devnull.argv.slice(1)] as string[]).status, 0, '/dev/null stays writable under read-only')
  const attempt = readOnly.confine(['/bin/sh', '-c', `echo hi > ${JSON.stringify(join(root, 'readonly.txt'))}`], 'read-only')
  assert.notEqual(spawnSync(attempt.argv[0] as string, [...attempt.argv.slice(1)] as string[]).status, 0, 'a read-only write is denied')
  assert.equal(existsSync(join(root, 'readonly.txt')), false, 'and nothing landed')
})

test('the sandbox service still fences the file tools with the same roots', () => {
  const root = workspace('fence-workspace')
  const outside = join(homedir(), '.heddle-sandbox-fence-outside.txt')
  const service = new SandboxService(new Context(), { mode: 'workspace-write', workspaceRoot: root })
  assert.equal(service.assertWritable('inside.txt', 'workspace-write'), canonical(join(root, 'inside.txt')), 'inside is permitted')
  assert.throws(() => service.assertWritable(outside, 'workspace-write'), /outside the sandbox root/, 'outside is refused')
  assert.throws(() => service.assertWritable('inside.txt', 'read-only'), /read-only/, 'read-only refuses a write')
  assert.equal(service.assertWritable(outside, 'danger-full-access'), canonical(outside), 'full access permits it')
  writeFileSync(outside, 'x')
  assert.equal(existsSync(outside), true)
  rmSync(outside)
})

test('the Linux chain: bwrap first, Landlock second, neither means fail closed', () => {
  const root = '/workspace'
  const policy = { mode: 'workspace-write' as const, workspaceRoot: root, extraWritableRoots: [] }

  const bwrap = bwrapProfileArgs(policy)
  assert.deepEqual(bwrap.slice(0, 8), ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc'], 'bwrap mounts a read-only host root with a fresh /dev and a private procfs')
  assert.ok(bwrap.includes('--die-with-parent'), 'and dies with its parent')
  assert.ok(bwrap.includes('--tmpfs') && bwrap.includes('/tmp'), 'workspace-write mounts an ephemeral /tmp')
  assert.ok(bwrap.includes('--bind') && bwrap.includes(canonical(root)), 'and a writable bind for the workspace')
  assert.ok(!bwrapProfileArgs({ ...policy, mode: 'read-only' }).includes('--tmpfs'), 'read-only mounts no writable tmpfs')

  const grants = landlockGrantArgs(policy)
  assert.deepEqual(grants.slice(0, 2), ['--ro', '/'], 'Landlock grants a read-only root first')
  assert.ok(grants.includes('/dev/null') && grants.includes(canonical(root)) && grants.includes(canonical('/tmp')), 'and read-write grants for the dev sink, temp area and workspace')

  const usable = bwrapBackendFake(true)
  const locked = landlockBackend({ probe: () => 'partial' })
  assert.ok(locked !== undefined)
  assert.equal(selectLinuxBackend(usable)?.name, 'bwrap', 'a usable bubblewrap wins')
  assert.equal(selectLinuxBackend(bwrapBackendFake(false), locked)?.name, 'landlock', 'otherwise the Landlock rung is selected')
  assert.equal(selectLinuxBackend(bwrapBackendFake(false), undefined), undefined, 'and with neither the host fails closed')
  assert.equal(locked.confine(['/bin/sh', '-c', 'true'], policy).enforcement, 'partial', 'an older Landlock ABI reports partial enforcement as a fact')

  function bwrapBackendFake(probe: boolean) {
    return {
      name: 'bwrap' as const,
      probe: () => probe,
      confine: (argv: readonly string[]) => ({ argv, enforcement: 'full' as const, denialSignatures: [], runnerFailureRules: [] }),
    }
  }
})

test('the model-visible policy statement names the mode and, under workspace-write, the workspace', () => {
  const root = canonical(workspace('statement-workspace'))
  assert.match(sandboxPolicyStatement({ mode: 'read-only', workspaceRoot: root, extraWritableRoots: [] }), /^Current heddle file policy: read-only\. /, 'read-only names the standing mode')
  const shared = sandboxPolicyStatement({ mode: 'workspace-write', workspaceRoot: root, extraWritableRoots: [] })
  assert.match(shared, /workspace-write/, 'workspace-write names its mode')
  assert.ok(shared.includes(`"${root}"`), 'and the workspace the mode promises')
  assert.match(shared, /temp/i, 'and says the temp areas may be writable')
  assert.match(sandboxPolicyStatement({ mode: 'danger-full-access', workspaceRoot: root, extraWritableRoots: [] }), /does not restrict file modifications/, 'full access says the sandbox does not restrict')
})

