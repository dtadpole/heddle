//! Where a session's log is filed: under the **workspace folder it belongs to**.
//!
//! Ported from `src/session/layout.ts`. The owner's ruling of 2026-10-11 —
//! `~/.heddle/sessions/<workspace>/<session-id>.v2.jsonl.zstd` — so a person who opens the store sees
//! whose logs they are before opening anything.
//!
//! The key is a **filing** decision and never an identity: it is lossy on purpose (two paths can share
//! one), the session id is the identity, and the meta record carries the canonical `cwd` beside it.

/// The folder a session with this working directory is filed under.
///
/// DSH's rule, restated: split on `/`, drop empty segments, join with `-`; every UTF-16 code unit
/// outside `[A-Za-z0-9._-]` becomes `~` (so a character outside the Basic Multilingual Plane becomes
/// `~~`, exactly as the JavaScript regex without the `u` flag does); keep the first 120 units; wrap the
/// result in `--…--`. An empty result is `--root--`.
///
/// ```text
/// /home/me/work/heddle  ->  --home-me-work-heddle--
/// /                     ->  --root--
/// ```
pub fn workspace_key(cwd: &str) -> String {
    todo!("port: layout.ts workspaceKey, counting UTF-16 code units")
}
