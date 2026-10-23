//! The commands this crate answers, behind the binary's D-043 entry-point convention.
//!
//! Ported from `src/cli.ts`: the `models` command, and the two pieces of the turn path this crate owns — the
//! endpoint a turn runs on and the `--stream` view (`printStream`, started before `runTurn`, disposed after it, its
//! summary under `stream` in `--json`). The convention is `rust/crates/heddle/INDEX.md`, "Command entry points in
//! the owning crate": no dependency on the binary, no process-global reads or effects, exit `0` or `1` with
//! `heddle: <sentence>` on `err` (never `2`), text byte for byte as the TypeScript build prints it, `--json` as
//! `JSON.stringify(value, null, 2)` plus a newline.
//!
//! - [`run`] with [`Command::Models`] answers `models` from the model row's [`ModelService`].
//! - `--turn` is `heddle-agent`'s command; its entry point calls [`turn_endpoint`] before it opens the session and,
//!   with `--stream`, starts [`print_stream`] before the turn and feeds it every `session/event` of that session.
//!
//! What the verifiers judge, and where it is pinned in the tests below:
//!
//! - `10-llm-backends` — `models --json` is the endpoint list, the built-in offline endpoint included, and makes no
//!   request; the named endpoint answers a turn; with none named, the configuration's default answers even when it
//!   is not first.
//! - `20-streaming` — reasoning and content reach stderr as separate deltas, reasoning first, the first one before
//!   the turn ends; `--json` carries `stream` with `textDeltas`, `reasoningDeltas` and `completed`.

use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde_json::Value;

use crate::printer::{StreamPrinter, StreamPrinterOptions};
use crate::service::ModelService;

/// The command words this crate answers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Command {
    /// `models`: the configured endpoints, without calling any.
    Models,
}

/// The flags this crate's commands read, named after the TypeScript `Args` fields.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Args {
    /// `--json`.
    pub json: bool,
}

/// What a command runs against: the model row's service, and the working directory the binary resolved.
pub struct Context<'a> {
    pub cwd: PathBuf,
    pub service: &'a ModelService,
}

/// Run one command: the answer goes to `out`, a failure to `err`; the result is the process exit code.
pub fn run(
    command: Command,
    args: &Args,
    context: &Context<'_>,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> i32 {
    let result = match command {
        Command::Models => models(args, context, out),
    };
    match result {
        Ok(()) => 0,
        Err(sentence) => {
            let _ = writeln!(err, "heddle: {sentence}");
            1
        }
    }
}

/// `models`: each endpoint as `describeEndpoint` prints it, credential-free. A listing is not a call, so nothing
/// here reaches a provider.
fn models(args: &Args, context: &Context<'_>, out: &mut dyn Write) -> Result<(), String> {
    let endpoints: Vec<Value> = context
        .service
        .list()
        .iter()
        .map(heddle_config::describe_endpoint)
        .collect();
    let text = if args.json {
        let json = serde_json::to_string_pretty(&endpoints)
            .map_err(|error| format!("the endpoint list could not be written — {error}"))?;
        format!("{json}\n")
    } else {
        let mut text = format!("heddle: {} endpoint(s)\n", endpoints.len());
        for endpoint in &endpoints {
            text.push_str(&format!(
                "  {:<18} {:<16} {}{}\n",
                display(endpoint.get("name")),
                display(endpoint.get("kind")),
                endpoint
                    .get("model")
                    .filter(|model| !model.is_null())
                    .map(|model| display(Some(model)))
                    .unwrap_or_else(|| "-".to_string()),
                if has_credential(endpoint) {
                    " credential"
                } else {
                    ""
                },
            ));
        }
        text
    };
    out.write_all(text.as_bytes())
        .map_err(|error| format!("the endpoint list could not be printed — {error}"))
}

/// `String(value)` for a described field: a string as itself, anything else as its JSON.
fn display(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(other) => other.to_string(),
        None => "undefined".to_string(),
    }
}

/// The TypeScript build's `endpoint.credential ?? endpoint.credentialFile ? ' credential' : ''`: the first of the
/// two that is present decides, by JavaScript truthiness.
fn has_credential(endpoint: &Value) -> bool {
    let decisive = endpoint
        .get("credential")
        .filter(|value| !value.is_null())
        .or_else(|| endpoint.get("credentialFile"));
    decisive.is_some_and(truthy)
}

