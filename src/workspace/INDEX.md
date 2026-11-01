---
title: Workspace
version: 1.2.0
description: Workspaces as target folders with records, the sessions grouped under them, and how a root came to exist.
grounded_in:
  - source: human-authored
---

# `workspace`

Holds [`service.ts`](service.ts), modelled on DSH's `dsh-workspace`. A workspace is a **target
folder** plus the record that says it is one:

```ts
{ id, path, title, origin, createdAt, updatedAt }
```

- `path` is the association key, and membership is **containment**: a session belongs to the nearest
  registered root at or above its `cwd` (`owner()`), not to the one whose path equals it. Nesting is
  therefore ordinary — a root inside another root owns what is under it, and the outer one owns the
  rest.
- `origin` says **how the root came to exist**. `added` is a folder a person registered; `auto` is a
  folder `bootstrap` or `ensureOwner` adopted because a session ran in it, which is what keeps "every
  session has a root" true without a hand-maintained list. The distinction is a view: the tree lists
  what a person chose, and adopted folders are reported apart as ad-hoc work. Registering an adopted
  folder **promotes** its record rather than writing a second one for the same path.
- Order lives in `workspaceIds` rather than in a field on each record, and a version-1 file that
  still carries the abandoned `sessionIds` array is read without it and written back without it.
  A new root is prepended; `insertBefore()` moves one root before another, or last, which is DSH's
  `workspace/insertBefore` and what the page's drag asks for (`POST /api/workspaces/insertBefore`).
  It rewrites that array and nothing else, so the file keeps the shape both builds read.

`remove()` exists because unregistering is not the same as forgetting: `bootstrap` re-creates a root
for any folder that has sessions and no owner, so a removed root that still holds sessions would come
back on the next run. It therefore refuses that case, naming the count; it removes a root whose
sessions an ancestor root will adopt (and reports which); and `force` removes anyway, leaving those
sessions to be re-registered.

## Read next

[`../INDEX.md`](../INDEX.md) for the source tree, and
[`../../_verifiers_/INDEX.md`](../../_verifiers_/INDEX.md) for the claims that decide it.
