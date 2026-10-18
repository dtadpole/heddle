---
title: Agentcloud Auth
version: 1.0.0
description: How an agent gets an authenticated agentcloud page through the browser-use tool, including the UBK tap that completes its hardware-backed 2FA, and what does not work.
grounded_in:
  - source: owner statement in the dsh session, 2026-10-17, asking for the flow to be kept in _context_
  - source: the flow run through _tools_/browser-use on 2026-10-17, with the owner completing the password/WebAuthn step
  - source: ubk-trigger authority at ~/meditation/skills/ubk-trigger/SKILL.md
---

# `agentcloud-auth`

Instance of [`_context_`](../INDEX.md). Holds the **authentication flow** that gives an agent a live,
signed-in `agentcloud.internalmeta.com` page without holding a credential: the durable browser profile,
the SSO path through `login.internalmeta.com`, the UBK tap that completes the hardware-backed step, and
the routes that were measured **not** to work.

## What belongs in it

- This entry point: the profile path, the flow, the failure modes and how to verify the result.
- No credentials. The session lives in a Chrome profile the owner authenticated; the agent reuses the
  profile and never sees or stores a password.

## Why it exists

A UI comparison against agentcloud is only as good as the authenticated page it measures, and the
harness's browser MCP was removed from the Web profile on 2026-10-17 (see
[`../dsh-browser-mcp/INDEX.md`](../dsh-browser-mcp/INDEX.md)). The repository's own
[`_tools_/browser-use/`](../../_tools_/browser-use/INDEX.md) opens a fresh Chrome profile, which is not
signed in. The flow was worked out once, by the owner acting in the visible window plus the UBK tap, and
is recorded here so the next session repeats it instead of rediscovering the gate.

## The durable profile

| Item | Value |
|---|---|
| Profile | `~/.heddle-browser/chrome-profile` (copied from the tool's temporary profile after the owner signed in) |
| Environment | `HEDDLE_BROWSER_HOME=$HOME/.heddle-browser` for every `cli.mjs` call in the session |
| Verified | still signed in after a `stop` / `start` and after the copy (2026-10-17) |

Do not delete or rename it. The login is the owner's, it is not a repository secret, and it expires on
the same schedule as their browser session.

## The flow

1. **Start a visible browser.** `node _tools_/browser-use/cli.mjs start` (no `--headless`: the SSO and
   hardware step are window interactions). Export `HEDDLE_BROWSER_HOME` first when reusing the durable
   profile.
2. **Open the conversation.** `new_page` with the agentcloud conversation URL; an unauthenticated
   profile lands on
   `https://login.internalmeta.com/.auth/internalfb/login?next_uri=<agentcloud url>`.
3. **Follow the gateway.** `take_snapshot`, then `click` the snapshot's `link "Sign in with InternalFB"`
   (its target is `login.internalmeta.com/.auth/internalfb/oidc/authorize?…`), which redirects to
   `https://www.internalfb.com/login/…`. The page recognises the owner's account (`zhenc@meta.com`)
   and offers three ways forward: the **'VPNLess WWW' Chrome extension** with a hardware-backed
   certificate, the **password**, or — after a recent session — a 2FA reauth
   (`internalfb.com/intern/auth/reauth_2fac/?…`).
4. **The owner's part.** The password is typed by the owner in that window; the agent never receives it.
   The agent does not type credentials.
5. **The hardware tap.** For the reauth step, a **UBK tap** completes the hardware-backed 2FA. Confirm
   the machine first (all three measured present on 2026-10-17): the socket
   `/Users/zhenc/.devserver-maintenance/ubk-hid.sock`, the daemon `ubk-hid-captured` running,
   `hidutil list` showing `0x1050 0x407 YubiKey OTP+FIDO+CCID`, and `/dev/cu.usbserial-2120`. Then send
   `capture\n` to the socket. **The answer is not the verdict**: on 2026-10-17 the daemon replied
   `ERROR:no otp captured` while the servo tap completed Chrome's WebAuthn prompt — the press went to
   the FIDO interface, not to the OTP capture.
6. **Verify by the page, not by the reply.** `evaluate_script` →
   `() => ({ title: document.title, url: location.href })`. Success is a `location.href` on
   `agentcloud.internalmeta.com` with the conversation title (`Explain pSelect · Metamate 3` on
   2026-10-17); failure is still `login.internalmeta.com` or `www.internalfb.com/login`.

## What does not work (measured 2026-10-17)

- **Copying the owner's Chrome cookies or profile.** macOS TCC answers `Operation not permitted` for
  reads under `~/Library/Application Support/Google/Chrome/` (the cookie database is
  `<profile>/Cookies`, and the profiles on this machine are `Profile 1`, `Profile 2`, `Profile 3` —
  there is no `Default`). The durable profile above is the working substitute.
- **A fresh browser-use profile.** It is not signed in, and `chrome://policy` shows `ExtensionSettings`
  force-installing the internal extensions from
  `https://www.internalfb.com/intern/browser_extensions/chrome/update.xml`; the fresh profile does not
  yet have the **'VPNLess WWW'** extension, so the hardware-backed link reports it missing.
- **Copying the profile with `cp -R`.** It fails on the dangling `Singleton*` symlinks the stopped
  Chrome leaves behind (`readlink: …: No such file or directory`). `rsync -a` copies it, and the
  `Singleton*` files are deleted from the copy before the next start.

## Read next

[`../../_tools_/browser-use/INDEX.md`](../../_tools_/browser-use/INDEX.md) for the tool that drives the
profile; `~/meditation/skills/ubk-trigger/SKILL.md` for the trigger's own authority and caveats.
