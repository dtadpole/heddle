//! The Trajectory ledger: one session's recorded events, projected as a turn-aware ledger.
//!
//! Ported from `projectLedger` in `src/server/ledger.ts`. The Chat view answers *what was said*; this answers
//! *what the harness did* — which step, in which turn, how long it took, and what it cost.
//!
//! The projection, event by event (`type` field):
//!
//! | Event | Becomes |
//! |---|---|
//! | `message` role `user` | closes the open turn, opens turn *n+1* with a `user` record as its prologue |
//! | `message` role `tool` | fills the open call it answers (by `toolCallId`, else the newest open one); an unmatched result is its own `tool` row; text starting `error` marks `state: error` |
//! | `message` role `assistant` | an `assistant` record |
//! | `session/created` | nothing |
//! | `model/request` | closes the open step and opens the next (the prologue folds into it); a `system`/`request` record carrying the estimate |
//! | `assistant/chunk` | assembles one streamed answer: text and reasoning deltas, provider usage, TTFT; a `tool-call` chunk is a `tool` record in state `running`; `done` settles it |
//! | `assistant/completed` | settles the stream; writes the answer only if the step does not already hold the same words; a `completed` note with finish reason and rounds |
//! | `turn/retry` | a `system`/`retry` record |
//! | `turn/completed` | closes the turn, with its rounds |
//! | `context/note` | a `system` record for `origin: system-prompt`, else a `context` record labelled by origin |
//! | anything else | a `system` record labelled by its type, its other fields as pretty JSON (at most 2000 UTF-16 units) |
//!
//! A stream still open when the events end is left **in flight**: no duration, `inFlight: true`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use heddle_web_composer::js;

use crate::usage::TokenUsage;

/// What produced a record. The vocabulary is DSH's, so a reader of either tool sees the same words.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LedgerKind {
    User,
    Assistant,
    Tool,
    Reasoning,
    System,
    Context,
    Compaction,
}

/// Where a record's token counts came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UsageSource {
    /// Reported by the provider.
    Provider,
    /// The harness's own estimate.
    Estimated,
}

/// A tool call's state: running until its result says otherwise.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolState {
    Running,
    Ok,
    Error,
}

/// One row of the ledger. Every optional field is skipped when `None`, so "not reported" never reads as zero.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerRecord {
    pub kind: LedgerKind,
    /// A one-line identity: the tool's name with its arrow, the model, or the record's kind.
    pub label: String,
    /// The full text — the tool's arguments, the reasoning, or the message.
    pub text: String,
    /// When it started, from its own event.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    /// How long it took, in milliseconds; absent while running and when the events cannot measure it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    /// Whether the record had not finished when the events ended. Serialised only when true.
    #[serde(default, skip_serializing_if = "is_false")]
    pub in_flight: bool,
    /// Time to first token, when a stream recorded one and a step start is known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ttft_ms: Option<u64>,
    /// Token counts; absent when the record carries none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<TokenUsage>,
    /// Present exactly when `usage` is.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage_source: Option<UsageSource>,
    /// Finish reason, refusal, and the like.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// A tool call's name, without the arrow its label carries.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// The call a result answers — the field that pairs the two halves into one row.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    /// What the tool answered, held on the call's own record.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<ToolState>,
    /// Which note wrote a context row: `system-prompt`, `instructions`, `runtime-context`, ….
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
}

fn is_false(value: &bool) -> bool {
    !*value
}

impl LedgerRecord {
    /// A record with only its kind, label and text set.
    pub fn new(kind: LedgerKind, label: impl Into<String>, text: impl Into<String>) -> Self {
        Self {
            kind,
            label: label.into(),
            text: text.into(),
            started_at: None,
            duration_ms: None,
            in_flight: false,
            ttft_ms: None,
            usage: None,
            usage_source: None,
            note: None,
            name: None,
            tool_call_id: None,
            result: None,
            state: None,
            origin: None,
        }
    }

    fn started(
        kind: LedgerKind,
        label: impl Into<String>,
        text: impl Into<String>,
        at: Option<&str>,
    ) -> Self {
        let mut record = Self::new(kind, label, text);
        record.started_at = at.map(str::to_owned);
        record
    }
}

/// A step: one model request and everything it produced.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerStep {
    /// 1-based within its turn.
    pub index: u32,
    pub records: Vec<LedgerRecord>,
    /// The model this step asked, when the request named one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
}

/// A turn: what one prompt caused, in steps.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerTurn {
    /// 1-based within the session.
    pub index: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rounds: Option<u64>,
    pub steps: Vec<LedgerStep>,
}

/// The session-wide token totals a header shows; each absent until something reported it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerTokens {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_write: Option<u64>,
    /// The sum of every request's own estimate.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub estimated: Option<u64>,
}

/// The whole ledger, plus the totals a header shows.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ledger {
    pub turns: Vec<LedgerTurn>,
    /// Records that belong to no turn — events recorded before the first prompt.
    pub loose: Vec<LedgerRecord>,
    pub tokens: LedgerTokens,
    /// How many records the ledger holds, loose ones included.
    pub records: usize,
    /// How many of them are in flight.
    pub in_flight: usize,
}

/// Milliseconds between two timestamps, or `None` when either is missing or the pair is backwards.
fn between(from: Option<&str>, to: Option<&str>) -> Option<u64> {
    let start = js::parse_time_ms(from?)?;
    let end = js::parse_time_ms(to?)?;
    if end < start {
        None
    } else {
        Some((end - start) as u64)
    }
}

/// The words a message carried: every content part's `text`, concatenated as the TypeScript does.
fn message_text(event: &Value) -> String {
    let mut text = String::new();
    if let Some(parts) = event
        .get("message")
        .and_then(|message| message.get("content"))
        .and_then(Value::as_array)
    {
        for part in parts {
            text.push_str(part.get("text").and_then(Value::as_str).unwrap_or(""));
        }
    }
    text
}

fn at_of(event: &Value) -> Option<&str> {
    event.get("at").and_then(Value::as_str)
}

fn type_of(event: &Value) -> &str {
    event.get("type").and_then(Value::as_str).unwrap_or("")
}

/// The action a tool result reports: DSH's rule is a text starting with `error`, case-insensitively.
fn is_refusal(text: &str) -> bool {
    text.get(..5)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("error"))
}

/// One number as the TypeScript prints it when it interpolates the field.
fn number_text(value: Option<&Value>) -> Option<String> {
    let value = value?;
    if let Some(number) = value.as_u64() {
        return Some(number.to_string());
    }
    value.as_f64().map(|number| number.to_string())
}

/// A chunk stream that is being assembled into one assistant record.
struct PendingAssistant {
    parts: Vec<String>,
    reasoning: Vec<String>,
    started_at: Option<String>,
    first_token_at: Option<String>,
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    cache_read_tokens: Option<u64>,
    cache_write_tokens: Option<u64>,
    saw_provider_usage: bool,
}

