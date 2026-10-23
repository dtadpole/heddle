//! Durable tool-result pruning.
//!
//! A port of `src/context/prune.ts`, modelled on DSH's `dsh-compaction-tool-result-pruner`. Pruning
//! is a **surface rewrite**, not an edit made while assembling a request: a pruned result is a new
//! `message` event whose surface operation shadows the original, immediately preceded by a log-only
//! `compaction/prune` event carrying the original's shadow price. The original stays in the log, so
//! a transcript still shows what the tool returned.
//!
//! The rules that look improvable and must not be improved:
//!
//! - **One snapshot, walked in surface order, with a per-result budget.** No ranking, no
//!   "worst first", no sum across results.
//! - **Non-text blocks are never dropped or reordered.**
//! - **The shadow price is logged before the replacement it prices.**
//! - **A result that cannot shrink is not replaced**, so a second pass appends nothing.
//!
//! Lengths are UTF-16 code units, as in the TypeScript build. Where a head or tail boundary would
//! fall inside a surrogate pair, the Rust build keeps the whole character out of the kept part
//! (a JavaScript string can hold a lone surrogate; a Rust `String` cannot) and counts it as removed.

use crate::events::{ContextEvent, ShadowedRange};
use crate::store::{AppendOptions, ContextStore, SeqRange, StoreError};
use crate::text::utf16_len;
use crate::types::{ContentPart, Message, Role};

/// A tool result longer than this is pruned, in characters.
pub const PRUNE_THRESHOLD_CHARS: usize = 8192;
/// How many characters of a pruned result's start are kept.
pub const PRUNE_HEAD_CHARS: usize = 4096;
/// How many characters of a pruned result's end are kept.
pub const PRUNE_TAIL_CHARS: usize = 1024;
/// What replaces a pruned result's middle, with `N` standing for the count removed.
///
/// Its template length is what the head/tail budget is validated against.
pub const PRUNE_MARKER: &str = "\n… [pruned, N characters removed] …\n";

/// The three character budgets that decide when a result is pruned and how.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PruneConfig {
    /// A result whose text is longer than this is pruned.
    pub threshold_chars: usize,
    /// How much of the start is kept.
    pub head_chars: usize,
    /// How much of the end is kept.
    pub tail_chars: usize,
}

impl Default for PruneConfig {
    /// DSH's numbers: 8192, 4096 and 1024.
    fn default() -> Self {
        Self {
            threshold_chars: PRUNE_THRESHOLD_CHARS,
            head_chars: PRUNE_HEAD_CHARS,
            tail_chars: PRUNE_TAIL_CHARS,
        }
    }
}

/// A text after [`prune_text`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PrunedText {
    /// The text, or `head + marker + tail`.
    pub text: String,
    /// Whether it was cut.
    pub pruned: bool,
}

/// Cut a text longer than the threshold to head, marker and tail.
///
/// A text exactly at the threshold is untouched; the marker names the characters removed.
pub fn prune_text(text: &str, config: &PruneConfig) -> PrunedText {
    let length = utf16_len(text);
    if length <= config.threshold_chars {
        return PrunedText {
            text: text.to_string(),
            pruned: false,
        };
    }
    let head = whole_units(text, 0, config.head_chars);
    // `slice(-0)` is `slice(0)`, the whole string, so an empty tail is spelled out.
    let tail = if config.tail_chars == 0 {
        ""
    } else {
        whole_units(text, length.saturating_sub(config.tail_chars), length)
    };
    let removed = length - utf16_len(head) - utf16_len(tail);
    let marker = PRUNE_MARKER.replacen('N', &removed.to_string(), 1);
    PrunedText {
        text: format!("{head}{marker}{tail}"),
        pruned: true,
    }
}

/// The characters of `text` whose UTF-16 span lies wholly inside `[start_units, end_units)`.
///
/// A JavaScript `slice` may cut a surrogate pair in half and keep a lone surrogate; a Rust
/// `String` cannot, so a character that straddles either boundary is kept out entirely and
/// counts as removed.
fn whole_units(text: &str, start_units: usize, end_units: usize) -> &str {
    let mut unit = 0usize;
    let mut begin = None;
    for (byte, character) in text.char_indices() {
        let next = unit + character.len_utf16();
        if next > end_units {
            return begin.map_or("", |begin| &text[begin..byte]);
        }
        if begin.is_none() && unit >= start_units {
            begin = Some(byte);
        }
        unit = next;
    }
    begin.map_or("", |begin| &text[begin..])
}

