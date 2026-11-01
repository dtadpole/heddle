---
title: Config
version: 1.0.0
description: The configuration system — layers, profiles, includes, environment references, validation and provenance.
grounded_in:
  - source: owner statement in the dsh session, 2026-10-11, asking for a properly designed config system
---

# `config`

Holds [`schema.ts`](schema.ts) and [`validate.ts`](validate.ts), which together decide what a
run's tree is. Modelled on how DSH composes a profile: an empty base, rows addressed by `id`,
patch layers over it, and an activation order driven by service availability rather than by row
order.

## The model

| Concept | What it is |
|---|---|
| layer | A YAML array of `insert`, `patch`, `remove` and `include` entries |
| profile | A named directory under `$HEDDLE_HOME/profiles/` holding a profile's layers |
| insert | Adds a row, which later layers address by `id` |
| patch | Restates a row's fields; **the last write wins**, and a patch replaces rather than merges |
| remove | Disables a row, leaving it visible in the composition rather than deleting it |
| include | Another layer file, resolved relative to the file that names it, with a cycle refused by path |
| `!env NAME` | A whole value from the environment, parsed so a number stays a number |
| `${NAME}` | Textual substitution inside a string, for a URL prefix or a path |

Three rules exist because their absence caused a real failure while building this:
a missing environment reference is an **error rather than an empty string**; a patch that names a
row no layer inserted fails **where it is written**; and a bad value fails with the **row and the
field** in the message. `heddle config --validate` enforces the third without starting anything,
`heddle config --origins` answers where each value came from, and `heddle profiles` lists what the
machine holds.

## Why provenance is kept

A composed tree is a tree nobody can read backwards: two layers say the same field and only the
result is visible. Recording which layer supplied each field costs one array per row and makes
"where did this come from" answerable, which is the question an operator actually has. DSH's
equivalent answer is the patch view the loader keeps; this is the same idea made printable.

## The plugin inventory

[`plugin-inventory.ts`](plugin-inventory.ts) is DSH's read-only `pluginInventory/list`, served as
`GET /api/plugin-inventory`: every non-group loader entry in loader order, with the module name **the layer
wrote** (paired back from the composed rows, because `boot` hands the loader a resolved `file://` URL), whether
it is enabled, and its fiber's phase, read from the loader on every request. There is no
`managementAvailable`, because nothing here can change the profile. The Rust port is `heddle-config`'s
`plugin_inventory`, over the rows and the loader's entries.

## Read next

[`../boot.ts`](../boot.ts) for what starts the composed tree, and
[`../../_verifiers_/05-config-system/INDEX.md`](../../_verifiers_/05-config-system/INDEX.md) for the
claim this decides.
