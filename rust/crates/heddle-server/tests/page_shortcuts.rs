//! The session shortcuts in the page this binary serves match the physical key.
//!
//! The binary embeds `src/server/page.html` (`page::PAGE_SOURCE`), so the chords a person presses against the Rust
//! server are the ones written there. Chrome on a Mac applies Option to `KeyboardEvent.key` (⌥⌘A arrives as `å`,
//! ⌥⌘N as a dead key), so a table of letters never fired on a Mac; DSH's `dsh-client-shortcuts` matches `code` with an
//! abstract `Mod` (DSH parity R-developer-seven-7). The behaviour is judged in a browser by
//! `_verifiers_/80-web-ui/check-shortcut-keys.mjs` and executed by `test/page-shortcuts.test.ts`; this test is the
//! removal detector on the build that embeds the page, since there is no script engine here.

use heddle_server::page::PAGE_SOURCE;

/// The text from the shortcut table to the end of `shortcutFor`.
fn shortcut_source() -> &'static str {
    let start = PAGE_SOURCE
        .find("const SESSION_SHORTCUTS = [")
        .expect("the page has a SESSION_SHORTCUTS table");
    let from_start = &PAGE_SOURCE[start..];
    let matcher = from_start
        .find("function shortcutFor(")
        .expect("the page has a shortcutFor function");
    let end = from_start[matcher..]
        .find("\n}\n")
        .expect("shortcutFor ends at a closing brace on its own line");
    &from_start[..matcher + end + 2]
}

#[test]
fn every_chord_in_the_table_names_its_physical_key() {
    let source = shortcut_source();
    for (code, action) in [
        ("KeyA", "archive"),
        ("KeyG", "rename"),
        ("KeyK", "search"),
        ("KeyF", "fork"),
        ("KeyB", "sidebar"),
        ("KeyN", "new-session"),
        ("Comma", "settings"),
        ("KeyO", "add-workspace"),
        ("Slash", "shortcuts-reference"),
    ] {
        let entry = source
            .lines()
            .find(|line| line.contains(&format!("action: '{action}'")))
            .unwrap_or_else(|| panic!("the table has a {action} chord"));
        assert!(
            entry.contains(&format!("code: '{code}'")),
            "the {action} chord names {code}: {entry}"
        );
    }
}

#[test]
fn the_matcher_compares_the_code_and_reads_mod_by_platform() {
    let source = shortcut_source();
    assert!(
        source.contains("code !== '' ? code !== shortcut.code"),
        "the physical code decides whenever the event carries one"
    );
    assert!(
        source.contains("const primary = mac ? event.metaKey : event.ctrlKey"),
        "Mod is Command on a Mac and Control elsewhere"
    );
    assert!(
        source.contains("if (!primary || other) return null"),
        "the other of Command and Control is not part of any chord"
    );
    assert!(
        source.contains("event.key === 'Dead' && !(mac && code === 'KeyN'"),
        "a dead key fires nothing except ⌥⌘N on a Mac"
    );
    assert!(
        source.contains("getModifierState('AltGraph')"),
        "nothing fires under AltGraph"
    );
    assert!(
        source.contains("const SHORTCUTS_ON_MAC = /darwin|mac|iphone|ipad/iu.test(navigator.platform"),
        "a Mac is read as DSH reads it, from navigator.platform and without minding case"
    );
}

/// Two Escape presses within DSH's `stopSequenceMs` (500 ms) stop the running turn (DSH parity R-developer-seven-10).
#[test]
fn two_escape_presses_stop_the_running_turn() {
    assert!(PAGE_SOURCE.contains("const STOP_SEQUENCE_MS = 500"));
    assert!(PAGE_SOURCE.contains("function isStopSequence(previous, now)"));
    assert!(PAGE_SOURCE.contains("if (isStopSequence(stopEscapeAt, now) && anyRunning()) {"));
}

/// Mod+/ opens DSH's keyboard reference, one dialog titled Keyboard shortcuts (DSH parity R-developer-seven-11).
#[test]
fn the_keyboard_reference_is_one_dialog() {
    assert!(PAGE_SOURCE.contains("<dialog id=\"shortcut-reference\" class=\"ws-dialog\""));
    assert!(PAGE_SOURCE.contains("<h2 id=\"shortcut-reference-title\">Keyboard shortcuts</h2>"));
    assert!(PAGE_SOURCE.contains("function shortcutReferenceRows(query, mac)"));
}

/// A person can record, remove and restore a binding, kept per device in `heddle.keybindings.v1` as DSH keeps
/// `dsh.keybindings.v1` (DSH parity R-developer-seven-12). Executed by `test/page-shortcuts.test.ts`.
#[test]
fn bindings_are_recorded_as_overrides() {
    assert!(PAGE_SOURCE.contains("const KEYBINDINGS_KEY = 'heddle.keybindings.v1'"));
    assert!(PAGE_SOURCE.contains("function effectiveShortcuts(defaults, overrides)"));
    assert!(PAGE_SOURCE.contains("shortcutFor(event, { afterDeadKey: shortcutAfterDeadKey, table: activeShortcuts })"));
    assert!(PAGE_SOURCE.contains("<button type=\"button\" id=\"shortcut-restore-all\">"));
}