/// A pruning budget whose head, marker and tail do not fit inside its trigger.
///
/// Such a replacement would still be over the threshold and the next pass would prune it forever.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error(
    "ToolResultPruner: headChars ({head_chars}) + marker ({marker_chars}) + tailChars ({tail_chars}) = {emitted} must be at most thresholdChars ({threshold_chars})"
)]
pub struct PruneConfigError {
    /// The configured head.
    pub head_chars: usize,
    /// The marker template's length.
    pub marker_chars: usize,
    /// The configured tail.
    pub tail_chars: usize,
    /// Their sum.
    pub emitted: usize,
    /// The configured trigger.
    pub threshold_chars: usize,
}

/// How a pruned result's shadow price is computed; [`crate::meter::estimate_message`] by default.
pub type Estimator = fn(&Message) -> u64;

/// What one pruning pass did.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PruneOutcome {
    /// How many tool results were replaced.
    pub pruned: u64,
    /// How many characters the replacements removed, in total.
    pub chars_removed: u64,
}

/// Rewrites every over-budget tool result on a session's surface as a durable replacement.
#[derive(Clone, Copy, Debug)]
pub struct ToolResultPruner {
    config: PruneConfig,
    estimate: Estimator,
}

impl ToolResultPruner {
    /// A pruner with this budget and the meter's estimate, refusing a budget that cannot work.
    pub fn new(config: PruneConfig) -> Result<Self, PruneConfigError> {
        Self::with_estimator(config, crate::meter::estimate_message)
    }

    /// A pruner with this budget and its own shadow-price estimator.
    pub fn with_estimator(
        config: PruneConfig,
        estimate: Estimator,
    ) -> Result<Self, PruneConfigError> {
        let emitted = config.head_chars + utf16_len(PRUNE_MARKER) + config.tail_chars;
        if emitted > config.threshold_chars {
            return Err(PruneConfigError {
                head_chars: config.head_chars,
                marker_chars: utf16_len(PRUNE_MARKER),
                tail_chars: config.tail_chars,
                emitted,
                threshold_chars: config.threshold_chars,
            });
        }
        Ok(Self { config, estimate })
    }

    /// The budget in force.
    pub fn config(&self) -> &PruneConfig {
        &self.config
    }

    /// Rewrite every over-budget tool result as a surface replacement.
    ///
    /// For each `tool` node over the threshold: append `compaction/prune` (`shadowedRange`,
    /// `shadowedSeqs`, `shadowedTokenCount` — the estimator's price of the **original**), then a
    /// `message` whose content differs only in its pruned text parts, replacing that one node and
    /// citing it in `sourceEventSeqs`. A node whose parts are each under the threshold is left alone.
    pub fn prune_session<S: ContextStore>(
        &self,
        store: &S,
        session: &S::Handle,
    ) -> Result<PruneOutcome, StoreError> {
        let mut outcome = PruneOutcome::default();
        // Snapshot first: appending during the walk must not extend the walk, or a replacement
        // could be reconsidered within the same pass. The snapshot is derived in one call; an
        // append cannot change how an earlier node derives, so deriving up front is the same walk.
        let snapshot = store.derive_surface(session)?;
        for node in snapshot {
            let seq = node.seq;
            let Some(original) = node.message else {
                continue;
            };
            if original.role != Role::Tool {
                continue;
            }
            let before: usize = original
                .content
                .iter()
                .map(|part| match part {
                    ContentPart::Text { text } => utf16_len(text),
                    _ => 0,
                })
                .sum();
            if before <= self.config.threshold_chars {
                continue;
            }

            let mut content: Vec<ContentPart> = Vec::with_capacity(original.content.len());
            let mut changed = false;
            let mut removed = 0usize;
            // Non-text parts are copied across where they are, never reordered or dropped.
            for part in &original.content {
                match part {
                    ContentPart::Text { text } => {
                        let result = prune_text(text, &self.config);
                        if result.pruned {
                            changed = true;
                            removed += utf16_len(text) - utf16_len(&result.text);
                        }
                        content.push(ContentPart::Text { text: result.text });
                    }
                    other => content.push(other.clone()),
                }
            }
            if !changed {
                continue;
            }

            // Before the replacement, never after: a consumer reading forward can subtract the
            // shadowed cost before it reaches what replaced it.
            let prune = ContextEvent::Prune {
                shadowed_range: ShadowedRange {
                    start: seq,
                    end: seq,
                },
                shadowed_seqs: vec![seq],
                shadowed_token_count: (self.estimate)(&original),
            };
            store.append(session, prune.to_value(), AppendOptions::default())?;

            let replacement = Message {
                role: original.role,
                content,
                tool_call_id: original.tool_call_id.clone(),
                source: original.source.clone(),
            };
            store.append(
                session,
                serde_json::json!({ "type": "message", "message": replacement }),
                AppendOptions::replace(
                    SeqRange {
                        start_seq: seq,
                        end_seq: seq,
                    },
                    vec![seq],
                ),
            )?;
            outcome.pruned += 1;
            outcome.chars_removed += removed as u64;
        }
        Ok(outcome)
    }
}

