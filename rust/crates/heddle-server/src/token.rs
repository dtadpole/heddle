//! The Web UI's door — the port of `src/server/token.ts`.
//!
//! Modelled on how DSH protects its own UI, and every part is deliberate:
//!
//! - **A per-process launch token** — 32 random bytes, base64url, generated when the server starts and
//!   never written anywhere. It is printed once in the URL, and presenting it at `/` exchanges it for a
//!   cookie.
//! - **A persistent signing secret** in a mode-600 file (`$HEDDLE_HOME/web-secret`), so a cookie survives a
//!   restart without the launch token being reusable. The mode is re-applied on every reuse.
//! - **A cookie bound to the authority**: `heddle-auth-<first 16 hex of sha256(host)>`, signed over
//!   `secret:authority:payload`, so a cookie minted for one Host is refused by another.
//! - **Constant-time comparison** for both secrets.
//!
//! **Byte-compatible with the TypeScript build**: the secret file, the cookie name and the cookie value are
//! the same bytes, so a cookie minted by `dist/server/token.js` with the same secret and authority verifies
//! here and the reverse. `_verifiers_/90-web-ui-token` mints one with the TypeScript module to judge the
//! stale-cookie page, which is why this matters.

use std::io;
use std::path::{Path, PathBuf};

use base64::Engine;
use sha2::{Digest, Sha256};

/// The query parameter the launch token is presented in.
pub const TOKEN_QUERY: &str = "token";
/// The version tag at the front of every cookie value.
pub const COOKIE_VERSION: &str = "v1";
/// Thirty days, matching the DSH default, in seconds.
pub const COOKIE_MAX_AGE: u64 = 60 * 60 * 24 * 30;
/// The file name of the signing secret inside the heddle home.
pub const SECRET_FILE: &str = "web-secret";

/// Where the cookie-signing secret lives: `$HEDDLE_HOME/web-secret`, else `~/.heddle/web-secret`.
///
/// Pure over its inputs so the rule is testable without touching the process environment;
/// [`default_secret_path`] is the same rule over the real environment.
pub fn secret_path_for(heddle_home: Option<&Path>, home: &Path) -> PathBuf {
    match heddle_home {
        Some(dir) => dir.join(SECRET_FILE),
        None => home.join(".heddle").join(SECRET_FILE),
    }
}

/// [`secret_path_for`] over `HEDDLE_HOME` and `HOME` as the process sees them.
pub fn default_secret_path() -> PathBuf {
    let heddle_home = std::env::var_os("HEDDLE_HOME").map(PathBuf::from);
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    secret_path_for(heddle_home.as_deref(), &home)
}

/// Expand a leading `~` to the home directory, because every path in this project may be written that way.
///
/// Like the TypeScript `expandHome`, only the first character is looked at: `~/x` and `~x` both expand.
pub fn expand_home(path: &str, home: &Path) -> PathBuf {
    match path.strip_prefix('~') {
        Some(rest) => PathBuf::from(format!("{}{}", home.display(), rest)),
        None => PathBuf::from(path),
    }
}

