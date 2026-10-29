//! The command routes the composer's slash menu uses.
//!
//! Ported from `src/commands/http.ts`:
//!
//! | Route | Answer |
//! |---|---|
//! | `GET /commands/menu.js` | `200 text/javascript; charset=utf-8` — the composer's slash menu the page imports, `src/commands/menu.js` embedded at compile time (one file serves both builds, as `heddle-server` embeds `page.html`) |
//! | `GET /api/commands` | `200 {"commands": [...]}` — the registered commands, as [`CommandRegistry::list`](crate::CommandRegistry::list) shapes them |
//! | `POST /api/sessions/{id}/commands`, body `{"line": "..."}` | `200 {"matched": false}` for a line that is not a registered command (nothing written), else `200 {"matched": true, commandId, name, kind, text?, action?, seq}` — a handler's refusal is `kind: "error"` with status 200, because the command ran and its row says so |
//! | … an id that is not `session-<uuid>` | `400 {"error": "not a session id"}` |
//! | … an id no session has | `404 {"error": "no session <id>"}` |
//! | … a body over 64 KiB + 1 KiB | `413 {"error": "a command line is at most 65536 bytes"}` |
//! | … a body that is not a JSON object with a string `line` | `400 {"error": "the body must be JSON with a string \"line\""}` |
//!
//! Every JSON answer, the refusals included, is `JSON.stringify(value, null, 2)` plus a newline, as
//! `application/json` with `cache-control: no-store` — `http.ts`'s one `json` helper. The checks are in that
//! order: the id, the session, then the body. The server mounts these behind its door, after the token
//! check, like every other `/api` route; a wrong method falls through to its `404`.

