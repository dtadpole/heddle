//! The timeline's domain and its spans, derived from the ledger's own timings.
//!
//! Ported from `projectTimeline` in `src/server/ledger.ts`. The rules, each because the alternative lies:
//!
//! - **The domain is the recorded span**, earliest start to latest end (or latest start, for running work);
//!   nothing is padded. A zero-width domain is widened to one millisecond.
//! - **A record with no timing contributes no span** — it stays in the ledger, off the axis.
//! - **A running record extends the domain and marks its span running**, never given a duration.
//! - **One span per turn**, carrying the turn index; its kinds are ordered by significance
//!   (`tool, assistant, reasoning, compaction, context, user, system`), and its width is at least `0.02` of the
//!   axis so it can be aimed at.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use heddle_web_composer::js;

use crate::ledger::{Ledger, LedgerKind};
use crate::rows::{LedgerLane, lane_of};

/// One turn on the axis.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineSpan {
    pub turn: u32,
    /// A position from 0 to 1 along the domain.
    pub start: f64,
    /// At least `start + 0.02`.
    pub end: f64,
    /// The kinds the span covers, de-duplicated, most significant first.
    pub kinds: Vec<LedgerKind>,
    /// The lanes those kinds belong to, de-duplicated in the same order.
    pub lanes: Vec<LedgerLane>,
    /// How many timed records the span covers.
    pub records: usize,
    /// Whether anything in the span was still running when the events ended.
    pub running: bool,
}

/// The axis and its spans.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Timeline {
    pub spans: Vec<TimelineSpan>,
    /// The domain's width in milliseconds; `0` when nothing is timed.
    pub duration_ms: u64,
    /// The domain's start as `Date#toISOString` writes it; absent when nothing is timed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub starts_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ends_at: Option<String>,
}

/// One timed record, before it is grouped by turn.
struct Timed {
    turn: u32,
    start: i64,
    end: i64,
    kind: LedgerKind,
    running: bool,
}

/// What one turn's records add up to on the axis.
struct SpanAccumulator {
    start: i64,
    end: i64,
    kinds: Vec<LedgerKind>,
    running: bool,
}

