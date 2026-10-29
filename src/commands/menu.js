// The composer's slash-command menu, loaded by the page with `import('/commands/menu.js')` and installed over the
// composer's text field. Owner: developer-three (D-057); the page hands over at three points (src/commands/INDEX.md).
//
// Modelled on DSH's dsh-client-ui-input-trigger and dsh-client-ui-commands, re-read from its source on 2026-10-29:
// `/` at the caret opens a menu of the host's commands, grouped "Add" and "Commands" until something is typed; the
// arrows move (wrapping), Enter or Tab picks, Escape or Shift+Tab closes and leaves that token alone. A command that
// takes input becomes `/name ` with its hint shown; one that takes none runs at once. A run is never a prompt: the line
// goes to `POST /api/sessions/{id}/commands`, and only a line the host does not recognise goes on to the model.
//
// One deliberate difference: DSH's web client sends `/compact foo` to the model as a prompt (the host would refuse
// the argument, so the client never asks it). Here a registered command's name always reaches the host, which answers
// with its own usage sentence — a command's name is never something the model is asked about.

/** The line rule, the host's own (`src/commands/registry.ts`). */
const COMMAND_LINE = /^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/

/** DSH's empty-query sections and their order. Unlisted names follow in their section, by name. */
const SECTION_ORDER = { add: ['file', 'goal', 'plan', 'feedback'], commands: ['compact', 'permission', 'model', 'export'] }
const SECTION_TITLES = { add: 'Add', commands: 'Commands' }

/** What a claimed command shows while its input is still empty: DSH's composer hints. */
const INPUT_HINTS = {
  goal: 'describe the objective for a long-running task',
  plan: 'describe your task to generate plan',
  feedback: 'what would you like to tell us about this session?',
  permission: 'read-only, workspace-write or danger-full-access',
}

/**
 * The slash token the caret is in, or `null`.
 *
 * DSH's rule: scan left from the caret to whitespace; the token must start with `/` and hold no other `/` (a path
 * such as `/usr/bin` is not a command), and the `/` must open the draft or follow whitespace or punctuation — never a
 * word character or a `:` glued to a word, so `a/b` and `http://x` never open the menu.
 */
export function detectTrigger(text, caret) {
  let start = caret
  while (start > 0 && !/\s/.test(text[start - 1])) start -= 1
  const token = text.slice(start, caret)
  if (!token.startsWith('/') || token.indexOf('/', 1) !== -1) return null
  const query = token.slice(1)
  if (!/^[a-z0-9_-]*$/i.test(query)) return null
  const before = text.slice(0, start)
  return { start, end: caret, query, position: before.trim().length === 0 ? 'leading' : 'inline' }
}

/** Whether `query` is an ordered, case-insensitive subsequence of `value`. */
function subsequence(query, value) {
  let at = 0
  for (const character of value.toLowerCase()) {
    if (character === query[at]) at += 1
    if (at === query.length) return true
  }
  return query.length === 0
}

/**
 * The rows for a token: inline hides every command that takes input (DSH), an empty query is grouped, a typed one is
 * ranked — prefixes of the name or label first, then any subsequence match.
 */
export function candidates(catalog, trigger) {
  const visible = catalog.filter((entry) => trigger.position === 'leading' || entry.input === undefined)
  const query = trigger.query.toLowerCase()
  if (query.length === 0) {
    const rows = []
    for (const section of ['add', 'commands']) {
      const order = SECTION_ORDER[section]
      const members = visible
        .filter((entry) => entry.section === section)
        .sort((left, right) => rank(order, left.name) - rank(order, right.name) || left.name.localeCompare(right.name))
      for (const entry of members) rows.push({ ...entry, group: SECTION_TITLES[section] })
    }
    return rows
  }
  const prefix = visible.filter((entry) => entry.name.startsWith(query) || entry.label.toLowerCase().startsWith(query))
  const rest = visible.filter((entry) => !prefix.includes(entry) && (subsequence(query, entry.name) || subsequence(query, entry.label)))
  return [...prefix, ...rest].map((entry) => ({ ...entry, group: 'Commands' }))
}

function rank(order, name) {
  const index = order.indexOf(name)
  return index === -1 ? order.length : index
}

/**
 * Whether a submitted line belongs to the command layer rather than the model.
 *
 * A registered host command always does (its own handler refuses an argument it does not take). A page entry
 * (`/model`, `/file`) does only bare, as DSH's does. Anything else — an unknown `/word`, a path, prose — does not.
 */
