//! The session's bottom statistics — what the composer's dock prints — and the context panel's sections.
//!
//! Ported from `projectSessionStats` and `contextBreakdownWithFallback` in `src/server/ledger.ts`. One pass over
//! the session's own events: user messages are the turns, `turn/completed.rounds` are the steps, assistant chunks
//! carry the provider's usage per round. Nothing is estimated or multiplied; a figure no event pair measured stays
//! absent so the page prints a blank instead of an invented number.
//!
//! The server's chat route (`GET /api/sessions/{id}`) puts [`session_stats_view`] in its `stats` field.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use heddle_web_composer::js;

use crate::usage::{TokenUsage, billed_input_tokens, merge_token_usage};

/// The three meter sections of a request: system prompts, tool schemas, every other message.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct ContextBreakdown {
    pub system: u64,
    pub tools: u64,
    pub messages: u64,
}

/// The same three sections measured on the session's current surface (`ctx.context.measure`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct MeasuredSurface {
    pub system_tokens: u64,
    pub tools_tokens: u64,
    pub message_tokens: u64,
}

/// Which source the context panel's sections came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BreakdownSource {
    /// Recorded by the most recent request.
    Request,
    /// Measured on the current surface, because no request recorded sections.
    Current,
}

/// The sections the panel prints and where they came from; both absent when neither source has them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct BreakdownChoice {
    pub context_breakdown: Option<ContextBreakdown>,
    pub context_breakdown_source: Option<BreakdownSource>,
}

/// The dock's figures. Every optional field is skipped when `None`.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStats {
    /// User messages.
    pub turns: u64,
    /// The sum of every `turn/completed.rounds`.
    pub steps: u64,
    /// The sum of every chunk's provider usage, bucket by bucket.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<TokenUsage>,
    /// Over rounds that reported output tokens and whose both ends were recorded: request to closing frame.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generation_ms: Option<u64>,
    /// The output tokens of those same rounds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decode_tokens: Option<u64>,
    /// Request to closing frame, over every round with both ends recorded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub llm_ms: Option<u64>,
    /// Call chunk to result message, over every call whose result was recorded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_ms: Option<u64>,
    /// The **sum** of request-to-first-chunk waits; the page divides by `ttftSteps`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ttft_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ttft_steps: Option<u64>,
    /// The most recent request's recorded sections.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_breakdown: Option<ContextBreakdown>,
    /// The prompt-side total of the most recent round that reported one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_prompt_tokens: Option<u64>,
}

/// The chat route's `stats`: the dock's figures with the panel's sections chosen and their source stated.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatsView {
    /// `contextBreakdown` here is the chosen one (recorded, else measured).
    #[serde(flatten)]
    pub stats: SessionStats,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_breakdown_source: Option<BreakdownSource>,
}

/// `Date.parse` of an event's own `at`, or `None` when the event carries no usable time.
fn time_of(event: &Value) -> Option<i64> {
    js::parse_time_ms(event.get("at").and_then(Value::as_str)?)
}

/// One usage frame as the harness keeps it: every bucket that was reported, none that was not.
fn usage_of(value: Option<&Value>) -> Option<TokenUsage> {
    let value = value?;
    Some(TokenUsage {
        input_tokens: value.get("inputTokens").and_then(Value::as_u64),
        output_tokens: value.get("outputTokens").and_then(Value::as_u64),
        cache_read_tokens: value.get("cacheReadTokens").and_then(Value::as_u64),
        cache_write_tokens: value.get("cacheWriteTokens").and_then(Value::as_u64),
    })
}

