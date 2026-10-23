//! The deterministic backend the checks run against, and the reason they spend nothing.
//!
//! Ported from `scriptedAdapter` in `src/llm/adapters.ts`. The endpoint's `baseUrl` names a JSON file
//! `{"steps": [...]}` (a leading `~` is the home directory). It reads no clock and calls nothing.
//!
//! - Steps are filtered by **purpose** (`step.purpose`, default `"turn"`, against `request.purpose`, default
//!   `"turn"`) and then handed out by **round** (`request.round`, default 0): one step per call, so a script is a
//!   sequence, not a repeat. A missing step answers nothing and finishes `stop`.
//! - A step may carry `reasoning`, `text`, `toolCall: {name, arguments}` (emitted as id `call-<name>` with the
//!   arguments re-serialized), `finishReason` (default `tool_calls` with a call, else `stop`), or
//!   `error: {code?, status?, message?}`, which fails the call instead (code default `SCRIPT`).
//! - The file is read on every call, so a check may rewrite it between turns.

use std::path::PathBuf;

use crate::adapter::{Adapter, ChunkStream};
use crate::error::ModelError;
use crate::types::{Chunk, GenerateRequest};
use heddle_config::EndpointConfig;

/// The scripted adapter for one endpoint.
#[derive(Debug, Clone)]
pub struct ScriptedAdapter {
    endpoint: EndpointConfig,
}

impl ScriptedAdapter {
    pub fn new(endpoint: EndpointConfig) -> Self {
        Self { endpoint }
    }
}

impl Adapter for ScriptedAdapter {
    fn endpoint(&self) -> &EndpointConfig {
        &self.endpoint
    }

    fn stream(&self, request: GenerateRequest) -> ChunkStream {
        let outcome = load_script(&self.endpoint)
            .and_then(|script| scripted_chunks(&script, &request, &self.endpoint.name));
        match outcome {
            Ok(chunks) => Box::pin(futures::stream::iter(chunks.into_iter().map(Ok))),
            Err(error) => Box::pin(futures::stream::once(async move { Err::<Chunk, _>(error) })),
        }
    }
}

/// The script's path: `base_url` with a leading `~` replaced by the home directory.
pub fn script_path(base_url: &str) -> PathBuf {
    expand_home(base_url, std::env::var_os("HOME").as_deref())
}

/// `~` expands to `home`, which a test supplies so the expansion is judged without touching the environment.
fn expand_home(base_url: &str, home: Option<&std::ffi::OsStr>) -> PathBuf {
    match (base_url.strip_prefix('~'), home) {
        (Some(rest), Some(home)) => PathBuf::from(home).join(rest.trim_start_matches('/')),
        _ => PathBuf::from(base_url),
    }
}

/// Read and parse the script (`SCRIPT` when it cannot be read or is not JSON). Steps are kept as raw JSON so a
/// malformed step reads as an empty one, as it does in the TypeScript build.
pub fn load_script(endpoint: &EndpointConfig) -> Result<serde_json::Value, ModelError> {
    let path = script_path(&endpoint.base_url);
    let text = std::fs::read_to_string(&path).map_err(|error| {
        ModelError::new(
            format!(
                "the script for '{}' could not be read at {}",
                endpoint.name,
                path.display()
            ),
            endpoint.name.clone(),
            crate::error::code::SCRIPT,
        )
        .with_source(error)
    })?;
    serde_json::from_str(&text).map_err(|error| {
        ModelError::new(
            format!(
                "the script for '{}' could not be read at {}",
                endpoint.name,
                path.display()
            ),
            endpoint.name.clone(),
            crate::error::code::SCRIPT,
        )
        .with_source(error)
    })
}

