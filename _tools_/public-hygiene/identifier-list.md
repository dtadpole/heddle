---
title: Public hygiene identifier list
created: 2026-10-24T05:00:36Z
modified: 2026-10-24T05:00:36Z
level: L2
version: 1.0.0
description: Where the private identifier list lives, its rule format, how a finding is redacted, and the one built-in rule.
status: unverified
grounded_in:
  - source: the public-hygiene INDEX.md this was split from
---

# The identifier list

The list is **private** and lives outside the repository. Its path is `--identifiers FILE`, else
`$HEDDLE_PUBLIC_HYGIENE_FILE`, else `~/.config/heddle/public-hygiene.txt`. The gate refuses to run — exit 2, never
a silent pass — when the list is missing, empty, unreadable, entirely comments, or inside the repository: an empty
gate is not a gate.

## Format

```
# one rule per line; a literal (matched case-insensitively) or re:<regex>
host-01
host-02
re:\bhost-[0-9]+\b
team-private/notes
re:token-[0-9a-f]{8}-
```

Those are placeholders, not the team's terms: the real list names the devservers, the owner's home directory,
the private tree paths, session ids and internal model aliases, and it is never committed.

## Who keeps it

The owner or the coordinator owns the file; the tool developer seeded it with the names already known to the
team. Its contents never go into a record or a message: add a term by line, then report only the rule number the
gate prints.

## Redaction

The gate never prints the list and never echoes a term: a finding shows the file and line with the match
replaced by `[redacted]`, and names the rule by its number in the list (`private 12 literal`), so the reader can
find it without the terminal history carrying it.

## The built-in rule

One built-in rule holds whatever the list says: a **private IPv4 address** (10/8, 172.16/12, 192.168/16). A
generic `/Users/<name>` rule is not built in, because a fixture or a placeholder legitimately carries one; the
name belongs in the private list. `--no-builtin` removes the built-in rule for a deliberate exception.

## Read next

[placeholder-uuids.md](placeholder-uuids.md) for the ids a match may be exempted for.