impl Default for ToolResultPruner {
    /// DSH's budget, which always fits, with the meter's estimate.
    fn default() -> Self {
        Self::new(PruneConfig::default()).expect("the default prune budget always fits")
    }
}

#[cfg(test)]
mod tests {
    use super::{
        PRUNE_HEAD_CHARS, PRUNE_MARKER, PRUNE_TAIL_CHARS, PRUNE_THRESHOLD_CHARS, PruneConfig,
        PruneConfigError, PruneOutcome, ToolResultPruner, prune_text,
    };

    fn counted(text: &str) -> usize {
        crate::text::utf16_len(text)
    }

    #[test]
    fn the_defaults_are_dsh_numbers() {
        let config = PruneConfig::default();
        assert_eq!(config.threshold_chars, 8192);
        assert_eq!(config.head_chars, 4096);
        assert_eq!(config.tail_chars, 1024);
    }

    #[test]
    fn text_at_exactly_the_threshold_is_untouched_and_over_it_is_cut_with_the_count_named() {
        let exact = "e".repeat(PRUNE_THRESHOLD_CHARS);
        let untouched = prune_text(&exact, &PruneConfig::default());
        assert!(!untouched.pruned);
        assert_eq!(untouched.text, exact);

        let over = "o".repeat(PRUNE_THRESHOLD_CHARS + 1);
        let removed = over.len() - PRUNE_HEAD_CHARS - PRUNE_TAIL_CHARS;
        let cut = prune_text(&over, &PruneConfig::default());
        assert!(cut.pruned);
        assert_eq!(
            cut.text,
            format!(
                "{}{}{}",
                &over[..PRUNE_HEAD_CHARS],
                PRUNE_MARKER.replacen('N', &removed.to_string(), 1),
                &over[over.len() - PRUNE_TAIL_CHARS..]
            )
        );
        // The marker's digits are the count removed, not the count kept.
        assert!(
            cut.text
                .contains(&format!("… [pruned, {removed} characters removed] …"))
        );
    }

    #[test]
    fn an_empty_tail_is_spelled_out_rather_than_slicing_from_zero() {
        let over = "t".repeat(30);
        let config = PruneConfig {
            threshold_chars: 10,
            head_chars: 4,
            tail_chars: 0,
        };
        let cut = prune_text(&over, &config);
        assert_eq!(
            cut.text,
            format!("tttt{}", PRUNE_MARKER.replacen('N', "26", 1))
        );
    }

    #[test]
    fn a_boundary_inside_a_surrogate_pair_keeps_the_whole_character_out() {
        // Units: abcdef (6) + emoji (2) + ten digits (10) = 18. A head of 7 splits the emoji, and
        // a pair may not be split: the emoji leaves the head and is counted as removed.
        let text = format!("abcdef😀{}", "0123456789");
        let config = PruneConfig {
            threshold_chars: 10,
            head_chars: 7,
            tail_chars: 2,
        };
        let cut = prune_text(&text, &config);
        assert!(cut.pruned);
        // Kept: six units of head and two of tail; the eighteen units less those eight are
        // removed, the emoji included.
        assert_eq!(
            cut.text,
            format!("abcdef{}89", PRUNE_MARKER.replacen('N', "10", 1))
        );
    }

    #[test]
    fn the_counts_are_utf16_units_so_the_typescript_build_cuts_in_the_same_place() {
        // 21 emoji are 42 UTF-16 units: over a 41-unit threshold, under a 50-unit one.
        let text = "😀".repeat(21);
        let config = PruneConfig {
            threshold_chars: 41,
            head_chars: 8,
            tail_chars: 4,
        };
        assert_eq!(counted(&text), 42);
        let cut = prune_text(&text, &config);
        assert!(cut.pruned);
        // Eight units of head is four whole emoji, not eight characters.
        assert_eq!(cut.text.chars().filter(|c| *c == '😀').count(), 6);
    }

