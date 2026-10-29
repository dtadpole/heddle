//! The question vocabulary and its checks, ported from `src/questions/service.ts`.
//!
//! The refusal sentences and the order of the checks are the TypeScript build's, so a model or a page reads the same
//! answer from either binary.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The version written on every question event.
pub const QUESTION_EVENT_VERSION: u64 = 1;
/// DSH's default foreground wait for a timed call, in seconds.
pub const DEFAULT_TIMEOUT_SECONDS: i64 = 120;
/// The longest wait a call may name, in seconds: DSH's schema bound.
pub const MAX_TIMEOUT_SECONDS: i64 = 2_147_483;

/// One choice the person may pick.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct QuestionOption {
    /// The label an answer selects.
    pub label: String,
    /// One sentence explaining the tradeoff.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// One question in a batch, in the normalised form the log keeps.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Question {
    /// Unique within the batch; echoed in the answer.
    pub id: String,
    /// The question's text.
    pub question: String,
    /// An optional short heading.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub header: Option<String>,
    /// Choices, absent when there are none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<QuestionOption>>,
    /// Present (and `true`) only for a multi-select question.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub multi_select: Option<bool>,
}

impl Question {
    fn is_multi(&self) -> bool {
        self.multi_select == Some(true)
    }
}

/// One answer: chosen labels, and free text that supplements a multi-select or replaces a single choice.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Answer {
    /// The question this answers.
    pub id: String,
    /// The chosen labels; empty with no `custom` is a skip.
    pub selected: Vec<String>,
    /// Free text, absent when unused.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom: Option<String>,
}

/// The stable refusal codes.
pub mod codes {
    /// The batch is not one the tool can ask.
    pub const INVALID_QUESTIONS: &str = "INVALID_QUESTIONS";
    /// The answer batch does not fit its questions.
    pub const INVALID_ANSWERS: &str = "INVALID_ANSWERS";
    /// No such request in the session.
    pub const NOT_FOUND: &str = "NOT_FOUND";
    /// The request is already answered or cancelled.
    pub const SETTLED: &str = "SETTLED";
    /// The turn was stopped.
    pub const CANCELLED: &str = "CANCELLED";
    /// The session log could not be read or written.
    pub const LOG: &str = "LOG";
}

/// A refusal with a stable code, the TypeScript `QuestionError`.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct QuestionError {
    /// One of [`codes`].
    pub code: &'static str,
    /// The sentence a person and the model read.
    pub message: String,
}

impl QuestionError {
    /// A refusal with this code and sentence.
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
}

fn invalid_questions(message: String) -> QuestionError {
    QuestionError::new(codes::INVALID_QUESTIONS, message)
}

fn invalid_answers(message: String) -> QuestionError {
    QuestionError::new(codes::INVALID_ANSWERS, message)
}

/// A string with something other than spaces in it, kept as written (the TypeScript `text`).
fn text(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).filter(|value| !value.trim().is_empty()).map(str::to_owned)
}

/// Check a batch the way DSH's schema does: at least one question, unique non-empty ids, a question each.
pub fn validate_questions(raw: &Value) -> Result<Vec<Question>, QuestionError> {
    let entries = match raw.as_array() {
        Some(entries) if !entries.is_empty() => entries,
        _ => return Err(invalid_questions("questions must be a non-empty list".into())),
    };
    let mut seen = HashSet::new();
    let mut questions = Vec::with_capacity(entries.len());
    for (index, entry) in entries.iter().enumerate() {
        let Some(entry) = entry.as_object() else {
            return Err(invalid_questions(format!("question {} is not an object", index + 1)));
        };
        let id = text(entry.get("id"));
        let question = text(entry.get("question"));
        let Some(id) = id else {
            return Err(invalid_questions(format!("question {} needs an id", index + 1)));
        };
        if !seen.insert(id.clone()) {
            return Err(invalid_questions(format!("question id '{id}' is used twice")));
        }
        let Some(question) = question else {
            return Err(invalid_questions(format!("question '{id}' needs its text")));
        };
        let mut options = None;
        if let Some(raw_options) = entry.get("options") {
            let Some(raw_options) = raw_options.as_array() else {
                return Err(invalid_questions(format!("question '{id}' options must be a list")));
            };
            let mut labels = HashSet::new();
            let mut parsed = Vec::with_capacity(raw_options.len());
            for (at, option) in raw_options.iter().enumerate() {
                let object = option.as_object();
                let Some(label) = object.and_then(|option| text(option.get("label"))) else {
                    return Err(invalid_questions(format!("question '{id}' option {} needs a label", at + 1)));
                };
                if !labels.insert(label.clone()) {
                    return Err(invalid_questions(format!("question '{id}' has the option '{label}' twice")));
                }
                let description = object.and_then(|option| text(option.get("description")));
                parsed.push(QuestionOption { label, description });
            }
            options = Some(parsed);
        }
        questions.push(Question {
            id,
            question,
            header: text(entry.get("header")),
            options: options.filter(|options| !options.is_empty()),
            multi_select: (entry.get("multi_select") == Some(&Value::Bool(true))).then_some(true),
        });
    }
    Ok(questions)
}

