---
title: 95-web-daemon — the four checks, the scratch service and the Rust branch
created: 2026-10-23T04:42:38Z
modified: 2026-10-23T05:30:26Z
level: L3
version: 1.1.0
description: What each of the four checks in check.mjs asserts, how the verifier judges a scratch service instead of the deployment, and why the Rust binary needs no second definition.
status: unverified
grounded_in:
  - source: _verifiers_/95-web-daemon/check.mjs and _tools_/web-daemon/service.mjs
  - source: D-042, the ui lane gate stops killing the live service
---

# The four checks, the scratch service and the Rust branch

1. **The agent definition is complete**, judged from the repository: a working directory, `KeepAlive`, a throttle,
   real log paths, arguments the installer renders (loopback host, the machine's port, the profile beside the
   checkout); an installer that fails loudly, offers status, restart and uninstall, replaces rather than duplicates,
   kickstarts after bootstrapping, and resolves the real interpreter rather than a shell shim.
2. **The Linux unit is complete**, read as values through a unit parser: the launcher on loopback with a port
   placeholder and the profile named, `WorkingDirectory`, `Restart=always` at a fixed `RestartSec` with no start
   limit, logs appended to a file, `HEDDLE_HOME`, `WantedBy=default.target`; an installer that reloads, enables,
   restarts, uninstalls with `--now` and checks lingering.
3. **This machine runs it**: the installed service is written for the documented port (3082 on macOS behind the
   8082 gate, 8082 on Linux), binds loopback, answers `/healthz` with this service's name and port, and still refuses
   the page and the API without a session. No installed service is unjudged.
4. **It stays up**: the process owning the port is killed and a new pid must answer within 20 s. Which layer replaces
   it — launchd, systemd, or `supervisor.mjs` — is not this check's business. Against the deployment it is
   **unjudged** unless `HEDDLE_95_KILL_DEPLOYMENT=1` says the kill is meant: four seats killed the owner's page by
   running 95 the plain way on 2026-10-22, the last a verifier loop at 22:20.

**Judging it without killing the owner's server.** Check 4 is a real kill, so against the deployment it is an outage
(the lane gate stopped that under D-042). When `HEDDLE_WEB_LABEL` names a scratch service, all four checks judge it
instead; `_tools_/web-daemon/rehearse.sh` installs one (`com.dtadpole.heddle-web.rehearsal`, port 3096) and runs this
verifier as its last claim. Only a scratch label lets `HEDDLE_WEB_PORT` set the documented port, so the environment
cannot weaken the deployment's claim.

**The Rust branch** is the same daemon pointed at the binary: `HEDDLE_BIN` makes the installer render the binary as
the program with the same arguments, and the supervisor runs it as it runs node. Checks 1 and 2 judge the rendered
definition and checks 3 and 4 the installed service, so no second verifier is needed; which page the binary serves
is `96-deployment`'s claim.
