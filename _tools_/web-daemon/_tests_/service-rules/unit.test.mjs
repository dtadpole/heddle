import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'

import {
  DOCUMENTED_PORT,
  UNIT,
  builtPagePath,
  checkoutVerdict,
  describeCommand,
  expectedPage,
  lastLaunchToken,
  listenerFromLsof,
  listenerFromSs,
  logPathOf,
  parseShow,
  parseUnit,
  pidFromLaunchctl,
  plistPath,
  serviceTarget,
  splitCommandLine,
  supervisorFor,
  unitPath,
  unitValue,
} from '../../service.mjs'

test('each platform has its supervisor and its documented port, and an unknown one has neither', () => {
  assert.equal(supervisorFor('darwin'), 'launchd')
  assert.equal(supervisorFor('linux'), 'systemd')
  assert.equal(supervisorFor('win32'), null, 'install.sh has no supervisor there, so nothing is read')
  assert.equal(DOCUMENTED_PORT.darwin, 3082, 'macOS: the service sits behind the 8082 gate')
  assert.equal(DOCUMENTED_PORT.linux, 8082, 'Linux: no gate, the server owns the port the forward reaches')
})

test('the definitions live where install.sh writes them, honouring XDG_CONFIG_HOME', () => {
  assert.equal(plistPath({ HOME: '/h' }), '/h/Library/LaunchAgents/com.dtadpole.heddle-web.plist')
  assert.equal(unitPath({ HOME: '/h' }), `/h/.config/systemd/user/${UNIT}`)
  assert.equal(unitPath({ HOME: '/h', XDG_CONFIG_HOME: '/x' }), `/x/systemd/user/${UNIT}`)
  assert.equal(unitPath({ HOME: '/h', XDG_CONFIG_HOME: '' }), `/h/.config/systemd/user/${UNIT}`, 'an empty XDG_CONFIG_HOME is unset')
})

test('a unit file parses as systemd reads it: comments, continuations, repeats and resets', () => {
  const sections = parseUnit([
    '# a comment',
    '; another',
    '[Unit]',
    'Description=heddle',
    '[Service]',
    'ExecStart=/bin/false',
    'ExecStart=',
    'ExecStart=/usr/bin/node /srv/heddle/dist/cli.js \\',
    '  web --port 8082',
    'Environment=A=1',
    'Environment=B=2',
    'WorkingDirectory = /srv/heddle ',
  ].join('\n'))
  assert.equal(unitValue(sections, 'Unit', 'Description'), 'heddle')
  assert.deepEqual(sections.Service.ExecStart, ['/usr/bin/node /srv/heddle/dist/cli.js web --port 8082'], 'an empty assignment resets the list, and a backslash continues the line')
  assert.deepEqual(sections.Service.Environment, ['A=1', 'B=2'], 'repeated keys accumulate')
  assert.equal(unitValue(sections, 'Service', 'WorkingDirectory'), '/srv/heddle', 'keys and values are trimmed')
  assert.equal(unitValue(sections, 'Service', 'Missing'), null)
  assert.equal(unitValue(sections, 'Install', 'WantedBy'), null, 'a missing section is not an error')
  assert.equal(unitValue(parseUnit('[Service]\nExecStart=x\nExecStart=\n'), 'Service', 'ExecStart'), null, 'a reset with nothing after it is unset')
})

test('an ExecStart line splits into argv the way systemd splits it', () => {
  assert.deepEqual(splitCommandLine('/usr/bin/node  /a/dist/cli.js web --port 8082'), ['/usr/bin/node', '/a/dist/cli.js', 'web', '--port', '8082'])
  assert.deepEqual(splitCommandLine('"/opt/my app/heddle" web \'--config\' "/a b/cordis.yml"'), ['/opt/my app/heddle', 'web', '--config', '/a b/cordis.yml'], 'quotes group')
  assert.deepEqual(splitCommandLine('/bin/x a\\ b ""'), ['/bin/x', 'a b', ''], 'a backslash escapes, and an empty quoted word is a word')
  assert.deepEqual(splitCommandLine('-@/bin/heddle web'), ['/bin/heddle', 'web'], 'the run-mode prefixes are not part of the program')
  assert.deepEqual(splitCommandLine(''), [])
  assert.throws(() => splitCommandLine('/bin/x "open'), /unterminated/, 'an unterminated quote is an error, not a guess')
})

