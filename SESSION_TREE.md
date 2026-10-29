---
title: Heddle Session Tree
level: L2
version: 1.2.0
description: How a workspace names a target folder, how a session is bound to a folder, and how that becomes a recursive tree in the Web UI's left column.
status: unverified
grounded_in:
  - source: owner statement in the dsh session, 2026-10-11, choosing containment, one session per folder, every folder in the tree, kind icons with type badges, and verifier 7 as the owner of the claim
  - source: owner statement in the dsh session, 2026-10-11, that a type folder is the boundary and a session node exists only where the type plus instance pattern matches
  - source: the installed DSH 0.2.0-rc.2 packages, read 2026-10-11 for the sidebar node model, the workspace-tree mode, and the lazy directory tree
  - source: the reflection conventions repository, read 2026-10-11 for the type and instance rules this tree renders
  - source: owner goal of 2026-10-28 to follow the DSH web GUI's workspace tree, which put the sessions under their workspaces
---

# The session tree

> **Superseded in part on 2026-10-28 (owner goal G2): the left column now follows DSH's workspace tree.** Workspaces
> are groups with **all** their sessions nested under them as rows (child workspaces first, five rows and `Show more`,
> pinned then last updated, an Ungrouped bucket for sessions no registered workspace owns), fed by `GET
> /api/workspaces` (each workspace's `parent` and `sessionIds`) and `GET /api/sessions`. The folder tree below is kept
> **under each workspace's sessions**, behind a `Files` heading, so §3's file rows and the file panel are unchanged; a
> session is no longer a folder row or a hoisted `_sessions_` row in it, because it is already a session row of its
> workspace. Membership (§2) and every route in §5 are unchanged. The page's grouping rules are the `workspace-tree`
> block in `src/server/page.html`, judged by `test/workspace-tree.test.ts` and
> `_verifiers_/80-web-ui/check-workspace-tree.mjs`.

Heddle has workspaces and sessions. What it does not have is a **navigation**: the Web UI lists
sessions flat, newest first, and a person looking for the conversation they had about one folder
finds it by its first prompt instead of by the folder it belongs to.

This document states the model that fixes that, and the decisions behind it. The claim is judged by
[`_verifiers_/70-workspaces-sessions/`](_verifiers_/70-workspaces-sessions/INDEX.md), which owns it.

## 1. Two models, and the one that was chosen

**DSH's model** (measured on the installed 0.2.0-rc.2 and confirmed against the running UI): a
workspace is a path, and a session is a member when its canonical `cwd` **equals** that path. A
session started in a subdirectory is not a member — it becomes a workspace of its own. The live
registry shows the consequence: `~/reflection` and `~/reflection/_projects_/ssh-controlmaster-ops`
are two entries at the same level. DSH's left column is flat (one row per workspace); its recursive
mode, `groupBy: "workspace-tree"`, nests **workspaces by path ancestry** and is off by default.

**Heddle's model** (the owner's choice, 2026-10-11): a workspace names a **target folder**, and a
session is bound to a **folder** at or below it. Membership is containment, the session's name is the
folder's name, and the left column renders the folder tree itself.

The reason to diverge is the thing being asked for: a tree of *folders* is not a tree of
*workspaces*, and forcing every folder that holds a conversation to become a workspace would make
the registry the navigation rather than the folder.

## 2. The model

**A workspace** is a record and a folder, as it is today: `{ id, path, title, createdAt, updatedAt }`
in `$HEDDLE_HOME/workspaces.json`, where `path` is the canonical absolute path of the target folder.
Newest first, as now.

**A session** keeps its `cwd` in `meta.json` and is bound to that folder. Nothing else about the
store changes: the log stays append-only under `$HEDDLE_HOME/sessions/<id>/`.

**Membership is containment, compared by path segment.** A session belongs to the workspace with the
**longest root that is an ancestor of its `cwd` (or equal to it)**. Segment-wise, never string-wise:
`/a/b-sibling` is not below `/a/b`.

**Roots may nest, and the nearest one owns the session.** Registering both `~/reflection` and
`~/reflection/_projects_/x` is allowed; a session in `.../x/deep` belongs to `.../x`. The outer root
renders the inner root as a child node of kind `workspace`, which is DSH's `owningParentFolder`
precedent read from its own code.

**One folder, one session.** The folder *is* the session:

- The first prompt in a folder creates the folder's session; every later prompt in that folder
  **continues** it. `heddle run --turn …` therefore means "ask this folder's session", not "start a
  new session".
- `--new` forces a fresh session for the folder; it becomes the folder's **current** session and the
  previous one becomes history. The history stays in the store, stays in `heddle sessions`, and stays
  readable by id (`heddle transcript <id>`); it simply has no node of its own.