/// Thirty-two random bytes, base64url without padding — the same size and encoding DSH uses.
pub fn new_secret() -> String {
    let mut bytes = [0_u8; 32];
    // The OS entropy source failing is not a condition this server can recover from without a secret;
    // the TypeScript build's `randomBytes` throws for the same reason.
    getrandom::fill(&mut bytes).expect("the operating system entropy source");
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// The launch token for one process: generated per call and held only in memory by the caller, so a
/// restart invalidates every URL a previous run printed.
pub fn create_launch_token() -> String {
    new_secret()
}

/// Read the persistent signing secret, creating it on first use.
///
/// The file holds the secret and a newline; it is read trimmed. On reuse the mode is re-applied to 600
/// (a failure to chmod is ignored, as in the TypeScript build); on creation the parent directories are
/// created, the file is written, and the mode is set to 600 explicitly because the process umask masks the
/// creation mode.
pub fn read_or_create_secret(path: &Path) -> io::Result<String> {
    if let Ok(existing) = std::fs::read_to_string(path) {
        let existing = existing.trim().to_owned();
        if !existing.is_empty() {
            // Re-applied on every reuse, not only at creation: a secret copied in, restored from a
            // backup, or created by an older version must not stay world-readable.
            let _ = set_mode_600(path);
            return Ok(existing);
        }
    }
    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
    {
        std::fs::create_dir_all(parent)?;
    }
    let secret = new_secret();
    std::fs::write(path, format!("{secret}\n"))?;
    // `write`'s creation mode is masked by the process umask, so the mode is set again explicitly.
    set_mode_600(path)?;
    Ok(secret)
}

/// Set a file's mode to 600. `std::fs::set_permissions` is the portable spelling of `chmodSync(path, 0o600)`.
#[cfg(unix)]
fn set_mode_600(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn set_mode_600(_path: &Path) -> io::Result<()> {
    Ok(())
}

/// The SHA-256 of `value`, lower-case hex — the digest the cookie name and signature are built from.
fn sha256_hex(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    let digest = hasher.finalize();
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// The SHA-256 of `value`, base64url without padding — the signature encoding `digest('base64url')` writes.
fn sha256_base64url(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(hasher.finalize())
}

/// The cookie's name, bound to the authority it was minted for: `heddle-auth-<16 hex>`.
pub fn cookie_name(authority: &str) -> String {
    format!("heddle-auth-{}", &sha256_hex(authority)[..16])
}

/// Mint a cookie value for an authority: `v1.<issued-at ms>.<base64url sha256(secret:authority:v1.<issued>)>`.
///
/// The timestamp is inside the signed payload, so an expiry is enforced without server-side state and a
/// cookie cannot be extended by editing it.
pub fn mint_cookie(secret: &str, authority: &str, now_ms: u64) -> String {
    let issued = now_ms.to_string();
    let payload = format!("{COOKIE_VERSION}.{issued}");
    let signature = sha256_base64url(&format!("{secret}:{authority}:{payload}"));
    format!("{payload}.{signature}")
}

/// Whether a cookie value is one this server minted for this authority, and still fresh.
///
/// Three dot-separated parts, the right version, a signature that matches in constant time, and an age in
/// `0..=max_age_seconds` measured from `now_ms`. An issued time in the future is refused.
pub fn verify_cookie(
    value: &str,
    secret: &str,
    authority: &str,
    max_age_seconds: u64,
    now_ms: u64,
) -> bool {
    let parts: Vec<&str> = value.split('.').collect();
    if parts.len() != 3 {
        return false;
    }
    let [version, issued, signature] = [parts[0], parts[1], parts[2]];
    if version != COOKIE_VERSION || issued.is_empty() || signature.is_empty() {
        return false;
    }
    let expected = sha256_base64url(&format!("{secret}:{authority}:{version}.{issued}"));
    if !safe_equal(signature, &expected) {
        return false;
    }
    let Ok(issued_ms) = issued.parse::<u64>() else {
        return false;
    };
    // `Number.isFinite(age) && age >= 0 && age <= maxAge` — a future stamp is a negative age.
    if issued_ms > now_ms {
        return false;
    }
    now_ms - issued_ms <= max_age_seconds.saturating_mul(1000)
}

/// Compare two strings without leaking where they differ. Unequal lengths are unequal, answered first.
pub fn safe_equal(left: &str, right: &str) -> bool {
    let left = left.as_bytes();
    let right = right.as_bytes();
    if left.len() != right.len() {
        return false;
    }
    let mut difference = 0_u8;
    for (a, b) in left.iter().zip(right) {
        difference |= a ^ b;
    }
    difference == 0
}

/// The `Set-Cookie` line for a freshly minted cookie:
/// `<name>=<value>; Path=/; HttpOnly; SameSite=Strict; Max-Age=<seconds>`.
pub fn cookie_header(authority: &str, value: &str, max_age_seconds: u64) -> String {
    format!(
        "{name}={value}; Path=/; HttpOnly; SameSite=Strict; Max-Age={max_age_seconds}",
        name = cookie_name(authority)
    )
}

/// Read one cookie out of a request's `Cookie` header.
///
/// Parts are split on `;` and trimmed; the value is everything after the first `=` (so a value may itself
/// contain `=`), and a part with no `=` whose key matches reads as the empty string.
pub fn read_cookie<'a>(header: Option<&'a str>, name: &str) -> Option<&'a str> {
    let header = header?;
    for part in header.split(';') {
        let part = part.trim();
        match part.split_once('=') {
            Some((key, value)) if key == name => return Some(value),
            Some(_) => {}
            None if part == name => return Some(""),
            None => {}
        }
    }
    None
}

/// The milliseconds since the Unix epoch, as `Date.now()` reports them.
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// What a request presented.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Credentials<'a> {
    /// The value of the cookie named for this authority, when the request carried one.
    pub cookie: Option<&'a str>,
    /// The `?token=` query parameter, when present.
    pub query: Option<&'a str>,
}

impl Credentials<'_> {
    /// What the request offered, independent of whether it was accepted — a refusal says which it was.
    pub fn offered(&self) -> Offered {
        Offered {
            cookie: self.cookie.is_some(),
            token: self.query.is_some(),
        }
    }
}

/// Which credentials a request offered, so a refusal can tell "missing" from "stale".
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Offered {
    pub cookie: bool,
    pub token: bool,
}