/// Check an answer batch against its questions: one item per question, labels from that question's options, at
/// most one label for a single-select question, free text only as a string. A skip is `selected: []` with no
/// `custom`; a missing item is refused, because DSH answers one item per question. Returned in question order.
pub fn validate_answers(questions: &[Question], raw: &Value) -> Result<Vec<Answer>, QuestionError> {
    let Some(entries) = raw.as_array() else {
        return Err(invalid_answers("answers must be a list".into()));
    };
    let by_id: HashMap<&str, &Question> = questions.iter().map(|question| (question.id.as_str(), question)).collect();
    let mut given: HashMap<String, Answer> = HashMap::new();
    for entry in entries {
        let Some((object, id)) = entry.as_object().and_then(|object| object.get("id").and_then(Value::as_str).map(|id| (object, id))) else {
            return Err(invalid_answers("every answer needs the id of its question".into()));
        };
        let Some(question) = by_id.get(id) else {
            return Err(invalid_answers(format!("no question has the id '{id}'")));
        };
        if given.contains_key(id) {
            return Err(invalid_answers(format!("question '{id}' is answered twice")));
        }
        let selected: Vec<String> = match object.get("selected") {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Array(labels)) if labels.iter().all(Value::is_string) => {
                labels.iter().filter_map(Value::as_str).map(str::to_owned).collect()
            }
            Some(_) => return Err(invalid_answers(format!("answer '{id}' must select labels"))),
        };
        let labels: HashSet<&str> = question.options.iter().flatten().map(|option| option.label.as_str()).collect();
        if let Some(label) = selected.iter().find(|label| !labels.contains(label.as_str())) {
            return Err(invalid_answers(format!("'{label}' is not an option of question '{id}'")));
        }
        if selected.iter().collect::<HashSet<_>>().len() != selected.len() {
            return Err(invalid_answers(format!("answer '{id}' selects a label twice")));
        }
        if !question.is_multi() && selected.len() > 1 {
            return Err(invalid_answers(format!("question '{id}' takes one choice")));
        }
        let custom = match object.get("custom") {
            None => None,
            Some(Value::String(custom)) => Some(custom.trim().to_owned()).filter(|custom| !custom.is_empty()),
            Some(_) => return Err(invalid_answers(format!("answer '{id}' custom must be text"))),
        };
        let kept = if !question.is_multi() && custom.is_some() { Vec::new() } else { selected };
        given.insert(id.to_owned(), Answer { id: id.to_owned(), selected: kept, custom });
    }
    let mut answers = Vec::with_capacity(questions.len());
    for question in questions {
        match given.remove(&question.id) {
            Some(answer) => answers.push(answer),
            None => {
                return Err(invalid_answers(format!(
                    "question '{}' has no answer (send selected: [] to skip it)",
                    question.id
                )))
            }
        }
    }
    Ok(answers)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn batch() -> Vec<Question> {
        validate_questions(&json!([
            { "id": "cleanup", "question": "Delete?", "options": [{ "label": "Yes (Recommended)", "description": "x" }, { "label": "No" }] },
            { "id": "tags", "question": "Which?", "options": [{ "label": "a" }, { "label": "b" }, { "label": "c" }], "multi_select": true }
        ]))
        .unwrap()
    }

    #[test]
    fn a_batch_is_checked_and_normalised_as_the_typescript_build_does() {
        let refused = |raw: Value| validate_questions(&raw).unwrap_err().message;
        assert_eq!(refused(json!([])), "questions must be a non-empty list");
        assert_eq!(refused(json!([{ "id": "a", "question": "x" }, { "id": "a", "question": "y" }])), "question id 'a' is used twice");
        assert_eq!(refused(json!([{ "id": "a" }])), "question 'a' needs its text");
        assert_eq!(refused(json!([{ "id": "a", "question": "x", "options": [{ "label": "p" }, { "label": "p" }] }])), "question 'a' has the option 'p' twice");
        let normalised = validate_questions(&json!([{ "id": "a", "question": "x", "header": "", "options": [], "multi_select": false }])).unwrap();
        assert_eq!(serde_json::to_string(&normalised).unwrap(), r#"[{"id":"a","question":"x"}]"#);
    }

    #[test]
    fn an_answer_batch_has_one_item_per_question_and_skip_is_an_empty_selection() {
        let questions = batch();
        let refused = |raw: Value| validate_answers(&questions, &raw).unwrap_err().message;
        assert_eq!(refused(json!([{ "id": "cleanup", "selected": ["No"] }])), "question 'tags' has no answer (send selected: [] to skip it)");
        assert_eq!(refused(json!([{ "id": "cleanup", "selected": ["Maybe"] }, { "id": "tags", "selected": [] }])), "'Maybe' is not an option of question 'cleanup'");
        assert_eq!(refused(json!([{ "id": "cleanup", "selected": ["No", "Yes (Recommended)"] }, { "id": "tags" }])), "question 'cleanup' takes one choice");
        let answers = validate_answers(
            &questions,
            &json!([{ "id": "tags", "selected": ["a", "c"], "custom": " and d " }, { "id": "cleanup", "selected": ["No"], "custom": "only the logs" }]),
        )
        .unwrap();
        assert_eq!(
            serde_json::to_string(&answers).unwrap(),
            r#"[{"id":"cleanup","selected":[],"custom":"only the logs"},{"id":"tags","selected":["a","c"],"custom":"and d"}]"#
        );
        let skipped = validate_answers(&questions, &json!([{ "id": "cleanup", "selected": [] }, { "id": "tags" }])).unwrap();
        assert_eq!(serde_json::to_string(&skipped).unwrap(), r#"[{"id":"cleanup","selected":[]},{"id":"tags","selected":[]}]"#);
    }
}