/// Fold the dock's figures from a session's events.
pub fn project_session_stats(events: &[Value]) -> SessionStats {
    let mut turns = 0u64;
    let mut steps = 0u64;
    let mut usage: Option<TokenUsage> = None;
    let mut last_prompt_tokens: Option<u64> = None;
    let mut round_started_at: Option<i64> = None;
    let mut generation_ms = 0u64;
    let mut decode_tokens = 0u64;
    let mut llm_ms = 0u64;
    let mut llm_rounds = 0u64;
    let mut ttft_ms = 0u64;
    let mut ttft_steps = 0u64;
    let mut ttft_seen = false;
    let mut tool_ms = 0u64;
    let mut tool_calls = 0u64;
    let mut context_breakdown: Option<ContextBreakdown> = None;
    let mut pending_calls: HashMap<String, i64> = HashMap::new();

    for event in events {
        match event.get("type").and_then(Value::as_str).unwrap_or("") {
            "message" => {
                let role = event
                    .get("message")
                    .and_then(|message| message.get("role"))
                    .and_then(Value::as_str);
                if role == Some("user") {
                    turns += 1;
                } else if role == Some("tool") {
                    // A result closes the call it answers; an unmatched result measured nothing.
                    let call_id = event
                        .get("message")
                        .and_then(|message| message.get("toolCallId"))
                        .and_then(Value::as_str);
                    if let (Some(call_id), Some(at)) = (call_id, time_of(event))
                        && let Some(dispatched) = pending_calls.remove(call_id)
                    {
                        tool_ms += (at - dispatched).max(0) as u64;
                        tool_calls += 1;
                    }
                }
            }
            "turn/completed" => {
                steps += event
                    .get("rounds")
                    .and_then(Value::as_u64)
                    .filter(|rounds| *rounds > 0)
                    .unwrap_or(0);
            }
            "model/request" => {
                // A new round opens its own clock; a round that never reported tokens contributes nothing.
                round_started_at = time_of(event);
                ttft_seen = false;
                if let Some(sections) = event.get("breakdown") {
                    let system = sections.get("system").and_then(Value::as_u64);
                    let tools = sections.get("tools").and_then(Value::as_u64);
                    let messages = sections.get("messages").and_then(Value::as_u64);
                    if system.is_some() || tools.is_some() || messages.is_some() {
                        context_breakdown = Some(ContextBreakdown {
                            system: system.unwrap_or(0),
                            tools: tools.unwrap_or(0),
                            messages: messages.unwrap_or(0),
                        });
                    }
                }
            }
            "assistant/chunk" => {
                let Some(chunk) = event.get("chunk") else {
                    continue;
                };
                let at = time_of(event);
                let chunk_type = chunk.get("type").and_then(Value::as_str).unwrap_or("");
                if chunk_type == "tool-call"
                    && let (Some(id), Some(at)) = (chunk.get("id").and_then(Value::as_str), at)
                {
                    pending_calls.insert(id.to_owned(), at);
                }
                if !ttft_seen
                    && let (Some(round_start), Some(at)) = (round_started_at, at)
                    && chunk_type != "done"
                {
                    ttft_ms += (at - round_start).max(0) as u64;
                    ttft_steps += 1;
                    ttft_seen = true;
                }
                if let Some(frame) = usage_of(chunk.get("usage")) {
                    usage = merge_token_usage(usage, Some(frame));
                    if let Some(billed) = billed_input_tokens(Some(&frame)) {
                        last_prompt_tokens = Some(billed);
                    }
                }
                if chunk_type == "done" {
                    // Only a round that reported tokens contributes a rate, and only when both ends of its
                    // span were recorded.
                    let output_tokens = chunk
                        .get("usage")
                        .and_then(|usage| usage.get("outputTokens"))
                        .and_then(Value::as_u64);
                    if let (Some(round_start), Some(at), Some(output)) =
                        (round_started_at, at, output_tokens)
                    {
                        generation_ms += (at - round_start).max(0) as u64;
                        decode_tokens += output;
                    }
                    if let (Some(round_start), Some(at)) = (round_started_at, at) {
                        llm_ms += (at - round_start).max(0) as u64;
                        llm_rounds += 1;
                    }
                    round_started_at = None;
                }
            }
            _ => {}
        }
    }

    SessionStats {
        turns,
        steps,
        usage,
        generation_ms: (decode_tokens > 0).then_some(generation_ms),
        decode_tokens: (decode_tokens > 0).then_some(decode_tokens),
        llm_ms: (llm_rounds > 0).then_some(llm_ms),
        tool_ms: (tool_calls > 0).then_some(tool_ms),
        ttft_ms: (ttft_steps > 0).then_some(ttft_ms),
        ttft_steps: (ttft_steps > 0).then_some(ttft_steps),
        context_breakdown,
        last_prompt_tokens,
    }
}

/// Prefer the sections the request recorded; else the measured ones when any is non-zero; else nothing.
pub fn context_breakdown_with_fallback(
    recorded: Option<ContextBreakdown>,
    measured: Option<MeasuredSurface>,
) -> BreakdownChoice {
    if let Some(recorded) = recorded {
        return BreakdownChoice {
            context_breakdown: Some(recorded),
            context_breakdown_source: Some(BreakdownSource::Request),
        };
    }
    if let Some(measured) = measured
        && (measured.system_tokens > 0 || measured.tools_tokens > 0 || measured.message_tokens > 0)
    {
        return BreakdownChoice {
            context_breakdown: Some(ContextBreakdown {
                system: measured.system_tokens,
                tools: measured.tools_tokens,
                messages: measured.message_tokens,
            }),
            context_breakdown_source: Some(BreakdownSource::Current),
        };
    }
    BreakdownChoice::default()
}