export function claims(catalog, text) {
  const match = COMMAND_LINE.exec(text)
  if (match === null) return false
  const entry = catalog.find((candidate) => candidate.name === match[1])
  if (entry === undefined) return false
  if (entry.client === true) return text.trim() === `/${entry.name}`
  return true
}

/** The page entries DSH's composer adds beside the host's commands, offered only when the page can perform them. */
function clientEntries(api) {
  const entries = []
  if (typeof api.openFilePicker === 'function') {
    entries.push({ name: 'file', label: 'File', description: 'Attach a file to the message', section: 'add', client: true, run: api.openFilePicker })
  }
  if (typeof api.openModelMenu === 'function') {
    entries.push({ name: 'model', label: 'Model', description: 'Select the model for this conversation', section: 'commands', client: true, run: api.openModelMenu })
  }
  return entries
}

const STYLE = `
.hc-menu, .hc-hint { position: fixed; z-index: 60; background: var(--surface, #232324); color: var(--text, #f9fafb);
  border: 1px solid var(--border, #353535); border-radius: var(--radius-md, 12px); box-shadow: var(--shadow-menu, 0 2px 8px -2px #0003);
  font: 13px/1.4 var(--font, system-ui); }
.hc-menu { padding: 4px; max-height: 320px; overflow-y: auto; min-width: 280px; }
.hc-menu[hidden], .hc-hint[hidden] { display: none; }
.hc-group { padding: 6px 10px 2px; color: var(--chat-caption, #81858c); font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
.hc-row { display: flex; gap: 8px; align-items: baseline; padding: 6px 10px; border-radius: var(--radius, 8px); cursor: pointer; }
.hc-row[aria-selected="true"] { background: var(--hover, #2c2c2c); }
.hc-row .hc-name { font-weight: 600; }
.hc-row .hc-token, .hc-row .hc-args { font-family: var(--mono, ui-monospace); color: var(--chat-muted, #adb2b8); font-size: 12px; }
.hc-row .hc-desc { color: var(--chat-muted, #adb2b8); margin-left: auto; padding-left: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hc-hint { padding: 6px 10px; color: var(--chat-muted, #adb2b8); pointer-events: none; }
.hc-command { margin: 8px 0; padding: 8px 12px; border: 1px solid var(--border, #353535); border-radius: var(--radius, 8px);
  background: var(--surface, #232324); font: 13px/1.5 var(--font, system-ui); }
.hc-command .hc-head { display: flex; gap: 8px; align-items: baseline; }
.hc-command .hc-title { font-family: var(--mono, ui-monospace); font-weight: 600; }
.hc-command .hc-args { font-family: var(--mono, ui-monospace); color: var(--chat-muted, #adb2b8); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hc-command .hc-state { margin-left: auto; color: var(--chat-caption, #81858c); font-size: 12px; }
.hc-command .hc-text { margin-top: 4px; white-space: pre-wrap; color: var(--chat-secondary, #cfd3d6); }
.hc-command[data-state="error"] { border-color: #b4483f; }
.hc-command[data-state="error"] .hc-state { color: #e5786e; }
`

/**
 * Install the menu over the composer and answer the page's three hand-over points.
 *
 * `api` is what the page lends: `field` (the textarea), `anchor` (what the menu sits above), `sessionId()` (the
 * session the composer is attached to, or null), `ensureSession()` (start one when there is none), `sendAsPrompt(text)`
 * (the page's ordinary send, for a line the host does not recognise), `addRow(node)` (append to the transcript),
 * `notice(text)` (say something went wrong), and optionally `openFilePicker()` and `openModelMenu()`.
 */
