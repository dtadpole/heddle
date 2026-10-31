---
title: Server
version: 1.0.0
description: The Web UI — the HTTP surface, and the token that guards it.
grounded_in:
  - source: human-authored
---

# `server`

Holds [`web.ts`](web.ts) and [`token.ts`](token.ts). The server is `node:http` and
nothing else, binds loopback and refuses any other host, serves one page with no build
step, and takes its token the way DSH does: a per-process launch token in the printed URL,
exchanged at the root for an HttpOnly cookie signed with a persistent mode-600 secret.
`token.ts` is separate because the handshake, the cookie and the constant-time comparison
are worth reading — and checking — without a socket.

[`terminals.ts`](terminals.ts) holds the page's interactive terminals (live-testing issue #85): one shell per
terminal in a PTY from `script(1)`, owned by one session, confined like bash, bounded, and closed with its whole
process tree on close, archive, idle and shutdown. `web.ts` routes `/api/sessions/<id>/terminals` to it.

## Read next

[`../INDEX.md`](../INDEX.md) for the source tree, and
[`../../_verifiers_/INDEX.md`](../../_verifiers_/INDEX.md) for the claims that decide it.