/// JavaScript truthiness of a JSON value.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// The sentence a turn fails with when no endpoint is configured at all.
pub const NO_ENDPOINT_CONFIGURED: &str = "no endpoint is configured; write ~/.heddle/heddle.json or pass --endpoint after configuring one";

/// The endpoint a turn runs on: `--endpoint` when given, else the configuration's nominated default when it names a
/// configured endpoint, else the first configured endpoint.
///
/// `configured` is the service's endpoint names in declaration order (`ModelService::names`), and `nominated` the
/// configuration's `default` (`ModelService::nominated`). A failure is the whole sentence the binary prints after
/// `heddle: `, exiting 1: [`NO_ENDPOINT_CONFIGURED`], or `no endpoint named '<name>'; configured: <a>, <b>`.
pub fn turn_endpoint(
    flag: Option<&str>,
    configured: &[String],
    nominated: Option<&str>,
) -> Result<String, String> {
    let chosen = match flag {
        Some(named) => Some(named.to_string()),
        None => nominated
            .filter(|default| configured.iter().any(|name| name == default))
            .map(ToString::to_string)
            .or_else(|| configured.first().cloned()),
    };
    let Some(endpoint) = chosen else {
        return Err(NO_ENDPOINT_CONFIGURED.to_string());
    };
    if !configured.contains(&endpoint) {
        return Err(format!(
            "no endpoint named '{endpoint}'; configured: {}",
            configured.join(", ")
        ));
    }
    Ok(endpoint)
}

/// The live view `--stream` starts: one session's reasoning and content deltas, written to the writer it was given
/// (standard error in the binary) as each event is appended, and counted for `--json`.
pub struct StreamView {
    printer: Mutex<StreamPrinter>,
    disposed: std::sync::atomic::AtomicBool,
}

/// Start printing one session's stream (`printStream(ctx, { session })`).
///
/// Every write is flushed at once, because a terminal that receives the answer at the end is exactly the failure
/// `20-streaming` exists to catch. The view is shared — the session's event listener feeds it while the turn runs,
/// and the turn disposes it and reads its summary — so every method takes `&self`; wrap it in an `Arc`.
pub fn print_stream(session: &str, stderr: Box<dyn Write + Send>) -> StreamView {
    let sink = Arc::new(Mutex::new(stderr));
    let printer = StreamPrinter::with_writer(StreamPrinterOptions::new(session), move |text| {
        let mut sink = sink
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // A closed stderr is not a reason to fail a turn; the summary still counts what arrived.
        let _ = sink.write_all(text.as_bytes());
        let _ = sink.flush();
    });
    StreamView {
        printer: Mutex::new(printer),
        disposed: std::sync::atomic::AtomicBool::new(false),
    }
}

impl StreamView {
    /// One `session/event` as the session log writes it — a JSON object with `type` and the type's fields
    /// (`{"type":"assistant/chunk","chunk":{…}}`, `{"type":"assistant/completed",…}`, `{"type":"message",…}`).
    /// Another session's events, an event it does not show and a line that is not JSON are ignored, as is
    /// everything after [`StreamView::dispose`].
    pub fn observe(&self, session: &str, event_json: &str) {
        if let Ok(event) = serde_json::from_str::<Value>(event_json) {
            self.observe_value(session, &event);
        }
    }

    /// [`StreamView::observe`] for an event that is already parsed.
    pub fn observe_value(&self, session: &str, event: &Value) {
        if self.disposed.load(std::sync::atomic::Ordering::Acquire) {
            return;
        }
        self.printer
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .observe(session, event);
    }

    /// Stop printing; the summary keeps what was seen.
    pub fn dispose(&self) {
        self.disposed
            .store(true, std::sync::atomic::Ordering::Release);
    }

    /// The summary `--json` prints under `stream`:
    /// `{"textDeltas":…,"reasoningDeltas":…,"toolCalls":…,"spanMs":…,"completed":…}`.
    pub fn summary(&self) -> Value {
        let summary = self
            .printer
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .summary();
        serde_json::to_value(summary).unwrap_or(Value::Null)
    }

