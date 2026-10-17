---
title: DSH Browser MCP
version: 1.0.0
description: How the DeepSeek Harness browser MCP exposes Chrome DevTools Protocol as tools, read from chrome-devtools-mcp 1.11.0 and the DSH MCP client.
grounded_in:
  - source: chrome-devtools-mcp 1.11.0 under ~/.npm/_npx/15c61037b1978c83 read on 2026-10-17
  - source: dsh-mcp-client 0.2.0-rc.2 under ~/.volta read on 2026-10-17
  - source: the live profile at ~/.dsh/profiles/web/cordis.patch.yml read on 2026-10-17
---

# DSH browser MCP

What the agent sees as `mcp__browser__*` is two layers: the
[`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp) server,
which owns 67 tools over Puppeteer and the DevTools frontend, and the DSH MCP client,
which connects to it over stdio and re-registers whichever tools the server advertises.
This report reads both from the installed copies and records the wire shapes a
reimplementation would have to reproduce.

## Paths and versions

- `CDM/` = `/Users/zhenc/.npm/_npx/15c61037b1978c83/node_modules/chrome-devtools-mcp/`
- `MCPC/` = `/Users/zhenc/.volta/tools/image/packages/@deepseek-ai/dsh/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-mcp-client/`
- `PROFILE/` = `/Users/zhenc/.dsh/profiles/web/`

`chrome-devtools-mcp` **1.11.0** (`CDM/package.json:3`) bundles Puppeteer 25.14.0, the
DevTools frontend models and Lighthouse 13.5.0 into `build/src/third_party/`.
`@deepseek-ai/dsh-mcp-client` **0.2.0-rc.2** (`MCPC/package.json`) is one bundled
`MCPC/lib/index.js` (835 lines). The live row is `PROFILE/cordis.patch.yml:231-239`; the
comment above it (`:218-230`) records that the browser is **headed** and **persistent**.
The package ships no tests or snapshot fixtures, so everything below is read from the
shipped JavaScript.

## The DSH side

### Registration and naming

`syncTools()` lists the server's tools and registers each one under a deterministic
public name (`MCPC/lib/index.js:127-161`):

```js
const joined = `mcp__${serverName}__${rawName}`;
const normalized = joined.replace(INVALID_NAME_CHARS, "_");
if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized;
```

When normalization or the 64-character limit changes the name, the result is truncated to
51 characters and suffixed with `_` plus the first 12 hex characters of
`sha256("<serverName>\0<rawName>")` (`MCPC/lib/index.js:96-102`).

`MAX_PUBLIC_NAME_LENGTH` is 64 and the allowed alphabet is `[A-Za-z0-9_-]`
(`MCPC/lib/index.js:64-72`). With `serverName: browser` every chrome-devtools-mcp name is
already clean and short, so the mapping is literally `mcp__browser__<rawName>` — for
example `mcp__browser__take_snapshot`, 27 characters, no hash. The raw name is kept
separately and only sent on the wire (`tools/call`); the public name is never parsed back
(`:56-60`).

The input schema is passed through untouched as the harness tool's `parameters`
(`MCPC/lib/index.js:185`). An `outputSchema` is used only if it passes
`assertSupportedJsonSchema`; otherwise the tool advertises an open object
(`:162-171`, `:200-220`).

### Transport and configuration

Stdio is the MCP SDK's `StdioClientTransport`, spawned with a scrubbed parent environment
plus the configured `env` (`MCPC/lib/index.js:26-48`). The browser row is:

```yaml
- id: mcp-browser
  name: "@deepseek-ai/dsh-mcp-client"
  config:
    serverName: browser
    transport: stdio
    command: /Users/zhenc/.volta/bin/npx
    args: ["-y", "chrome-devtools-mcp@1.11.0", "--userDataDir=/Users/zhenc/.cache/chrome-devtools-mcp/chrome-profile"]
    env:
      PATH: /Users/zhenc/.volta/bin:/usr/local/bin:/usr/bin:/bin
```

(`PROFILE/cordis.patch.yml:231-239`). No `--headless`, `--isolated`, `--slim`, category
or experimental flag is passed. `chrome-devtools-mcp` itself launches Chrome with
`channel: "chrome"`, `defaultViewport: null`, `pipe: true`, the given `userDataDir`, and
headed by default (`CDM/build/src/BrowserManager.js:226-274`); CDP therefore travels over
a pipe, not a WebSocket.

The server advertises only tools that are enabled: `#registerTool` calls
`registeredTool.disable()` when a category or condition flag is off
(`CDM/build/src/index.js:239-251`, `CDM/build/src/ToolHandler.js:90-118`). Under the DSH
row's default flags that is **32 of 67** tools. `--viaCli` is what keeps disabled tools
listed with an explanatory error; DSH does not pass it.

### Results and errors

`createExecutor` validates the MCP `CallToolResult`, projects its content, and turns
`isError` into a thrown error whose message is the joined text:
`const text = extractText(content, rawName); if (result.isError === true) throw new Error(text);`
(`MCPC/lib/index.js:226-254`). `extractText` joins text blocks with `\n`; image, audio and
resource blocks become placeholders (`:361-414`). DSH therefore never sees an MCP error
as a protocol error — it sees a failed tool call carrying the server's `Error: ...` line.

Screenshots are the one special case: a valid `image/*` block is decoded, admitted only
if the current model route declares image input, and saved to the attachment store;
otherwise the model sees
`[image unavailable: <mime>; <reason>; raw image data remains available to programmatic callers]`
(`MCPC/lib/index.js:304-353`). On a text-only route `mcp__browser__take_screenshot`
returns only that placeholder.

Per-call timeout defaults to 60 000 ms (`MCPC/lib/index.js:765`, `:787`), which is also
the server's own browser-connect timeout (`CDM/build/src/ToolHandler.js:81`).

## Tool inventory

The list below is the registered surface, derived by running the shipped
`createTools()` and applying the shipped flag defaults. `*` marks a required parameter.
Every tool marked “page” has `pageId` (number, required) injected ahead of its own
parameters by `definePageTool` when `pageIdRouting` is on, which is the default
(`CDM/build/src/tools/ToolDefinition.js:10-26`, `CDM/build/src/config/mcp-options.js:31-37`).

### Enabled under the DSH configuration (32)

| Tool | Parameters | Response |
|---|---|---|
| `list_pages` | — | `## Pages` list |
| `select_page` | `*pageId: number`, `bringToFront: boolean` | page list; focuses the tab when asked |
| `close_page` | `*pageId: number` | page list; refuses the last page |
| `new_page` | `*url: string`, `background: boolean`, `isolatedContext: string`, `timeout: integer` | page list |
| `navigate_page` page | `type: enum(url, back, forward, reload)`, `url: string`, `ignoreCache: boolean`, `handleBeforeUnload: enum(accept, dismiss)`, `initScript: string`, `timeout: integer` | success or failure navigation line, then page list |
| `resize_page` page | `*width: integer > 0`, `*height: integer > 0` | page list |
| `handle_dialog` page | `*action: enum(accept, dismiss)`, `promptText: string` | `Successfully accepted/dismissed the dialog`, page list |
| `wait_for` page | `*text: string[]` (min 1), `timeout: integer` | `Element matching one of [...] found.` then a snapshot |
| `click` page | `*uid: string`, `dblClick: boolean`, `includeSnapshot: boolean` | `Successfully clicked on the element` |
| `hover` page | `*uid: string`, `includeSnapshot: boolean` | `Successfully hovered over the element` |
| `fill` page | `*uid: string`, `*value: string`, `includeSnapshot: boolean` | `Successfully filled out the element` |
| `fill_form` page | `*elements: {uid: string, value: string}[]`, `includeSnapshot: boolean` | `Successfully filled out the form` |
| `type_text` page | `*text: string`, `submitKey: string` | `Typed text "<text>[ + <key>]"` |
| `press_key` page | `*key: string`, `includeSnapshot: boolean` | `Successfully pressed key: <key>` |
| `drag` page | `*from_uid: string`, `*to_uid: string`, `includeSnapshot: boolean` | `Successfully dragged an element` |
| `upload_file` page | `*uid: string`, `*filePaths: string[]` (min 1), `includeSnapshot: boolean` | `File uploaded from <paths>.` |
| `emulate` page | `networkConditions: enum(Offline, Slow 3G, Fast 3G, Slow 4G, Fast 4G)`, `cpuThrottlingRate: number 1-20`, `geolocation: string`, `userAgent: string`, `colorScheme: enum(dark, light, auto)`, `forcedColors: enum(active, none, auto)`, `prefersContrast: enum(more, less, custom, no-preference, auto)`, `prefersReducedMotion: enum(reduce, no-preference, auto)`, `viewport: string`, `extraHttpHeaders: string` (JSON object) | `Emulation configured successfully` plus one line per active setting |
| `take_snapshot` page | `verbose: boolean`, `filePath: string` | `## Latest page snapshot` + tree, or `Saved snapshot to <path>.` |
| `take_screenshot` page | `format: enum(png, jpeg, webp)` (default png), `quality: number 0-100`, `uid: string`, `fullPage: boolean`, `filePath: string` | one line + an image block, or `Saved screenshot to <path>.` |
| `evaluate_script` page | `function: string`, `sourcePath: string`, `format: enum(function, script)`, `args: string[]` (uids), `filePath: string`, `dialogAction: string`, `waitForStableDom: boolean` | fenced `json` block, or `Script ran on page. Output saved to <path>.` |
| `list_console_messages` page | `pageSize: integer`, `pageIdx: integer`, `types: string[]`, `includePreservedMessages: boolean`, `includeStackTraces: boolean`, `serviceWorkerId: string` | `## Console messages` + lines |
| `get_console_message` page | `*msgid: number` | detailed message block |
| `list_network_requests` page | `pageSize: integer`, `pageIdx: integer`, `resourceTypes: string[]`, `includePreservedRequests: boolean` | `## Network requests` + lines |
| `get_network_request` page | `reqid: number`, `requestFilePath: string`, `responseFilePath: string` | detailed request block |
| `get_css_styles` page | `*uid: string`, `pageSize: integer` (default 10), `pageIdx: integer` (default 0) | matched-rule tree, always paginated |
| `performance_start_trace` page | `reload: boolean` (default true), `autoStop: boolean` (default true), `ignoreCache: boolean`, `filePath: string` | trace summary, or `The performance trace is being recorded...` |
| `performance_stop_trace` page | `filePath: string` | trace summary |
| `performance_analyze_insight` page | `*insightSetId: string`, `*insightName: string` | formatted insight |
| `lighthouse_audit` page | `mode: enum(navigation, snapshot)` (default navigation), `device: enum(desktop, mobile)` (default desktop), `outputDirPath: string` | `## Lighthouse audit results` block |
| `screencast_start` page | `filePath: string` | `Screencast recording started...` |
| `screencast_stop` page | — | `The screencast recording has been stopped and saved to <path>.` |
| `take_heapsnapshot` page | `*filePath: string` | `Heap snapshot saved to <path>` |

`take_heapsnapshot` is advertised although the other memory tools are not: it is the only
`MEMORY`-category tool without the `memoryDebugging` condition (`CDM/build/src/tools/memory.js:39-62`).

### Present in the package, not advertised under DSH (35)

These are disabled by a category or condition flag, so DSH never lists them. Parameter
names are given for completeness; their exact zod types are in the cited tool files and
follow the same conventions as above.

| Group / flag | Tools and parameters |
|---|---|
| `--experimentalVision` | `click_at` `*x`, `*y`, `dblClick`, `includeSnapshot` |
| `--experimentalInteropTools` | `get_tab_id` |
| `--devtoolsComments` | `open_devtools`; `get_devtools_comments`; `resolve_devtools_comment` `*threadId`, `*replyText`; `reveal_in_devtools` `panelName`, `uid`, `reqid` |
| `--memoryDebugging` | `get_heapsnapshot_summary`, `get_heapsnapshot_details`, `get_heapsnapshot_class_nodes`, `get_heapsnapshot_retainers`, `close_heapsnapshot`, `get_heapsnapshot_retaining_paths`, `get_heapsnapshot_edges`, `get_heapsnapshot_dominators`, `compare_heapsnapshots`, `get_heapsnapshot_duplicate_strings`, `get_heapsnapshot_object_details`, `query_heapsnapshot_objects`, `analyze_heapsnapshot_contexts`. All require `*filePath`; most add `pageIdx`, `pageSize`, `maxNameLength`, and a `*nodeId`/`*id` or a class/property filter. |
| `--categoryExtensions` | `install_extension` `*path`; `uninstall_extension` `*id`; `list_extensions`; `reload_extension` `*id`; `trigger_extension_action` `*id` |
| `--categoryPwa` | `install_pwa` `*manifestId`, `*installUrlOrBundleUrl`, `displayMode`; `uninstall_pwa` `*manifestId`; `launch_pwa` `*manifestId`, `url`; `get_os_app_state` `*manifestId` |
| `--categoryExperimentalWebmcp` | `list_webmcp_tools`; `execute_webmcp_tool` `*toolName`, `*input` |
| `--categoryExperimentalThirdParty` | `list_3p_developer_tools`; `execute_3p_developer_tool` `*toolName`, `*params` |
| `--slim` (replaces the whole regular set) | `screenshot`; `navigate` `*url`; `evaluate` `*script` |

## Page identity and selection

Page ids come from a module-global counter starting at 1 and are never reused, not even
across reconnects (`CDM/build/src/McpContext.js:19-23`, `:415-430`); a stale id fails with
`No page found` (`McpContext.js:339-345`). A page is tracked by its CDP target:
`targetcreated` mints the `McpPage`, `targetdestroyed` disposes it
(`McpContext.js:83-106`). `createPagesSnapshot()` reconciles tracked pages against the
browser's targets, prunes orphans, and selects the first page only when the previous
selection is really closed, reporting
`Note: the previously selected page was closed.` (or `is no longer listed.`) and, when a
live page could be chosen, `Page N is now selected.` (`McpContext.js:431-465`,
`CDM/build/src/McpResponse.js:675-688`). A reconnect additionally notes that page ids
have changed (`McpResponse.js:568-572`).

The list format is one line per page (`McpResponse.js:663-703`, `:1212-1235`):

```
## Pages
1: Example Domain (https://example.com/) [selected]
2: about:blank isolatedContext=work
```

Id, then `Title (url)`; a page still carrying Chrome's URL placeholder shows the URL
alone, and a title over 50 characters is cut with `...`. `[selected]` marks the current
selection, ` isolatedContext=<name>` marks a named browser context, and extension pages
are split under `## Extension Pages` only when the extension category is on.

`new_page` creates a page — in a named isolated browser context when asked, created on
first use via `browser.createBrowserContext()` — initialises it, selects it, and runs the
server's URL policy check (`CDM/build/src/tools/pages.js:89-129`, `McpContext.js:193-211`). Same-named
contexts share cookies and storage; different names are fully isolated. `select_page`
resolves and initialises the page, makes it the selection, and with `bringToFront` calls
`Page.bringToFront` (`pages.js:29-58`). `close_page` appends
`The last open page cannot be closed. It is fine to keep it open.` instead of failing and
closes with `runBeforeUnload: false` (`McpContext.js:212-219`,
`CDM/build/src/tools/ToolDefinition.js:23`).

## The accessibility snapshot

### Capture

`TextSnapshot.create` asks Puppeteer for the accessibility tree of the page with iframes
included and `interestingOnly` mirroring `verbose`
(`CDM/build/src/TextSnapshot.js:78-86`):

```js
const rootNode = await page.pptrPage.accessibility.snapshot({
  includeIframes: true,
  interestingOnly: !verbose,
});
```

Puppeteer implements that with one `Accessibility.getFullAXTree` call for the main frame,
builds a node tree, and recurses into each `Iframe` node's content frame, attaching its
snapshot under the iframe node (`CDM/build/src/third_party/index.js:61068-61126`). With
`interestingOnly` a node is kept when it is a landmark, focusable, richly editable, busy,
live, modal, has an error message, details or a role description, is a control, or is a
named/described leaf outside a control (`third_party/index.js:61128-61140`,
`:61341-61365`); other nodes are dropped and their children lifted to the parent.

`verbose: true` disables that pruning; the tree then also contains ignored nodes and
`StaticText` leaves.

### uids

Ids are assigned during a depth-first walk (`TextSnapshot.js:88-131`):

```js
const uniqueBackendId = `${node.loaderId}_${backendNodeId}`;
const existingMcpId = uniqueBackendNodeIdToMcpId.get(uniqueBackendId);
id = existingMcpId ?? `${snapshotId}_${idCounter++}`;
```

- The prefix is a process-global snapshot counter starting at 1, incremented for every
  snapshot on any page (`TextSnapshot.js:60-63`, `:88`); the suffix is a per-walk counter.
  A first snapshot is `uid=1_0`; a later one might be `uid=7_3`.
- Ids are reused while `(loaderId, backendNodeId)` is unchanged, so a uid survives repeated
  snapshots on the same document. A cross-document navigation changes the loader id, so
  all uids change; unseen entries are dropped (`TextSnapshot.js:145-150`) and old uids
  fail.
- `option` nodes get their `name` copied into `value` because the AX node has no value
  (`TextSnapshot.js:120-127`).

### Text format

`SnapshotFormatter` prints one line per node, indented two spaces per depth
(`CDM/build/src/formatters/SnapshotFormatter.js:27-43`):

```
uid=1_0 RootWebArea "Example Domain" url="https://example.com/"
  uid=1_1 heading "Example Domain" level="1"
  uid=1_2 StaticText "This domain is for use in illustrative examples..."
```

- `uid=<id>` is always first.
- The role follows, except for `StaticText` (omitted) and `none` (rendered `ignored`).
- `"<name>"` follows when the node has a name.
- Remaining attributes are walked in sorted key order; booleans appear bare
  (`disabled`, `expanded`, `focused`, `selected`, ...), strings and numbers as
  `key="value"` (`level="1"`, `url="https://..."`). `id`, `role`, `name`, `elementHandle`,
  `children`, `backendNodeId` and `loaderId` are excluded
  (`SnapshotFormatter.js:68-104`, `:144-158`).
- If the node is the element selected in an open DevTools Elements panel, the line ends
  ` [selected in the DevTools Elements panel]`. When such a selection exists but pruning
  removed it, the output starts with a two-line note telling the reader to take a verbose
  snapshot (`SnapshotFormatter.js:15-20`).
- In non-verbose mode, a named node whose children are all un-nested `StaticText` whose
  concatenated text equals the node's name has those children suppressed, avoiding
  duplicate text (`SnapshotFormatter.js:44-58`).

There is no truncation and no line cap; size is bounded only by the page. `toJSON()`
returns the same tree as nested objects.

`take_snapshot` attaches the text under `## Latest page snapshot`
(`McpResponse.js:830-841`). With `filePath`, the text is written with a forced `.txt`
extension and the response is only `Saved snapshot to <path>.`
(`McpResponse.js:328-331`). `includeSnapshot: true` on an action, and `wait_for`, capture
a fresh snapshot at response time.

### uid to element

The snapshot keeps each AX node, and its `elementHandle()` adopts the node's
`backendDOMNodeId` back into the page via `DOM.resolveNode`
(`third_party/index.js:61383-61395`). Resolution is `this.textSnapshot.idToNode.get(uid)`
then `node.elementHandle()` (`CDM/build/src/McpPage.js:795-819`). Errors are
`No snapshot found for page <id>. Use take_snapshot to capture one.`,
`Element uid "<uid>" not found on page <id>.`, and
`Element with uid <uid> no longer exists on the page.` The last one covers a node removed
after the snapshot. Actions always resolve against the most recent snapshot object, so a
new `take_snapshot` invalidates uids that were not reused.

## Interaction semantics

Page-scoped tools are serialised behind one mutex (`CDM/build/src/ToolHandler.js:239-247`).
Each mutating tool wraps its work in `waitForEventsAfterAction`, which follows a dialog,
popups, main-frame navigation and DOM stability (`CDM/build/src/utils/WaitForHelper.js:134-302`):
a `MutationObserver` resolves after 100 ms of quiet, capped at 3 000 ms, both multiplied
by the CPU throttle rate; navigation is awaited for up to 3 000 ms times the network
multiplier. The result contributes `Page navigated to <url>.`, `## Opened pages` and
`Accepted/Dismissed a beforeunload dialog.` lines.

- **`click`** resolves the uid. If the AX role is `option` and this is not a double click,
  it first tries the native-select path: the option must sit in a non-multiple,
  non-disabled `<select>`, and be neither disabled nor inside a disabled `<optgroup>`;
  the tool then fills the select with the option's real `value` instead of clicking
  (`CDM/build/src/tools/input.js:96-133`, `:150-167`). Otherwise it does a locator click
  (`count: 2` for `dblClick`): Puppeteer scrolls it into the viewport, waits until its
  bounding box is stable and the element is enabled, then clicks the centre of its
  clickable box. A dialog opening during the click aborts the wait, and the tool reports
  `The element was clicked and it opened a dialog.`, leaving the dialog for
  `handle_dialog` (`input.js:75-95`, `:176-181`).
- **`fill`** has three branches (`input.js:339-407`): a `combobox` AX node with `option`
  children is matched by option *name* and the select is filled with the matched child's
  `value` (`:286-329`); a checkbox/radio/`role=switch` requires the string `"true"` or
  `"false"`; everything else is focused, assigned the string, and has `input` and
  `change` dispatched, with the locator timeout raised by 10 ms per character. A plain
  `<select>` is filled by option *value*.
- **`fill_form`** is that loop over `elements` inside one wait, stopping at the first
  element that opens a dialog and adding
  `Filling out the element with uid <uid> opened a dialog.` and, when relevant,
  `The remaining elements were not filled out.` (`input.js:503-544`).
- **`type_text`** sends real key events into whatever is focused
  (`page.keyboard.type`), then presses `submitKey` as a single key
  (`input.js:439-463`); it does not focus an element, and `submitKey` is not parsed for
  modifiers.
- **`press_key`** splits the string on `+`: the last token is the key, earlier tokens are
  modifiers held in order and released in reverse even on failure
  (`input.js:613-656`, `CDM/build/src/utils/keyboard.js:273-296`). `Control++` means key
  `+` with modifier `Control`. The valid set is the CDP `KeyInput` list plus single
  characters (`keyboard.js:7-263`); anything else throws
  `<key> is invalid. Valid keys are: ...`.
- **`hover`** scrolls the element into view and moves the mouse to its clickable point
  (`input.js:224-267`).
- **`drag`** scrolls the source into view, presses at its clickable point, moves to the
  target, waits 50 ms, releases over it (`input.js:464-502`). It is mouse-event drag, not
  HTML5 drag-and-drop with data transfer.
- **`upload_file`** sets the files on the element directly; if that fails it clicks the
  element and accepts the file chooser within 3 s (`input.js:545-612`). Paths resolve on
  the browser host, not the MCP host.
- **`handle_dialog`** accepts or dismisses the recorded dialog with optional prompt text
  and clears it; with no dialog it throws `No open dialog found`
  (`CDM/build/src/tools/pages.js:296-347`).
- **`wait_for`** races `aria/<value>` and `text/<value>` locators across every frame,
  returns on the first match, then attaches a snapshot
  (`CDM/build/src/tools/snapshot.js:40-62`, `McpPage.js:1074-1084`).

A dialog is recorded by a page-level listener. Tools defined with `blockedByDialog: true`
are checked before the handler and fail with `A dialog is open (<type>: <message>).`
(`McpPage.js:331-335`, `ToolHandler.js:287-289`); the response also carries an
`# Open dialog` section naming the type, message, prompt default and `handle_dialog` as
the way out (`McpResponse.js:646-665`). `list_pages`, the console/network tools,
`handle_dialog`, the screencast tools, `close_page`, `new_page` and `select_page` are not
blocked.

## Observation

### `take_screenshot`

Format defaults to `png` (from `--screenshotFormat` if set); `quality` applies only to
JPEG/WebP; `uid` and `fullPage` are mutually exclusive
(`CDM/build/src/tools/screenshot.js:196-205`). With `uid` the element's bounding box is
captured, with `fullPage` the scrollable page, otherwise the viewport, always with
`optimizeForSpeed: true` (`screenshot.js:227-253`). The response says
`Took a screenshot of node with uid "<uid>".`, `Took a screenshot of the full current page.`
or `Took a screenshot of the current page's viewport.`. With `filePath` the bytes go to a
forced `.png`/`.jpeg`/`.webp` file and the line becomes `Saved screenshot to <path>.`;
otherwise a base64 `image/<format>` block is attached, unless the bytes reach 2 000 000,
in which case they are written to a temporary file and its path is returned
(`screenshot.js:254-280`). The CLI downscale options compute a CDP clip scale; DSH passes
neither.

### `evaluate_script`

`function` and `sourcePath` are mutually exclusive (`CDM/build/src/tools/script.js:197-217`).
`format: "function"` (default) trims a trailing semicolon, wraps the source as
`(\n<source>\n)`, evaluates it to a function handle and returns
`JSON.stringify(await fn(...args))`; `format: "script"` evaluates classic source and
returns `JSON.stringify(value)` (`script.js:218-250`). `args` are uids resolved to element
handles and passed positionally; mixed frames are rejected with
`Elements from different frames can't be evaluated together.`, and `args` with `script`
format is rejected (`script.js:169-184`, `:263-273`). Output is
`Script ran on page and returned:` plus a fenced `json` block, or, with `filePath`, a
forced `.json` file and `Script ran on page. Output saved to <path>.`
(`script.js:251-261`). `dialogAction` (`accept`, `dismiss`, or a prompt response) defaults
to accept; `waitForStableDom` defaults true (`script.js:124-129`, `:184`). A
non-JSON-serializable return becomes `undefined`.

### Console messages

`list_console_messages` returns messages since the last navigation, or the last three
navigations plus the current one with `includePreservedMessages`
(`CDM/build/src/collectors/PageCollector.js:18-110`). The ring is newest-first, capped at
four navigations, each capped at 10 000 messages (`PageCollector.js:129-132`). Message
ids are a monotonic per-page counter and are the handle `get_console_message` takes.

Filterable types: `log, debug, info, error, warn, dir, dirxml, table, trace, clear,
startGroup, startGroupCollapsed, endGroup, assert, profile, profileEnd, count, timeEnd,
verbose, issue` (`CDM/build/src/tools/console.js:9-30`); `issue` selects DevTools
aggregated issues, everything else matches the CDP message type.

```
## Console messages
Showing 1-2 of 2 (Page 1 of 1).
msgid=1 [log] hello (1 args)
msgid=2 [error] boom (1 args)
  at handler (https://example.com/app.js:10:5)
Note: stack trace line and column numbers use 1-based indexing
```

Consecutive messages with the same type, text and argument count collapse with
` [N times]` (`CDM/build/src/formatters/ConsoleFormatter.js:149-178`). Stacks stop at 50
frames with `... and N more frames` (`:246-250`); the note appears only if some message
carries a stack. An empty page prints `<no console messages found>`
(`CDM/build/src/McpResponse.js:1097-1120`). `get_console_message` prints `ID: <id>`,
`Message: <type>> <text>`, `### Arguments` with `Arg #N: <value>`, and `### Stack trace`
(`ConsoleFormatter.js:228-243`).

### Network requests

`list_network_requests` emits `## Network requests`, the pagination header, and one line
per request (`CDM/build/src/formatters/NetworkFormatter.js:190-198`):

```
reqid=3 GET https://example.com/api/items [200]
reqid=4 POST https://example.com/api/items [pending] [selected in the DevTools Network panel]
```

Status is the HTTP status, the failure text, or `pending` (`NetworkFormatter.js:143-157`).
URLs over 255 characters are cut with `... <truncated>`. Requests are per navigation,
newest first, capped at 1 000, the navigation request itself being the first entry of the
new ring (`PageCollector.js:260-290`). `get_network_request` prints
`## Request <url>`, `Status:`, `### Request Headers` / `### Response Headers` with
`- name:value` lines, optional `### Request Body` and `### Response Body`,
`### Request failed with`, and an indented `### Redirect chain`
(`NetworkFormatter.js:200-241`). Bodies are capped at 10 000 characters with
`... <truncated>`; binary is `<binary data>`, empty is `<empty response>`, expired is
`<Response body not available anymore>` (`NetworkFormatter.js:8-9`, `:59-92`, `:158-179`).
Bodies can be saved to `.network-request` / `.network-response` files. Without `reqid` the
tool uses the request selected in the DevTools Network panel, or says
`Nothing is currently selected in the DevTools Network panel.`
(`CDM/build/src/tools/network.js:103-126`). Header redaction is opt-in and DSH does not
enable it.

### CSS

`get_css_styles` takes a uid and prints `Styles for <selector> (uid: "<uid>"):` plus an
indented cascade: matched rules with selectors and sources (`index:196`, `<style>`, file
name, `user agent stylesheet`), declarations tagged `[overloaded]`, `[invalid]` or
`[disabled]` when not winning, inline styles, inherited blocks, custom properties and
`@layer`/`@media`/`@container`/`@scope` wrappers (`CDM/build/src/tools/css.js:9-46`,
`CDM/build/src/formatters/CssFormatter.js:735-750`). It is always paginated because
`pageSize` (10) and `pageIdx` (0) have defaults, so every response starts with
`Showing 1-10 of N (Page 1 of M).` (`css.js:19-35`, `McpResponse.js:1133-1162`). This is
the one output built from the DevTools frontend's `CSSModel.getMatchedStyles` and cascade
models rather than plain CDP data; the formatter is 812 lines
(`CDM/build/src/McpPage.js:860-899`).

## Emulation and window size

`emulate` replaces the whole emulation state on each call; the only option that persists
when omitted is `extraHttpHeaders` (`CDM/build/src/tools/emulation.js:35-96`,
`McpPage.js:947-1059`). Each setting maps to a CDP/Puppeteer call:

| Option | Values | Effect |
|---|---|---|
| `networkConditions` | `Offline`, `Slow 3G`, `Fast 3G`, `Slow 4G`, `Fast 4G` | `Network.emulateNetworkConditions`; omitted disables throttling |
| `cpuThrottlingRate` | 1–20 | `Emulation.setCPUThrottlingRate`; 1 or omitted disables |
| `geolocation` | `"<lat>,<lon>"`, lat ±90, lon ±180 | `Emulation.setGeolocationOverride`; omitted resets to 0,0 |
| `userAgent` | string | `Emulation.setUserAgentOverride`; empty/omitted clears |
| `colorScheme` | `dark`, `light`, `auto` | `prefers-color-scheme` media feature |
| `forcedColors` | `active`, `none`, `auto` | `forced-colors` |
| `prefersContrast` | `more`, `less`, `custom`, `no-preference`, `auto` | `prefers-contrast` |
| `prefersReducedMotion` | `reduce`, `no-preference`, `auto` | `prefers-reduced-motion` |
| `viewport` | `"<w>x<h>x<dpr>[,mobile][,touch][,landscape]"` | `Emulation.setDeviceMetricsOverride`; omitted clears |
| `extraHttpHeaders` | JSON object string, `""` clears | `Network.setExtraHTTPHeaders` |

The viewport string is parsed strictly; bad width, height or dpr throws
`Invalid viewport width "...". Expected format '<width>x<height>x<devicePixelRatio>[,mobile][,touch][,landscape]' with a positive width.`
and the analogous height/dpr messages (`CDM/build/src/tools/ToolDefinition.js:37-63`).
Geolocation errors are equally specific (`:64-79`). Media features are always sent as a
set of four, with an empty value clearing a feature, because CDP replaces the whole list
(`McpPage.js:933-946`). Setting the viewport can force a reload, so timeouts are updated
first (`McpPage.js:1056-1058`).

Network throttling is rejected with
`Network throttling is not supported when network blocking (allowlist/blocklist) is configured.`
when the server has a URL allow/block list (`McpPage.js:950-955`); DSH configures none.

The response prefixes one line per active setting, for example
`Emulating network conditions: Slow 3G` plus
`Default navigation timeout set to 15000 ms`, `Emulating viewport: {...}`,
`Emulating CPU throttling: 4x slowdown` (`McpResponse.js:602-644`).

`resize_page` first normalises the OS window out of fullscreen/maximised (twice on
Ubuntu), then calls `Browser.setContentsSize` for the page's window; the window APIs are
wrapped in a try/catch because not every platform supports them
(`CDM/build/src/tools/pages.js:258-295`).

## Pagination, limits, truncation, timeouts

Pagination is shared (`CDM/build/src/utils/pagination.js:6-49`):

- No `pageSize` and no `pageIdx`: all items, `totalPages = 1`. Either option present:
  `pageSize` defaults to 20, index is 0-based, and an out-of-range index falls back to page
  0 with `Invalid page number provided. Showing first page.`
- The header is always `Showing <start>-<end> of <total> (Page <i> of <n>).`, with
  `Next page: <i>` / `Previous page: <i>` when applicable (`McpResponse.js:1176-1212`); an
  empty list prints `Showing 0-0 of 0 (Page 1 of 1).`
- Console pagination counts grouped messages; CSS always paginates at 10.

Limits and truncation:

| Where | Rule |
|---|---|
| Page title | 50 characters, `...` suffix (`McpResponse.js:1212-1217`) |
| Network URL in list | 255 characters, `... <truncated>` (`NetworkFormatter.js:8-9`, `:190-198`) |
| Network body inline | 10 000 characters, `... <truncated>` |
| Console stack trace | 50 frames, `... and N more frames` |
| Console ring | 10 000 messages per navigation (`PageCollector.js:129-132`) |
| Network ring | 1 000 requests per navigation (`PageCollector.js:260-262`) |
| Screenshot | ≥ 2 000 000 bytes goes to a temp file instead of an image block (`screenshot.js:271-274`) |

Timeouts:

- Default action timeout 5 000 ms × CPU factor; navigation timeout 10 000 ms × network
  factor × CPU factor (`McpPage.js:116-117`, `:1060-1073`). The network factors are
  1 / 2.5 / 5 / 10 for Fast 4G / Slow 4G / Fast 3G / Slow 3G (`WaitForHelper.js:307-320`).
- `timeout` on `new_page`, `navigate_page`, `wait_for` overrides; `<= 0` means “default”
  (`ToolDefinition.js:27-36`).
- The MCP layer bounds only the browser-connection wait, 60 000 ms
  (`ToolHandler.js:81`); a long `wait_for` is not cut by it. DSH adds its own 60 000 ms
  per call (`MCPC/lib/index.js:765`).

## Error conventions

Every handler error is caught into the response, appended as a final `Error: <message>`
line, and returned as an MCP result with `isError: true` — not as a JSON-RPC error
(`CDM/build/src/ToolHandler.js:295-310`, `McpResponse.js:1155-1168`). DSH turns that into a
failed tool whose message is the joined content, so the `Error:` prefix survives.

Messages worth reproducing verbatim, because callers branch on them:

| Situation | Text |
|---|---|
| Unknown page id | `No page found` |
| Last page close | `The last open page cannot be closed. It is fine to keep it open.` |
| Unknown uid | `Element uid "<uid>" not found on page <id>.` |
| No snapshot yet | `No snapshot found for page <id>. Use take_snapshot to capture one.` |
| Detached node | `Element with uid <uid> no longer exists on the page.` |
| Locator failure | `Failed to interact with the element with uid <uid>. The element did not become interactive within the configured timeout.` |
| Dialog open | `A dialog is open (<type>: <message>).` |
| No dialog | `No open dialog found` |
| Invalid uid+fullPage | `Providing both "uid" and "fullPage" is not allowed.` |
| Script args | `args cannot be used when format is "script".` |
| Mixed frames | `Elements from different frames can't be evaluated together.` |
| Toggle value | `Checkboxes, radio boxes and toggles require "true" or "false" value, but <v> was used` |
| Missing option | `Could not find option with text "<value>"` |
| Bad key | `<key> is invalid. Valid keys are: ...` |
| Bad page index | `Invalid page number provided. Showing first page.` |

Input schemas are `zod.object(...).strict()`, so an unexpected parameter or a wrong type
is rejected by the MCP SDK before the handler runs (`ToolHandler.js:208`).

## What a dependency-free CDP driver would have to build

| Capability | Today | Feasibility |
|---|---|---|
| Snapshot | Puppeteer `Accessibility.snapshot` over `Accessibility.getFullAXTree`, iframe recursion, interesting-node filter | **Easy.** Call `Accessibility.getFullAXTree` per frame, implement the interesting filter (the rules above) and the formatter. ~250 lines. |
| uid resolution | AX `backendDOMNodeId` adopted with `DOM.resolveNode` | **Easy.** Keep `uid → {backendNodeId, loaderId}`; resolve on demand. |
| Click/hover/fill/type/drag | Puppeteer `Locator`: scroll into the viewport, stable bounding box, enabled, click centre | **Moderate.** The CDP primitives are easy (`DOM.getBoxModel`, `Input.dispatchMouseEvent`); the hard part is the wait conditions, iframe offsets and the clickable box. 300–800 lines. |
| Key input | `Input.dispatchKeyEvent` with Puppeteer's key map | **Easy to moderate.** Need the same key list and modifier bitmask. |
| Dialogs | `Page.javascriptDialogOpening` + `Page.handleJavaScriptDialog` | **Easy.** |
| Screenshot | `Page.captureScreenshot`; element clip via box model | **Easy.** `fromSurface`, `captureBeyondViewport`, `clip.scale` are all CDP. |
| evaluate | `Runtime.evaluate` with `awaitPromise`, `returnByValue`, `DOM.resolveNode` for uid args | **Easy.** |
| Console | Puppeteer console/pageerror events; DevTools issues and symbolization | **Mostly easy.** `Runtime.consoleAPICalled`, `Runtime.exceptionThrown`, `Log.entryAdded` cover the list; `issue` grouping and source-mapped/linked stacks need DevTools code (omit or degrade). |
| Network | `Network.*` events, stable integer reqids, bodies | **Easy to moderate.** Request/response correlation, redirect chains and body expiry are the fiddly parts. |
| Emulation | CDP `Emulation.*`, `Network.*` | **Easy.** One-to-one mapping, except viewport reload behaviour. |
| CSS styles | DevTools `CSSModel.getMatchedStyles` and cascade formatting | **Hard.** `CSS.getMatchedStylesForNode` gives the raw material; ranking, `[overloaded]`, at-rule layers and container queries are ~800 lines of DevTools model logic in this package. Partial output is honest; full fidelity is not. |
| Performance trace | Puppeteer tracing + DevTools `PerformanceTraceFormatter` and insights | **Capture easy, analysis hard.** `Tracing.start`/`Tracing.end` + `Tracing.dataCollected` can save a raw trace; the summary, insight sets and `performance_analyze_insight` need the DevTools trace parser and are out of scope. |
| Lighthouse | Bundled Lighthouse 13.5 and `lighthouse-runner` | **Not feasible dependency-free.** Leave out or shell out to the real Lighthouse. |
| Screencast | Puppeteer `page.record` → `Page.startScreenRecording`, `IO.read` stream, `IO.close` | **Feasible.** Chrome produces MP4 on the stream; the driver copies chunks to a file. The legacy ffmpeg path is not needed. |
| Heap snapshot | `HeapProfiler.takeHeapSnapshot` streamed | **Capture easy.** The 13 analysis tools parse the `.heapsnapshot` with the DevTools heap worker and are not. |
| PWA / extensions / WebMCP / 3P tools | Browser-context and page-injected protocols, DevTools frontend | **Not feasible in a small driver.** They are off under DSH anyway. |
| Comments / selected element | DevTools frontend page (`devtools://`) and a patched `window.universe` bridge | **Not feasible.** The `[selected in the DevTools Elements panel]` marker and comment tools depend on an open DevTools UI. |
| Page ids / selection | Process-global counter, target tracking | **Easy.** A `Map<targetId, number>`; emit the same `## Pages` lines. |
| Response envelope | Markdown sections, pagination header, image blocks, `isError` | **Easy**, and necessary for an agent trained on these shapes. |

The shortest honest reimplementation keeps the envelope and the uid/snapshot contract,
uses CDP for snapshot, input, screenshot, script, console, network and emulation, and
deliberately omits CSS cascade formatting, performance insights, Lighthouse and heap
analysis.
