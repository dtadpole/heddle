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
    // `.split(sep)` with `sep === '/'` on POSIX: every empty segment — a leading slash, a doubled
    // slash, a trailing slash — disappears before the join, so none of them leaves a stray dash.
    let joined = cwd
        .split('/')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-");

    // The JavaScript regex is applied **per UTF-16 code unit** (it carries no `u` flag), so a
    // character above U+FFFF is two units and becomes two tildes. Counting and cutting in units is
    // what makes the 120-unit limit identical to `String.prototype.slice(0, 120)`; every kept unit is
    // ASCII, so no cut can ever split a surrogate pair.
    let mut readable = String::with_capacity(120);
    for (units, unit) in joined.encode_utf16().enumerate() {
        // The index **is** the unit count, so the cut is exactly `slice(0, 120)`.
        if units == 120 {
            break;
        }
        readable.push(match unit {
            0x41..=0x5A | 0x61..=0x7A | 0x30..=0x39 | 0x2E | 0x5F | 0x2D => char::from(unit as u8),
            _ => '~',
        });
    }

    if readable.is_empty() {
        "--root--".to_string()
    } else {
        format!("--{readable}--")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_path_becomes_its_segments_joined_by_dashes() {
        assert_eq!(
            workspace_key("/home/me/work/heddle"),
            "--home-me-work-heddle--"
        );
    }

    #[test]
    fn the_root_is_its_own_key() {
        assert_eq!(workspace_key("/"), "--root--");
        assert_eq!(workspace_key(""), "--root--");
        assert_eq!(workspace_key("///"), "--root--");
    }

    #[test]
    fn empty_segments_leave_no_stray_dash() {
        // A trailing slash and a doubled slash are the same directory; the key must not distinguish
        // them, or one folder would be filed under two workspace folders.
        assert_eq!(workspace_key("/a/b/"), "--a-b--");
        assert_eq!(workspace_key("/a//b"), "--a-b--");
        assert_eq!(workspace_key("/a/b/"), workspace_key("/a/b"));
    }

    #[test]
    fn what_a_filesystem_would_misread_becomes_a_tilde() {
        // Space, unicode, `:`, `~` itself and a backslash (the other platform's separator).
        assert_eq!(workspace_key("/a b/c:d"), "--a~b-c~d--");
        assert_eq!(workspace_key("/x~y"), "--x~y--");
        assert_eq!(workspace_key("/a\\b"), "--a~b--");
    }

    #[test]
    fn non_ascii_is_one_tilde_per_utf16_unit() {
        // `é` is one unit; each CJK character is one unit; an emoji is two.
        assert_eq!(workspace_key("/café"), "--caf~--");
        assert_eq!(workspace_key("/项目"), "--~~--");
        assert_eq!(workspace_key("/😀"), "--~~--");
        assert_eq!(
            workspace_key("/😀a"),
            "--~~a--",
            "the emoji's two units come before the letter"
        );
    }

    #[test]
    fn the_key_is_cut_at_a_hundred_and_twenty_units() {
        let long = format!("/{}", "a".repeat(200));
        let key = workspace_key(&long);
        let expected = format!("--{}--", "a".repeat(120));
        assert_eq!(key, expected);
        assert_eq!(key.len(), 124);
    }

    #[test]
    fn the_cut_counts_units_after_the_tildes() {
        // Four emoji are eight units, so 112 more letters fit; the rest is dropped.
        let long = format!("/😀😀😀😀{}", "b".repeat(200));
        let key = workspace_key(&long);
        let expected = format!("--{}{}--", "~".repeat(8), "b".repeat(112));
        assert_eq!(key, expected);
    }
}