/// The chunks one call produces from a parsed script, or the error its step names.
pub fn scripted_chunks(
    script: &serde_json::Value,
    request: &GenerateRequest,
    endpoint_name: &str,
) -> Result<Vec<Chunk>, ModelError> {
    // Steps are separated by purpose, then handed out by round: a script is a sequence, not a repeat.
    let wanted = request.purpose.as_deref().unwrap_or("turn");
    let round = request.round.unwrap_or(0) as usize;
    let step = script
        .get("steps")
        .and_then(serde_json::Value::as_array)
        .and_then(|steps| {
            steps
                .iter()
                .filter(|entry| {
                    entry
                        .get("purpose")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("turn")
                        == wanted
                })
                .nth(round)
        });

    let Some(step) = step else {
        // No step answers nothing, which is an empty stop.
        return Ok(vec![Chunk::Done {
            finish_reason: "stop".into(),
            usage: None,
        }]);
    };

    if let Some(error) = step.get("error") {
        let code = error
            .get("code")
            .and_then(serde_json::Value::as_str)
            .unwrap_or(crate::error::code::SCRIPT);
        let message = error
            .get("message")
            .and_then(serde_json::Value::as_str)
            .map(ToString::to_string)
            .unwrap_or_else(|| format!("the script for '{endpoint_name}' failed at round {round}"));
        let mut failure = ModelError::new(message, endpoint_name, code);
        if let Some(status) = error
            .get("status")
            .and_then(serde_json::Value::as_u64)
            .and_then(|status| u16::try_from(status).ok())
        {
            failure = failure.with_status(status);
        }
        return Err(failure);
    }

    let mut chunks = Vec::new();
    if let Some(reasoning) = step
        .get("reasoning")
        .and_then(serde_json::Value::as_str)
        .filter(|text| !text.is_empty())
    {
        chunks.push(Chunk::ReasoningDelta {
            text: reasoning.to_string(),
        });
    }
    if let Some(text) = step
        .get("text")
        .and_then(serde_json::Value::as_str)
        .filter(|text| !text.is_empty())
    {
        chunks.push(Chunk::TextDelta {
            text: text.to_string(),
        });
    }
    let tool_call = step
        .get("toolCall")
        .filter(|call| call.is_object())
        .map(|call| {
            let name = call
                .get("name")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .to_string();
            let arguments = call
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({}));
            Chunk::ToolCall(crate::types::ToolCall {
                id: format!("call-{name}"),
                name,
                arguments: serde_json::to_string(&arguments).unwrap_or_else(|_| "{}".into()),
            })
        });
    let asked_for_tools = tool_call.is_some();
    if let Some(tool_call) = tool_call {
        chunks.push(tool_call);
    }

    let finish_reason = step
        .get("finishReason")
        .and_then(serde_json::Value::as_str)
        .map(ToString::to_string)
        .unwrap_or_else(|| {
            if asked_for_tools {
                "tool_calls".into()
            } else {
                "stop".into()
            }
        });
    chunks.push(Chunk::Done {
        finish_reason,
        usage: None,
    });
    Ok(chunks)
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};

    use futures::StreamExt;
    use serde_json::json;

    use super::*;
    use crate::types::{Chunk, ToolCall};
    use heddle_config::EndpointKind;

    fn endpoint(base_url: &str) -> EndpointConfig {
        EndpointConfig {
            name: "scripted".into(),
            kind: EndpointKind::Scripted,
            base_url: base_url.into(),
            model: None,
            models: None,
            reasoning: None,
            project: None,
            region: None,
            api_key: None,
            api_key_file: None,
            headers: None,
            stream: None,
            max_output_tokens: None,
            context_window: None,
            capabilities: None,
            input_modalities: None,
            proxy: None,
            timeout_ms: None,
        }
    }

    fn request(round: u32, purpose: Option<&str>) -> GenerateRequest {
        GenerateRequest {
            endpoint: "scripted".into(),
            round: Some(round),
            purpose: purpose.map(ToString::to_string),
            ..GenerateRequest::default()
        }
    }

    /// A script file on disk, removed when the test ends.
    struct TempScript {
        path: PathBuf,
        dir: PathBuf,
    }

    impl Drop for TempScript {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn script(steps: serde_json::Value) -> TempScript {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "heddle-scripted-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).expect("creates the temp dir");
        let path = dir.join("script.json");
        std::fs::write(
            &path,
            serde_json::to_string(&json!({ "steps": steps })).expect("serializes"),
        )
        .expect("writes the script");
        TempScript { path, dir }
    }

    fn text_chunks(chunks: &[Chunk]) -> Vec<&str> {
        chunks
            .iter()
            .filter_map(|chunk| match chunk {
                Chunk::TextDelta { text } => Some(text.as_str()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn a_step_is_chosen_by_purpose_and_an_untagged_script_stays_an_ordinary_turn() {
        let script = json!({ "steps": [
            { "text": "ordinary answer" },
            { "purpose": "team", "text": "teammate answer" },
            { "purpose": "team", "text": "second teammate step" }
        ] });
        let turn = scripted_chunks(&script, &request(0, None), "scripted").expect("answers");
        assert_eq!(text_chunks(&turn), vec!["ordinary answer"]);
        let team =
            scripted_chunks(&script, &request(0, Some("team")), "scripted").expect("answers");
        assert_eq!(text_chunks(&team), vec!["teammate answer"]);
    }

    #[test]
    fn a_purpose_with_no_steps_of_its_own_answers_nothing_instead_of_borrowing_another() {
        let script = json!({ "steps": [{ "text": "ordinary" }] });
        let chunks =
            scripted_chunks(&script, &request(0, Some("team")), "scripted").expect("answers");
        assert_eq!(text_chunks(&chunks), Vec::<&str>::new());
        assert_eq!(
            chunks,
            vec![Chunk::Done {
                finish_reason: "stop".into(),
                usage: None
            }]
        );
    }

    #[test]
    fn steps_are_handed_out_by_round_so_a_script_is_a_sequence_not_a_repeat() {
        let script = json!({ "steps": [{ "text": "first" }, { "text": "second" }] });
        assert_eq!(
            text_chunks(&scripted_chunks(&script, &request(0, None), "s").expect("answers")),
            vec!["first"]
        );
        assert_eq!(
            text_chunks(&scripted_chunks(&script, &request(1, None), "s").expect("answers")),
            vec!["second"]
        );
        // Past the end of the script, the call answers nothing rather than replaying it.
        assert_eq!(
            text_chunks(&scripted_chunks(&script, &request(7, None), "s").expect("answers")),
            Vec::<&str>::new()
        );
    }

    #[test]
    fn a_step_emits_reasoning_text_and_a_tool_call_in_that_order() {
        let script = json!({ "steps": [{
            "reasoning": "thinking",
            "text": "doing",
            "toolCall": { "name": "read_file", "arguments": { "path": "a.txt", "n": 2 } }
        }] });
        assert_eq!(
            scripted_chunks(&script, &request(0, None), "s").expect("answers"),
            vec![
                Chunk::ReasoningDelta {
                    text: "thinking".into()
                },
                Chunk::TextDelta {
                    text: "doing".into()
                },
                Chunk::ToolCall(ToolCall {
                    id: "call-read_file".into(),
                    name: "read_file".into(),
                    arguments: r#"{"path":"a.txt","n":2}"#.into(),
                }),
                Chunk::Done {
                    finish_reason: "tool_calls".into(),
                    usage: None
                },
            ]
        );
    }

    #[test]
    fn a_declared_finish_reason_wins_over_the_default() {
        let script = json!({ "steps": [{ "toolCall": { "name": "bash", "arguments": {} }, "finishReason": "length" }] });
        let chunks = scripted_chunks(&script, &request(0, None), "s").expect("answers");
        assert_eq!(
            chunks.last(),
            Some(&Chunk::Done {
                finish_reason: "length".into(),
                usage: None
            })
        );
    }

    #[test]
    fn a_step_can_fail_the_call_with_the_code_and_status_it_names() {
        let script = json!({ "steps": [{ "error": { "code": "HTTP", "status": 503, "message": "gateway down" } }] });
        let error = scripted_chunks(&script, &request(0, None), "s").expect_err("fails");
        assert_eq!(error.code, "HTTP");
        assert_eq!(error.status, Some(503));
        assert_eq!(error.to_string(), "gateway down");

        // A failure that names nothing is a script failure naming the round it happened in.
        let script = json!({ "steps": [{ "text": "0" }, { "text": "1" }, { "text": "2" }, { "error": {} }] });
        let error = scripted_chunks(&script, &request(3, None), "s").expect_err("fails");
        assert_eq!(error.code, crate::error::code::SCRIPT);
        assert!(error.to_string().contains("round 3"), "{error}");
        assert_eq!(error.endpoint, "s");
    }

    #[test]
    fn a_script_that_cannot_be_read_or_parsed_is_a_script_error_naming_the_path() {
        let missing = load_script(&endpoint("/nonexistent/script.json")).expect_err("missing");
        assert_eq!(missing.code, crate::error::code::SCRIPT);
        assert!(
            missing.to_string().contains("/nonexistent/script.json"),
            "{missing}"
        );
        assert!(missing.to_string().contains("'scripted'"), "{missing}");

        let dir = std::env::temp_dir().join(format!("heddle-scripted-bad-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("bad.json");
        std::fs::write(&path, "not json").expect("writes");
        let invalid = load_script(&endpoint(&path.to_string_lossy())).expect_err("not JSON");
        assert_eq!(invalid.code, crate::error::code::SCRIPT);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_leading_tilde_expands_to_the_home_directory() {
        assert_eq!(
            expand_home(
                "~/.heddle/scripted.json",
                Some(std::ffi::OsStr::new("/Users/me"))
            ),
            Path::new("/Users/me/.heddle/scripted.json").to_path_buf()
        );
        assert_eq!(
            expand_home("~", Some(std::ffi::OsStr::new("/Users/me"))),
            Path::new("/Users/me").to_path_buf()
        );
        // A path without a tilde, or no home to expand to, is left alone.
        assert_eq!(
            expand_home("/tmp/s.json", Some(std::ffi::OsStr::new("/Users/me"))),
            PathBuf::from("/tmp/s.json")
        );
        assert_eq!(expand_home("~/s.json", None), PathBuf::from("~/s.json"));
    }

    #[test]
    fn the_adapter_streams_the_chunks_its_script_names() {
        let script = script(json!([{ "reasoning": "hm", "text": "answer" }]));
        let adapter = ScriptedAdapter::new(endpoint(&script.path.to_string_lossy()));
        let chunks: Vec<_> =
            futures::executor::block_on(adapter.stream(request(0, None)).collect());
        assert_eq!(chunks.len(), 3);
        assert_eq!(
            chunks[0].as_ref().ok(),
            Some(&Chunk::ReasoningDelta { text: "hm".into() })
        );
        assert_eq!(
            chunks[1].as_ref().ok(),
            Some(&Chunk::TextDelta {
                text: "answer".into()
            })
        );
        assert!(matches!(chunks[2], Ok(Chunk::Done { .. })));
    }

    #[test]
    fn a_missing_script_fails_the_stream_as_its_only_item() {
        let adapter = ScriptedAdapter::new(endpoint("/nonexistent/script.json"));
        let chunks: Vec<_> =
            futures::executor::block_on(adapter.stream(request(0, None)).collect());
        assert_eq!(chunks.len(), 1);
        assert_eq!(
            chunks[0].as_ref().err().map(|error| error.code.as_str()),
            Some("SCRIPT")
        );
    }
}