- `--resume <id>` still addresses any session by id, whatever folder it was bound to.

**There is no separate session row in the tree.** A folder row *is* its session when it has one: its
label is the folder's name, and a marker on the trailing side says whether a session exists and how
many turns it holds. This is what "the session name is the instance name" means in practice, and it
is why a folder can never show two rows with the same name.

**A session row exists only for an instance.** The owner's rule of 2026-10-11: a `_type_` folder is
the **boundary**, and a folder is a place to work only where the `_type_` plus `<instance>` pattern
matches. A workspace root, a plain container (`shared/`, `src/`) and a type folder itself carry no
session row, and neither does a folder nested inside an instance — several levels of ordinary
structure may sit between a boundary and the `_type_` that follows it, and none of them is a place to
work. A session bound to such a folder is not lost: it is in the store, in `heddle sessions`, and in
its workspace's account; it is simply not a node of this tree, because the tree is a view of the
conventions' structure rather than a list of every conversation.

**A new root is still self-healing.** A run in a folder with no registered root above it registers
that folder as a root, so the existing bootstrap property survives: the record is derived from what
exists rather than maintained by hand.

## 3. The tree

The left column renders folders **and the files inside them**, folders first. This reverses the first
version of this section, which read *"files are not nodes; a leaf is reached by opening the transcript,
not by browsing"* — the owner asked for the files on 2026-10-11, and for clicking one to open its
content in the right panel. What the reversal keeps is the part that was really about navigation: a
file is a leaf that carries no session, and what nobody means by content (dot-entries, `node_modules`,
`__pycache__`) is still not enumerated at all.

**Node kinds.** Each node carries a `kind`, a `label`, an optional `badge`, and — for a folder that
has a session — the session's id, turn count and running flag.

| kind | What it is | How it is recognised |
|---|---|---|
| `workspace` | a registered root | present in `workspaces.json` |
| `type` | a type folder, and a **boundary** | the name matches `^_[a-z0-9]+(_[a-z0-9]+)*_$` |
| `instance` | an instance inside a type folder — **the only kind that carries a session** | its parent is a `type`, and the name matches `^[a-z0-9]+(-[a-z0-9]+){1,3}$` |
| `folder` | a plain content folder | anything else that carries an `INDEX.md` |
| `generated` | a folder a tool writes | named by the caller, exactly as the convention linter's `--generated` names it |
| `file` | a leaf, and the only kind that opens a **panel** rather than a conversation | not a directory; carries its size and no children |
| `session` | one session of the branch it sits in — a **hoisted** node, never a folder of its own | an instance inside a `_sessions_` folder, drawn as a child of that folder's parent |

A `type` may appear at any depth, including inside an instance (`_projects_/a-project/_context_/`),
and an `instance` may hold content and further type folders — the conventions place no depth limit,
and the observed maximum is four.

**The right panel follows the selection, and each kind of row behaves differently.** The owner's rules of
2026-10-11, and they are one idea: *the panel shows the thing that was chosen, and navigation is not a
choice of thing.*

| The row clicked | What happens to the tree | What the panel shows |
|---|---|---|
| a **session** | nothing: it is a **leaf**, and the files of its definition folder (`INDEX.md`, `session.json`) are never rows | that conversation, with `Chat` and `Trajectory` as its two views |
| a **file** | nothing | that file, and **only** its preview: no `Chat`, no `Trajectory`, no `Docs`, because all three are statements about a session and a file has none |
| anything else — a folder | it opens or closes | nothing changes: the panel keeps showing whatever it was showing |

**A session's menu is DSH's, and its list reads like DSH's.** The owner's instruction of 2026-10-17 was to
review how DSH works and make this UI work similarly, so the session row now offers what DSH's session menu
offers — `Pin`/`Unpin`, `Rename…`, `Archive`/`Unarchive` — and two things are missing on purpose: **delete**,
because this store's log is append-only and archiving is the reversible act, and **duplicate**, because a
session is a record of a run rather than a document.

What the two menus say about a session, and where each fact lives:

| Fact | Where | Why there |
|---|---|---|
| its **name** | the store's `title`, and the definition's `session.json` | a name is content: the committed record should call the session what its reader calls it |
| its **pin** and its **archive** | the store's meta only | reading state rather than facts about the run: in the definition, the tree and the store disagreed and sessions vanished |
| its **age** and turn count | the row (`6min`), the tooltip (the count) | DSH's list reads `context-mgmt 4d`; the age is what tells a reader which conversations are live |