/// The chat route's `stats` for a session. `measure` is called **only** when no request recorded sections, and
/// a measurement that fails answers `None`.
pub fn session_stats_view(
    events: &[Value],
    measure: impl FnOnce() -> Option<MeasuredSurface>,
) -> SessionStatsView {
    let mut stats = project_session_stats(events);
    let recorded = stats.context_breakdown;
    let measured = if recorded.is_none() { measure() } else { None };
    let choice = context_breakdown_with_fallback(recorded, measured);
    stats.context_breakdown = choice.context_breakdown;
    SessionStatsView {
        stats,
        context_breakdown_source: choice.context_breakdown_source,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;

    fn event(at: Option<&str>, rest: Value) -> Value {
        let mut map = match rest {
            Value::Object(map) => map,
            _ => serde_json::Map::new(),
        };
        if let Some(at) = at {
            map.insert("at".to_owned(), json!(at));
        }
        Value::Object(map)
    }

    fn at(ms: i64) -> String {
        js::to_iso_string(ms)
    }

    #[test]
    fn the_stats_fold_turns_steps_and_usage_buckets_from_the_sessions_own_events() {
        let events = vec![
            event(
                None,
                json!({"type": "message", "message": {"role": "user", "content": [{"type": "text", "text": "hi"}]}}),
            ),
            event(
                None,
                json!({"type": "assistant/chunk", "chunk": {"type": "done", "usage": {"inputTokens": 10, "outputTokens": 4, "cacheReadTokens": 30}}}),
            ),
            event(None, json!({"type": "turn/completed", "rounds": 2})),
            event(
                None,
                json!({"type": "message", "message": {"role": "user", "content": [{"type": "text", "text": "again"}]}}),
            ),
            event(
                None,
                json!({"type": "assistant/chunk", "chunk": {"type": "done", "usage": {"inputTokens": 5, "outputTokens": 6, "cacheWriteTokens": 7}}}),
            ),
            event(None, json!({"type": "turn/completed", "rounds": 3})),
        ];
        assert_eq!(
            project_session_stats(&events),
            SessionStats {
                turns: 2,
                steps: 5,
                usage: Some(TokenUsage {
                    input_tokens: Some(15),
                    output_tokens: Some(10),
                    cache_read_tokens: Some(30),
                    cache_write_tokens: Some(7),
                }),
                last_prompt_tokens: Some(12),
                ..SessionStats::default()
            },
            "the last reported prompt side is the context share's numerator (5 + 7)"
        );
    }

    #[test]
    fn the_stats_stay_empty_rather_than_zero_where_nothing_was_reported() {
        assert_eq!(
            project_session_stats(&[]),
            SessionStats {
                turns: 0,
                steps: 0,
                ..SessionStats::default()
            }
        );
        assert_eq!(
            serde_json::to_value(project_session_stats(&[])).unwrap(),
            json!({"turns": 0, "steps": 0})
        );
        let no_usage = vec![
            event(
                None,
                json!({"type": "message", "message": {"role": "user", "content": [{"type": "text", "text": "hi"}]}}),
            ),
            event(None, json!({"type": "turn/completed", "rounds": 1})),
        ];
        assert_eq!(
            project_session_stats(&no_usage),
            SessionStats {
                turns: 1,
                steps: 1,
                ..SessionStats::default()
            },
            "a frame with no usage leaves the usage absent"
        );
    }

    #[test]
    fn the_stats_fold_the_generation_span_and_decoded_tokens_of_each_round_that_reported_them() {
        let t0 = js::parse_time_ms("2026-10-17T00:00:00.000Z").unwrap();
        let events = vec![
            event(
                None,
                json!({"type": "message", "message": {"role": "user", "content": [{"type": "text", "text": "one"}]}}),
            ),
            event(Some(&at(t0)), json!({"type": "model/request"})),
            event(
                Some(&at(t0 + 100)),
                json!({"type": "assistant/chunk", "chunk": {"type": "text-delta", "text": "a"}}),
            ),
            event(
                Some(&at(t0 + 500)),
                json!({"type": "assistant/chunk", "chunk": {"type": "done", "finishReason": "stop", "usage": {"outputTokens": 50}}}),
            ),
            event(
                Some(&at(t0 + 500)),
                json!({"type": "turn/completed", "rounds": 1}),
            ),
            event(
                None,
                json!({"type": "message", "message": {"role": "user", "content": [{"type": "text", "text": "two"}]}}),
            ),
            event(Some(&at(t0 + 600)), json!({"type": "model/request"})),
            event(
                Some(&at(t0 + 700)),
                json!({"type": "assistant/chunk", "chunk": {"type": "reasoning-delta", "text": "think"}}),
            ),
            event(
                Some(&at(t0 + 1000)),
                json!({"type": "assistant/chunk", "chunk": {"type": "done", "finishReason": "stop", "usage": {"outputTokens": 20}}}),
            ),
            event(
                Some(&at(t0 + 1000)),
                json!({"type": "turn/completed", "rounds": 1}),
            ),
            // A round whose provider reported no tokens cannot contribute a rate; its time is not counted either.
            event(Some(&at(t0 + 1100)), json!({"type": "model/request"})),
            event(
                Some(&at(t0 + 1200)),
                json!({"type": "assistant/chunk", "chunk": {"type": "text-delta", "text": "b"}}),
            ),
            event(
                Some(&at(t0 + 1500)),
                json!({"type": "assistant/chunk", "chunk": {"type": "done", "finishReason": "stop"}}),
            ),
            event(
                Some(&at(t0 + 1500)),
                json!({"type": "turn/completed", "rounds": 1}),
            ),
        ];
        let stats = project_session_stats(&events);
        assert_eq!(
            stats.generation_ms,
            Some(900),
            "two measurable rounds: request-to-done spans of 500ms + 400ms"
        );
        assert_eq!(
            stats.decode_tokens,
            Some(70),
            "their reported output tokens: 50 + 20"
        );
    }

    #[test]
    fn decode_time_stays_absent_when_no_round_reported_tokens() {
        let events = vec![
            event(
                Some("2026-10-17T00:00:00.000Z"),
                json!({"type": "model/request"}),
            ),
            event(
                Some("2026-10-17T00:00:00.100Z"),
                json!({"type": "assistant/chunk", "chunk": {"type": "text-delta", "text": "x"}}),
            ),
            event(
                Some("2026-10-17T00:00:00.500Z"),
                json!({"type": "assistant/chunk", "chunk": {"type": "done", "finishReason": "stop"}}),
            ),
        ];
        let stats = project_session_stats(&events);
        assert_eq!(
            stats.generation_ms, None,
            "no tokens means no generation time to divide by"
        );
        assert_eq!(stats.decode_tokens, None);
    }

    #[test]
    fn the_stats_fold_llm_time_tool_time_and_average_ttft_from_the_event_pairs_that_measured_them()
    {
        let t0 = js::parse_time_ms("2026-10-17T00:00:00.000Z").unwrap();
        let events = vec![
            event(Some(&at(t0)), json!({"type": "model/request"})),
            event(
                Some(&at(t0 + 100)),
                json!({"type": "assistant/chunk", "chunk": {"type": "text-delta", "text": "a"}}),
            ),
            event(
                Some(&at(t0 + 200)),
                json!({"type": "assistant/chunk", "chunk": {"type": "tool-call", "id": "call-1", "name": "bash", "arguments": "{}"}}),
            ),
            event(
                Some(&at(t0 + 500)),
                json!({"type": "assistant/chunk", "chunk": {"type": "done", "finishReason": "tool_calls", "usage": {"outputTokens": 10}}}),
            ),
            event(
                Some(&at(t0 + 800)),
                json!({"type": "message", "message": {"role": "tool", "toolCallId": "call-1", "content": [{"type": "text", "text": "ok"}]}}),
            ),
            event(Some(&at(t0 + 900)), json!({"type": "model/request"})),
            event(
                Some(&at(t0 + 1150)),
                json!({"type": "assistant/chunk", "chunk": {"type": "text-delta", "text": "b"}}),
            ),
            event(
                Some(&at(t0 + 1500)),
                json!({"type": "assistant/chunk", "chunk": {"type": "done", "finishReason": "stop", "usage": {"outputTokens": 5}}}),
            ),
            // A result for a call this log never saw dispatched: no span, so it must not move the total.
            event(
                Some(&at(t0 + 1600)),
                json!({"type": "message", "message": {"role": "tool", "toolCallId": "call-unknown", "content": [{"type": "text", "text": "x"}]}}),
            ),
        ];
        let stats = project_session_stats(&events);
        assert_eq!(
            stats.llm_ms,
            Some(500 + 600),
            "two rounds: 500ms and 600ms from request to done"
        );
        assert_eq!(
            stats.ttft_ms,
            Some(100 + 250),
            "their first tokens arrived 100ms and 250ms after the request"
        );
        assert_eq!(stats.ttft_steps, Some(2));
        assert_eq!(
            stats.tool_ms,
            Some(600),
            "the one matched call spent 600ms between dispatch and result"
        );
    }

    #[test]
    fn the_timing_rows_stay_absent_when_no_event_pair_measured_them() {
        let events = vec![event(
            Some("2026-10-17T00:00:00.000Z"),
            json!({"type": "model/request"}),
        )];
        let stats = project_session_stats(&events);
        assert_eq!(stats.llm_ms, None);
        assert_eq!(stats.tool_ms, None);
        assert_eq!(stats.ttft_ms, None);
        assert_eq!(stats.ttft_steps, None);
    }

    #[test]
    fn the_stats_carry_the_most_recent_requests_context_breakdown() {
        let events = vec![
            event(
                Some("2026-10-17T00:00:00.000Z"),
                json!({"type": "model/request", "breakdown": {"system": 100, "tools": 200, "messages": 300}}),
            ),
            event(
                Some("2026-10-17T00:00:01.000Z"),
                json!({"type": "assistant/chunk", "chunk": {"type": "done", "finishReason": "stop", "usage": {"outputTokens": 1}}}),
            ),
            event(
                Some("2026-10-17T00:00:02.000Z"),
                json!({"type": "model/request", "breakdown": {"system": 100, "tools": 250, "messages": 600}}),
            ),
        ];
        assert_eq!(
            project_session_stats(&events).context_breakdown,
            Some(ContextBreakdown {
                system: 100,
                tools: 250,
                messages: 600
            }),
            "the last request is the one the panel describes"
        );
        assert_eq!(
            project_session_stats(&[event(None, json!({"type": "model/request"}))])
                .context_breakdown,
            None,
            "a request without a breakdown leaves the section absent"
        );
    }

    #[test]
    fn the_context_panel_prefers_the_recorded_sections_and_falls_back_to_the_current_surface() {
        let recorded = ContextBreakdown {
            system: 1,
            tools: 2,
            messages: 3,
        };
        let current = MeasuredSurface {
            system_tokens: 10,
            tools_tokens: 20,
            message_tokens: 30,
        };
        assert_eq!(
            context_breakdown_with_fallback(Some(recorded), Some(current)),
            BreakdownChoice {
                context_breakdown: Some(recorded),
                context_breakdown_source: Some(BreakdownSource::Request)
            }
        );
        assert_eq!(
            context_breakdown_with_fallback(None, Some(current)),
            BreakdownChoice {
                context_breakdown: Some(ContextBreakdown {
                    system: 10,
                    tools: 20,
                    messages: 30
                }),
                context_breakdown_source: Some(BreakdownSource::Current),
            }
        );
        assert_eq!(
            context_breakdown_with_fallback(None, Some(MeasuredSurface::default())),
            BreakdownChoice::default(),
            "a surface with nothing in it measures nothing to show"
        );
        assert_eq!(
            context_breakdown_with_fallback(None, None),
            BreakdownChoice::default()
        );
    }

    #[test]
    fn the_chat_routes_stats_measure_only_when_no_request_recorded_sections() {
        let with_recorded = vec![event(
            Some("2026-10-17T00:00:00.000Z"),
            json!({"type": "model/request", "breakdown": {"system": 1, "tools": 2, "messages": 3}}),
        )];
        let view = session_stats_view(&with_recorded, || {
            panic!("the measure is not asked when a request recorded sections")
        });
        assert_eq!(
            view.context_breakdown_source,
            Some(BreakdownSource::Request)
        );
        assert_eq!(
            view.stats.context_breakdown,
            Some(ContextBreakdown {
                system: 1,
                tools: 2,
                messages: 3
            })
        );

        let without = vec![event(
            Some("2026-10-17T00:00:00.000Z"),
            json!({"type": "model/request"}),
        )];
        let view = session_stats_view(&without, || {
            Some(MeasuredSurface {
                system_tokens: 5,
                tools_tokens: 0,
                message_tokens: 0,
            })
        });
        assert_eq!(
            view.context_breakdown_source,
            Some(BreakdownSource::Current)
        );
        assert_eq!(
            view.stats.context_breakdown,
            Some(ContextBreakdown {
                system: 5,
                tools: 0,
                messages: 0
            })
        );

        let view = session_stats_view(&without, || None);
        assert_eq!(view.context_breakdown_source, None);
        assert_eq!(view.stats.context_breakdown, None);
        let serialised = serde_json::to_value(&view).unwrap();
        assert!(
            serialised.get("contextBreakdown").is_none(),
            "an absent section is absent from the body"
        );
    }
}
