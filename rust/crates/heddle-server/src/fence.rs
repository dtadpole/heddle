//! The Host and Origin fence, and the cross-site write rule — from `rejectUntrusted` and `handle` in
//! `src/server/web.ts`.
//!
//! The fence runs **before** any secret is compared: a page on another origin can make a browser send a
//! request here, and without the fence the response would be readable to that page.
//!
//! - A `Host` that is not loopback is refused.
//! - An `Origin` that is not a URL (`null`, which a sandboxed frame or a `file://` page sends) is refused.
//! - An `Origin` that is neither this server's authority nor a loopback host is refused. A same-machine
//!   origin on another port is **not** foreign: the owner opens heddle through a token-supplying gate on a
//!   second loopback port, and the credential, not the origin, is what separates the owner from a page.
//! - `Sec-Fetch-Site` is not judged here. A cross-site request that **changes state** is refused only when it
//!   offered the cookie and the cookie did not verify ([`refuse_cross_site_write`]); that rule needs the
//!   credential, so it runs after authorization.

use axum::http::Method;

use crate::server::DEFAULT_HOST;

/// The body of the `403` a refused cross-site write gets.
pub const CROSS_SITE_WRITE_REFUSAL: &str = "refused: a cross-site request that changes state and carries no valid session; a cross-site request may read, but writing requires the cookie this page was opened with\n";

/// The message a non-loopback bind is refused with, naming the host and the default.
pub fn bind_refusal(host: &str) -> String {
    format!(
        "refusing to bind {host}: the Web UI runs tools, so exposing it is remote code execution behind a token. Use {DEFAULT_HOST}."
    )
}

/// Whether a host names this machine: `127.0.0.1`, `localhost`, `::1` or `::ffff:127.0.0.1`, exactly.
pub fn is_loopback(host: &str) -> bool {
    matches!(host, "127.0.0.1" | "localhost" | "::1" | "::ffff:127.0.0.1")
}

/// The hostname part of a `Host` header, as `request.headers.host` is read: an IPv6 literal keeps its
/// brackets around the address, and anything else is cut at its first colon.
fn header_hostname(host: &str) -> &str {
    if let Some(rest) = host.strip_prefix('[') {
        // `host.slice(1, host.indexOf(']'))`: the brackets are not part of the hostname.
        match rest.find(']') {
            Some(end) => &rest[..end],
            None => host,
        }
    } else {
        host.split(':').next().unwrap_or(host)
    }
}

/// A parsed `Origin` header: the host (`host[:port]`, default port dropped) and the hostname.
struct Origin {
    host: String,
    hostname: String,
}

/// Parse an `Origin` the way a WHATWG `URL` parses it. `None` when the value is not an absolute URL, which
/// is the TypeScript `try { new URL(origin) } catch` path (`null` included).
///
/// This is the subset the fence uses: the scheme must be present, the authority is read up to the first
/// `/`, `?` or `#`, a scheme's default port is dropped, and the host is lower-cased. A path, query or
/// fragment is irrelevant to the comparison.
fn parse_origin(origin: &str) -> Option<Origin> {
    let (scheme, rest) = origin.split_once("://")?;
    if scheme.is_empty() || !scheme.starts_with(|c: char| c.is_ascii_alphabetic()) {
        return None;
    }
    let scheme = scheme.to_ascii_lowercase();
    let authority = rest.find(['/', '?', '#']).map_or(rest, |end| &rest[..end]);
    // Userinfo, if any, is not part of the host.
    let authority = authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host);
    if authority.is_empty() {
        // A `file:` URL parses with an empty host, which is still an Origin the rule compares.
        return (scheme == "file").then(|| Origin {
            host: String::new(),
            hostname: String::new(),
        });
    }

    let (hostname, port) = if let Some(bracketed) = authority.strip_prefix('[') {
        let end = bracketed.find(']')?;
        // The brackets stay on, as `URL.hostname` keeps them for an IPv6 literal.
        let hostname = format!("[{}]", &bracketed[..end]);
        let rest = &bracketed[end + 1..];
        let port = match rest.strip_prefix(':') {
            Some(port) => Some(parse_port(port)?),
            None if rest.is_empty() => None,
            None => return None,
        };
        (hostname, port)
    } else {
        match authority.rsplit_once(':') {
            Some((name, port)) => (name.to_ascii_lowercase(), Some(parse_port(port)?)),
            None => (authority.to_ascii_lowercase(), None),
        }
    };
    if hostname.is_empty() {
        return None;
    }

    let default_port = match scheme.as_str() {
        "http" | "ws" => Some(80),
        "https" | "wss" => Some(443),
        "ftp" => Some(21),
        _ => None,
    };
    let host = match port {
        Some(port) if Some(port) != default_port => format!("{hostname}:{port}"),
        _ => hostname.clone(),
    };
    Some(Origin { host, hostname })
}