impl PendingAssistant {
    fn new(started_at: Option<&str>) -> Self {
        Self {
            parts: Vec::new(),
            reasoning: Vec::new(),
            started_at: started_at.map(str::to_owned),
            first_token_at: None,
            input_tokens: None,
            output_tokens: None,
            cache_read_tokens: None,
            cache_write_tokens: None,
            saw_provider_usage: false,
        }
    }
}

/// The open step while it is being filled.
struct StepBuf {
    started_at: Option<String>,
    ended_at: Option<String>,
    model: Option<String>,
    records: Vec<LedgerRecord>,
}

/// The open turn while it is being filled.
struct TurnBuf {
    index: u32,
    started_at: Option<String>,
    ended_at: Option<String>,
    rounds: Option<u64>,
    steps: Vec<LedgerStep>,
}

/// Where an open call lives, so its result can be written into the same record.
#[derive(Clone, Copy)]
enum CallLocation {
    Step(usize),
    Prologue(usize),
    Loose(usize),
}

/// The projection's running state. The event loop is a method so each rule reads once.
struct Projector {
    turns: Vec<LedgerTurn>,
    loose: Vec<LedgerRecord>,
    turn: Option<TurnBuf>,
    /// Records that belong to the current turn but precede its first step — the prompt.
    prologue: Vec<LedgerRecord>,
    step: Option<StepBuf>,
    pending: Option<PendingAssistant>,
    input: Option<u64>,
    output: Option<u64>,
    cache_read: Option<u64>,
    cache_write: Option<u64>,
    estimated: Option<u64>,
}

impl Projector {
    fn new() -> Self {
        Self {
            turns: Vec::new(),
            loose: Vec::new(),
            turn: None,
            prologue: Vec::new(),
            step: None,
            pending: None,
            input: None,
            output: None,
            cache_read: None,
            cache_write: None,
            estimated: None,
        }
    }

    /// Where a record goes: the open step, or the turn's prologue, or the loose records.
    fn put(&mut self, record: LedgerRecord) {
        if let Some(step) = self.step.as_mut() {
            step.records.push(record);
        } else if self.turn.is_some() {
            self.prologue.push(record);
        } else {
            self.loose.push(record);
        }
    }

    /// Close the open step. `keep_prologue` holds the prompt for the step a `model/request` is about to open.
    fn close_step(&mut self, at: Option<&str>, keep_prologue: bool) {
        let mut step = self.step.take();
        let records = step
            .as_mut()
            .map(|step| std::mem::take(&mut step.records))
            .unwrap_or_default();
        let started_at = step.as_ref().and_then(|step| step.started_at.clone());
        let model = step.as_ref().and_then(|step| step.model.clone());
        let ended_at = step
            .as_ref()
            .and_then(|step| step.ended_at.clone())
            .or_else(|| at.map(str::to_owned));
        if records.is_empty() && self.prologue.is_empty() {
            return;
        }
        if records.is_empty() {
            // Nothing but a prompt so far: it waits for the step that will hold it.
            if !keep_prologue {
                let started = self
                    .prologue
                    .first()
                    .and_then(|record| record.started_at.clone());
                let prologue = std::mem::take(&mut self.prologue);
                if let Some(turn) = self.turn.as_mut() {
                    turn.steps.push(LedgerStep {
                        index: turn.steps.len() as u32 + 1,
                        records: prologue,
                        model: None,
                        started_at: started,
                        duration_ms: None,
                    });
                }
            }
            return;
        }
        let duration = between(started_at.as_deref(), ended_at.as_deref());
        let mut merged = std::mem::take(&mut self.prologue);
        merged.extend(records);
        if let Some(turn) = self.turn.as_mut() {
            turn.steps.push(LedgerStep {
                index: turn.steps.len() as u32 + 1,
                records: merged,
                model,
                started_at,
                duration_ms: duration,
            });
        }
    }

    /// Close the current turn, if there is one.
    fn close_turn(&mut self, at: Option<&str>, rounds: Option<u64>) {
        self.close_step(at, false);
        if !self.prologue.is_empty() {
            self.close_step(at, false);
        }
        let Some(turn) = self.turn.take() else {
            return;
        };
        let end = at.map(str::to_owned).or_else(|| turn.ended_at.clone());
        let duration = between(turn.started_at.as_deref(), end.as_deref());
        self.turns.push(LedgerTurn {
            index: turn.index,
            started_at: turn.started_at,
            duration_ms: duration,
            rounds: turn.rounds.or(rounds),
            steps: turn.steps,
        });
    }

    /// The open tool call a result belongs to, searched newest-first through the step, the prologue and the
    /// loose records.
    fn open_call(&self, tool_call_id: Option<&str>) -> Option<CallLocation> {
        let step_records = self.step.as_ref().map(|step| &step.records);
        let lists = [step_records, Some(&self.prologue), Some(&self.loose)];
        for (slot, list) in lists.into_iter().enumerate() {
            let Some(list) = list else {
                continue;
            };
            for index in (0..list.len()).rev() {
                let record = &list[index];
                if record.kind != LedgerKind::Tool || record.result.is_some() {
                    continue;
                }
                // A provider that sends no id is paired with the newest call still open; a result that
                // carries one matches only its own call.
                if let (Some(wanted), Some(found)) = (tool_call_id, record.tool_call_id.as_deref())
                    && wanted != found
                {
                    continue;
                }
                return Some(match slot {
                    0 => CallLocation::Step(index),
                    1 => CallLocation::Prologue(index),
                    _ => CallLocation::Loose(index),
                });
            }
        }
        None
    }

    /// Write a result into the call it answers, so one row shows both halves.
    fn answer_call(&mut self, location: CallLocation, result: String, refused: bool) {
        let record = match location {
            CallLocation::Step(index) => self.step.as_mut().map(|step| &mut step.records[index]),
            CallLocation::Prologue(index) => self.prologue.get_mut(index),
            CallLocation::Loose(index) => self.loose.get_mut(index),
        };
        if let Some(record) = record {
            record.result = Some(result);
            record.state = Some(if refused {
                ToolState::Error
            } else {
                ToolState::Ok
            });
            if refused {
                record.note = Some("the tool refused this call".to_owned());
            }
        }
    }

    /// Close an in-flight assistant stream. `settled` decides whether it gets a duration or is marked running.
    fn settle_assistant(&mut self, at: Option<&str>, settled: bool) {
        let Some(pending) = self.pending.take() else {
            return;
        };
        let text = pending.parts.concat();
        let reasoning = pending.reasoning.concat();
        let ttft = between(
            pending.started_at.as_deref(),
            pending.first_token_at.as_deref(),
        );
        if !reasoning.is_empty() {
            self.put(LedgerRecord::started(
                LedgerKind::Reasoning,
                "reasoning",
                reasoning,
                pending.started_at.as_deref(),
            ));
        }
        let has_usage = pending.input_tokens.is_some() || pending.output_tokens.is_some();
        if !text.is_empty() || has_usage {
            let mut record = LedgerRecord::started(
                LedgerKind::Assistant,
                "assistant",
                text,
                pending.started_at.as_deref(),
            );
            if settled {
                record.duration_ms = between(pending.started_at.as_deref(), at);
            }
            record.in_flight = !settled;
            record.ttft_ms = ttft;
            if has_usage {
                record.usage = Some(TokenUsage {
                    input_tokens: pending.input_tokens,
                    output_tokens: pending.output_tokens,
                    cache_read_tokens: pending.cache_read_tokens,
                    cache_write_tokens: pending.cache_write_tokens,
                });
                record.usage_source = Some(if pending.saw_provider_usage {
                    UsageSource::Provider
                } else {
                    UsageSource::Estimated
                });
            }
            self.put(record);
        }
    }

