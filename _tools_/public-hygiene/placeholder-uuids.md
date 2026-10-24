---
title: Public hygiene placeholder UUIDs
created: 2026-10-24T05:00:36Z
modified: 2026-10-24T05:00:36Z
level: L2
version: 1.0.0
description: How the public-hygiene gate tells a placeholder UUID or near-UUID from a real id, under D-046 and the rule-22 ruling.
status: unverified
grounded_in:
  - source: the public-hygiene INDEX.md this was split from
---

# Placeholder UUIDs

A test must carry a well-formed id, and building one at runtime to slip past the gate is not allowed (D-044), so
the gate tells a placeholder from a real id.

## The D-046 rule

Ignoring the version nibble (the first hex digit of the third group) and the variant nibble (the first of the
fourth), a UUID is a **placeholder** when at least 29 of its remaining 30 hex digits are one and the same digit:
the nil UUID, `00000000-0000-4000-8000-000000000000`, the all-ones forms, each with or without one trailing
counter digit. A random UUID never meets that.

A match is exempt only when every UUID it overlaps is a placeholder; a match on a real UUID, or on text that is
not a full UUID (a vector with eleven digits or a `g` in it), is judged as before. The exemption is not tied to a
rule number, because numbers are lines of the private list and move when it is edited.

## Near-UUIDs

The coordinator's rule-22 ruling allows one widening beyond D-046: a **near-UUID**, a session-id-shaped token that
is not a valid UUID, whose groups may each be one character short or long and which may carry one non-hex
character, is a placeholder when every hex digit apart from the version and variant nibbles is one repeated digit
(no stray hex digit). That covers a parser's negative vectors written in placeholder digits; a stray hex digit, a
random-digit near-UUID or a sequential id stays caught.

## The gate's own comments

A change to the gate is judged by the gate already on main, so the gate's own comments describe these shapes in
words, never as literals.
