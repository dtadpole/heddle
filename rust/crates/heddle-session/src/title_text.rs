//! How an accepted session title is cleaned: DSH's `normalizeSessionTitle`, ported from
//! `src/session/title-text.ts` (live-testing draft developer-six-1).
//!
//! `dsh-session-title` `lib/index.js:10-54` removes terminal control sequences (OSC, CSI, two-character
//! ESC), non-whitespace C0/C1 controls and the directional and invisible controls that can make a
//! displayed title deceptive, collapses whitespace into one trimmed line, and cuts the result to
//! `maxTitleBytes` UTF-8 bytes without splitting a code point; its `rename` applies the rule before
//! accepting a title (`:295-306`) and the controller answers `session/title-invalid` when nothing
//! visible is left (`dsh-api-session-controller` `lib/index.js:827-840`). `maxTitleBytes` is 80 in
//! DSH's shipped profile (`dsh-base/cordis.patch.yml:60-65`).
//!
//! The store applies it to a rename, to a session created with a title and to a definition's title,
//! so both builds write the same bytes. The character classes are the ones `hd/developer-eight-auto-title`
//! ports for a generated title (`title.rs`); once both land, that module can use these.

/// `session-title.maxTitleBytes` in DSH's shipped profile: the most UTF-8 bytes an accepted title holds.
pub const MAX_TITLE_BYTES: usize = 80;

/// DSH's refusal of a title with nothing visible left: the `session/title-invalid` code.
pub const TITLE_INVALID_CODE: &str = "session/title-invalid";

/// DSH's refusal of a title with nothing visible left, word for word (`SessionTitleInvalidError`).
pub const TITLE_INVALID_MESSAGE: &str = "session title must contain visible characters";