    fn push(&mut self, event: &Value) {
        let at = at_of(event);
        match type_of(event) {
            "message" => self.message(event, at),
            "session/created" => {}
            "model/request" => self.model_request(event, at),
            "assistant/chunk" => self.chunk(event, at),
            "assistant/completed" => self.completed(event, at),
            "turn/retry" => self.put(LedgerRecord::started(
                LedgerKind::System,
                "retry",
                "this step was retried",
                at,
            )),
            "turn/completed" => {
                self.settle_assistant(at, true);
                self.close_turn(at, event.get("rounds").and_then(Value::as_u64));
            }
            "context/note" => self.context_note(event, at),
            other => self.unknown(event, at, other),
        }
    }

    fn message(&mut self, event: &Value, at: Option<&str>) {
        let role = event
            .get("message")
            .and_then(|message| message.get("role"))
            .and_then(Value::as_str);
        match role {
            Some("user") => {
                self.settle_assistant(at, true);
                self.close_turn(at, None);
                self.turn = Some(TurnBuf {
                    index: self.turns.len() as u32 + 1,
                    started_at: at.map(str::to_owned),
                    ended_at: None,
                    rounds: None,
                    steps: Vec::new(),
                });
                self.prologue = vec![LedgerRecord::started(
                    LedgerKind::User,
                    "user",
                    message_text(event),
                    at,
                )];
            }
            Some("tool") => {
                let text = message_text(event);
                let refused = is_refusal(&text);
                let tool_call_id = event
                    .get("message")
                    .and_then(|message| message.get("toolCallId"))
                    .and_then(Value::as_str);
                match self.open_call(tool_call_id) {
                    Some(location) => self.answer_call(location, text, refused),
                    None => {
                        let mut record = LedgerRecord::started(
                            LedgerKind::Tool,
                            if refused {
                                "tool (refused)"
                            } else {
                                "tool result"
                            },
                            "",
                            at,
                        );
                        record.result = Some(text);
                        record.state = Some(if refused {
                            ToolState::Error
                        } else {
                            ToolState::Ok
                        });
                        if refused {
                            record.note = Some("the tool refused this call".to_owned());
                        }
                        self.put(record);
                    }
                }
            }
            Some("assistant") => {
                self.settle_assistant(at, true);
                self.put(LedgerRecord::started(
                    LedgerKind::Assistant,
                    "assistant",
                    message_text(event),
                    at,
                ));
            }
            _ => {}
        }
    }

    fn model_request(&mut self, event: &Value, at: Option<&str>) {
        self.settle_assistant(at, true);
        // The prompt waits for this step, which is the one it belongs to.
        self.close_step(at, true);
        self.step = Some(StepBuf {
            started_at: at.map(str::to_owned),
            ended_at: None,
            model: event
                .get("model")
                .and_then(Value::as_str)
                .map(str::to_owned),
            records: Vec::new(),
        });
        let Some(estimated) = event.get("estimatedTokens").and_then(Value::as_u64) else {
            return;
        };
        self.estimated = Some(self.estimated.unwrap_or(0) + estimated);
        let mut lines = vec![format!(
            "{} message(s)",
            number_text(event.get("messages")).unwrap_or_else(|| "?".to_owned())
        )];
        if let Some(tools) = event.get("tools").and_then(Value::as_array) {
            let names: Vec<&str> = tools.iter().filter_map(Value::as_str).collect();
            lines.push(format!("tools: {}", names.join(", ")));
        }
        if let Some(endpoint) = event.get("endpoint").and_then(Value::as_str) {
            lines.push(format!("endpoint: {endpoint}"));
        }
        if let Some(pruned) = event.get("pruned").and_then(Value::as_u64)
            && pruned > 0
        {
            lines.push(format!("pruned: {pruned}"));
        }
        if event.get("compacted").and_then(Value::as_bool) == Some(true) {
            lines.push("compacted: yes".to_owned());
        }
        let mut record = LedgerRecord::started(LedgerKind::System, "request", lines.join("\n"), at);
        record.usage = Some(TokenUsage {
            input_tokens: Some(estimated),
            ..TokenUsage::default()
        });
        record.usage_source = Some(UsageSource::Estimated);
        self.put(record);
    }

    fn chunk(&mut self, event: &Value, at: Option<&str>) {
        let Some(chunk) = event.get("chunk") else {
            return;
        };
        if self.pending.is_none() {
            self.pending = Some(PendingAssistant::new(at));
        }
        let pending = self
            .pending
            .as_mut()
            .expect("a pending stream was just opened");
        if pending.first_token_at.is_none() {
            pending.first_token_at = at.map(str::to_owned);
        }
        let chunk_type = chunk.get("type").and_then(Value::as_str).unwrap_or("");
        match chunk_type {
            "text-delta" => {
                if let Some(text) = chunk.get("text").and_then(Value::as_str) {
                    self.pending
                        .as_mut()
                        .expect("a pending stream was just opened")
                        .parts
                        .push(text.to_owned());
                }
            }
            "reasoning-delta" => {
                if let Some(text) = chunk.get("text").and_then(Value::as_str) {
                    self.pending
                        .as_mut()
                        .expect("a pending stream was just opened")
                        .reasoning
                        .push(text.to_owned());
                }
            }
            "tool-call" => {
                if let Some(name) = chunk.get("name").and_then(Value::as_str) {
                    self.settle_assistant(at, true);
                    let arguments = chunk
                        .get("arguments")
                        .and_then(Value::as_str)
                        .unwrap_or("{}");
                    let mut record =
                        LedgerRecord::started(LedgerKind::Tool, format!("→ {name}"), arguments, at);
                    record.name = Some(name.to_owned());
                    record.state = Some(ToolState::Running);
                    record.tool_call_id =
                        chunk.get("id").and_then(Value::as_str).map(str::to_owned);
                    self.put(record);
                }
            }
            _ => {}
        }
        // Provider usage, read **before** a `done` chunk settles the record: providers normally report it with
        // the last chunk, and the first version settled first and then wrote to a record that was closed.
        if let Some(pending) = self.pending.as_mut()
            && let Some(usage) = chunk.get("usage")
        {
            let reported = TokenUsage {
                input_tokens: usage.get("inputTokens").and_then(Value::as_u64),
                output_tokens: usage.get("outputTokens").and_then(Value::as_u64),
                cache_read_tokens: usage.get("cacheReadTokens").and_then(Value::as_u64),
                cache_write_tokens: usage.get("cacheWriteTokens").and_then(Value::as_u64),
            };
            if !reported.is_empty() {
                pending.saw_provider_usage = true;
                if let Some(value) = reported.input_tokens {
                    pending.input_tokens = Some(value);
                    self.input = Some(self.input.unwrap_or(0) + value);
                }
                if let Some(value) = reported.output_tokens {
                    pending.output_tokens = Some(value);
                    self.output = Some(self.output.unwrap_or(0) + value);
                }
                if let Some(value) = reported.cache_read_tokens {
                    pending.cache_read_tokens = Some(value);
                    self.cache_read = Some(self.cache_read.unwrap_or(0) + value);
                }
                if let Some(value) = reported.cache_write_tokens {
                    pending.cache_write_tokens = Some(value);
                    self.cache_write = Some(self.cache_write.unwrap_or(0) + value);
                }
            }
        }
        if chunk_type == "done" {
            self.settle_assistant(at, true);
        }
    }