A session **names itself from its first message** when nothing has named it — one line, shortened at a word —
because a list of clock names is a list nobody can scan. A title a person typed afterwards wins, because this
only fills a blank. And the tree has a **search** over those names, which DSH has above its session list: the
query filters *rows*, so the branches around a match stay where they are and the answer still shows where the
sessions are.

**A session's own `…` holds its name.** The owner's request of 2026-10-17: a session row offers
`Rename…`, which sets the session's **title** — the label a person reads — and the row then shows that
title instead of the folder it lives in. The folder stays the identity, and stays reachable as the row's
tooltip, because the conventions require an instance name and a person is not expected to type one. One
rename writes **both** halves: the store's meta record, which this UI and a listing read, and the session's
`session.json`, which is the record a reader of the repository reads — a rename that stopped at the store
would leave the committed definition calling the session something else.

**A conversation is shown once.** A session can be attached to a folder twice over — bound by its `cwd`, and
captured as an instance under that folder's `_sessions_` — and then the tree drew one conversation as two
rows, with the instance row coming first. Measured: clicking the session row moved the selection mark to the
instance row. A branch therefore drops its own binding when a definition under it names the same session:
the conversation belongs to the row that *is* the session, and the folder is only where it worked.

**A session can be created at any branch, the workspace root included.** The owner's rule of
2026-10-11: `heddle session new [<branch>]`, the `New session` item on a workspace or instance row, and
`POST /api/sessions` all start a session and write its **definition** into that branch, leaving the
transcript where logs live. A session created at the root is a session about the repository as a whole,
which is exactly what a person wants before they know which instance the work belongs to.

**A branch shows its sessions first, and never shows the folder that holds them.** The owner's rule of
2026-10-11: `_sessions_` is a **filing** folder rather than something a person navigates, so the tree does
not draw it at all — each session inside it becomes a `session` node directly under the branch it belongs
to, ahead of that branch's own folders and files, **newest name first** — the names are chronological by
construction, so a descending name order is a descending time order, and the session a person just started
is the one at the top. A `_sessions_` folder with no session in it therefore leaves no trace, which is
right: there is nothing to show. Asked for **by name** (`heddle tree
<branch>/_sessions_`), it still answers, and answers with sessions — the folder keeps its meaning even
where the tree declines to draw it.

**A row reads left to right as "what it is" then "what you can do".** The left carries the kind's
icon, the type's badge and the name, then the session marker and turn count; the right carries the
disclosure (`+` when closed, `−` when open) and, where there is anything to do, a `…` menu last of
all. Both controls moved to the right edge on the owner's instruction of 2026-10-11, and for the same
reason: a control that removes something must not sit a pixel away from the one that navigates, and
the eye should find the controls in one place rather than hunting a glyph that is sometimes left of
the name and sometimes right of it.

**Actions live behind the menu, never on the row.** A workspace root offers *Rename…* and
*Unregister*; an instance offers *New session here* and, once it has a conversation, *Rename
conversation…*; a type folder, a plain folder and a file offer nothing yet and therefore draw no menu
rather than an empty one. A rename keeps the path and changes only the label — for a workspace that is
the record's `title`, for a conversation the meta record's `title`, which is why the append-only log is
never rewritten by either. An empty name is refused rather than saved.

**The selected row is what the right panel is showing.** One idea rather than two: the panel shows a
conversation or a file, and the tree marks the row being shown — a left accent bar and a tint, not a
tint alone, because a tint is what hover already draws. Selecting a folder with a session, selecting a
folder without one, opening a file and switching back to Chat each move the mark, and exactly one row
carries it at a time. The session marker (`●`/`○`) stays a separate fact: it says whether a
conversation *exists* there, which is not the same question as which one is on screen.

**A file row carries no disclosure.** A file is a leaf: a `+` on it would promise children that cannot
exist, and clicking the row shows the file's content in the right panel instead.

**What is not enumerated.** Plumbing is hidden: dot-folders (`.git`, `.github`), `node_modules`,
`__pycache__`. A folder without an `INDEX.md` and without a session is still enumerated, because
walking into an instance requires passing through folders — but the Web UI dims a folder that has
neither an entry point nor a session, so a structurally wrong folder is visible rather than silent.

**The type vocabulary is optional enrichment, never a dependency.** The pattern above decides
`kind: "type"`. If configuration names a `type-vocabulary.md`, a type absent from it is marked
unregistered; with no vocabulary configured, nothing is claimed about registration. Heddle does not
hard-code a path into another repository.