/// JavaScript's `\s` (with the `u` flag), which the TypeScript rule trims and collapses by.
fn is_js_space(character: char) -> bool {
    matches!(
        character,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// `/(?:\u001B\]|\u009D)(?:(?!\u0007|\u001B\\)[\s\S])*(?:\u0007|\u001B\\|$)/gu`: an OSC sequence runs to
/// the first BEL or ESC `\`, or to the end of the text.
fn strip_osc(chars: &[char]) -> Vec<char> {
    let mut out = Vec::with_capacity(chars.len());
    let mut index = 0;
    while index < chars.len() {
        let start = if chars[index] == '\u{1b}' && chars.get(index + 1) == Some(&']') {
            Some(index + 2)
        } else if chars[index] == '\u{9d}' {
            Some(index + 1)
        } else {
            None
        };
        let Some(mut at) = start else {
            out.push(chars[index]);
            index += 1;
            continue;
        };
        loop {
            match chars.get(at) {
                None => break,
                Some('\u{7}') => {
                    at += 1;
                    break;
                }
                Some('\u{1b}') if chars.get(at + 1) == Some(&'\\') => {
                    at += 2;
                    break;
                }
                Some(_) => at += 1,
            }
        }
        index = at;
    }
    out
}

/// `/(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/gu`: a CSI sequence with its parameters, intermediates and
/// final byte.
fn strip_csi(chars: &[char]) -> Vec<char> {
    let mut out = Vec::with_capacity(chars.len());
    let mut index = 0;
    while index < chars.len() {
        let start = if chars[index] == '\u{1b}' && chars.get(index + 1) == Some(&'[') {
            Some(index + 2)
        } else if chars[index] == '\u{9b}' {
            Some(index + 1)
        } else {
            None
        };
        if let Some(mut at) = start {
            while chars.get(at).is_some_and(|c| ('0'..='?').contains(c)) {
                at += 1;
            }
            while chars.get(at).is_some_and(|c| (' '..='/').contains(c)) {
                at += 1;
            }
            if chars.get(at).is_some_and(|c| ('@'..='~').contains(c)) {
                index = at + 1;
                continue;
            }
        }
        out.push(chars[index]);
        index += 1;
    }
    out
}

/// `/\u001B[@-_]/gu`: the remaining two-character ESC sequences.
fn strip_esc(chars: &[char]) -> Vec<char> {
    let mut out = Vec::with_capacity(chars.len());
    let mut index = 0;
    while index < chars.len() {
        if chars[index] == '\u{1b}'
            && chars
                .get(index + 1)
                .is_some_and(|c| ('@'..='_').contains(c))
        {
            index += 2;
            continue;
        }
        out.push(chars[index]);
        index += 1;
    }
    out
}

/// Non-whitespace C0/C1 controls, and the directional and invisible controls that can make a title
/// deceptive.
fn is_removed_control(character: char) -> bool {
    matches!(
        character,
        '\u{0}'..='\u{8}'
            | '\u{b}'
            | '\u{c}'
            | '\u{e}'..='\u{1f}'
            | '\u{7f}'..='\u{9f}'
            | '\u{200b}'
            | '\u{200e}'
            | '\u{200f}'
            | '\u{202a}'..='\u{202e}'
            | '\u{2060}'..='\u{2064}'
            | '\u{2066}'..='\u{206f}'
            | '\u{feff}'
    )
}

/// DSH's `cleanTitleText`: controls removed, then one trimmed line with whitespace runs collapsed to a
/// space.
pub fn clean_title_text(input: &str) -> String {
    let chars: Vec<char> = input.chars().collect();
    let chars = strip_esc(&strip_csi(&strip_osc(&chars)));
    let mut out = String::with_capacity(chars.len());
    let mut in_space = false;
    for character in chars.into_iter().filter(|c| !is_removed_control(*c)) {
        if is_js_space(character) {
            in_space = true;
            continue;
        }
        if in_space && !out.is_empty() {
            out.push(' ');
        }
        in_space = false;
        out.push(character);
    }
    out
}

/// The longest leading code-point prefix of `input` within `max_bytes` UTF-8 bytes (DSH's
/// `truncateTitleUtf8`).
pub fn truncate_title_utf8(input: &str, max_bytes: usize) -> String {
    if input.len() <= max_bytes {
        return input.to_string();
    }
    let mut end = 0;
    for (at, character) in input.char_indices() {
        if at + character.len_utf8() > max_bytes {
            break;
        }
        end = at + character.len_utf8();
    }
    input[..end].to_string()
}

/// DSH's `normalizeSessionTitle` at the shipped cap: a terminal-safe one-line title within
/// [`MAX_TITLE_BYTES`], possibly empty.
pub fn clean_session_title(input: &str) -> String {
    truncate_title_utf8(&clean_title_text(input), MAX_TITLE_BYTES)
        .trim_end_matches(is_js_space)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::definition::{
        DefinitionOptions, read_session_definition, update_session_definition,
        write_session_definition,
    };
    use crate::meta::CreateOptions;
    use crate::store::SessionStore;
    use heddle_config::Env;

    /// The cases `test/title-text.test.ts` pins, with the same answers.
    fn cases() -> Vec<(&'static str, String, String)> {
        vec![
            (
                "an ANSI colour sequence",
                "a\u{1b}[31mred\u{1b}[0m b".into(),
                "ared b".into(),
            ),
            (
                "an OSC title sequence",
                "x\u{1b}]0;evil\u{7}y".into(),
                "xy".into(),
            ),
            (
                "a newline and a tab",
                "line1\n\tline2".into(),
                "line1 line2".into(),
            ),
            (
                "a right-to-left override",
                "abc\u{202e}dcba".into(),
                "abcdcba".into(),
            ),
            (
                "a zero-width space",
                "zero\u{200b}width".into(),
                "zerowidth".into(),
            ),
            ("NUL and BEL", "nul\u{0}ctl\u{7}x".into(), "nulctlx".into()),
            ("a C1 control", "c1\u{85}here".into(), "c1here".into()),
            (
                "surrounding and inner runs of space",
                "  two   words  ".into(),
                "two words".into(),
            ),
            ("300 ASCII letters", "a".repeat(300), "a".repeat(80)),
            ("60 CJK characters", "字".repeat(60), "字".repeat(26)),
            (
                "a cut that would leave a trailing space",
                format!("{} b", "a".repeat(79)),
                "a".repeat(79),
            ),
        ]
    }

    fn file_title(path: &str) -> Option<String> {
        let value: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        value
            .get("title")
            .and_then(|title| title.as_str())
            .map(str::to_string)
    }

    #[test]
    fn a_rename_stores_the_title_cleaned_as_dsh_cleans_it_within_80_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().into_owned();
        let store = SessionStore::new(&format!("{root}/sessions"), &Env::default());
        let handle = store
            .create(CreateOptions {
                cwd: Some(root.clone()),
                ..Default::default()
            })
            .unwrap();
        for (what, sent, kept) in cases() {
            assert_eq!(clean_session_title(&sent), kept, "{what}");
            let meta = store.rename(&handle.id, &sent).unwrap().unwrap();
            assert_eq!(meta.title(), Some(kept.as_str()), "{what}");
            assert!(kept.len() <= MAX_TITLE_BYTES, "{what}: within the cap");
            assert_eq!(file_title(&handle.meta), Some(kept), "{what}: on disk");
        }
        let cleared = store
            .rename(&handle.id, " \u{200b}\u{7}\n ")
            .unwrap()
            .unwrap();
        assert_eq!(cleared.title(), None, "nothing visible left clears it");
    }

    #[test]
    fn a_session_created_with_a_title_stores_it_cleaned_and_a_blank_one_none() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().into_owned();
        let store = SessionStore::new(&format!("{root}/sessions"), &Env::default());
        let made = store
            .create(CreateOptions {
                cwd: Some(root.clone()),
                title: Some("made\u{1b}[31m red\u{1b}[0m\n\there \u{202e}".to_string()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(file_title(&made.meta).as_deref(), Some("made red here"));
        let blank = store
            .create(CreateOptions {
                cwd: Some(root.clone()),
                title: Some("\u{200b} \u{0}".to_string()),
                ..Default::default()
            })
            .unwrap();
        let text = std::fs::read_to_string(&blank.meta).unwrap();
        assert!(!text.contains("\"title\""), "no empty title key: {text}");
    }

    /// A title of only terminal sequences and whitespace has nothing visible left, so it is a blank
    /// title: the rename clears as three spaces do and a session created with it stores none (the Web
    /// route refuses it, verifier 70). The cases `test/title-text.test.ts` pins.
    #[test]
    fn a_title_of_only_control_or_escape_characters_is_cleaned_to_nothing_as_a_blank_one_is() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().into_owned();
        let store = SessionStore::new(&format!("{root}/sessions"), &Env::default());
        let handle = store
            .create(CreateOptions {
                cwd: Some(root.clone()),
                title: Some("kept title".to_string()),
                ..Default::default()
            })
            .unwrap();
        for (what, sent) in [
            ("three spaces", "   "),
            ("a clear-screen sequence and a tab", "\u{1b}[2J\t"),
            ("an empty window-title command", "\u{1b}]0;\u{7}"),
            (
                "a C1 control sequence, a reverse index and a line break",
                "\u{9b}31m\u{1b}M\r\n",
            ),
        ] {
            assert_eq!(
                clean_session_title(sent),
                "",
                "{what}: nothing visible is left"
            );
            let kept = store.rename(&handle.id, "kept title").unwrap().unwrap();
            assert_eq!(kept.title(), Some("kept title"));
            let cleared = store.rename(&handle.id, sent).unwrap().unwrap();
            assert_eq!(
                cleared.title(),
                None,
                "{what}: the rename clears, as a blank one does"
            );
            assert_eq!(
                file_title(&handle.meta),
                None,
                "{what}: no title key is left"
            );
            let made = store
                .create(CreateOptions {
                    cwd: Some(root.clone()),
                    title: Some(sent.to_string()),
                    ..Default::default()
                })
                .unwrap();
            let text = std::fs::read_to_string(&made.meta).unwrap();
            assert!(
                !text.contains("\"title\""),
                "{what}: a session created with it stores none: {text}"
            );
        }
    }

    #[test]
    fn a_definition_takes_the_same_cleaned_title_as_its_store_record() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().into_owned();
        let store = SessionStore::new(&format!("{root}/sessions"), &Env::default());
        let handle = store
            .create(CreateOptions {
                cwd: Some(root.clone()),
                ..Default::default()
            })
            .unwrap();
        let written = write_session_definition(
            &handle,
            &root,
            &DefinitionOptions {
                created_at: "2026-10-30T12:00:00.000Z".to_string(),
                title: Some("line1\n\tline2\u{202e}".to_string()),
                ..Default::default()
            },
        )
        .unwrap();
        let title = |dir: &str| {
            read_session_definition(dir)
                .unwrap()
                .title()
                .map(str::to_string)
        };
        assert_eq!(title(&written.dir).as_deref(), Some("line1 line2"));
        assert!(update_session_definition(&written.dir, Some(&"字".repeat(60))).unwrap());
        assert_eq!(title(&written.dir), Some("字".repeat(26)));
        assert!(update_session_definition(&written.dir, Some("\u{7}")).unwrap());
        assert_eq!(
            title(&written.dir),
            None,
            "nothing visible left deletes the key"
        );
    }
}
