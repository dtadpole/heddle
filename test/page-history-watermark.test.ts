import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
const page = readFileSync(join(import.meta.dirname, '..', 'src/server/page.html'), 'utf8')
const start = page.indexOf('function handleSessionPayload(')
const handler = page.slice(start, page.indexOf('\n}', start) + 2)
function state() {
  const calls: string[] = []
  const context = { calls, scheduleTreeRefresh() {}, scheduleGoalRefresh() {}, scheduleTodoRefresh() {},
    paintRunningMarks() {}, renderComposerState() {}, refreshRunningStatus() {}, updateStatusBar() {},
    refreshSessionStats() {}, settleChat() {}, renderSettledAnswers() {}, renderScheduleCards() {},
    pumpQueue: (id: string) => calls.push(`pump:${id}`), add: (kind: string, text: string) => calls.push(`${kind}:${text}`),
    settleReasoning() {}, noteCompletion() {}, markBranchable() {},
    messageContentText: () => 'user', contentAttachments: () => [],
  }
  return runInNewContext(`
    const transcriptLoads = new Map(), transcriptWatermarks = new Map([['S', 10]]), pendingInteractions = new Map();
    const current = 'S', composerKey = 'S', view = 'chat';
    const runningSessions = new Set(['S']), runningSince = new Map(), queues = new Map([['S', []]]);
    let liveRounds=0,liveRoundStartedAt=null;
    ${handler}
    ({ handle: handleSessionPayload, running: () => runningSessions.has('S'), calls })
  `, context) as { handle(value: unknown): void; running(): boolean; calls: string[] }
}
test('snapshot-covered completion still clears running state and pumps the queue', { timeout: 5000 }, () => {
  const h = state()
  h.handle({ session: 'S', event: { seq: 10, type: 'turn/completed' } })
  assert.equal(h.running(), false)
  assert.ok(h.calls.includes('pump:S'))
})
test('snapshot-covered text is not drawn twice, later text still arrives', { timeout: 5000 }, () => {
  const h = state()
  h.handle({ session: 'S', event: { seq: 9, type: 'assistant/chunk', chunk: { type: 'text-delta', text: 'old' } } })
  assert.equal(h.calls.length, 0)
  h.handle({ session: 'S', event: { seq: 11, type: 'assistant/chunk', chunk: { type: 'text-delta', text: 'new' } } })
  assert.deepEqual(h.calls, ['assistant:new'])
})