**Badges.** A type's badge is the first three letters of its name with the vowels dropped, uppercased
(`_verifiers_` → `VRF`, `_tools_` → `TLS`, `_context_` → `CTX`, `_conventions_` → `CNV`), padded from
the full name when fewer than three letters remain. That rule keeps the three `_con..._` types apart,
which the first two letters do not. A name whose derived badge is not the one in use is listed as an
**override** in `badgeFor` — `_context_` is `CTX` because that is what a reader calls it, while the
derivation would say `CNT`.

**Icons are per kind, not per type.** One inline SVG per `kind`, plus a session marker and the
disclosure control. There are 27 registered types and 12 of them do not exist on this machine; a
glyph per type would be an invented picture with no reader, while a kind glyph plus the type's own
badge is decidable from the name.

**Expansion is explicit and remembered.** The disclosure control is a literal `+` when collapsed and
`−` when expanded, in a boxed 14px hit target, with `role="treeitem"` and `aria-expanded` on the row
and `role="group"` on the children. The whole row toggles; indentation is `depth * 14px`, and it is the row's
**content** inset rather than its box — the row's paint spans the panel's width at every depth, so the highlight does
not step inward with the tree. Expansion
is persisted in `localStorage` under `heddle.tree.expanded.v1`, keyed by absolute path, pruned when a
path disappears.

**The tree draws no list markers.** Every list inside it is a layout container: a node's children are
built into a `<ul role="group">`, and a style rule that named only `ol` left the browser's own defaults
on the nested level — `list-style-type: circle` and a 40px gutter — so each nested row carried a stray
dot at its left and the whole level was pushed in. Indentation is the tree's rule and nothing else's;
the browser check asserts that no list under `#tree` draws a marker, and that a nested row's offset is
the tree's own.

**A folder that turns out to be empty still opens and closes.** The first version disabled the control
and turned it into `·` once a folder had no children, and the owner hit it immediately: a leaf could be
opened and then had no control left to close it. Whether a folder is empty is only known *after*
asking, so the control cannot be the thing that reports it — the children area says `no folders inside`
in words, and `+` / `−` keep meaning what they say. A check now judges this in a browser, because no
API check could see it.

**Loading is lazy, one level at a time.** A node's children are fetched when it is first expanded;
`children: null` means "not asked for", `[]` means "asked for and empty". An empty type folder
(`_monitors_` with only its `INDEX.md`) is a type with no children, not an error.

## 4. Where each fact lives

| Fact | Home | Why there |
|---|---|---|
| a root folder, its title, the root order | `$HEDDLE_HOME/workspaces.json` | it is a record a person can read |
| a session's folder | `meta.json` `cwd` | already there; the log is the record |
| a session's transcript title | the log | already there, latest wins |
| **membership** | derived, from `cwd` containment over the roots | one fact in one place |
| a folder's session | derived, the newest session whose `cwd` equals the folder | one fact in one place |

**The record loses `sessionIds`.** Today the record stores an ordered account of session ids *and*
the session's `cwd` — two statements of the same membership, which can disagree, and one of which
cannot express the tree. With one session per folder the account carries nothing the folder does not,
so it goes. `heddle workspaces --json` still prints a `sessions` array, now derived; the field name
is kept because the checks and the CLI already read it.

## 5. Surfaces

**CLI**

| Command | Meaning |
|---|---|
| `heddle workspace add <path> [--title T]` | register a target folder as a root |
| `heddle workspaces --json` | the roots, newest first, each with its derived sessions |
| `heddle tree [<path>] --json [--generated NAME]…` | one level of the tree; no path lists the roots |
| `heddle file <path> --json` | a text file under a root, as the right panel shows it |
| `heddle workspace rename <id\|path> <name>` | retitle a root, leaving its path alone |
| `heddle run --turn T [--new]` | ask this folder's session, or start a new one for it |
| `heddle sessions --json` | every session, flat — unchanged, and the way history is reached |

`heddle tree` prints one level and prints `children: null` for the grandchildren it did not look at.
That is the same derivation the HTTP route serves, so the lazy rule is judged from the CLI and does
not need a browser.

**HTTP** (behind the existing token and fence)

| Route | Answer |
|---|---|
| `GET /api/tree` | the roots, one level |
| `GET /api/tree?path=<abs>` | one level under `<abs>`; `400` when the path is outside every root |
| `GET /api/file?path=<abs>` | a text file's content; `400` outside every root, `404` when it is not a file, `415` when it is not UTF-8 text |
| `POST /api/folders/session` `{folder, new?}` | the folder's current session, created when absent; `new` starts another |
| `PATCH /api/workspaces/<id\|path>` `{title}` | retitle a root; `400` on an empty name |
| `POST /api/sessions/<id>/title` `{title}` | retitle a conversation; the log is untouched |
| `GET /api/sessions`, `/api/sessions/<id>`, `/api/events`, `/api/turn` | unchanged |

