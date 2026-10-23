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

/// The body of the `403` a refused cross-site write gets.
pub const CROSS_SITE_WRITE_REFUSAL: &str = "refused: a cross-site request that changes state and carries no valid session; a cross-site request may read, but writing requires the cookie this page was opened with\n";

/// The message a non-loopback bind is refused with, naming the host and the default.
pub fn bind_refusal(host: &str) -> String {
    todo!()
}

/// Whether a host names this machine: `127.0.0.1`, `localhost`, `::1` or `::ffff:127.0.0.1`, exactly.
pub fn is_loopback(host: &str) -> bool {
    todo!()
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
    todo!()
}

/// Whether a method changes state: anything but `GET` and `HEAD`.
pub fn changes_state(method: &Method) -> bool {
    todo!()
}

/// The cross-site write rule: refuse a state-changing request that **offered** the cookie and was not
/// authorized. A request that offered no cookie falls through to the ordinary `401`.
pub fn refuse_cross_site_write(method: &Method, offered_cookie: bool, authorized: bool) -> bool {
    todo!()
}
