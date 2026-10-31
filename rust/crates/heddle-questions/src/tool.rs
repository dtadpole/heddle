//! The model-facing `ask_user_question` tool, ported from `src/questions/tool.ts`.
//!
//! DSH's schema (a batch of questions with ids, an optional header, options with a label and a description, a
//! multi-select flag, and a per-call `timeout` in timed mode), DSH's compact JSON answers, and `DELEGATED_CALLER` for a
//! child agent, which must carry the decision back to its parent.

use std::sync::Arc;

use heddle_tools::{Tool, ToolArgs, ToolError, ToolFuture, ToolResult, ToolRunContext, ToolSpec};
use serde_json::{Map, Value, json};

use crate::model::{MAX_TIMEOUT_SECONDS, QuestionError};
use crate::service::{AskOutcome, Mode, QuestionService};

/// The tool's name.
pub const ASK_USER_TOOL: &str = "ask_user_question";

const DESCRIPTION: &str = "Ask the user for confirmation, a choice, or missing information. Send one or more questions with ids unique within the call; the answer echoes those ids. Put a recommended option first and append \"(Recommended)\" to its label. A skipped question comes back with empty selected and no custom.";

const PENDING_MESSAGE: &str = "The user has not answered yet. The questions stay answerable; continue with work that does not depend on the answer. A later answer arrives as a user message naming this callId. A timeout is never approval.";

/// The JSON Schema the model is shown; `timed` adds DSH's per-call wait.
pub fn ask_user_parameters(timed: bool, default_timeout: i64) -> Value {
    let question = json!({
        "type": "object",
        "properties": {
            "id": { "type": "string", "description": "Stable id for this question; echoed in the answer." },
            "question": { "type": "string", "description": "The specific question to ask the user." },
            "header": { "type": "string", "description": "Optional short heading for the question, such as \"Confirm\" or \"Choose Mode\"." },
            "options": {
                "type": "array",
                "description": "Optional choices to show the user. If you recommend one, put it first and append \"(Recommended)\" to that label.",
                "items": {
                    "type": "object",
                    "properties": {
                        "label": { "type": "string", "description": "Short user-facing option label." },
                        "description": { "type": "string", "description": "One sentence explaining the tradeoff or impact." }
                    },
                    "required": ["label"]
                }
            },
            "multi_select": { "type": "boolean", "description": "Whether the user may select more than one option. Defaults to false." }
        },
        "required": ["id", "question"]
    });
    let mut properties = Map::new();
    properties.insert(
        "questions".into(),
        json!({
            "type": "array",
            "minItems": 1,
            "description": if timed { "Questions to ask the user before continuing." } else { "Questions to ask the user." },
            "items": question
        }),
    );
    if timed {
        properties.insert(
            "timeout".into(),
            json!({
                "type": "integer",
                "minimum": -1,
                "maximum": MAX_TIMEOUT_SECONDS,
                "description": format!("Wait seconds for the entire batch (default {default_timeout}); omit unless the user specifies a duration. Use -1 only when an answer is required before proceeding.")
            }),
        );
    }
    json!({ "type": "object", "properties": properties, "required": ["questions"] })
}

/// A refusal whose output is its sentence, as the TypeScript tool writes it.
fn refusal(code: &str, message: &str) -> ToolResult {
    ToolResult {
        output: message.to_owned(),
        error: Some(ToolError {
            code: code.to_owned(),
            message: message.to_owned(),
        }),
        data: None,
    }
}

/// Whether a session is a delegated child: its record names a parent.
fn delegated_parent(meta_path: &str) -> Option<String> {
    let text = std::fs::read_to_string(meta_path).ok()?;
    let meta: Value = serde_json::from_str(&text).ok()?;
    meta.get("parentSession")
        .and_then(Value::as_str)
        .map(str::to_owned)
}

/// The tool, bound to one question service.
pub struct AskUserTool {
    service: Arc<QuestionService>,
    spec: ToolSpec,
}

impl AskUserTool {
    /// The tool over `service`; its schema follows the service's mode.
    pub fn new(service: Arc<QuestionService>) -> Self {
        let timed = service.mode() == Mode::Timed;
        let spec = ToolSpec {
            name: ASK_USER_TOOL.into(),
            description: DESCRIPTION.into(),
            parameters: ask_user_parameters(timed, service.default_timeout()),
        };
        Self { service, spec }
    }
}

impl Tool for AskUserTool {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }

    fn run<'a>(&'a self, args: ToolArgs, context: ToolRunContext) -> ToolFuture<'a> {
        Box::pin(async move {
            let Some(session) = context.session.clone() else {
                return Ok(refusal(
                    "NO_SESSION",
                    "ask_user_question needs a session a person can answer in",
                ));
            };
            if delegated_parent(&session.meta).is_some() {
                return Ok(refusal(
                    "DELEGATED_CALLER",
                    "a delegated agent cannot ask the user; include the unresolved question or decision in your final result",
                ));
            }
            let questions = args.get("questions").cloned().unwrap_or(Value::Null);
            match self
                .service
                .ask(
                    &session.id,
                    &questions,
                    args.get("timeout"),
                    context.cancel.clone(),
                )
                .await
            {
                Ok(AskOutcome::Pending { call_id }) => {
                    let output =
                        json!({ "pending": true, "callId": call_id, "message": PENDING_MESSAGE })
                            .to_string();
                    let mut data = Map::new();
                    data.insert("callId".into(), Value::String(call_id));
                    data.insert("pending".into(), Value::Bool(true));
                    Ok(ToolResult::ok(output).with_data(data))
                }
                Ok(AskOutcome::Answered(answers)) => {
                    let output = json!({ "answers": answers }).to_string();
                    let mut data = Map::new();
                    data.insert(
                        "answers".into(),
                        serde_json::to_value(&answers).unwrap_or(Value::Null),
                    );
                    Ok(ToolResult::ok(output).with_data(data))
                }
                Err(QuestionError { code, message }) => Ok(refusal(code, &message)),
            }
        })
    }
}