`/api/turn` gains an optional `folder`; `session` still addresses a session directly.

**The file viewer.** A file row opens a third view beside Chat and Trajectory, showing the file's path,
its size, its line count and its text. Three refusals are sentences rather than an empty panel: a
directory is not a file, a binary is not text, and a file longer than **256 KB is truncated and says
so** rather than being refused — a big log is exactly what a reader opens. The reader is a **view**: it
never bypasses the sandbox, because a tool acting for a model still goes through the sandbox and the
approval policy, while this route is fenced by the token and by "under a registered root", checked on
the **canonical** path so a symlink resolving outside a root is refused rather than followed.

**Web UI.** The left column is the tree: disclosure, kind icon, type badge, label, session marker,
and a file row with no disclosure. Selecting a folder with a session loads its transcript through the
existing `/api/sessions/<id>` route; selecting one without a session opens the folder and the first
prompt creates it; clicking a file shows its content through `/api/file`.

## 6. Decisions, and what was rejected

- **Containment over equality.** *Rejected:* keeping DSH's equality rule and nesting workspaces for
  display. It would leave every instance folder as its own workspace, which is the registry growing
  to match the file system rather than the navigation shrinking to match the work.
- **One session per folder over many.** *Rejected:* a folder expanding to many session rows. Two rows
  with the same name is the ambiguity the owner asked to remove; history is reached by search and by
  `heddle sessions`, which is where a person looks for a conversation they cannot place.
- **A folder row that is its session**, rather than a folder row plus a session child. *Rejected:*
  a session child row, which doubles the tree and makes the folder's own row unselectable.
- **`sessionIds` dropped.** *Rejected:* keeping the stored account as a cache. The tree cannot be
  built from it, and a cache that can disagree with the store is how "which folder was that in"
  becomes unanswerable.
- **Kind icons plus a badge.** *Rejected:* a glyph per type; see §3.
- **`+` / `−` as the disclosure.** *Rejected:* DSH's hover-swapped chevron, which a person only sees
  when the pointer is already on the row they were looking for.
- **The vocabulary as configuration.** *Rejected:* reading `~/reflection/shared/_conventions_/…`
  by default, which would make heddle's tree depend on one machine's layout.

## 7. What judges it

[`_verifiers_/70-workspaces-sessions/`](_verifiers_/70-workspaces-sessions/INDEX.md) owns the claim,
per the owner's choice on 2026-10-11. Three of its checks changed and thirteen are added, for twenty
in the part:

- **Changed.** *a session in a subdirectory is not a member of its parent workspace* asserted the
  equality rule, which the owner reversed, so it now asserts containment and says why. *a session can
  be found again without knowing its id* assumed two runs in one folder make two sessions, which the
  one-session-per-folder rule reverses. *a session is grouped under the workspace whose folder it ran
  in* keeps its body and changes meaning, from equality to containment.
- **Added**, one per mechanism: containment; the segment-wise trap; the nearest root when roots nest;
  the same folder twice returns the same session; `--new` moves the folder's current session and
  keeps the old one readable; the tree lists one level; a type and its badge; an instance and its
  label; a type inside an instance; a plain container folder; plumbing hidden and generated named;
  **only an instance carries a session, and nested plain folders do not**; the folder's name is the
  session's label rather than its first prompt; an empty type folder.

**Built, 2026-10-11, in the session that wrote this document.** The mechanism landed with the design:
`heddle tree`, `heddle workspace add`, `--new`, the folder-bound session, the `/api/tree` and
`/api/folders/session` routes, and the left column itself. Part 7 reports `0` with twenty checks and
the other eleven verifiers stayed green; the rendering was read back from a real browser against a
fixture shaped like the conventions repository, rather than assumed from the code.

## 8. What this document does not decide

- The visual design of the icons, beyond "one per kind, 16px, currentColor".
- Where a flat, searchable list lives. The tree is the left column, and the sessions that are not on an
  instance — history, and a conversation started outside the conventions' structure — are reached
  through `heddle sessions`, `heddle transcript <id>` and the `/api/sessions` route. The page carries
  them in a collapsed **All sessions** disclosure under the tree so nothing vanishes from the UI; a
  search over them is still a later decision.
- How a browser check would judge the rendered tree. The roadmap's "a browser check" is still open,
  and every check here judges the derivation, which is where the mechanism lives.
- Renaming, deleting and reordering roots and folders; today a root can be added and sessions can be
  found, and nothing more is claimed.