    #[test]
    fn a_budget_whose_head_and_tail_do_not_fit_inside_the_trigger_is_refused_naming_every_number() {
        let error = ToolResultPruner::new(PruneConfig {
            threshold_chars: 100,
            head_chars: 90,
            tail_chars: 30,
        })
        .expect_err("the emitted replacement would still be over the threshold");
        let PruneConfigError {
            head_chars,
            marker_chars,
            tail_chars,
            emitted,
            threshold_chars,
        } = error;
        assert_eq!(head_chars, 90);
        assert_eq!(marker_chars, counted(PRUNE_MARKER));
        assert_eq!(tail_chars, 30);
        assert_eq!(emitted, 90 + counted(PRUNE_MARKER) + 30);
        assert_eq!(threshold_chars, 100);
        let message = PruneConfigError {
            head_chars,
            marker_chars,
            tail_chars,
            emitted,
            threshold_chars,
        }
        .to_string();
        assert!(message.contains("headChars (90)"), "{message}");
        assert!(message.contains("tailChars (30)"), "{message}");
        assert!(message.contains("thresholdChars (100)"), "{message}");
        // The defaults fit, so the same construction with no arguments must not fail.
        assert!(ToolResultPruner::new(PruneConfig::default()).is_ok());
    }

    #[test]
    fn the_default_pruner_holds_the_default_budget() {
        assert_eq!(
            *ToolResultPruner::default().config(),
            PruneConfig::default()
        );
    }

    use crate::store::ContextStore;
    use crate::testing::MemoryStore;
    use crate::types::{ContentPart, Message, Role, text_message};
    use serde_json::json;

    /// Three times the text length, so a shadow price cannot be mistaken for a character count.
    fn triple(message: &Message) -> u64 {
        let characters: u64 = message
            .content
            .iter()
            .map(|part| match part {
                ContentPart::Text { text } => crate::text::utf16_len(text) as u64,
                _ => 0,
            })
            .sum();
        3 * characters
    }

    fn text_part(length: usize, character: &str) -> ContentPart {
        ContentPart::Text {
            text: character.repeat(length),
        }
    }

    #[test]
    fn a_result_within_the_threshold_is_untouched_and_nothing_is_appended() {
        let store = MemoryStore::new();
        let session = store.open("s");
        let original = Message {
            role: Role::Tool,
            tool_call_id: Some("call-1".to_string()),
            content: vec![text_part(64, "s")],
            source: None,
        };
        let seq = store.message(&session, original.clone());

        let outcome = ToolResultPruner::default()
            .prune_session(&store, &session)
            .expect("the walk succeeds");
        assert_eq!(
            outcome,
            PruneOutcome {
                pruned: 0,
                chars_removed: 0
            }
        );
        assert_eq!(
            store.count(&session).expect("the count"),
            1,
            "nothing was appended"
        );
        assert_eq!(
            store.surface(&session).expect("the surface").nodes,
            vec![seq]
        );
        assert_eq!(
            store.derive_node(&session, seq).expect("the node"),
            Some(original)
        );
    }