/// Project a ledger onto a time axis.
pub fn project_timeline(ledger: &Ledger) -> Timeline {
    let mut timed: Vec<Timed> = Vec::new();
    for turn in &ledger.turns {
        for step in &turn.steps {
            for record in &step.records {
                let Some(started_at) = record.started_at.as_deref() else {
                    continue;
                };
                let Some(start) = js::parse_time_ms(started_at) else {
                    continue;
                };
                // A finished record ends after its duration; a running one ends where the events end.
                let end = match record.duration_ms {
                    Some(duration) => start + duration as i64,
                    None => start,
                };
                timed.push(Timed {
                    turn: turn.index,
                    start,
                    end,
                    kind: record.kind,
                    running: record.in_flight,
                });
            }
        }
    }

    if timed.is_empty() {
        return Timeline {
            spans: Vec::new(),
            duration_ms: 0,
            starts_at: None,
            ends_at: None,
        };
    }

    let domain_start = timed
        .iter()
        .map(|entry| entry.start)
        .min()
        .expect("a non-empty axis");
    // The domain ends at the latest recorded end **or** the latest start, whichever is later: a running record
    // has no end, and an axis that stopped at the last finished work would hide the work in progress.
    let latest = timed
        .iter()
        .map(|entry| entry.end)
        .chain(timed.iter().map(|entry| entry.start))
        .max()
        .expect("a non-empty axis");
    // A domain of zero width is real — one instantaneous record — and is widened to a millisecond so every
    // position is a number rather than `NaN`.
    let domain_end = if latest > domain_start {
        latest
    } else {
        domain_start + 1
    };
    let duration_ms = (domain_end - domain_start) as u64;

    let mut by_turn: BTreeMap<u32, SpanAccumulator> = BTreeMap::new();
    for entry in &timed {
        match by_turn.get_mut(&entry.turn) {
            Some(existing) => {
                existing.start = existing.start.min(entry.start);
                existing.end = existing.end.max(entry.end);
                existing.kinds.push(entry.kind);
                existing.running |= entry.running;
            }
            None => {
                by_turn.insert(
                    entry.turn,
                    SpanAccumulator {
                        start: entry.start,
                        end: entry.end,
                        kinds: vec![entry.kind],
                        running: entry.running,
                    },
                );
            }
        }
    }

    // Kinds most significant first: every turn begins with a user record, so ordering by the first record made
    // every band the same colour and told a reader nothing.
    const ORDER: [LedgerKind; 7] = [
        LedgerKind::Tool,
        LedgerKind::Assistant,
        LedgerKind::Reasoning,
        LedgerKind::Compaction,
        LedgerKind::Context,
        LedgerKind::User,
        LedgerKind::System,
    ];
    let mut spans = Vec::with_capacity(by_turn.len());
    for (turn, span) in by_turn {
        let records = span.kinds.len();
        let mut kinds: Vec<LedgerKind> = Vec::new();
        for kind in span.kinds {
            if !kinds.contains(&kind) {
                kinds.push(kind);
            }
        }
        // A stable sort, as JavaScript's `Array#sort` is: ties keep the order the records were seen in.
        kinds.sort_by_key(|kind| {
            ORDER
                .iter()
                .position(|candidate| candidate == kind)
                .unwrap_or(usize::MAX)
        });
        let mut lanes: Vec<LedgerLane> = Vec::new();
        for kind in &kinds {
            let lane = lane_of(*kind);
            if !lanes.contains(&lane) {
                lanes.push(lane);
            }
        }
        let start = (span.start - domain_start) as f64 / duration_ms as f64;
        let measured_end = (span.end - domain_start) as f64 / duration_ms as f64;
        // A span always has a pickable width, because a hairline band cannot be aimed at with a mouse.
        spans.push(TimelineSpan {
            turn,
            start,
            end: measured_end.max(start + 0.02),
            kinds,
            lanes,
            records,
            running: span.running,
        });
    }

    Timeline {
        spans,
        duration_ms,
        starts_at: Some(js::to_iso_string(domain_start)),
        ends_at: Some(js::to_iso_string(domain_end)),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;
    use crate::ledger::project_ledger;

    fn event(seq: u64, at: &str, rest: Value) -> Value {
        let mut map = match rest {
            Value::Object(map) => map,
            _ => serde_json::Map::new(),
        };
        map.insert("seq".to_owned(), json!(seq));
        map.insert("at".to_owned(), json!(at));
        Value::Object(map)
    }

    fn message(seq: u64, at: &str, text: &str) -> Value {
        event(
            seq,
            at,
            json!({"type": "message", "message": {"role": "user", "content": [{"type": "text", "text": text}]}}),
        )
    }

    #[test]
    fn the_timeline_is_the_recorded_span_and_an_untimed_record_contributes_no_span() {
        let ledger = project_ledger(&[
            message(1, "2026-10-11T10:00:00.000Z", "go"),
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
            // an untimed record: it is in the ledger but must not appear on the axis
            json!({"type": "something/new"}),
        ]);
        let timeline = project_timeline(&ledger);
        assert_eq!(
            timeline.starts_at.as_deref(),
            Some("2026-10-11T10:00:00.000Z"),
            "the domain starts at the earliest recorded time"
        );
        assert_eq!(
            timeline.duration_ms, 2000,
            "and spans the recorded two seconds"
        );
        assert_eq!(timeline.spans.len(), 1, "one turn, one span");
        assert_eq!(timeline.spans[0].turn, 1, "labelled with its turn");
        assert!(timeline.spans[0].start == 0.0, "starting at the left edge");
        assert!(timeline.spans[0].end > 0.9, "and reaching the right");
    }

    #[test]
    fn a_running_record_extends_the_axis_and_marks_its_span_running() {
        let ledger = project_ledger(&[
            message(1, "2026-10-11T10:00:00.000Z", "go"),
            event(
                2,
                "2026-10-11T10:00:00.000Z",
                json!({"type": "model/request", "estimatedTokens": 10}),
            ),
            event(
                3,
                "2026-10-11T10:00:05.000Z",
                json!({"type": "assistant/chunk", "chunk": {"type": "text-delta", "text": "still going"}}),
            ),
        ]);
        let timeline = project_timeline(&ledger);
        assert_eq!(
            timeline.ends_at.as_deref(),
            Some("2026-10-11T10:00:05.000Z"),
            "the domain reaches the newest event"
        );
        assert!(
            timeline.spans[0].running,
            "and the span is marked running rather than given a duration"
        );
    }

    #[test]
    fn a_ledger_with_nothing_timed_has_an_empty_axis_rather_than_a_made_up_one() {
        assert_eq!(
            project_timeline(&project_ledger(&[json!({"type": "session/created"})])),
            Timeline {
                spans: Vec::new(),
                duration_ms: 0,
                starts_at: None,
                ends_at: None
            }
        );
    }

    #[test]
    fn spans_are_ordered_by_turn_and_each_keeps_a_visible_width() {
        let ledger = project_ledger(&[
            message(1, "2026-10-11T10:00:00.000Z", "one"),
            event(
                2,
                "2026-10-11T10:00:00.000Z",
                json!({"type": "model/request", "estimatedTokens": 10}),
            ),
            event(
                3,
                "2026-10-11T10:00:00.000Z",
                json!({"type": "turn/completed", "rounds": 1}),
            ),
            message(4, "2026-10-11T10:00:10.000Z", "two"),
            event(
                5,
                "2026-10-11T10:00:10.000Z",
                json!({"type": "model/request", "estimatedTokens": 10}),
            ),
            event(
                6,
                "2026-10-11T10:00:20.000Z",
                json!({"type": "turn/completed", "rounds": 1}),
            ),
        ]);
        let timeline = project_timeline(&ledger);
        assert_eq!(
            timeline
                .spans
                .iter()
                .map(|span| span.turn)
                .collect::<Vec<_>>(),
            vec![1, 2],
            "in turn order"
        );
        assert!(
            timeline
                .spans
                .iter()
                .all(|span| span.end - span.start >= 0.02),
            "each is wide enough to pick"
        );
    }

    #[test]
    fn a_turns_band_is_coloured_by_what_it_did_not_by_the_prompt_that_opened_it() {
        let with_tool = project_timeline(&project_ledger(&[
            message(1, "2026-10-11T10:00:00.000Z", "go"),
            event(
                2,
                "2026-10-11T10:00:00.000Z",
                json!({"type": "model/request", "estimatedTokens": 10}),
            ),
            event(
                3,
                "2026-10-11T10:00:00.100Z",
                json!({"type": "assistant/chunk", "chunk": {"type": "tool-call", "name": "bash", "arguments": "{}"}}),
            ),
            event(
                4,
                "2026-10-11T10:00:01.000Z",
                json!({"type": "turn/completed", "rounds": 1}),
            ),
        ]));
        let with_answer = project_timeline(&project_ledger(&[
            message(1, "2026-10-11T10:00:00.000Z", "go"),
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
        ]));
        assert_eq!(
            with_tool.spans[0].kinds[0],
            LedgerKind::Tool,
            "a turn that called a tool leads with the tool"
        );
        assert_eq!(
            with_answer.spans[0].kinds[0],
            LedgerKind::Assistant,
            "and a turn that only answered leads with the answer"
        );
        assert!(
            with_tool.spans[0].lanes.contains(&LedgerLane::Tools),
            "and the span says it touched the tools lane"
        );
        assert!(with_tool.spans[0].records >= 2);
    }

    #[test]
    fn one_instantaneous_record_still_gives_a_domain_of_one_millisecond() {
        // A prompt with no request is a step of its own, timed at the prompt and with no duration: a real
        // zero-width domain, widened so every position is a number.
        let ledger = project_ledger(&[
            message(1, "2026-10-11T10:00:00.000Z", "go"),
            event(
                2,
                "2026-10-11T10:00:00.000Z",
                json!({"type": "turn/completed", "rounds": 1}),
            ),
        ]);
        let timeline = project_timeline(&ledger);
        assert_eq!(
            timeline.duration_ms, 1,
            "the domain is one millisecond wide"
        );
        assert_eq!(
            timeline.starts_at.as_deref(),
            Some("2026-10-11T10:00:00.000Z")
        );
        assert_eq!(
            timeline.ends_at.as_deref(),
            Some("2026-10-11T10:00:00.001Z")
        );
        assert_eq!(timeline.spans[0].start, 0.0);
        assert_eq!(
            timeline.spans[0].end, 0.02,
            "the span keeps its pickable width"
        );
    }

    #[test]
    fn a_ledger_of_only_loose_records_is_off_the_axis() {
        let ledger = project_ledger(&[event(
            1,
            "2026-10-11T10:00:00.000Z",
            json!({"type": "something/new", "detail": 1}),
        )]);
        assert_eq!(project_timeline(&ledger).duration_ms, 0);
        assert!(project_timeline(&ledger).spans.is_empty());
    }
}