export function install(api) {
  const field = api.field
  const anchor = api.anchor ?? field.closest('form') ?? field.parentElement
  let catalog = []
  let rows = []
  let selected = 0
  let trigger = null
  let dismissed = null
  const drawn = new Map()

  if (document.getElementById('hc-style') === null) {
    const style = document.createElement('style')
    style.id = 'hc-style'
    style.textContent = STYLE
    document.head.append(style)
  }
  const menu = document.createElement('div')
  menu.className = 'hc-menu'
  menu.id = 'slash-menu'
  menu.setAttribute('role', 'listbox')
  menu.setAttribute('aria-label', 'Commands')
  menu.hidden = true
  const hint = document.createElement('div')
  hint.className = 'hc-hint'
  hint.id = 'slash-hint'
  hint.hidden = true
  document.body.append(menu, hint)
  field.setAttribute('aria-controls', 'slash-menu')

  const ready = refresh()

  async function refresh() {
    try {
      const response = await fetch('/api/commands', { credentials: 'same-origin' })
      if (!response.ok) throw new Error(`the command list answered ${response.status}`)
      const body = await response.json()
      const host = Array.isArray(body.commands) ? body.commands : []
      catalog = [...host.map((entry) => ({ ...entry, client: false })), ...clientEntries(api)]
    } catch (error) {
      catalog = clientEntries(api)
      api.notice?.(`the command list could not be read: ${(error && error.message) || error}`)
    }
    update()
    return catalog
  }

  function place(element) {
    const box = anchor.getBoundingClientRect()
    element.style.left = `${Math.round(box.left)}px`
    element.style.bottom = `${Math.round(window.innerHeight - box.top + 6)}px`
    element.style.maxWidth = `${Math.round(Math.max(280, box.width))}px`
  }

  function close() {
    menu.hidden = true
    field.setAttribute('aria-expanded', 'false')
    trigger = null
    rows = []
  }

  function render() {
    menu.replaceChildren()
    let group = null
    rows.forEach((row, index) => {
      if (row.group !== group) {
        group = row.group
        const heading = document.createElement('div')
        heading.className = 'hc-group'
        heading.textContent = group
        menu.append(heading)
      }
      const option = document.createElement('div')
      option.className = 'hc-row'
      option.setAttribute('role', 'option')
      option.dataset.command = row.name
      option.setAttribute('aria-selected', index === selected ? 'true' : 'false')
      const name = document.createElement('span')
      name.className = 'hc-name'
      name.textContent = row.label
      const token = document.createElement('span')
      token.className = 'hc-token'
      token.textContent = `/${row.name}`
      option.append(name, token)
      if (row.input !== undefined) {
        const args = document.createElement('span')
        args.className = 'hc-args'
        args.textContent = row.input.hint
        option.append(args)
      }
      const description = document.createElement('span')
      description.className = 'hc-desc'
      description.textContent = row.description
      option.append(description)
      option.addEventListener('mousedown', (event) => {
        event.preventDefault()
        selected = index
        pick()
      })
      option.addEventListener('mousemove', () => {
        if (selected !== index) {
          selected = index
          render()
        }
      })
      menu.append(option)
    })
    menu.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }

  function update() {
    updateHint()
    const found = detectTrigger(field.value, field.selectionStart ?? field.value.length)
    if (found === null || (dismissed !== null && dismissed === found.start)) {
      if (found === null) dismissed = null
      close()
      return
    }
    const next = candidates(catalog, found)
    if (next.length === 0) {
      close()
      return
    }
    const sameToken = trigger !== null && trigger.start === found.start
    trigger = found
    rows = next
    if (!sameToken || selected >= rows.length) selected = 0
    place(menu)
    menu.hidden = false
    field.setAttribute('aria-expanded', 'true')
    render()
  }

  function updateHint() {
    const match = /^\/([a-z][a-z0-9_-]*)\s*$/.exec(field.value)
    const entry = match === null ? undefined : catalog.find((candidate) => candidate.name === match[1] && candidate.input !== undefined)
    if (entry === undefined || !/\s$/.test(field.value)) {
      hint.hidden = true
      return
    }
    hint.textContent = INPUT_HINTS[entry.name] ?? entry.input.hint
    place(hint)
    hint.hidden = false
  }

  function replaceToken(replacement) {
    const value = field.value
    field.value = `${value.slice(0, trigger.start)}${replacement}${value.slice(trigger.end)}`
    const caret = trigger.start + replacement.length
    field.setSelectionRange(caret, caret)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  }

  function pick() {
    const row = rows[selected]
    if (row === undefined || trigger === null) return
    if (row.client === true) {
      replaceToken('')
      close()
      row.run()
      return
    }
    if (row.input !== undefined) {
      replaceToken(`/${row.name} `)
      close()
      updateHint()
      field.focus()
      return
    }
    replaceToken('')
    close()
    void submit(`/${row.name}`)
  }

  document.addEventListener(
    'keydown',
    (event) => {
      if (event.target !== field || menu.hidden || rows.length === 0) return
      if (event.isComposing) return
      const keys = ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape']
      if (!keys.includes(event.key)) return
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'ArrowDown') selected = (selected + 1) % rows.length
      else if (event.key === 'ArrowUp') selected = (selected - 1 + rows.length) % rows.length
      else if (event.key === 'Escape' || (event.key === 'Tab' && event.shiftKey)) {
        dismissed = trigger?.start ?? null
        close()
        return
      } else {
        pick()
        return
      }
      render()
    },
    true,
  )
  field.addEventListener('input', update)
  field.addEventListener('click', update)
  field.addEventListener('keyup', (event) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'Home' || event.key === 'End') update()
  })
  field.addEventListener('blur', () => setTimeout(close, 120))
  window.addEventListener('resize', () => {
    if (!menu.hidden) place(menu)
    if (!hint.hidden) place(hint)
  })

  /** Run a submitted line on the host; a line the host does not recognise goes on to the model. */
  async function submit(text) {
    await ready
    hint.hidden = true
    const entry = catalog.find((candidate) => candidate.client === true && text.trim() === `/${candidate.name}`)
    if (entry !== undefined) {
      entry.run()
      return
    }
    try {
      let id = api.sessionId()
      if (id === null && typeof api.ensureSession === 'function') id = await api.ensureSession()
      if (id === null || id === undefined) throw new Error('open or start a session first')
      const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/commands`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ line: text }),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error ?? `the command answered ${response.status}`)
      if (body.matched !== true) {
        api.sendAsPrompt(text)
        return
      }
      draw({ type: 'command/run', commandId: body.commandId, name: body.name })
      draw({ type: 'command/done', commandId: body.commandId, kind: body.kind, ...(body.text !== undefined ? { text: body.text } : {}) })
      if (body.kind === 'success' && body.action?.kind === 'download' && typeof body.action.href === 'string') {
        const link = document.createElement('a')
        link.href = body.action.href
        link.download = ''
        link.hidden = true
        document.body.append(link)
        link.click()
        link.remove()
      }
    } catch (error) {
      if (field.value.trim() === '') field.value = text
      field.dispatchEvent(new Event('input', { bubbles: true }))
      api.notice?.(`the command could not run: ${(error && error.message) || error}`)
    }
  }

  /** The row a run is shown in, created on its first event. */
  function rowFor(commandId, name) {
    let row = drawn.get(commandId)
    if (row !== undefined && row.isConnected) return row
    // A history render leaves a placeholder where the row belongs, so the transcript keeps its order.
    const holder = [...document.querySelectorAll('.hc-command')].find((element) => element.dataset.commandId === commandId)
    if (holder !== undefined && holder.querySelector('.hc-head') !== null) {
      drawn.set(commandId, holder)
      return holder
    }
    const placed = holder !== undefined
    row = placed ? holder : document.createElement('div')
    row.className = 'turn hc-command'
    row.dataset.kind = 'command'
    row.dataset.commandId = commandId
    row.dataset.state = 'running'
    const head = document.createElement('div')
    head.className = 'hc-head'
    const title = document.createElement('span')
    title.className = 'hc-title'
    title.textContent = `/${name ?? 'command'}`
    const args = document.createElement('span')
    args.className = 'hc-args'
    const state = document.createElement('span')
    state.className = 'hc-state'
    state.textContent = 'Running…'
    head.append(title, args, state)
    const text = document.createElement('div')
    text.className = 'hc-text'
    row.append(head, text)
    drawn.set(commandId, row)
    if (!placed) api.addRow(row)
    return row
  }

  /** Draw a live `command/run` or `command/done` event; repeats of one event change nothing. */
  function draw(event) {
    if (typeof event.commandId !== 'string') return
    if (event.type === 'command/run') {
      const row = rowFor(event.commandId, event.name)
      if (typeof event.args === 'string') row.querySelector('.hc-args').textContent = event.args
      return
    }
    if (event.type === 'command/done') {
      const row = rowFor(event.commandId, event.name)
      const failed = event.kind === 'error'
      row.dataset.state = failed ? 'error' : 'done'
      row.querySelector('.hc-state').textContent = failed ? 'Command failed' : 'Completed'
      row.querySelector('.hc-text').textContent = typeof event.text === 'string' ? event.text : ''
    }
  }

  /** Draw a finished run from a session's history (`{kind: 'command', commandId, name, args?, state, text?}`). */
  function drawTurn(turn) {
    draw({ type: 'command/run', commandId: turn.commandId, name: turn.name, ...(turn.args !== undefined ? { args: turn.args } : {}) })
    if (turn.state === 'done' || turn.state === 'error') {
      draw({ type: 'command/done', commandId: turn.commandId, kind: turn.state === 'error' ? 'error' : 'success', ...(turn.text !== undefined ? { text: turn.text } : {}) })
    }
  }

  return {
    claims: (text) => claims(catalog, text),
    submit,
    draw,
    drawTurn,
    refresh,
    /** For a session switch: rows belong to the transcript that is being replaced. */
    forget: () => drawn.clear(),
  }
}