    /// [`StreamView::summary`] as JSON text.
    pub fn summary_json(&self) -> String {
        self.summary().to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use heddle_config::{EndpointConfig, EndpointKind};

    fn configured(name: &str, kind: EndpointKind, base_url: &str) -> EndpointConfig {
        EndpointConfig {
            name: name.to_string(),
            kind,
            base_url: base_url.to_string(),
            ..EndpointConfig::default()
        }
    }

    /// Run `models` against a service holding `endpoints`; the exit code, stdout and stderr.
    fn models_run(endpoints: Vec<EndpointConfig>, json: bool) -> (i32, String, String) {
        let service = ModelService::new(endpoints).expect("registers the endpoints");
        let context = Context {
            cwd: PathBuf::from("/work"),
            service: &service,
        };
        let (mut out, mut err) = (Vec::new(), Vec::new());
        let code = run(
            Command::Models,
            &Args { json },
            &context,
            &mut out,
            &mut err,
        );
        (
            code,
            String::from_utf8(out).expect("utf-8"),
            String::from_utf8(err).expect("utf-8"),
        )
    }

    #[test]
    fn models_json_is_the_configured_list_with_the_offline_endpoint() {
        // 10-llm-backends: the configured endpoint is listed with its kind and URL, and the built-in offline
        // endpoint is there for a fresh clone.
        let mut chat = configured(
            "not-the-first",
            EndpointKind::OpenaiChat,
            "http://127.0.0.1:9/ds",
        );
        chat.model = Some("double".into());
        let mut scripted = configured("scripted", EndpointKind::Scripted, "scripted.json");
        scripted.model = Some("scripted".into());
        let (code, stdout, stderr) = models_run(vec![scripted, chat], true);
        assert_eq!(code, 0, "{stderr}");
        assert_eq!(stderr, "");
        let listed: Value = serde_json::from_str(&stdout).expect("it printed JSON");
        let listed = listed.as_array().expect("it printed a list");
        let names: Vec<&str> = listed
            .iter()
            .filter_map(|endpoint| endpoint["name"].as_str())
            .collect();
        assert_eq!(names, vec!["scripted", "not-the-first"]);
        let chat = &listed[1];
        assert_eq!(chat["kind"], Value::from("openai-chat"));
        assert_eq!(chat["baseUrl"], Value::from("http://127.0.0.1:9/ds"));
        // JSON.stringify(value, null, 2) plus a newline.
        assert!(
            stdout.starts_with("[\n  {\n    \"name\": \"scripted\","),
            "{stdout}"
        );
        assert!(stdout.ends_with("\n]\n"), "{stdout}");
    }

    #[test]
    fn models_text_is_the_typescript_table() {
        let mut fast = configured("fast", EndpointKind::OpenaiChat, "http://h");
        fast.model = Some("m-1".into());
        let mut local = configured("local", EndpointKind::Scripted, "scripted.json");
        local.api_key = Some("a-secret".into());
        let (code, stdout, _) = models_run(vec![fast, local], false);
        assert_eq!(code, 0);
        assert_eq!(
            stdout,
            "heddle: 2 endpoint(s)\n  fast               openai-chat      m-1\n  local              scripted         - credential\n"
        );
        assert!(
            !stdout.contains("a-secret"),
            "a credential value never appears"
        );
    }

    #[test]
    fn a_key_file_marks_the_credential_and_nothing_marks_nothing() {
        let mut keyed = configured("keyed", EndpointKind::OpenaiChat, "http://h");
        keyed.api_key_file = Some("~/.keys/k".into());
        let plain = configured("plain", EndpointKind::OpenaiChat, "http://h");
        let (_, stdout, _) = models_run(vec![keyed, plain], false);
        assert_eq!(
            stdout,
            "heddle: 2 endpoint(s)\n  keyed              openai-chat      - credential\n  plain              openai-chat      -\n"
        );
        assert!(
            !stdout.contains(".keys"),
            "the key file's path is not printed in the table"
        );
    }

    #[test]
    fn an_empty_configuration_lists_nothing() {
        let (code, stdout, _) = models_run(Vec::new(), false);
        assert_eq!(code, 0);
        assert_eq!(stdout, "heddle: 0 endpoint(s)\n");
        let (_, json, _) = models_run(Vec::new(), true);
        assert_eq!(json, "[]\n");
    }

    #[test]
    fn listing_the_endpoints_reaches_no_provider() {
        // 10-llm-backends points an endpoint at a recording double and requires the listing to leave it empty.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("binds a loopback port");
        listener.set_nonblocking(true).expect("non-blocking");
        let address = listener.local_addr().expect("has an address");
        let mut double = configured(
            "double",
            EndpointKind::OpenaiChat,
            &format!("http://{address}/ds"),
        );
        double.model = Some("double".into());
        let (code, _, _) = models_run(vec![double.clone()], true);
        assert_eq!(code, 0);
        let (code, _, _) = models_run(vec![double], false);
        assert_eq!(code, 0);
        assert!(
            matches!(listener.accept(), Err(error) if error.kind() == std::io::ErrorKind::WouldBlock),
            "listing the endpoints made no request"
        );
    }

    #[test]
    fn javascript_truthiness_decides_the_credential_mark() {
        assert!(has_credential(&serde_json::json!({ "credential": "set" })));
        assert!(has_credential(
            &serde_json::json!({ "credentialFile": "/k" })
        ));
        assert!(!has_credential(
            &serde_json::json!({ "credentialFile": "" })
        ));
        assert!(!has_credential(&serde_json::json!({})));
        // `??` takes the first present value, even when it is falsy.
        assert!(!has_credential(
            &serde_json::json!({ "credential": "", "credentialFile": "/k" })
        ));
    }

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|name| (*name).to_string()).collect()
    }

    #[test]
    fn the_named_endpoint_answers() {
        // 10-llm-backends: `--endpoint chat` runs over the endpoint it names.
        assert_eq!(
            turn_endpoint(Some("chat"), &names(&["scripted", "chat"]), None),
            Ok("chat".to_string())
        );
        // A flag wins over the configured default.
        assert_eq!(
            turn_endpoint(
                Some("codex"),
                &names(&["first", "codex", "chosen"]),
                Some("chosen")
            ),
            Ok("codex".to_string())
        );
    }

    #[test]
    fn with_none_named_the_configured_default_answers_even_when_it_is_not_first() {
        // 10-llm-backends sets `default: chosen` with `first` ahead of it, so honouring the default cannot be
        // an accident of ordering.
        assert_eq!(
            turn_endpoint(None, &names(&["first", "chosen"]), Some("chosen")),
            Ok("chosen".to_string())
        );
    }

    #[test]
    fn with_no_usable_default_the_first_endpoint_answers() {
        assert_eq!(
            turn_endpoint(None, &names(&["first", "second"]), None),
            Ok("first".to_string())
        );
        // A default that names nothing configured is not a selection.
        assert_eq!(
            turn_endpoint(None, &names(&["first", "second"]), Some("gone")),
            Ok("first".to_string())
        );
    }

    #[test]
    fn an_unknown_endpoint_is_refused_naming_what_is_configured() {
        assert_eq!(
            turn_endpoint(Some("typo"), &names(&["scripted", "chat"]), None),
            Err("no endpoint named 'typo'; configured: scripted, chat".to_string())
        );
    }

    #[test]
    fn no_configured_endpoint_is_refused_with_the_way_to_configure_one() {
        assert_eq!(
            turn_endpoint(None, &[], None),
            Err(NO_ENDPOINT_CONFIGURED.to_string())
        );
        assert_eq!(
            turn_endpoint(Some("chat"), &[], None),
            Err("no endpoint named 'chat'; configured: ".to_string())
        );
    }

    /// A writer a test can read back, standing in for standard error.
    #[derive(Clone, Default)]
    struct Captured(Arc<Mutex<Vec<u8>>>);

    impl Write for Captured {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().expect("buffer").extend_from_slice(bytes);
            Ok(bytes.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl Captured {
        fn text(&self) -> String {
            String::from_utf8_lossy(&self.0.lock().expect("buffer")).into_owned()
        }
    }

    fn chunk(kind: &str, text: &str) -> String {
        serde_json::json!({
            "seq": 1,
            "at": "2026-10-22T00:00:00.000Z",
            "type": "assistant/chunk",
            "chunk": { "type": kind, "text": text }
        })
        .to_string()
    }

    #[test]
    fn reasoning_and_content_reach_stderr_as_separate_deltas_in_the_order_they_arrived() {
        let stderr = Captured::default();
        let view = print_stream("s1", Box::new(stderr.clone()));
        view.observe("s1", &chunk("reasoning-delta", "thinking about it"));
        // Written the moment it is observed, not at the end of the turn.
        assert!(
            stderr.text().contains("[reasoning] thinking about it"),
            "{}",
            stderr.text()
        );
        view.observe("s1", &chunk("text-delta", "the answer"));
        view.observe(
            "s1",
            &serde_json::json!({ "type": "assistant/completed" }).to_string(),
        );
        let printed = stderr.text();
        assert!(printed.contains("the answer"), "{printed}");
        assert!(
            printed.find("[reasoning]") < printed.find("the answer"),
            "reasoning came before the content, as the provider sent it: {printed}"
        );
    }

    #[test]
    fn the_summary_is_what_json_prints_under_stream() {
        let view = print_stream("s1", Box::new(Captured::default()));
        view.observe("s1", &chunk("reasoning-delta", "r"));
        view.observe("s1", &chunk("text-delta", "a"));
        view.observe("s1", &chunk("text-delta", "b"));
        view.observe(
            "s1",
            &serde_json::json!({ "type": "assistant/completed" }).to_string(),
        );
        view.dispose();
        let summary: serde_json::Value =
            serde_json::from_str(&view.summary_json()).expect("the summary is JSON");
        assert_eq!(summary["textDeltas"], serde_json::json!(2));
        assert_eq!(summary["reasoningDeltas"], serde_json::json!(1));
        assert_eq!(summary["toolCalls"], serde_json::json!(0));
        assert_eq!(summary["completed"], serde_json::json!(true));
        assert!(summary["spanMs"].is_u64());
        assert_eq!(
            summary
                .as_object()
                .map(|object| object.keys().cloned().collect::<Vec<_>>()),
            Some(names(&[
                "textDeltas",
                "reasoningDeltas",
                "toolCalls",
                "spanMs",
                "completed"
            ])),
            "the TypeScript build's field order"
        );
    }

    #[test]
    fn another_sessions_events_a_bad_line_and_anything_after_dispose_are_ignored() {
        let stderr = Captured::default();
        let view = print_stream("s1", Box::new(stderr.clone()));
        view.observe("s2", &chunk("text-delta", "not mine"));
        view.observe("s1", "not json");
        view.dispose();
        view.observe("s1", &chunk("text-delta", "too late"));
        assert_eq!(stderr.text(), "");
        let summary: serde_json::Value =
            serde_json::from_str(&view.summary_json()).expect("the summary is JSON");
        assert_eq!(summary["textDeltas"], serde_json::json!(0));
        assert_eq!(summary["completed"], serde_json::json!(false));
    }

    #[test]
    fn the_view_is_shared_between_the_event_listener_and_the_turn() {
        // The binary's session listener feeds the view on another thread while the turn holds it to dispose it
        // and read the summary; both see one view.
        fn assert_shareable<T: Send + Sync>() {}
        assert_shareable::<StreamView>();
        let stderr = Captured::default();
        let view = Arc::new(print_stream("s1", Box::new(stderr.clone())));
        let listener = {
            let view = view.clone();
            std::thread::spawn(move || {
                view.observe("s1", &chunk("reasoning-delta", "r"));
                view.observe("s1", &chunk("text-delta", "t"));
                view.observe(
                    "s1",
                    &serde_json::json!({ "type": "assistant/completed" }).to_string(),
                );
            })
        };
        listener.join().expect("the listener ran");
        view.dispose();
        let summary = view.summary();
        assert_eq!(summary["textDeltas"], serde_json::json!(1));
        assert_eq!(summary["reasoningDeltas"], serde_json::json!(1));
        assert_eq!(summary["completed"], serde_json::json!(true));
        assert!(stderr.text().contains("[reasoning] r"), "{}", stderr.text());
    }

    #[test]
    fn every_turn_of_a_resumed_session_is_counted_by_its_own_view() {
        // 20-streaming runs two turns in one session and requires both to report deltas: each turn starts its
        // own view, so the second turn's summary is not the first's left over.
        for _turn in 0..2 {
            let view = print_stream("s1", Box::new(Captured::default()));
            view.observe("s1", &chunk("reasoning-delta", "r"));
            view.observe("s1", &chunk("text-delta", "t"));
            view.dispose();
            let summary: serde_json::Value =
                serde_json::from_str(&view.summary_json()).expect("the summary is JSON");
            assert_eq!(summary["textDeltas"], serde_json::json!(1));
            assert_eq!(summary["reasoningDeltas"], serde_json::json!(1));
        }
    }
}