/// The secrets one server compares against.
#[derive(Debug, Clone, Copy)]
pub struct Door<'a> {
    pub launch_token: &'a str,
    pub secret: &'a str,
    pub authority: &'a str,
    pub now_ms: u64,
}

/// Whether a request may proceed, and why not when it may not.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Allowed,
    /// Refused; the reason is `"authentication required"`, as in the TypeScript build.
    Refused {
        reason: &'static str,
    },
}

impl Decision {
    pub fn is_ok(&self) -> bool {
        matches!(self, Decision::Allowed)
    }
}

/// Decide a request: it passes if the cookie verifies **or** the query token equals the launch token.
///
/// The cookie is checked first; both comparisons are constant-time.
pub fn authorize(credentials: &Credentials<'_>, door: &Door<'_>) -> Decision {
    if let Some(cookie) = credentials.cookie
        && verify_cookie(
            cookie,
            door.secret,
            door.authority,
            COOKIE_MAX_AGE,
            door.now_ms,
        )
    {
        return Decision::Allowed;
    }
    if let Some(query) = credentials.query
        && safe_equal(query, door.launch_token)
    {
        return Decision::Allowed;
    }
    Decision::Refused {
        reason: "authentication required",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The vector `/usr/bin/node` prints for the TypeScript module, so the two builds are compared to
    /// each other rather than to an opinion:
    ///
    /// ```text
    /// mintCookie('secret', '127.0.0.1:3082', 1700000000000)
    /// cookieName('127.0.0.1:3082')
    /// ```
    const VECTOR_AUTHORITY: &str = "127.0.0.1:3082";
    const VECTOR_SECRET: &str = "secret";
    const VECTOR_NOW: u64 = 1_700_000_000_000;

    #[test]
    fn cookie_name_is_the_authority_digest_not_a_constant() {
        assert_eq!(
            cookie_name(VECTOR_AUTHORITY),
            "heddle-auth-09075b88f37cf2e6"
        );
        assert_ne!(cookie_name("127.0.0.1:3082"), cookie_name("localhost:3082"));
    }

    #[test]
    fn minted_cookie_matches_the_typescript_vector() {
        assert_eq!(
            mint_cookie(VECTOR_SECRET, VECTOR_AUTHORITY, VECTOR_NOW),
            "v1.1700000000000.y0MDpUlsVJ6sm2hmAEvtnw8ZvUKA1WhcxfNyQ_Nx3wk"
        );
    }

    #[test]
    fn a_cookie_verifies_only_for_its_authority_and_secret() {
        let value = mint_cookie(VECTOR_SECRET, VECTOR_AUTHORITY, VECTOR_NOW);
        assert!(verify_cookie(
            &value,
            VECTOR_SECRET,
            VECTOR_AUTHORITY,
            COOKIE_MAX_AGE,
            VECTOR_NOW
        ));
        assert!(!verify_cookie(
            &value,
            VECTOR_SECRET,
            "localhost:3082",
            COOKIE_MAX_AGE,
            VECTOR_NOW
        ));
        assert!(!verify_cookie(
            &value,
            "another secret",
            VECTOR_AUTHORITY,
            COOKIE_MAX_AGE,
            VECTOR_NOW
        ));
    }

    #[test]
    fn a_cookie_is_refused_once_stale_or_from_the_future() {
        let value = mint_cookie(VECTOR_SECRET, VECTOR_AUTHORITY, VECTOR_NOW);
        assert!(verify_cookie(
            &value,
            VECTOR_SECRET,
            VECTOR_AUTHORITY,
            COOKIE_MAX_AGE,
            VECTOR_NOW + COOKIE_MAX_AGE * 1000
        ));
        assert!(!verify_cookie(
            &value,
            VECTOR_SECRET,
            VECTOR_AUTHORITY,
            COOKIE_MAX_AGE,
            VECTOR_NOW + COOKIE_MAX_AGE * 1000 + 1
        ));
        assert!(!verify_cookie(
            &value,
            VECTOR_SECRET,
            VECTOR_AUTHORITY,
            COOKIE_MAX_AGE,
            VECTOR_NOW - 1
        ));
    }

    #[test]
    fn a_tampered_cookie_is_refused() {
        let value = mint_cookie(VECTOR_SECRET, VECTOR_AUTHORITY, VECTOR_NOW);
        for bad in [
            "",
            "v1",
            "v1.1700000000000",
            "v2.1700000000000.signature",
            "v1.not-a-number.signature",
            "v1.1700000000000.signature",
            &format!("{value}.extra"),
        ] {
            assert!(!verify_cookie(
                bad,
                VECTOR_SECRET,
                VECTOR_AUTHORITY,
                COOKIE_MAX_AGE,
                VECTOR_NOW
            ));
        }
        let mut edited = value.clone();
        edited.pop();
        edited.push('A');
        assert!(!verify_cookie(
            &edited,
            VECTOR_SECRET,
            VECTOR_AUTHORITY,
            COOKIE_MAX_AGE,
            VECTOR_NOW
        ));
    }

    #[test]
    fn cookie_header_is_the_door_line() {
        assert_eq!(
            cookie_header(VECTOR_AUTHORITY, "v1.1.sig", 60),
            "heddle-auth-09075b88f37cf2e6=v1.1.sig; Path=/; HttpOnly; SameSite=Strict; Max-Age=60"
        );
    }

    #[test]
    fn read_cookie_keeps_everything_after_the_first_equals() {
        let header = "a=1; heddle-auth-x=v1.2.sig==; b=2";
        assert_eq!(
            read_cookie(Some(header), "heddle-auth-x"),
            Some("v1.2.sig==")
        );
        assert_eq!(read_cookie(Some(header), "a"), Some("1"));
        assert_eq!(
            read_cookie(Some("heddle-auth-x"), "heddle-auth-x"),
            Some("")
        );
        assert_eq!(read_cookie(Some(header), "missing"), None);
        assert_eq!(read_cookie(None, "heddle-auth-x"), None);
    }

    #[test]
    fn safe_equal_answers_length_first_and_then_bytes() {
        assert!(safe_equal("abc", "abc"));
        assert!(!safe_equal("abc", "ab"));
        assert!(!safe_equal("abc", "abd"));
        assert!(safe_equal("", ""));
    }

    #[test]
    fn authorize_takes_either_credential_and_names_its_refusal() {
        let token = create_launch_token();
        let cookie = mint_cookie("secret", VECTOR_AUTHORITY, 1_000);
        let door = Door {
            launch_token: &token,
            secret: "secret",
            authority: VECTOR_AUTHORITY,
            now_ms: 1_000,
        };
        assert_eq!(
            authorize(
                &Credentials {
                    cookie: Some(&cookie),
                    query: None
                },
                &door
            ),
            Decision::Allowed
        );
        assert_eq!(
            authorize(
                &Credentials {
                    cookie: None,
                    query: Some(&token)
                },
                &door
            ),
            Decision::Allowed
        );
        let refused = authorize(&Credentials::default(), &door);
        assert_eq!(
            refused,
            Decision::Refused {
                reason: "authentication required"
            }
        );
        assert!(!refused.is_ok());
        assert_eq!(
            authorize(
                &Credentials {
                    cookie: Some("v1.1.forged"),
                    query: Some("wrong")
                },
                &door
            ),
            Decision::Refused {
                reason: "authentication required"
            }
        );
    }

    #[test]
    fn offered_says_which_credentials_were_present() {
        assert_eq!(
            Credentials {
                cookie: Some("x"),
                query: None
            }
            .offered(),
            Offered {
                cookie: true,
                token: false
            }
        );
        assert_eq!(Credentials::default().offered(), Offered::default());
    }

    #[test]
    fn launch_tokens_are_fresh_base64url_secrets() {
        let one = create_launch_token();
        let two = create_launch_token();
        assert_ne!(one, two);
        assert_eq!(one.len(), 43, "32 bytes base64url without padding");
        assert!(
            one.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        );
    }

    #[test]
    fn secret_path_follows_heddle_home_then_home() {
        let home = Path::new("/home/person");
        assert_eq!(
            secret_path_for(Some(Path::new("/srv/heddle")), home),
            PathBuf::from("/srv/heddle/web-secret")
        );
        assert_eq!(
            secret_path_for(None, home),
            PathBuf::from("/home/person/.heddle/web-secret")
        );
    }

    #[test]
    fn expand_home_looks_only_at_the_first_character() {
        let home = Path::new("/home/person");
        assert_eq!(expand_home("~/x", home), PathBuf::from("/home/person/x"));
        assert_eq!(expand_home("~x", home), PathBuf::from("/home/personx"));
        assert_eq!(expand_home("/abs/x", home), PathBuf::from("/abs/x"));
        assert_eq!(expand_home("plain", home), PathBuf::from("plain"));
    }

    #[test]
    fn a_created_secret_is_mode_600_and_reused() {
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join(format!(
            "heddle-token-test-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let path = dir.join("nested").join(SECRET_FILE);
        let created = read_or_create_secret(&path).expect("creates the secret");
        assert!(!created.is_empty());
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        // The file holds the secret and a newline, and it is read trimmed.
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            format!("{created}\n")
        );
        // Reuse returns the same secret, and re-tightens a mode that was widened.
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(read_or_create_secret(&path).unwrap(), created);
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        std::fs::remove_dir_all(&dir).ok();
    }
}