use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::extract::rejection::PathRejection;
use axum::extract::{Path, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::Response;
use axum::routing::{get, post};
use futures::StreamExt;
use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::service::Commands;
use crate::text;

/// The largest command line a request may carry, in bytes; the body may carry 1 KiB more.
pub const MAX_COMMAND_LINE: usize = 64 * 1024;

/// The content type of every JSON answer — without a charset, as the TypeScript server sends it.
pub const JSON_CONTENT_TYPE: &str = "application/json";

/// Where the page imports the slash menu from (`MENU_PATH`).
pub const MENU_PATH: &str = "/commands/menu.js";

/// The menu module's source: `src/commands/menu.js`, as committed. Edited only in the TypeScript tree; a rebuild
/// picks it up.
pub const MENU_SOURCE: &str = include_str!("../../../../src/commands/menu.js");

/// The three routes, with their state applied.
pub fn routes(host: Arc<Commands>) -> Router {
    Router::new()
        .route(MENU_PATH, get(menu_script))
        .route("/api/commands", get(list_commands))
        .route("/api/sessions/{id}/commands", post(run_command))
        .with_state(host)
}

/// `GET /commands/menu.js`: the menu module, as `text/javascript` with `cache-control: no-store`.
async fn menu_script() -> Response {
    let mut response = Response::new(Body::from(MENU_SOURCE));
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/javascript; charset=utf-8"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

/// `JSON.stringify(value, null, 2)` plus a newline, as `application/json` with `cache-control: no-store`.
pub fn json_pretty<T: Serialize>(status: StatusCode, value: &T) -> Response {
    let body = serde_json::to_string_pretty(value).unwrap_or_else(|_| "null".to_owned());
    let mut response = Response::new(Body::from(format!("{body}\n")));
    *response.status_mut() = status;
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(JSON_CONTENT_TYPE),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

fn refuse(status: StatusCode, message: &str) -> Response {
    json_pretty(status, &json!({ "error": message }))
}

async fn list_commands(State(host): State<Arc<Commands>>) -> Response {
    json_pretty(
        StatusCode::OK,
        &json!({ "commands": host.registry().list() }),
    )
}

async fn run_command(
    State(host): State<Arc<Commands>>,
    id: Result<Path<String>, PathRejection>,
    body: Body,
) -> Response {
    let Ok(Path(id)) = id else {
        return refuse(StatusCode::BAD_REQUEST, "not a session id");
    };
    if !text::is_session_id(&id) {
        return refuse(StatusCode::BAD_REQUEST, "not a session id");
    }
    let Some(handle) = host.open(&id) else {
        return refuse(StatusCode::NOT_FOUND, &format!("no session {id}"));
    };
    let body = match read_body(body).await {
        BodyRead::TooLarge => {
            return refuse(
                StatusCode::PAYLOAD_TOO_LARGE,
                &format!("a command line is at most {MAX_COMMAND_LINE} bytes"),
            );
        }
        BodyRead::Invalid => None,
        BodyRead::Object(body) => Some(body),
    };
    let Some(line) = body
        .as_ref()
        .and_then(|body| body.get("line"))
        .and_then(Value::as_str)
    else {
        return refuse(
            StatusCode::BAD_REQUEST,
            "the body must be JSON with a string \"line\"",
        );
    };
    match host.execute(&handle, line).await {
        // The session log refused an append: the TypeScript server's catch-all answers a 500 for a throw.
        Err(message) => refuse(StatusCode::INTERNAL_SERVER_ERROR, &message),
        Ok(None) => json_pretty(StatusCode::OK, &json!({ "matched": false })),
        Ok(Some(execution)) => {
            let result = &execution.result;
            let mut answer = Map::new();
            answer.insert("matched".to_owned(), Value::Bool(true));
            answer.insert(
                "commandId".to_owned(),
                Value::String(execution.command_id.clone()),
            );
            answer.insert("name".to_owned(), Value::String(execution.name.clone()));
            answer.insert("kind".to_owned(), Value::from(result.kind()));
            if let Some(text) = result.text() {
                answer.insert("text".to_owned(), Value::from(text));
            }
            if let Some(action) = result.action() {
                answer.insert(
                    "action".to_owned(),
                    serde_json::to_value(action).unwrap_or(Value::Null),
                );
            }
            answer.insert("seq".to_owned(), Value::from(execution.seq));
            json_pretty(StatusCode::OK, &Value::Object(answer))
        }
    }
}

/// A request body as `http.ts`'s `readBody` reads it.
enum BodyRead {
    /// A JSON object; an empty body reads as `{}`.
    Object(Map<String, Value>),
    /// Not JSON, or JSON that is not an object.
    Invalid,
    /// More than [`MAX_COMMAND_LINE`] + 1024 bytes; reading stopped there.
    TooLarge,
}

async fn read_body(body: Body) -> BodyRead {
    let mut stream = body.into_data_stream();
    let mut raw = Vec::new();
    while let Some(chunk) = stream.next().await {
        let Ok(chunk) = chunk else {
            return BodyRead::Invalid;
        };
        raw.extend_from_slice(&chunk);
        if raw.len() > MAX_COMMAND_LINE + 1024 {
            return BodyRead::TooLarge;
        }
    }
    // `raw += chunk` decodes as UTF-8 with replacement characters before `JSON.parse` sees it.
    let text = String::from_utf8_lossy(&raw);
    let text = if text.is_empty() { "{}" } else { &text };
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Object(body)) => BodyRead::Object(body),
        _ => BodyRead::Invalid,
    }
}

#[cfg(test)]
mod tests {
    use axum::http::Method;

    use super::*;
    use crate::builtins::export_command;
    use crate::registry::CommandRegistry;
    use crate::test_support::{Fixture, body_text, call};
    use heddle_session::SessionService;

    /// The two routes merged into a caller's router the way the server merges them: anything they do not
    /// claim — another path, a wrong method — is left to the caller's fallback.
    fn app(fixture: &Fixture) -> Router {
        let registry = CommandRegistry::new();
        registry.register(export_command()).unwrap();
        let host = Commands::with_registry(
            Arc::new(SessionService::from_store(fixture.store.clone())),
            registry,
        );
        let teapot = || async { (StatusCode::IM_A_TEAPOT, "not mine\n") };
        Router::new()
            .merge(routes(Arc::new(host)))
            .fallback(teapot)
            .method_not_allowed_fallback(teapot)
    }

    async fn json_of(response: Response) -> Value {
        serde_json::from_str(&body_text(response).await).expect("a JSON answer")
    }

    fn post_path(id: &str) -> String {
        format!("/api/sessions/{id}/commands")
    }

    #[tokio::test]
    async fn the_routes_list_commands_run_a_registered_line_and_answer_matched_false_for_anything_else()
     {
        let fixture = Fixture::new("routes");
        let app = app(&fixture);
        let id = fixture.handle.id.clone();

        let listed = call(app.clone(), Method::GET, "/api/commands", None).await;
        assert_eq!(listed.status(), StatusCode::OK);
        assert_eq!(listed.headers()[header::CONTENT_TYPE], "application/json");
        assert_eq!(listed.headers()[header::CACHE_CONTROL], "no-store");
        assert_eq!(
            body_text(listed).await,
            "{\n  \"commands\": [\n    {\n      \"name\": \"export\",\n      \"label\": \"Export\",\n      \"description\": \"Download this session log\",\n      \"section\": \"commands\"\n    }\n  ]\n}\n",
            "pretty, with a trailing newline, in the TypeScript key order"
        );

        let ran = call(
            app.clone(),
            Method::POST,
            &post_path(&id),
            Some(r#"{"line":"/export"}"#),
        )
        .await;
        assert_eq!(ran.status(), StatusCode::OK);
        let answer = json_of(ran).await;
        assert_eq!(answer["matched"], json!(true));
        assert_eq!(answer["name"], json!("export"));
        assert_eq!(answer["kind"], json!("success"));
        assert_eq!(answer["text"], json!("Session log download requested."));
        assert_eq!(
            answer["action"],
            json!({"kind": "download", "href": format!("/api/sessions/{id}/log")})
        );
        assert!(answer["seq"].is_u64());
        let keys: Vec<&str> = answer
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            [
                "matched",
                "commandId",
                "name",
                "kind",
                "text",
                "action",
                "seq"
            ]
        );
        let command_id = answer["commandId"].as_str().unwrap().to_owned();
        assert!(command_id.starts_with("cmd-") && command_id.ends_with("-1"));
        let events = fixture.events();
        let done = events
            .iter()
            .find(|event| event.kind == "command/done")
            .unwrap();
        assert_eq!(answer["seq"], json!(done.seq));

        let refused = json_of(
            call(
                app.clone(),
                Method::POST,
                &post_path(&id),
                Some(r#"{"line":"/export somewhere"}"#),
            )
            .await,
        )
        .await;
        assert_eq!(
            refused["kind"],
            json!("error"),
            "a refusal is still a run, with status 200"
        );
        assert_eq!(refused.get("action"), None);

        let before = fixture.events().len();
        for line in ["just a message", "/unknown thing"] {
            let response = call(
                app.clone(),
                Method::POST,
                &post_path(&id),
                Some(&json!({ "line": line }).to_string()),
            )
            .await;
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(body_text(response).await, "{\n  \"matched\": false\n}\n");
        }
        assert_eq!(
            fixture.events().len(),
            before,
            "an unmatched line writes nothing"
        );

        let status = |path: String, body: &'static str| {
            let app = app.clone();
            async move { call(app, Method::POST, &path, Some(body)).await }
        };
        let not_an_id = status(post_path("not-a-session"), "{}").await;
        assert_eq!(not_an_id.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            body_text(not_an_id).await,
            "{\n  \"error\": \"not a session id\"\n}\n"
        );
        let unknown = status(
            post_path("session-00000000-0000-4000-8000-000000000000"),
            r#"{"line":"/export"}"#,
        )
        .await;
        assert_eq!(unknown.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            json_of(unknown).await,
            json!({"error": "no session session-00000000-0000-4000-8000-000000000000"})
        );
        for body in ["not json", r#"{"line":7}"#, r#"["/export"]"#, "null"] {
            let response = status(post_path(&id), body).await;
            assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{body}");
            assert_eq!(
                json_of(response).await,
                json!({"error": "the body must be JSON with a string \"line\""})
            );
        }
        let empty = call(app.clone(), Method::POST, &post_path(&id), None).await;
        assert_eq!(
            empty.status(),
            StatusCode::BAD_REQUEST,
            "an empty body is {{}}, which has no line"
        );
        let oversized = json!({ "line": format!("/export {}", "x".repeat(70 * 1024)) }).to_string();
        let too_large = call(app.clone(), Method::POST, &post_path(&id), Some(&oversized)).await;
        assert_eq!(too_large.status(), StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(
            json_of(too_large).await,
            json!({"error": "a command line is at most 65536 bytes"})
        );
        let just_fits =
            json!({ "line": format!("/nothing {}", "x".repeat(MAX_COMMAND_LINE)) }).to_string();
        assert!(just_fits.len() <= MAX_COMMAND_LINE + 1024);
        let fits = call(app.clone(), Method::POST, &post_path(&id), Some(&just_fits)).await;
        assert_eq!(fits.status(), StatusCode::OK, "a 64 KiB line is read");

        let elsewhere = call(app.clone(), Method::GET, "/api/elsewhere", None).await;
        assert_eq!(
            elsewhere.status(),
            StatusCode::IM_A_TEAPOT,
            "any other route is left to the server"
        );
        let deleted = call(app.clone(), Method::DELETE, "/api/commands", None).await;
        assert_eq!(deleted.status(), StatusCode::IM_A_TEAPOT);
        let got = call(app, Method::GET, &post_path(&id), None).await;
        assert_eq!(got.status(), StatusCode::IM_A_TEAPOT);
    }

    #[tokio::test]
    async fn the_menu_module_is_served_as_the_typescript_tree_has_it() {
        let fixture = Fixture::new("routes-menu");
        let response = call(app(&fixture), Method::GET, MENU_PATH, None).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()[header::CONTENT_TYPE],
            "text/javascript; charset=utf-8"
        );
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        let source = body_text(response).await;
        assert_eq!(source, MENU_SOURCE);
        assert_eq!(
            source,
            std::fs::read_to_string(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../../src/commands/menu.js"
            ))
            .expect("src/commands/menu.js reads"),
            "the embedded copy is the file in the tree"
        );
    }

    #[tokio::test]
    async fn a_percent_encoded_id_is_decoded_before_it_is_judged() {
        let fixture = Fixture::new("routes-encoded");
        let app = app(&fixture);
        let encoded = fixture.handle.id.replacen("session-", "session%2D", 1);
        let response = call(
            app.clone(),
            Method::POST,
            &post_path(&encoded),
            Some(r#"{"line":"/export"}"#),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let answer = json_of(response).await;
        assert_eq!(answer["matched"], json!(true));
        let bad = call(
            app,
            Method::POST,
            &post_path("session%FF"),
            Some(r#"{"line":"/export"}"#),
        )
        .await;
        assert_eq!(bad.status(), StatusCode::BAD_REQUEST);
    }
}
