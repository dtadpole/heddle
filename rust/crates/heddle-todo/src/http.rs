//! `GET /api/todo?session=<id>`, answered as a status and the exact body bytes.
//!
//! The TypeScript server writes a success as `JSON.stringify(value, null, 2)` plus a newline and an error as
//! compact `JSON.stringify({error})` plus a newline; [`HttpAnswer::body`] is those bytes, so the Rust server
//! only sets `content-type: application/json` and writes them.

use crate::service::TodoService;

/// A route's answer: the status and the body, always `application/json`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HttpAnswer {
    /// The HTTP status.
    pub status: u16,
    /// The exact body.
    pub body: String,
}

/// Answer `GET /api/todo`.
///
/// `service` is `None` when the profile does not load the todo plugin → 503. `session` is the `session` query
/// parameter: absent or empty → 400 `a session is required`; no such session → 404 `no session <id>`;
/// otherwise 200 `{"session": id, "todo": view | null}` — `null` for "never written", which a client can tell
/// from "written empty".
pub fn get_todo(service: Option<&TodoService>, session: Option<&str>) -> HttpAnswer {
    let _ = (service, session);
    todo!("heddle-todo: get_todo")
}