/// A port, or `None` when it is not a number: `new URL` throws for `http://x:notaport`.
fn parse_port(port: &str) -> Option<u16> {
    if port.is_empty() || !port.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    port.parse().ok()
}

/// The fence. Returns the refusal sentence (without a trailing newline) when the request must be refused,
/// `None` when it may proceed.
///
/// `host` is the request's `Host` header, `origin` its `Origin` header, and `authority` the authority the
/// server judges against (the `Host` header, or `host:port` when there is none).
///
/// The Origin is parsed the way a WHATWG `URL` parses it, because the TypeScript rule compares
/// `URL.host` and `URL.hostname`: the host is lower-cased, a scheme's default port is dropped
/// (`http://127.0.0.1:80` has host `127.0.0.1`), and an IPv6 hostname keeps its brackets.
pub fn reject_untrusted(
    host: Option<&str>,
    origin: Option<&str>,
    authority: &str,
) -> Option<String> {
    let host = host.unwrap_or("");
    if !host.is_empty() && !is_loopback(header_hostname(host)) {
        return Some(format!("refused: Host {host} is not loopback"));
    }
    if let Some(origin) = origin
        && !origin.is_empty()
    {
        let Some(parsed) = parse_origin(origin) else {
            return Some(format!("refused: Origin {origin} is not a URL"));
        };
        if parsed.host != authority && !is_loopback(&parsed.hostname) {
            return Some(format!("refused: Origin {origin} is not this machine"));
        }
    }
    None
}

/// Whether a method changes state: anything but `GET` and `HEAD`.
pub fn changes_state(method: &Method) -> bool {
    !matches!(*method, Method::GET | Method::HEAD)
}