test('a command line names the build, the checkout and the port, for either build', () => {
  const ts = describeCommand(['/n/node', '/srv/live/dist/cli.js', 'web', '--host', '127.0.0.1', '--port', '8082', '--config', '/srv/live/cordis.yml'], '/srv/live')
  assert.equal(ts.cli, '/srv/live/dist/cli.js')
  assert.equal(ts.entry, '/srv/live/dist/cli.js', 'the TypeScript build is identified by its CLI, not by node')
  assert.equal(ts.root, '/srv/live')
  assert.equal(ts.port, 8082)
  assert.equal(ts.host, '127.0.0.1')
  assert.equal(ts.program, '/n/node')

  const rust = describeCommand(['/srv/live/rust/target/release/heddle', 'web', '--port', '3082', '--config', '/srv/live/cordis.yml'], '/srv/live')
  assert.equal(rust.cli, null)
  assert.equal(rust.entry, '/srv/live/rust/target/release/heddle', 'the binary is the entry')
  assert.equal(rust.root, '/srv/live', 'the checkout is the working directory')

  const noDirectory = describeCommand(['/b/heddle', 'web', '--config', '/srv/other/cordis.yml'])
  assert.equal(noDirectory.root, '/srv/other', 'without a working directory, the profile names the checkout')
  assert.equal(noDirectory.port, null, 'no --port is no port, not a default guessed here')
  assert.equal(describeCommand(['/b/heddle', 'web', '--port', 'eighty']).port, null, 'a port must be digits')
  assert.equal(describeCommand(['/b/heddle', 'web', '--port']).port, null, 'a flag with no value has none')
})

test('a supervised command line is judged by the server after --, never by the supervisor in front of it', () => {
  // The measured reason this exists: with the supervisor in the agent, `program` is node, so an entry taken from
  // the front of the command line would have made "the live process runs this build" true for any node process.
  const supervised = describeCommand(
    ['/n/node', '/srv/checkout/_tools_/web-daemon/supervisor.mjs', '--', '/n/node', '/srv/live/dist/cli.js', 'web', '--host', '127.0.0.1', '--port', '3082', '--config', '/srv/live/cordis.yml'],
    '/srv/live',
  )
  assert.equal(supervised.supervised, true)
  assert.equal(supervised.program, '/n/node', 'what launchd runs is the supervisor')
  assert.equal(supervised.entry, '/srv/live/dist/cli.js', 'what the deployment claims is the server')
  assert.equal(supervised.root, '/srv/live')
  assert.equal(supervised.port, 3082)
  assert.deepEqual(supervised.server.slice(0, 2), ['/n/node', '/srv/live/dist/cli.js'])

  const supervisedBinary = describeCommand(
    ['/n/node', '/srv/checkout/_tools_/web-daemon/supervisor.mjs', '--', '/srv/live/rust/target/release/heddle', 'web', '--port', '8082'],
    '/srv/live',
  )
  assert.equal(supervisedBinary.entry, '/srv/live/rust/target/release/heddle', 'and for the binary the port will serve')
  assert.equal(builtPagePath(supervisedBinary), '/srv/live/src/server/page.html')

  assert.equal(describeCommand(['/n/node', '/srv/live/dist/cli.js', 'web']).supervised, false, 'a bare command line is not supervised')
})

test('each build is compared with the page file it actually serves', () => {
  assert.equal(builtPagePath(describeCommand(['/n/node', '/srv/live/dist/cli.js', 'web'])), '/srv/live/dist/server/page.html')
  assert.equal(builtPagePath(describeCommand(['/srv/live/rust/target/release/heddle', 'web'], '/srv/live')), '/srv/live/src/server/page.html')
})

test('the expected document is the built page with its own hash in the marker, and nothing else changed', () => {
  const built = '<html><head><meta name="heddle-page" content="dev"><title>t</title></head><body>x</body></html>'
  const { marker, page } = expectedPage(built)
  assert.equal(marker, createHash('sha256').update(built).digest('hex').slice(0, 12))
  assert.equal(page, built.replace('content="dev"', `content="${marker}"`), 'exactly one substitution')
  assert.notEqual(expectedPage(`${built} `).marker, marker, 'one changed byte is another build')
  assert.equal(expectedPage('<html>no marker</html>').page, '<html>no marker</html>', 'a page without the marker is left as it is, so the comparison fails on it')
})

test('the log is the file StandardOutput writes to, and nothing else', () => {
  assert.equal(logPathOf('append:/h/.heddle/web.log'), '/h/.heddle/web.log')
  assert.equal(logPathOf('file:/var/log/x'), '/var/log/x')
  assert.equal(logPathOf('truncate:/tmp/y'), '/tmp/y')
  assert.equal(logPathOf('journal'), null)
  assert.equal(logPathOf('inherit'), null)
  assert.equal(logPathOf(null), null)
})

test('the launch token is the last one a start printed', () => {
  const log = [
    'heddle web: http://127.0.0.1:8082/?token=first_token-1',
    'heddle web: serving on 127.0.0.1:8082',
    "read it with: grep -o 'token=[A-Za-z0-9_-]*'",
    'heddle web: http://127.0.0.1:8082/?token=second-Token_2',
  ].join('\n')
  assert.equal(lastLaunchToken(log), 'second-Token_2', 'a restart prints a new one, and only the newest works')
  assert.equal(lastLaunchToken('nothing here\n'), null)
  assert.equal(lastLaunchToken("grep -o 'token=abc'"), null, 'the instruction text is not a token')
})