    #[test]
    fn an_oversized_result_lands_as_two_appends_the_shadow_price_then_the_replacement() {
        let store = MemoryStore::new();
        let session = store.open("s");
        let oversized = "H".repeat(9000);
        let kept = ContentPart::Reasoning {
            text: "a block that must keep its place".to_string(),
        };
        let small = text_part(2000, "T");
        let original = Message {
            role: Role::Tool,
            tool_call_id: Some("call-7".to_string()),
            content: vec![
                ContentPart::Text {
                    text: oversized.clone(),
                },
                kept.clone(),
                small.clone(),
            ],
            source: None,
        };
        let seq = store.message(&session, original);

        let outcome = ToolResultPruner::default()
            .prune_session(&store, &session)
            .expect("the walk succeeds");
        let removed = oversized.len() - PRUNE_HEAD_CHARS - PRUNE_TAIL_CHARS;
        let pruned_text = format!(
            "{}{}{}",
            &oversized[..PRUNE_HEAD_CHARS],
            PRUNE_MARKER.replacen('N', &removed.to_string(), 1),
            &oversized[oversized.len() - PRUNE_TAIL_CHARS..]
        );
        assert_eq!(outcome.pruned, 1);
        // The count is UTF-16 units, as it is everywhere in this crate; the marker's ellipsis is
        // one character but three bytes, so a byte length would not agree.
        assert_eq!(
            outcome.chars_removed as usize,
            oversized.len() - crate::text::utf16_len(&pruned_text)
        );

        let events = store.read(&session).expect("the log reads");
        assert_eq!(
            events.len(),
            3,
            "the original, the price and the replacement"
        );
        let price = &events[1];
        assert_eq!(price.kind, "compaction/prune");
        assert_eq!(
            price.field("shadowedRange"),
            Some(&json!({"start": seq, "end": seq}))
        );
        assert_eq!(price.field("shadowedSeqs"), Some(&json!([seq])));

        let replacement = &events[2];
        assert_eq!(replacement.kind, "message");
        assert_eq!(
            replacement.message(),
            Some(Message {
                role: Role::Tool,
                tool_call_id: Some("call-7".to_string()),
                content: vec![
                    ContentPart::Text {
                        text: pruned_text.clone()
                    },
                    kept,
                    small,
                ],
                source: None,
            })
        );
        assert_eq!(
            replacement
                .field("surfaceOp")
                .and_then(|value| value.get("op"))
                .and_then(serde_json::Value::as_str),
            Some("replace")
        );
        assert_eq!(replacement.field("sourceEventSeqs"), Some(&json!([seq])));
        // The surface now holds only the replacement, which is what a second pass reads.
        assert_eq!(store.surface(&session).expect("the surface").nodes, vec![2]);
    }

    #[test]
    fn the_shadow_price_is_the_estimators_price_of_the_original_not_of_the_replacement() {
        let store = MemoryStore::new();
        let session = store.open("s");
        let original = Message {
            role: Role::Tool,
            tool_call_id: Some("call-2".to_string()),
            content: vec![text_part(9000, "p")],
            source: None,
        };
        store.message(&session, original);
        ToolResultPruner::with_estimator(PruneConfig::default(), triple)
            .expect("the budget fits")
            .prune_session(&store, &session)
            .expect("the walk succeeds");

        let events = store.read(&session).expect("the log reads");
        assert_eq!(
            events[1].field("shadowedTokenCount"),
            Some(&json!(3 * 9000)),
            "the price is of the original, through the injected estimator"
        );
        let replacement = events[2].message().expect("the replacement parses");
        assert_ne!(
            events[1].field("shadowedTokenCount"),
            Some(&json!(triple(&replacement)))
        );
        assert!(triple(&replacement) < 3 * 9000);
    }

    #[test]
    fn a_second_pass_over_the_already_pruned_surface_prunes_nothing() {
        let store = MemoryStore::new();
        let session = store.open("s");
        // Two over-threshold parts with one under it: after the first pass each part is under the
        // threshold individually while their sum is still over it, which is the case where a
        // replacement must not be appended because nothing would change.
        let original = Message {
            role: Role::Tool,
            tool_call_id: Some("call-3".to_string()),
            content: vec![text_part(9000, "x"), text_part(4000, "y")],
            source: None,
        };
        store.message(&session, original);
        let pruner = ToolResultPruner::default();

        let first = pruner
            .prune_session(&store, &session)
            .expect("the first pass");
        assert_eq!(first.pruned, 1);
        assert_eq!(store.count(&session).expect("the count"), 3);
        let after_first = store.surface(&session).expect("the surface").nodes;

        let second = pruner
            .prune_session(&store, &session)
            .expect("the second pass");
        assert_eq!(
            second,
            PruneOutcome {
                pruned: 0,
                chars_removed: 0
            }
        );
        assert_eq!(
            store.count(&session).expect("the count"),
            3,
            "nothing was appended"
        );
        assert_eq!(
            store.surface(&session).expect("the surface").nodes,
            after_first
        );
    }

    #[test]
    fn a_non_tool_node_is_never_pruned() {
        let store = MemoryStore::new();
        let session = store.open("s");
        let original = text_message(Role::User, "u".repeat(9000));
        let seq = store.message(&session, original.clone());

        let outcome = ToolResultPruner::default()
            .prune_session(&store, &session)
            .expect("the walk succeeds");
        assert_eq!(
            outcome,
            PruneOutcome {
                pruned: 0,
                chars_removed: 0
            }
        );
        assert_eq!(store.count(&session).expect("the count"), 1);
        assert_eq!(
            store.derive_node(&session, seq).expect("the node"),
            Some(original)
        );
    }
}