/// The cross-site write rule: refuse a state-changing request that **offered** the cookie and was not
/// authorized. A request that offered no cookie falls through to the ordinary `401`.
pub fn refuse_cross_site_write(method: &Method, offered_cookie: bool, authorized: bool) -> bool {
    changes_state(method) && offered_cookie && !authorized
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bind_refusal_names_the_host_and_the_default() {
        assert_eq!(
            bind_refusal("0.0.0.0"),
            "refusing to bind 0.0.0.0: the Web UI runs tools, so exposing it is remote code execution behind a token. Use 127.0.0.1."
        );
    }

    #[test]
    fn loopback_is_the_four_exact_names() {
        for host in ["127.0.0.1", "localhost", "::1", "::ffff:127.0.0.1"] {
            assert!(is_loopback(host), "{host}");
        }
        for host in ["", "0.0.0.0", "127.0.0.2", "example.com", "::"] {
            assert!(!is_loopback(host), "{host}");
        }
    }

    #[test]
    fn a_non_loopback_host_is_refused() {
        assert_eq!(
            reject_untrusted(Some("evil.example:3082"), None, "evil.example:3082"),
            Some("refused: Host evil.example:3082 is not loopback".to_owned())
        );
        assert_eq!(
            reject_untrusted(Some("127.0.0.1:3082"), None, "127.0.0.1:3082"),
            None
        );
        assert_eq!(
            reject_untrusted(Some("localhost:3082"), None, "localhost:3082"),
            None
        );
        assert_eq!(
            reject_untrusted(Some("[::1]:3082"), None, "[::1]:3082"),
            None
        );
    }

    #[test]
    fn an_absent_host_is_not_judged() {
        assert_eq!(reject_untrusted(None, None, "127.0.0.1:3082"), None);
        assert_eq!(reject_untrusted(Some(""), None, "127.0.0.1:3082"), None);
    }

    #[test]
    fn a_non_url_origin_is_refused() {
        assert_eq!(
            reject_untrusted(Some("127.0.0.1:3082"), Some("null"), "127.0.0.1:3082"),
            Some("refused: Origin null is not a URL".to_owned())
        );
        assert_eq!(
            reject_untrusted(
                Some("127.0.0.1:3082"),
                Some("file:///tmp/x"),
                "127.0.0.1:3082"
            ),
            Some("refused: Origin file:///tmp/x is not this machine".to_owned())
        );
    }

    #[test]
    fn a_foreign_origin_is_refused_but_a_same_machine_port_is_not() {
        let authority = "127.0.0.1:3082";
        assert_eq!(
            reject_untrusted(Some(authority), Some("https://evil.example"), authority),
            Some("refused: Origin https://evil.example is not this machine".to_owned())
        );
        // The gate the owner actually uses: same machine, another port.
        assert_eq!(
            reject_untrusted(Some(authority), Some("http://127.0.0.1:8082"), authority),
            None
        );
        assert_eq!(
            reject_untrusted(Some(authority), Some("http://localhost:8082"), authority),
            None
        );
        assert_eq!(
            reject_untrusted(
                Some(authority),
                Some(&format!("http://{authority}")),
                authority
            ),
            None
        );
    }

    #[test]
    fn an_origin_is_parsed_like_a_url() {
        let parsed = parse_origin("HTTP://127.0.0.1:3082/some/path?q=1#f").unwrap();
        assert_eq!(parsed.host, "127.0.0.1:3082");
        assert_eq!(parsed.hostname, "127.0.0.1");
        // A scheme's default port is dropped, from `host` and not only from `hostname`.
        let default = parse_origin("http://127.0.0.1:80").unwrap();
        assert_eq!(default.host, "127.0.0.1");
        let tls = parse_origin("https://Example.COM:443").unwrap();
        assert_eq!(tls.host, "example.com");
        assert_eq!(tls.hostname, "example.com");
        // A non-default port is kept.
        assert_eq!(
            parse_origin("https://example.com:8443").unwrap().host,
            "example.com:8443"
        );
        // An IPv6 hostname keeps its brackets.
        let v6 = parse_origin("http://[::1]:3082").unwrap();
        assert_eq!(v6.hostname, "[::1]");
        assert_eq!(v6.host, "[::1]:3082");
        // Userinfo is not part of the host.
        assert_eq!(
            parse_origin("http://user:pass@127.0.0.1:1").unwrap().host,
            "127.0.0.1:1"
        );
    }

    #[test]
    fn a_malformed_origin_is_not_a_url() {
        for bad in [
            "null",
            "",
            "127.0.0.1:3082",
            "http://",
            "http://host:notaport",
            "1http://x",
        ] {
            assert!(parse_origin(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn an_empty_origin_header_is_ignored() {
        assert_eq!(
            reject_untrusted(Some("127.0.0.1:3082"), Some(""), "127.0.0.1:3082"),
            None
        );
    }

    #[test]
    fn state_changing_methods_are_everything_but_get_and_head() {
        assert!(!changes_state(&Method::GET));
        assert!(!changes_state(&Method::HEAD));
        for method in [Method::POST, Method::PATCH, Method::DELETE, Method::PUT] {
            assert!(changes_state(&method), "{method}");
        }
    }

    #[test]
    fn a_cross_site_write_needs_a_verified_cookie() {
        assert!(refuse_cross_site_write(&Method::POST, true, false));
        assert!(!refuse_cross_site_write(&Method::POST, true, true));
        assert!(!refuse_cross_site_write(&Method::POST, false, false));
        assert!(!refuse_cross_site_write(&Method::GET, true, false));
    }
}