    fn completed(&mut self, event: &Value, at: Option<&str>) {
        self.settle_assistant(at, true);
        let text = event.get("text").and_then(Value::as_str).unwrap_or("");
        // A `done` chunk settles the stream before this event arrives, so "was a stream pending" would write a
        // real answer twice. The question is whether these words are already recorded here.
        let already = |records: &[LedgerRecord]| {
            records
                .iter()
                .any(|record| record.kind == LedgerKind::Assistant && record.text == text)
        };
        let recorded = self
            .step
            .as_ref()
            .is_some_and(|step| already(&step.records))
            || already(&self.prologue);
        if !text.is_empty() && !recorded {
            self.put(LedgerRecord::started(
                LedgerKind::Assistant,
                "assistant",
                text,
                at,
            ));
        }
        let mut notes = Vec::new();
        if let Some(finish) = event.get("finishReason").and_then(Value::as_str) {
            notes.push(format!("finish: {finish}"));
        }
        if let Some(rounds) = number_text(event.get("rounds")) {
            notes.push(format!("rounds: {rounds}"));
        }
        if !notes.is_empty() {
            self.put(LedgerRecord::started(
                LedgerKind::System,
                "completed",
                notes.join("\n"),
                at,
            ));
        }
        if let Some(step) = self.step.as_mut() {
            step.ended_at = at.map(str::to_owned);
        }
    }

    fn context_note(&mut self, event: &Value, at: Option<&str>) {
        let origin = event
            .get("origin")
            .and_then(Value::as_str)
            .unwrap_or("note")
            .to_owned();
        let text = message_text(event);
        let label = match origin.as_str() {
            "system-prompt" => "system prompt",
            "instructions" => "instructions",
            other => other,
        };
        let kind = if origin == "system-prompt" {
            LedgerKind::System
        } else {
            LedgerKind::Context
        };
        let mut record = LedgerRecord::started(kind, label, text, at);
        record.origin = Some(origin);
        self.put(record);
    }

    fn unknown(&mut self, event: &Value, at: Option<&str>, type_name: &str) {
        let mut rest = serde_json::Map::new();
        if let Some(map) = event.as_object() {
            for (key, value) in map {
                if key != "seq" && key != "at" && key != "type" {
                    rest.insert(key.clone(), value.clone());
                }
            }
        }
        // The type is what the row needs to say; the rest is what opening it is for, and never more than the
        // renderer will show.
        let text = if rest.is_empty() {
            type_name.to_owned()
        } else {
            js::utf16_slice(&js::stringify_pretty(&Value::Object(rest)), 2_000).to_owned()
        };
        self.put(LedgerRecord::started(
            LedgerKind::System,
            type_name,
            text,
            at,
        ));
    }

    fn finish(mut self) -> Ledger {
        // The tail is left open deliberately: a caller projecting a running session must see the unfinished
        // stream as unfinished.
        self.settle_assistant(None, false);
        self.close_turn(None, None);
        let records = self
            .turns
            .iter()
            .flat_map(|turn| turn.steps.iter())
            .map(|step| step.records.len())
            .sum::<usize>()
            + self.loose.len();
        let in_flight = self
            .turns
            .iter()
            .flat_map(|turn| turn.steps.iter().flat_map(|step| step.records.iter()))
            .chain(self.loose.iter())
            .filter(|record| record.in_flight)
            .count();
        Ledger {
            turns: self.turns,
            loose: self.loose,
            tokens: LedgerTokens {
                input: self.input,
                output: self.output,
                cache_read: self.cache_read,
                cache_write: self.cache_write,
                estimated: self.estimated,
            },
            records,
            in_flight,
        }
    }
}