test('the supervisor reports are read for state and pid', () => {
  assert.deepEqual(parseShow('ActiveState=active\nMainPID=417607\nNRestarts=1\n'), { ActiveState: 'active', MainPID: '417607', NRestarts: '1' })
  assert.deepEqual(parseShow('Environment=A=1 B=2\n'), { Environment: 'A=1 B=2' }, 'only the first = separates')
  assert.equal(pidFromLaunchctl('gui/501/x = {\n\tstate = running\n\tpid = 4242\n}'), 4242)
  assert.equal(pidFromLaunchctl('gui/501/x = {\n\tstate = not running\n}'), null)
})

test('the listener is the pid on the exact port, never a longer one that ends the same way', () => {
  const ss = [
    'LISTEN 0 4096 [::1]:18082 [::]:* users:(("other",pid=11,fd=3))',
    'LISTEN 0 511 127.0.0.1:8082 0.0.0.0:* users:(("MainThread",pid=417607,fd=21))',
  ].join('\n')
  assert.equal(listenerFromSs(ss, 8082), 417607)
  assert.equal(listenerFromSs(ss, 18082), 11)
  assert.equal(listenerFromSs(ss, 9000), null)
  assert.equal(listenerFromSs('LISTEN 0 511 127.0.0.1:8082 0.0.0.0:*', 8082), null, 'no users column (another account\'s socket) is no pid')
  assert.equal(listenerFromLsof('COMMAND PID USER\nnode 4242 z 21u IPv4 TCP 127.0.0.1:3082 (LISTEN)\n'), 4242)
  assert.equal(listenerFromLsof('COMMAND PID USER\n'), null)
})

test('a deployment checkout is committed main: on main at its tip, or detached exactly at origin/main', () => {
  const a = 'a'.repeat(40)
  const b = 'b'.repeat(40)
  const clean = { dirty: '', mainTip: a, originTip: a }
  assert.equal(checkoutVerdict({ ...clean, branch: 'main', head: a }).ok, true)
  assert.equal(checkoutVerdict({ ...clean, branch: 'HEAD', head: a }).ok, true, 'a deployment worktree is detached at the fetched main')
  assert.equal(checkoutVerdict({ ...clean, branch: 'HEAD', head: a, mainTip: b }).ok, true, 'and is held to origin/main, not to a local main that may lag')

  const behind = checkoutVerdict({ ...clean, branch: 'HEAD', head: b })
  assert.equal(behind.ok, false)
  assert.match(behind.reason, /not at origin\/main/)
  assert.match(checkoutVerdict({ ...clean, branch: 'HEAD', head: a, originTip: null }).reason, /no origin\/main/)
  assert.match(checkoutVerdict({ ...clean, branch: 'main', head: b }).reason, /not main's tip/)
  assert.match(checkoutVerdict({ ...clean, branch: 'hd/live-deploy', head: a }).reason, /on hd\/live-deploy, not main/)
  assert.match(checkoutVerdict({ ...clean, branch: 'main', head: a, dirty: ' M src/x.ts' }).reason, /uncommitted changes: {2}M src\/x\.ts/)
  assert.match(checkoutVerdict({ ...clean, branch: 'HEAD', head: a, dirty: '?? scratch' }).reason, /uncommitted/, 'detached does not excuse a dirty tree')
  assert.match(checkoutVerdict({ branch: null, head: null, dirty: null, mainTip: null, originTip: null }).reason, /not a git checkout/)
})

test('the judged service is the deployment unless a scratch label names another, and only a scratch one takes its port from the environment', () => {
  assert.deepEqual(serviceTarget({}, 'darwin'), { label: 'com.dtadpole.heddle-web', unit: UNIT, scratch: false, documentedPort: 3082 })
  assert.deepEqual(serviceTarget({}, 'linux'), { label: 'com.dtadpole.heddle-web', unit: UNIT, scratch: false, documentedPort: 8082 })
  // An environment variable alone must never change what the deployment is held to.
  assert.equal(serviceTarget({ HEDDLE_WEB_PORT: '9999' }, 'darwin').documentedPort, 3082)
  assert.equal(serviceTarget({ HEDDLE_WEB_LABEL: '', HEDDLE_WEB_UNIT: '' }, 'darwin').scratch, false, 'blank overrides are the deployment (96 blanks them)')
  const scratch = serviceTarget({ HEDDLE_WEB_LABEL: 'com.dtadpole.heddle-web.rehearsal', HEDDLE_WEB_PORT: '3096' }, 'darwin')
  assert.equal(scratch.scratch, true)
  assert.equal(scratch.documentedPort, 3096)
  assert.equal(plistPath({ HOME: '/h', HEDDLE_WEB_LABEL: 'com.dtadpole.heddle-web.rehearsal' }), '/h/Library/LaunchAgents/com.dtadpole.heddle-web.rehearsal.plist')
  assert.equal(unitPath({ HOME: '/h', HEDDLE_WEB_UNIT: 'heddle-web-rehearsal.service' }), '/h/.config/systemd/user/heddle-web-rehearsal.service')
})
