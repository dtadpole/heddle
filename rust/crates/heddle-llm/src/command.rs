//! The turn's `--endpoint` and `--stream`: which endpoint answers, and the live view of what it says.
//!
//! Ported from the turn path of `main()` in `src/cli.ts` (the two endpoint sentences, `printStream` started before
//! `runTurn` and disposed after it, and the summary under `stream` in `--json`). Per D-043 the behaviour lives in
//! the crate that owns it and the binary only dispatches to it, so every public signature here uses **std types
//! only** — strings, slices, `std::io::Write` — and nothing from the binary crate.
//!
//! Both are modifiers of `--turn`, not commands of their own: the turn's driver asks [`turn_endpoint`] before it
//! opens the session, starts a [`StreamView`] before the turn so nothing that arrives is missed, feeds it every
//! `session/event` of that session, and disposes it after the turn (and the goal driver) finish.
//!
//! What the verifiers judge, and where it is pinned in the tests below:
//!
//! - `10-llm-backends` — the named endpoint answers; with none named, the configuration's default answers even when
//!   it is not first; `--json`'s `endpoint` is the endpoint that answered.
//! - `20-streaming` — reasoning and content reach stderr as separate deltas, reasoning first, the first one before
//!   the turn ends; `--json` carries `stream` with `textDeltas`, `reasoningDeltas` and `completed`.

use std::io::Write;
use std::sync::{Arc, Mutex};

use crate::printer::{StreamPrinter, StreamPrinterOptions};

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
    printer: StreamPrinter,
    disposed: bool,
}

/// Start printing one session's stream (`printStream(ctx, { session })`).
///
/// Every write is flushed at once, because a terminal that receives the answer at the end is exactly the failure
/// `20-streaming` exists to catch.
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
        printer,
        disposed: false,
    }
}

impl StreamView {
    /// One `session/event` as the session log writes it — a JSON object with `type` and the type's fields
    /// (`{"type":"assistant/chunk","chunk":{…}}`, `{"type":"assistant/completed",…}`, `{"type":"message",…}`).
    /// Another session's events, an event it does not show and a line that is not JSON are ignored, as is
    /// everything after [`StreamView::dispose`].
    pub fn observe(&mut self, session: &str, event_json: &str) {
        if self.disposed {
            return;
        }
        if let Ok(event) = serde_json::from_str::<serde_json::Value>(event_json) {
            self.printer.observe(session, &event);
        }
    }

    /// Stop printing; the summary keeps what was seen.
    pub fn dispose(&mut self) {
        self.disposed = true;
    }

    /// The summary `--json` prints under `stream`:
    /// `{"textDeltas":…,"reasoningDeltas":…,"toolCalls":…,"spanMs":…,"completed":…}`.
    pub fn summary_json(&self) -> String {
        serde_json::to_string(&self.printer.summary()).unwrap_or_else(|_| "{}".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let mut view = print_stream("s1", Box::new(stderr.clone()));
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
        let mut view = print_stream("s1", Box::new(Captured::default()));
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
        let mut view = print_stream("s1", Box::new(stderr.clone()));
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
    fn every_turn_of_a_resumed_session_is_counted_by_its_own_view() {
        // 20-streaming runs two turns in one session and requires both to report deltas: each turn starts its
        // own view, so the second turn's summary is not the first's left over.
        for _turn in 0..2 {
            let mut view = print_stream("s1", Box::new(Captured::default()));
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