/// Project events into the ledger. Pure: the same events always give the same ledger.
pub fn project_ledger(events: &[Value]) -> Ledger {
    let mut projector = Projector::new();
    for event in events {
        projector.push(event);
    }
    projector.finish()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    /// One logged event, in the shape the ledger reads.
    fn event(seq: u64, at: &str, rest: Value) -> Value {
        let mut map = serde_json::Map::new();
        map.insert("seq".to_owned(), json!(seq));
        map.insert("at".to_owned(), json!(at));
        if let Value::Object(fields) = rest {
            for (key, value) in fields {
                map.insert(key, value);
            }
        }
        Value::Object(map)
    }

    fn message(seq: u64, at: &str, role: &str, text: &str) -> Value {
        event(
            seq,
            at,
            json!({"type": "message", "message": {"role": role, "content": [{"type": "text", "text": text}]}}),
        )
    }

    fn kinds(ledger: &Ledger) -> Vec<LedgerKind> {
        ledger.turns[0].steps[0]
            .records
            .iter()
            .map(|record| record.kind)
            .collect()
    }

    #[test]
    fn one_prompt_becomes_one_turn_with_its_steps_and_records() {
        let ledger = project_ledger(&[
            event(
                1,
                "2026-10-11T10:00:00.000Z",
                json!({"type": "session/created", "cwd": "/tmp"}),
            ),
            message(2, "2026-10-11T10:00:00.000Z", "user", "what is a heddle?"),
            event(
                3,
                "2026-10-11T10:00:00.100Z",
                json!({"type": "model/request", "messages": 1, "estimatedTokens": 1200, "endpoint": "x", "tools": ["bash"]}),
            ),
            event(
                4,
                "2026-10-11T10:00:00.200Z",
                json!({"type": "assistant/chunk", "chunk": {"type": "reasoning-delta", "text": "thinking"}}),
            ),
            event(
                5,
                "2026-10-11T10:00:01.000Z",
                json!({"type": "assistant/chunk", "chunk": {"type": "text-delta", "text": "the part of a loom"}}),
            ),
            event(
                6,
                "2026-10-11T10:00:01.500Z",
                json!({"type": "assistant/completed", "text": "the part of a loom", "finishReason": "stop", "rounds": 1}),
            ),
            event(
                7,
                "2026-10-11T10:00:01.500Z",
                json!({"type": "turn/completed", "rounds": 1}),
            ),
        ]);
        assert_eq!(ledger.turns.len(), 1, "one turn");
        assert_eq!(
            ledger.turns[0].steps.len(),
            1,
            "and one step for one request"
        );
        assert_eq!(
            kinds(&ledger),
            vec![
                LedgerKind::User,
                LedgerKind::System,
                LedgerKind::Reasoning,
                LedgerKind::Assistant,
                LedgerKind::System
            ],
            "the records are grouped in order"
        );
        assert!(
            ledger.turns[0].steps[0].records[4].text.contains("finish:"),
            "the last one says how the step ended"
        );
        assert_eq!(
            ledger.turns[0].steps[0].records[0].text, "what is a heddle?",
            "the prompt is the turn opener"
        );
        assert!(
            ledger.turns[0].steps[0].records[1].text.contains("1200")
                || ledger.turns[0].steps[0].records[1].text.contains("message"),
            "the request record carries what the request said"
        );
    }

    #[test]
    fn a_turn_and_its_step_get_durations_and_a_step_with_no_end_gets_none() {
        let ledger = project_ledger(&[
            message(1, "2026-10-11T10:00:00.000Z", "user", "go"),
            event(
                2,
                "2026-10-11T10:00:00.000Z",
                json!({"type": "model/request", "estimatedTokens": 10}),
            ),
            event(
                3,
                "2026-10-11T10:00:02.000Z",
                json!({"type": "assistant/completed", "text": "done"}),
            ),
            event(
                4,
                "2026-10-11T10:00:02.000Z",
                json!({"type": "turn/completed", "rounds": 1}),
            ),
        ]);
        assert_eq!(
            ledger.turns[0].duration_ms,
            Some(2000),
            "the turn measured two seconds"
        );
        assert_eq!(
            ledger.turns[0].steps[0].duration_ms,
            Some(2000),
            "and so did its step"
        );
    }

    #[test]
    fn an_unfinished_stream_is_marked_in_flight_and_carries_no_duration() {
        let ledger = project_ledger(&[
            message(1, "2026-10-11T10:00:00.000Z", "user", "go"),
            event(
                2,
                "2026-10-11T10:00:00.000Z",
                json!({"type": "model/request", "estimatedTokens": 10}),
            ),
            event(
                3,
                "2026-10-11T10:00:00.500Z",
                json!({"type": "assistant/chunk", "chunk": {"type": "text-delta", "text": "half an ans"}}),
            ),
        ]);
        let partial = ledger.turns[0].steps[0]
            .records
            .iter()
            .find(|record| record.kind == LedgerKind::Assistant)
            .expect("the partial answer is recorded");
        assert!(partial.in_flight, "and marked in flight");
        assert_eq!(
            partial.duration_ms, None,
            "with no duration invented for it"
        );
        assert_eq!(
            partial.started_at.as_deref(),
            Some("2026-10-11T10:00:00.500Z"),
            "but with the start it does know"
        );
        assert_eq!(ledger.in_flight, 1, "and the ledger counts it");
    }

    #[test]
    fn an_unreported_token_count_is_absent_not_zero() {
        let ledger = project_ledger(&[
            message(1, "2026-10-11T10:00:00.000Z", "user", "go"),
            event(
                2,
                "2026-10-11T10:00:00.000Z",
                json!({"type": "model/request", "messages": 1}),
            ),
            event(
                3,
                "2026-10-11T10:00:01.000Z",
                json!({"type": "assistant/chunk", "chunk": {"type": "text-delta", "text": "answer"}}),
            ),
            event(
                4,
                "2026-10-11T10:00:01.000Z",
                json!({"type": "assistant/completed", "text": "answer"}),
            ),
        ]);
        let answer = ledger.turns[0].steps[0]
            .records
            .iter()
            .find(|record| record.kind == LedgerKind::Assistant)
            .expect("the answer");
        assert_eq!(
            answer.usage, None,
            "no usage object at all rather than zeroes"
        );
        assert_eq!(
            ledger.tokens,
            LedgerTokens::default(),
            "and the totals are empty rather than zero"
        );
        assert_eq!(serde_json::to_value(ledger.tokens).unwrap(), json!({}));
    }

    #[test]
    fn provider_usage_is_kept_apart_from_the_harness_estimate() {
        let ledger = project_ledger(&[
            message(1, "2026-10-11T10:00:00.000Z", "user", "go"),
            event(
                2,
                "2026-10-11T10:00:00.000Z",
                json!({"type": "model/request", "estimatedTokens": 900}),
            ),
            event(
                3,
                "2026-10-11T10:00:00.500Z",
                json!({"type": "assistant/chunk", "chunk": {"type": "text-delta", "text": "answer"}}),
            ),
            event(
                4,
                "2026-10-11T10:00:01.000Z",
                json!({"type": "assistant/chunk", "chunk": {"type": "done", "usage": {"inputTokens": 812, "outputTokens": 7}}}),
            ),
            event(
                5,
                "2026-10-11T10:00:01.000Z",
                json!({"type": "assistant/completed", "text": "answer"}),
            ),
        ]);
        let records = &ledger.turns[0].steps[0].records;
        let request = records
            .iter()
            .find(|record| record.label == "request")
            .expect("the request record");
        let answer = records
            .iter()
            .find(|record| record.kind == LedgerKind::Assistant)
            .expect("the answer");
        assert_eq!(
            request.usage_source,
            Some(UsageSource::Estimated),
            "the request record is the harness estimate"
        );
        assert_eq!(
            answer.usage_source,
            Some(UsageSource::Provider),
            "and the answer holds what the provider reported"
        );
        assert_eq!(
            answer.usage,
            Some(TokenUsage {
                input_tokens: Some(812),
                output_tokens: Some(7),
                ..TokenUsage::default()
            })
        );
        assert_eq!(ledger.tokens.input, Some(812));
        assert_eq!(ledger.tokens.output, Some(7));
        assert_eq!(
            ledger.tokens.estimated,
            Some(900),
            "the totals keep the two apart"
        );
    }

    #[test]
    fn a_tool_call_and_its_result_are_one_record_and_a_refusal_marks_that_record() {
        let ledger = project_ledger(&[
            message(1, "2026-10-11T10:00:00.000Z", "user", "run it"),
            event(
                2,
                "2026-10-11T10:00:00.000Z",
                json!({"type": "model/request", "estimatedTokens": 10}),
            ),
            event(
                3,
                "2026-10-11T10:00:00.100Z",
                json!({"type": "assistant/chunk", "chunk": {"type": "tool-call", "id": "c1", "name": "bash", "arguments": "{\"command\":\"pwd\"}"}}),
            ),
            event(
                4,
                "2026-10-11T10:00:00.200Z",
                json!({"type": "message", "message": {"role": "tool", "toolCallId": "c1", "content": [{"type": "text", "text": "/tmp/work"}]}}),
            ),
            event(
                5,
                "2026-10-11T10:00:00.300Z",
                json!({"type": "assistant/chunk", "chunk": {"type": "tool-call", "id": "c2", "name": "write_file", "arguments": "{\"path\":\"/etc/x\"}"}}),
            ),
            event(
                6,
                "2026-10-11T10:00:00.400Z",
                json!({"type": "message", "message": {"role": "tool", "toolCallId": "c2", "content": [{"type": "text", "text": "error: outside the sandbox root"}]}}),
            ),
        ]);
        let calls: Vec<&LedgerRecord> = ledger.turns[0].steps[0]
            .records
            .iter()
            .filter(|record| record.kind == LedgerKind::Tool)
            .collect();
        assert_eq!(calls.len(), 2, "two calls, two records — not four");
        assert_eq!(
            calls[0].name.as_deref(),
            Some("bash"),
            "the first names its tool"
        );
        assert_eq!(
            calls[0].text, "{\"command\":\"pwd\"}",
            "and holds the arguments exactly as recorded"
        );
        assert_eq!(
            calls[0].result.as_deref(),
            Some("/tmp/work"),
            "with the answer on the same record"
        );
        assert_eq!(calls[0].state, Some(ToolState::Ok));
        assert_eq!(calls[1].name.as_deref(), Some("write_file"));
        assert_eq!(
            calls[1].state,
            Some(ToolState::Error),
            "a refusal marks the call it answers"
        );
        assert_eq!(
            calls[1].note.as_deref(),
            Some("the tool refused this call"),
            "and says so in words"
        );
    }

    #[test]
    fn records_that_belong_to_no_turn_are_kept_not_dropped() {
        let ledger = project_ledger(&[event(
            1,
            "2026-10-11T10:00:00.000Z",
            json!({"type": "something/new", "detail": 7}),
        )]);
        assert_eq!(ledger.turns.len(), 0, "no turn was opened");
        assert_eq!(
            ledger.loose.len(),
            1,
            "and the event is kept as a loose record"
        );
        assert_eq!(
            ledger.loose[0].label, "something/new",
            "named by its own type"
        );
        assert_eq!(ledger.records, 1);
    }

    #[test]
    fn projecting_the_same_events_twice_gives_the_same_ledger() {
        let events = vec![
            message(1, "2026-10-11T10:00:00.000Z", "user", "go"),
            event(
                2,
                "2026-10-11T10:00:00.000Z",
                json!({"type": "model/request", "estimatedTokens": 10}),
            ),
            event(
                3,
                "2026-10-11T10:00:01.000Z",
                json!({"type": "assistant/completed", "text": "done"}),
            ),
            event(
                4,
                "2026-10-11T10:00:01.000Z",
                json!({"type": "turn/completed", "rounds": 1}),
            ),
        ];
        assert_eq!(
            project_ledger(&events),
            project_ledger(&events),
            "a pure projection has no state to drift"
        );
    }

    #[test]
    fn an_answer_recorded_only_as_a_completion_still_appears() {
        let ledger = project_ledger(&[
            message(1, "2026-10-11T10:00:00.000Z", "user", "go"),
            event(
                2,
                "2026-10-11T10:00:00.100Z",
                json!({"type": "model/request", "estimatedTokens": 10}),
            ),
            event(
                3,
                "2026-10-11T10:00:01.000Z",
                json!({"type": "assistant/completed", "text": "the answer", "finishReason": "stop"}),
            ),
            event(
                4,
                "2026-10-11T10:00:01.000Z",
                json!({"type": "turn/completed", "rounds": 1}),
            ),
        ]);
        let answer = ledger.turns[0].steps[0]
            .records
            .iter()
            .find(|record| record.kind == LedgerKind::Assistant)
            .expect("the answer is recorded");
        assert_eq!(
            answer.text, "the answer",
            "with the text the completion carried"
        );
    }

    #[test]
    fn a_stream_and_its_completion_yield_one_answer_not_two() {
        let ledger = project_ledger(&[
            message(1, "2026-10-11T10:00:00.000Z", "user", "go"),
            event(
                2,
                "2026-10-11T10:00:00.100Z",
                json!({"type": "model/request", "estimatedTokens": 10}),
            ),
            event(
                3,
                "2026-10-11T10:00:00.500Z",
                json!({"type": "assistant/chunk", "chunk": {"type": "text-delta", "text": "the answer"}}),
            ),
            event(
                4,
                "2026-10-11T10:00:01.000Z",
                json!({"type": "assistant/completed", "text": "the answer"}),
            ),
            event(
                5,
                "2026-10-11T10:00:01.000Z",
                json!({"type": "turn/completed", "rounds": 1}),
            ),
        ]);
        let answers: Vec<&LedgerRecord> = ledger.turns[0].steps[0]
            .records
            .iter()
            .filter(|record| record.kind == LedgerKind::Assistant)
            .collect();
        assert_eq!(
            answers.len(),
            1,
            "the stream is the answer, and the completion does not duplicate it"
        );
        assert_eq!(answers[0].text, "the answer");
    }

    #[test]
    fn a_tool_result_fills_the_call_it_answers_so_one_row_holds_both_halves() {
        let ledger = project_ledger(&[
            message(1, "2026-10-17T10:00:00.000Z", "user", "list it"),
            event(
                2,
                "2026-10-17T10:00:00.100Z",
                json!({"type": "model/request", "messages": 1}),
            ),
            event(
                3,
                "2026-10-17T10:00:00.200Z",
                json!({"type": "assistant/chunk", "chunk": {"type": "tool-call", "id": "c1", "name": "list_dir", "arguments": "{\"path\":\"/tmp\"}"}}),
            ),
            event(
                4,
                "2026-10-17T10:00:00.300Z",
                json!({"type": "message", "message": {"role": "tool", "toolCallId": "c1", "content": [{"type": "text", "text": "a.txt\nb.txt"}]}}),
            ),
            event(
                5,
                "2026-10-17T10:00:00.400Z",
                json!({"type": "turn/completed", "rounds": 1}),
            ),
        ]);
        let tools: Vec<&LedgerRecord> = ledger.turns[0].steps[0]
            .records
            .iter()
            .filter(|record| record.kind == LedgerKind::Tool)
            .collect();
        assert_eq!(tools.len(), 1, "one call, one record");
        assert_eq!(
            tools[0].name.as_deref(),
            Some("list_dir"),
            "the call names the tool, apart from the arrow"
        );
        assert_eq!(
            tools[0].text, "{\"path\":\"/tmp\"}",
            "and keeps its arguments"
        );
        assert_eq!(
            tools[0].result.as_deref(),
            Some("a.txt\nb.txt"),
            "with the answer on the same record"
        );
        assert_eq!(
            tools[0].state,
            Some(ToolState::Ok),
            "and a state that says it worked"
        );
        assert_eq!(tools[0].label, "→ list_dir");
    }

    #[test]
    fn an_error_result_marks_the_call_failed_and_a_result_with_no_call_is_still_shown() {
        let ledger = project_ledger(&[
            message(1, "2026-10-17T10:00:00.000Z", "user", "go"),
            event(
                2,
                "2026-10-17T10:00:00.100Z",
                json!({"type": "model/request", "messages": 1}),
            ),
            event(
                3,
                "2026-10-17T10:00:00.200Z",
                json!({"type": "assistant/chunk", "chunk": {"type": "tool-call", "id": "c1", "name": "bash", "arguments": "{\"command\":\"false\"}"}}),
            ),
            event(
                4,
                "2026-10-17T10:00:00.300Z",
                json!({"type": "message", "message": {"role": "tool", "toolCallId": "c1", "content": [{"type": "text", "text": "error: exit 1"}]}}),
            ),
            event(
                5,
                "2026-10-17T10:00:00.400Z",
                json!({"type": "message", "message": {"role": "tool", "toolCallId": "c9", "content": [{"type": "text", "text": "orphan output"}]}}),
            ),
            event(
                6,
                "2026-10-17T10:00:00.500Z",
                json!({"type": "turn/completed", "rounds": 1}),
            ),
        ]);
        let tools: Vec<&LedgerRecord> = ledger.turns[0].steps[0]
            .records
            .iter()
            .filter(|record| record.kind == LedgerKind::Tool)
            .collect();
        assert_eq!(
            tools[0].state,
            Some(ToolState::Error),
            "a refusal marks the call it answers"
        );
        assert_eq!(tools[0].result.as_deref(), Some("error: exit 1"));
        assert_eq!(
            tools[1].result.as_deref(),
            Some("orphan output"),
            "a result with no call is still shown"
        );
        assert_eq!(tools[1].state, Some(ToolState::Ok));
    }

    #[test]
    fn a_call_with_no_id_is_paired_with_the_newest_call_still_open() {
        let ledger = project_ledger(&[
            message(1, "2026-10-17T10:00:00.000Z", "user", "go"),
            event(
                2,
                "2026-10-17T10:00:00.100Z",
                json!({"type": "model/request", "messages": 1}),
            ),
            event(
                3,
                "2026-10-17T10:00:00.200Z",
                json!({"type": "assistant/chunk", "chunk": {"type": "tool-call", "name": "bash", "arguments": "{\"command\":\"one\"}"}}),
            ),
            event(
                4,
                "2026-10-17T10:00:00.300Z",
                json!({"type": "message", "message": {"role": "tool", "content": [{"type": "text", "text": "first"}]}}),
            ),
            event(
                5,
                "2026-10-17T10:00:00.400Z",
                json!({"type": "assistant/chunk", "chunk": {"type": "tool-call", "name": "bash", "arguments": "{\"command\":\"two\"}"}}),
            ),
            event(
                6,
                "2026-10-17T10:00:00.500Z",
                json!({"type": "message", "message": {"role": "tool", "content": [{"type": "text", "text": "second"}]}}),
            ),
            event(
                7,
                "2026-10-17T10:00:00.600Z",
                json!({"type": "turn/completed", "rounds": 1}),
            ),
        ]);
        let tools: Vec<(&str, Option<&str>)> = ledger.turns[0].steps[0]
            .records
            .iter()
            .filter(|record| record.kind == LedgerKind::Tool)
            .map(|record| (record.text.as_str(), record.result.as_deref()))
            .collect();
        assert_eq!(
            tools,
            vec![
                ("{\"command\":\"one\"}", Some("first")),
                ("{\"command\":\"two\"}", Some("second"))
            ],
            "each result fills its own call, not the previous one"
        );
    }

    #[test]
    fn a_context_note_is_a_row_with_its_text_and_origin_not_a_json_dump() {
        let ledger = project_ledger(&[
            event(
                1,
                "2026-10-17T10:00:00.000Z",
                json!({"type": "context/note", "origin": "instructions", "message": {"role": "user", "content": [{"type": "text", "text": "be terse"}]}}),
            ),
            event(
                2,
                "2026-10-17T10:00:00.100Z",
                json!({"type": "context/note", "origin": "system-prompt", "message": {"role": "system", "content": [{"type": "text", "text": "you are heddle"}]}}),
            ),
        ]);
        let notes = &ledger.loose;
        assert_eq!(
            notes[0].kind,
            LedgerKind::Context,
            "the instruction baseline is a CONTEXT row"
        );
        assert_eq!(
            notes[0].text, "be terse",
            "the note's own words, not the event as JSON"
        );
        assert_eq!(notes[0].origin.as_deref(), Some("instructions"));
        assert_eq!(
            notes[1].kind,
            LedgerKind::System,
            "the system prompt is a SYSTEM row"
        );
        assert_eq!(notes[1].text, "you are heddle");
    }

    #[test]
    fn a_runtime_context_note_is_a_context_row_that_says_where_it_came_from() {
        // The 80-web-ui runtime-context check reads the ledger's rows for this: each snapshot must be one
        // attributed row whose text carries the policy, so a mode change is legible after the fact.
        let ledger = project_ledger(&[event(
            1,
            "2026-10-23T03:21:46.186Z",
            json!({
                "type": "context/note",
                "origin": "runtime-context",
                "identity": "Current runtime context",
                "surfaceOp": "append",
                "message": {"role": "user", "content": [{"type": "text", "text": "Current runtime context.\n\nCurrent heddle file policy: workspace-write."}]},
            }),
        )]);
        let note = &ledger.loose[0];
        assert_eq!(
            note.kind,
            LedgerKind::Context,
            "a runtime-context snapshot is a CONTEXT row, as DSH tags it"
        );
        assert_eq!(note.origin.as_deref(), Some("runtime-context"));
        assert_eq!(
            note.label, "runtime-context",
            "attributed to the harness, not to a person"
        );
        assert!(
            note.text
                .contains("Current heddle file policy: workspace-write"),
            "and the policy is in its text"
        );
        assert_eq!(
            crate::rows::preview_of(note),
            "Current runtime context.",
            "the table's one-line preview names the snapshot"
        );
    }

    #[test]
    fn a_streamed_answer_and_its_completion_are_one_record_with_the_done_chunk_between() {
        let ledger = project_ledger(&[
            message(1, "2026-10-17T10:00:00.000Z", "user", "list it"),
            event(
                2,
                "2026-10-17T10:00:00.100Z",
                json!({"type": "model/request", "messages": 1}),
            ),
            event(
                3,
                "2026-10-17T10:00:00.200Z",
                json!({"type": "assistant/chunk", "chunk": {"type": "text-delta", "text": "the answer"}}),
            ),
            event(
                4,
                "2026-10-17T10:00:00.300Z",
                json!({"type": "assistant/chunk", "chunk": {"type": "done"}}),
            ),
            event(
                5,
                "2026-10-17T10:00:00.400Z",
                json!({"type": "assistant/completed", "text": "the answer"}),
            ),
            event(
                6,
                "2026-10-17T10:00:00.500Z",
                json!({"type": "turn/completed", "rounds": 1}),
            ),
        ]);
        let answers: Vec<&LedgerRecord> = ledger.turns[0].steps[0]
            .records
            .iter()
            .filter(|record| record.kind == LedgerKind::Assistant)
            .collect();
        assert_eq!(answers.len(), 1, "one answer, not two");
        assert_eq!(answers[0].text, "the answer");
    }

    #[test]
    fn the_prompt_is_folded_into_one_step_not_every_step_of_the_turn() {
        let ledger = project_ledger(&[
            message(1, "2026-10-17T10:00:00.000Z", "user", "what is in here"),
            event(
                2,
                "2026-10-17T10:00:00.010Z",
                json!({"type": "context/note", "origin": "instructions", "message": {"role": "user", "content": [{"type": "text", "text": "be terse"}]}}),
            ),
            event(
                3,
                "2026-10-17T10:00:00.100Z",
                json!({"type": "model/request", "messages": 2}),
            ),
            event(
                4,
                "2026-10-17T10:00:00.200Z",
                json!({"type": "assistant/chunk", "chunk": {"type": "tool-call", "id": "c1", "name": "list_dir", "arguments": "{\"path\":\"/tmp\"}"}}),
            ),
            event(
                5,
                "2026-10-17T10:00:00.300Z",
                json!({"type": "assistant/chunk", "chunk": {"type": "done"}}),
            ),
            event(
                6,
                "2026-10-17T10:00:00.400Z",
                json!({"type": "message", "message": {"role": "tool", "toolCallId": "c1", "content": [{"type": "text", "text": "a.txt"}]}}),
            ),
            event(
                7,
                "2026-10-17T10:00:00.500Z",
                json!({"type": "model/request", "messages": 4}),
            ),
            event(
                8,
                "2026-10-17T10:00:00.600Z",
                json!({"type": "assistant/chunk", "chunk": {"type": "text-delta", "text": "two files"}}),
            ),
            event(
                9,
                "2026-10-17T10:00:00.700Z",
                json!({"type": "assistant/chunk", "chunk": {"type": "done"}}),
            ),
            event(
                10,
                "2026-10-17T10:00:00.800Z",
                json!({"type": "assistant/completed", "text": "two files"}),
            ),
            event(
                11,
                "2026-10-17T10:00:00.900Z",
                json!({"type": "turn/completed", "rounds": 1}),
            ),
        ]);
        let steps = &ledger.turns[0].steps;
        let of_kind = |kind: LedgerKind| {
            steps
                .iter()
                .flat_map(|step| step.records.iter())
                .filter(|record| record.kind == kind)
                .count()
        };
        assert_eq!(
            of_kind(LedgerKind::User),
            1,
            "the prompt is recorded once for the turn"
        );
        assert_eq!(
            of_kind(LedgerKind::Context),
            1,
            "and so is the instruction baseline it carried"
        );
        assert_eq!(
            steps[1]
                .records
                .iter()
                .filter(
                    |record| record.kind == LedgerKind::User || record.kind == LedgerKind::Context
                )
                .count(),
            0,
            "the second step starts from the model request, not from a copy of the prompt"
        );
    }

    #[test]
    fn an_unknown_event_keeps_its_other_fields_as_pretty_json_bounded_at_two_thousand_units() {
        let ledger = project_ledger(&[event(
            1,
            "2026-10-11T10:00:00.000Z",
            json!({"type": "custom/event", "detail": {"deep": [1, 2]}}),
        )]);
        let record = &ledger.loose[0];
        assert_eq!(record.kind, LedgerKind::System);
        assert_eq!(record.label, "custom/event");
        assert!(
            record.text.starts_with("{\n  \"detail\""),
            "the body is the other fields, pretty-printed"
        );
        assert!(
            !record.text.contains("\"seq\""),
            "the tuple is not repeated in the body"
        );

        let long = "x".repeat(5_000);
        let ledger = project_ledger(&[event(
            1,
            "2026-10-11T10:00:00.000Z",
            json!({"type": "custom/event", "detail": long}),
        )]);
        assert!(
            js::utf16_len(&ledger.loose[0].text) <= 2_000,
            "the body is bounded"
        );
    }

    #[test]
    fn a_request_records_what_it_asked_with_and_folds_its_estimate_once() {
        let ledger = project_ledger(&[
            message(1, "2026-10-11T10:00:00.000Z", "user", "go"),
            event(
                2,
                "2026-10-11T10:00:00.100Z",
                json!({"type": "model/request", "messages": 3, "estimatedTokens": 100, "endpoint": "scripted", "tools": ["bash", "list_dir"], "pruned": 2, "compacted": true, "model": "tiny"}),
            ),
            event(
                3,
                "2026-10-11T10:00:01.000Z",
                json!({"type": "turn/completed", "rounds": 1}),
            ),
        ]);
        let request = ledger.turns[0].steps[0]
            .records
            .iter()
            .find(|record| record.label == "request")
            .expect("the request record");
        assert_eq!(
            request.text,
            "3 message(s)\ntools: bash, list_dir\nendpoint: scripted\npruned: 2\ncompacted: yes"
        );
        assert_eq!(
            request.usage,
            Some(TokenUsage {
                input_tokens: Some(100),
                ..TokenUsage::default()
            })
        );
        assert_eq!(request.usage_source, Some(UsageSource::Estimated));
        assert_eq!(ledger.tokens.estimated, Some(100));
        assert_eq!(ledger.turns[0].steps[0].model.as_deref(), Some("tiny"));
    }

    #[test]
    fn turn_completed_rounds_become_the_turns_rounds() {
        let ledger = project_ledger(&[
            message(1, "2026-10-11T10:00:00.000Z", "user", "go"),
            event(
                2,
                "2026-10-11T10:00:01.000Z",
                json!({"type": "turn/completed", "rounds": 3}),
            ),
        ]);
        assert_eq!(ledger.turns[0].rounds, Some(3));
        assert_eq!(
            ledger.turns[0].steps.len(),
            1,
            "a prompt with no request is still a step"
        );
        assert_eq!(ledger.turns[0].steps[0].records[0].kind, LedgerKind::User);
    }

    #[test]
    fn a_retry_is_a_system_row() {
        let ledger = project_ledger(&[
            message(1, "2026-10-11T10:00:00.000Z", "user", "go"),
            event(
                2,
                "2026-10-11T10:00:00.100Z",
                json!({"type": "model/request"}),
            ),
            event(3, "2026-10-11T10:00:00.200Z", json!({"type": "turn/retry"})),
            event(
                4,
                "2026-10-11T10:00:01.000Z",
                json!({"type": "turn/completed", "rounds": 1}),
            ),
        ]);
        let retry = ledger.turns[0].steps[0]
            .records
            .iter()
            .find(|record| record.label == "retry")
            .expect("a retry record");
        assert_eq!(retry.kind, LedgerKind::System);
        assert_eq!(retry.text, "this step was retried");
    }

    #[test]
    fn a_bare_assistant_message_is_a_record_and_a_session_created_event_is_nothing() {
        let ledger = project_ledger(&[
            event(
                1,
                "2026-10-11T10:00:00.000Z",
                json!({"type": "session/created"}),
            ),
            message(2, "2026-10-11T10:00:00.100Z", "user", "go"),
            message(3, "2026-10-11T10:00:00.200Z", "assistant", "an answer"),
        ]);
        assert_eq!(
            ledger.turns[0].steps[0].records[1].kind,
            LedgerKind::Assistant
        );
        assert_eq!(ledger.turns[0].steps[0].records[1].text, "an answer");
    }
}
