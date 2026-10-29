//! `GET /api/questions?session=<id>[&all=1]`, `POST /api/questions/<id>` and `POST /api/questions/<id>/hold`, answered
//! as a status and the exact body bytes the TypeScript server writes (`src/server/web.ts`).
//!
//! A success body is `JSON.stringify(value, null, 2)` plus a newline, an error body compact JSON plus a newline. The
//! server only matches the path, reads the body, and - for a late answer to a session with a running turn - appends
//! the returned [`Steer`] as the user message, which is how the TypeScript route delivers it.

use serde_json::{json, Map, Value};

use crate::model::{codes, QuestionError};
use crate::service::QuestionService;

/// A route's answer: the status and the body, always `application/json`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HttpAnswer {
    /// The HTTP status.
    pub status: u16,
    /// The exact body.
    pub body: String,
}

/// A late answer the server must append to a running session as a user message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Steer {
    /// The session.
    pub session: String,
    /// The user message text (DSH's `answer_to_pending_question` record).
    pub text: String,
}

fn success(value: &Value) -> HttpAnswer {
    HttpAnswer { status: 200, body: format!("{}\n", serde_json::to_string_pretty(value).unwrap_or_else(|_| "null".into())) }
}

fn failure(status: u16, body: Value) -> HttpAnswer {
    HttpAnswer { status, body: format!("{body}\n") }
}

/// Whether `id` is a session id the TypeScript route accepts: `session-` and 36 hex digits or dashes.
fn is_session_id(id: &str) -> bool {
    id.strip_prefix("session-").is_some_and(|rest| rest.len() == 36 && rest.chars().all(|c| c.is_ascii_hexdigit() || c == '-'))
}

/// Whether `id` is a question request id: `question-` and 36 hex digits or dashes.
pub fn is_question_id(id: &str) -> bool {
    id.strip_prefix("question-").is_some_and(|rest| rest.len() == 36 && rest.chars().all(|c| c.is_ascii_hexdigit() || c == '-'))
}

fn session_of(service: &QuestionService, raw: Option<&str>) -> Result<String, HttpAnswer> {
    let Some(id) = raw.filter(|id| is_session_id(id)) else {
        return Err(failure(400, json!({ "error": "a session id is required" })));
    };
    service.open(id).ok_or_else(|| failure(404, json!({ "error": format!("no session {id}") })))
}

fn refusal(error: &QuestionError) -> HttpAnswer {
    let status = match error.code {
        codes::NOT_FOUND => 404,
        codes::SETTLED => 409,
        codes::INVALID_ANSWERS => 400,
        _ => 500,
    };
    failure(status, json!({ "error": error.message, "code": error.code }))
}

fn unloaded() -> HttpAnswer {
    failure(503, json!({ "error": "this profile does not load the questions plugin" }))
}

/// Answer `GET /api/questions`: the session's answerable requests, or every request with `all`.
pub fn get_questions(service: Option<&QuestionService>, session: Option<&str>, all: bool) -> HttpAnswer {
    let Some(service) = service else { return unloaded() };
    let session = match session_of(service, session) {
        Ok(session) => session,
        Err(answer) => return answer,
    };
    match service.list(&session, !all) {
        Ok(requests) => success(&json!({ "session": session, "requests": requests })),
        Err(error) => refusal(&error),
    }
}

/// Answer `POST /api/questions/<id>` (or `/hold` when `hold`), given the parsed body and whether the body's session
/// has a running turn. A late answer to a running session comes back as the [`Steer`] to append.
pub fn post_question(service: Option<&QuestionService>, id: &str, hold: bool, body: &Value, running: impl Fn(&str) -> bool) -> (HttpAnswer, Option<Steer>) {
    let Some(service) = service else { return (unloaded(), None) };
    if !is_question_id(id) {
        return (failure(400, json!({ "error": "not a question route" })), None);
    }
    let session = match session_of(service, body.get("session").and_then(Value::as_str)) {
        Ok(session) => session,
        Err(answer) => return (answer, None),
    };
    if hold {
        return match service.hold(&session, id) {
            Ok(view) => (success(&json!({ "request": view })), None),
            Err(error) => (refusal(&error), None),
        };
    }
    let outcome = match service.answer(&session, id, body.get("answers").unwrap_or(&Value::Null)) {
        Ok(outcome) => outcome,
        Err(error) => return (refusal(&error), None),
    };
    if !outcome.late {
        return (success(&json!({ "answered": true, "late": false, "request": outcome.view })), None);
    }
    let message = outcome.message.unwrap_or_default();
    let steered = running(&session);
    let mut answer = Map::new();
    answer.insert("answered".into(), Value::Bool(true));
    answer.insert("late".into(), Value::Bool(true));
    answer.insert("delivered".into(), json!(if steered { "steer" } else { "none" }));
    if !steered {
        answer.insert("message".into(), Value::String(message.clone()));
    }
    answer.insert("request".into(), Value::Object(outcome.view));
    let steer = steered.then(|| Steer { session, text: message });
    (success(&Value::Object(answer)), steer)
}
