//! The few JavaScript behaviours the command layer reproduces, and the random ids it mints.
//!
//! The TypeScript build trims with `String#trim`, sorts names with `localeCompare`, builds an href with
//! `encodeURIComponent`, checks a session id with `/^session-[0-9a-f-]{36}$/i` and mints ids with
//! `node:crypto`. Each is a place a port silently differs, so each is written once, here, with its own tests.
//! The random ids are not secrets (a command id and an anonymous feedback id), so they come from the
//! standard library's randomly keyed hasher rather than from a new dependency.

use std::cmp::Ordering;
use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
use std::time::{SystemTime, UNIX_EPOCH};

/// Whether `c` is in JavaScript's `String#trim` set (`WhiteSpace` + `LineTerminator`).
pub fn is_space(c: char) -> bool {
    matches!(
        c,
        ' ' | '\t' | '\n' | '\u{0b}' | '\u{0c}' | '\r' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// `String#trim`, in JavaScript's whitespace set.
pub fn trim(text: &str) -> &str {
    text.trim_matches(is_space)
}

/// `encodeURIComponent(text)`: `A-Za-z0-9-_.!~*'()` kept, every other byte of the UTF-8 a `%XX`.
pub fn encode_uri_component(text: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = String::with_capacity(text.len());
    for &byte in text.as_bytes() {
        let c = byte as char;
        if c.is_ascii_alphanumeric()
            || matches!(c, '-' | '_' | '.' | '!' | '~' | '*' | '\'' | '(' | ')')
        {
            out.push(c);
        } else {
            out.push('%');
            out.push(HEX[(byte >> 4) as usize] as char);
            out.push(HEX[(byte & 0x0f) as usize] as char);
        }
    }
    out
}

/// Whether `id` is a session id as the store mints it: `^session-[0-9a-f-]{36}$`, case-insensitive.
pub fn is_session_id(id: &str) -> bool {
    const PREFIX: &str = "session-";
    let bytes = id.as_bytes();
    bytes.len() == PREFIX.len() + 36
        && bytes[..PREFIX.len()].eq_ignore_ascii_case(PREFIX.as_bytes())
        && bytes[PREFIX.len()..]
            .iter()
            .all(|byte| byte.is_ascii_hexdigit() || *byte == b'-')
}

/// Whether `text` has the shape of a UUID as `/^[0-9a-f-]{36}$/i` reads it.
pub fn is_uuid_shape(text: &str) -> bool {
    text.len() == 36
        && text
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
}

/// `left.localeCompare(right)` for command names (`[a-z][a-z0-9_-]*`).
///
/// ICU's root collation, which `localeCompare` uses, does not order these characters by their bytes: `_` sorts
/// before `-`, both before the digits, and the digits before the letters (measured with Node: `a a_ a_b a- a-b
/// a0 a1 a9b ab az b`). A name outside the rule falls back to its characters' code points after those.
pub fn locale_compare(left: &str, right: &str) -> Ordering {
    fn rank(c: char) -> (u32, u32) {
        match c {
            '_' => (0, 0),
            '-' => (1, 0),
            '0'..='9' => (2, c as u32),
            'a'..='z' => (3, c as u32),
            other => (4, other as u32),
        }
    }
    left.chars().map(rank).cmp(right.chars().map(rank))
}

/// A pseudo-random 64-bit number: a fresh randomly keyed SipHash over the time and a process-wide counter.
pub fn random_u64() -> u64 {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let mut hasher = RandomState::new().build_hasher();
    hasher.write_u64(COUNTER.fetch_add(1, AtomicOrdering::Relaxed));
    hasher.write_u128(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or(0),
    );
    hasher.write_u32(std::process::id());
    hasher.finish()
}

/// Eight lower-case hex digits, as `randomBytes(4).toString('hex')` writes them.
pub fn random_hex8() -> String {
    format!("{:08x}", random_u64() as u32)
}

/// A random version-4 UUID in its lower-case 8-4-4-4-12 shape, as `randomUUID()` writes it.
pub fn random_uuid() -> String {
    let mut bytes = [0u8; 16];
    bytes[..8].copy_from_slice(&random_u64().to_le_bytes());
    bytes[8..].copy_from_slice(&random_u64().to_le_bytes());
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trim_is_javascripts() {
        assert_eq!(trim("  hello there "), "hello there");
        assert_eq!(
            trim("\u{feff}\u{a0}x\u{2028}"),
            "x",
            "BOM, NBSP and LS are trimmed"
        );
        assert_eq!(
            trim("\u{85}x"),
            "\u{85}x",
            "NEL is not JavaScript whitespace"
        );
        assert_eq!(trim(" \t\n"), "");
    }

    #[test]
    fn an_href_segment_is_encoded_as_encode_uri_component_does() {
        assert_eq!(
            encode_uri_component("session-00000000-0000-4000-8000-000000000000"),
            "session-00000000-0000-4000-8000-000000000000"
        );
        assert_eq!(encode_uri_component("a b/c?é"), "a%20b%2Fc%3F%C3%A9");
        assert_eq!(encode_uri_component("!~*'()"), "!~*'()");
    }

    #[test]
    fn a_session_id_is_session_dash_a_uuid_shape() {
        assert!(is_session_id(
            "session-00000000-0000-4000-8000-000000000000"
        ));
        assert!(is_session_id(
            "SESSION-AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"
        ));
        assert!(!is_session_id("not-a-session"));
        assert!(!is_session_id(
            "session-00000000-0000-4000-8000-00000000000g"
        ));
        assert!(!is_session_id(
            "session-00000000-0000-4000-8000-000000000000/"
        ));
        assert!(!is_session_id(""));
    }

    #[test]
    fn names_sort_as_locale_compare_sorts_them() {
        let mut names = vec![
            "ab", "a-b", "a_b", "a1", "a9b", "a", "b", "a-", "a_", "az", "a0",
        ];
        names.sort_by(|left, right| locale_compare(left, right));
        assert_eq!(
            names,
            [
                "a", "a_", "a_b", "a-", "a-b", "a0", "a1", "a9b", "ab", "az", "b"
            ]
        );
        assert_eq!(locale_compare("goal", "goal"), Ordering::Equal);
    }

    #[test]
    fn random_ids_have_their_shapes_and_differ() {
        let hex = random_hex8();
        assert_eq!(hex.len(), 8);
        assert!(
            hex.bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        );
        let uuid = random_uuid();
        assert!(is_uuid_shape(&uuid), "{uuid}");
        assert_eq!(&uuid[14..15], "4", "version 4: {uuid}");
        assert!(
            matches!(&uuid[19..20], "8" | "9" | "a" | "b"),
            "variant: {uuid}"
        );
        assert_ne!(random_uuid(), random_uuid());
        assert_ne!(random_u64(), random_u64());
    }
}
