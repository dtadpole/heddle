//! Compaction: condensing the oldest part of a surface into one checkpoint.
//!
//! A port of `src/context/compaction.ts`, modelled on DSH's `dsh-compaction-basic`. What makes it
//! safe to run on a conversation somebody is having:
//!
//! - **The log is never rewritten.** A compaction appends `compaction/start`, `compaction/summary`,
//!   one `context/note` replacement whose surface operation shadows the span, `compaction/end` and
//!   `compaction/measured`; the shadowed events stay readable.
//! - **The cut is balanced.** No span separates an answered tool call from its result; the cut walks
//!   backwards until the pairing balances. The system prompt is never shadowed.
//! - **A summary that does not shrink is refused** and recorded as `compaction/failed`, and the
//!   surface is left exactly as it was.
//! - **The summariser replays the real prefix**: the system node, the span, then the instruction.
//! - **Pruning comes first**, and if it clears the pressure nothing is summarised.
//!
//! Unlike the TypeScript class, the engine does not hold the store: each call is given it, so one
//! engine serves every session and a test hands it a double.

use std::collections::{HashMap, HashSet};

use futures::future::BoxFuture;
use serde::Serialize;

use crate::budget::Budget;
use crate::error::ContextError;
use crate::events::{ContextEvent, origin};
use crate::meter::{Measurement, estimate_message};
use crate::prune::ToolResultPruner;
use crate::store::{AppendOptions, ContextStore, SeqRange, SurfaceNode};
use crate::text::js_trim;
use crate::types::{ContentPart, Message, Role};

/// What the summariser is asked: the final user message of the auxiliary call.
pub const COMPACTION_INSTRUCTION: &str = "Summarise the conversation above so it can continue without the original messages. \
Keep every decision, constraint, file path, command and result that still matters. \
Keep unresolved questions and what was tried. Drop greetings and repetition. \
Write it as a briefing to yourself, not as a reply to the user.";

/// Opens a checkpoint's text, so a reader can tell it from something a person said.
pub const SUMMARY_OPEN_TAG: &str = "<compacted-summary>";
/// Closes a checkpoint's text.
pub const SUMMARY_CLOSE_TAG: &str = "</compacted-summary>";

/// The span one compaction will shadow, chosen before anything is written.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactionPlan {
    /// The seq at the span's first position.
    pub from_seq: u64,
    /// The seq at the span's last position.
    pub through_seq: u64,
    /// Every seq in the span, in surface order — not necessarily ascending.
    pub shadowed_seqs: Vec<u64>,
    /// What is kept verbatim, newest last.
    pub retained_seqs: Vec<u64>,
    /// The span's price, which the checkpoint has to beat.
    pub shadowed_tokens: u64,
}

/// What a compaction did, in numbers a caller can report.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactionOutcome {
    /// Whether a replacement landed.
    pub compacted: bool,
    /// Why not, when it did not and there was a reason to give.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// How many oversized tool results were rewritten before a summary was considered.
    pub pruned: u64,
    /// The measurement the decision was taken on.
    pub before: u64,
    /// The measurement afterwards.
    pub after: u64,
    /// The span, when one was chosen.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan: Option<CompactionPlan>,
    /// The `compaction/failed` event, when the summary was refused.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason_seq: Option<u64>,
    /// The `compaction/summary` event.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary_seq: Option<u64>,
    /// The replacement `context/note`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replacement_seq: Option<u64>,
}

/// A summariser that could not answer; recorded as a refusal, never raised.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct SummarizeError(pub String);

/// One model call that returns the summary text for the replayed prefix.
///
/// Passed in rather than reached for, so the engine has no model of its own and a test compacts
/// without spending anything. A closure `Fn(Vec<Message>) -> impl Future<Output = Result<String,
/// SummarizeError>>` is a summariser.
pub trait Summarizer: Send + Sync {
    /// Summarise `messages`: the system node, the span, and [`COMPACTION_INSTRUCTION`].
    fn summarize(&self, messages: Vec<Message>) -> BoxFuture<'_, Result<String, SummarizeError>>;
}

impl<F, Fut> Summarizer for F
where
    F: Fn(Vec<Message>) -> Fut + Send + Sync,
    Fut: Future<Output = Result<String, SummarizeError>> + Send + 'static,
{
    fn summarize(&self, messages: Vec<Message>) -> BoxFuture<'_, Result<String, SummarizeError>> {
        Box::pin(self(messages))
    }
}

/// Take a fresh measurement of the session — after a prune, and after a replacement.
pub type MeasureFn<'a> = dyn Fn() -> Result<Measurement, ContextError> + Send + Sync + 'a;

/// What a compaction needs from whoever calls it.
#[derive(Clone, Copy)]
pub struct CompactOptions<'a> {
    /// The budget for the routed endpoint.
    pub budget: Budget,
    /// The measurement the decision is taken on.
    pub measurement: &'a Measurement,
    /// The model call that writes the summary.
    pub summarizer: &'a dyn Summarizer,
    /// A fresh measurement on demand.
    pub measure: &'a MeasureFn<'a>,
    /// Overflow recovery: ignore the trigger and the retained tail and take one maximal balanced
    /// reduction. Read by [`CompactionEngine::compact_if_needed`] only.
    pub force: bool,
}

/// Wrap a summary the way the model should read it: one user message,
/// `<compacted-summary>\n{trimmed}\n</compacted-summary>`.
pub fn frame_summary(summary: &str) -> Message {
    Message::text(
        Role::User,
        format!(
            "{SUMMARY_OPEN_TAG}\n{}\n{SUMMARY_CLOSE_TAG}",
            js_trim(summary)
        ),
    )
}

/// Whether cutting the surface before `index` keeps every **answered** tool call paired.
///
/// A call the surface never answers is ignored rather than counted as open, or one stopped call
/// would make the whole conversation un-compactable.
pub fn tool_pairing_balanced_before(nodes: &[SurfaceNode], index: usize) -> bool {
    // Only calls the surface actually answers constrain the cut: a call the model never had
    // answered would otherwise make the whole conversation un-compactable.
    let mut answered: HashSet<&str> = HashSet::new();
    for node in nodes {
        if let Some(message) = &node.message {
            if message.role == Role::Tool {
                if let Some(id) = message.tool_call_id.as_deref() {
                    answered.insert(id);
                }
            }
        }
    }

    let mut open: HashSet<&str> = HashSet::new();
    for node in nodes.iter().take(index) {
        let Some(message) = &node.message else {
            continue;
        };
        if message.role == Role::Assistant {
            for part in &message.content {
                if let ContentPart::ToolCall { id, .. } = part {
                    if answered.contains(id.as_str()) {
                        open.insert(id.as_str());
                    }
                }
            }
        } else if message.role == Role::Tool {
            if let Some(id) = message.tool_call_id.as_deref() {
                open.remove(id);
            }
        }
    }
    open.is_empty()
}

/// The compaction engine: prune, choose a span, summarise it, shadow it.
#[derive(Clone, Copy, Debug, Default)]
pub struct CompactionEngine {
    pruner: ToolResultPruner,
}

impl CompactionEngine {
    /// An engine that prunes with `pruner` before it summarises.
    pub fn new(pruner: ToolResultPruner) -> Self {
        Self { pruner }
    }

    /// The pruner it runs first.
    pub fn pruner(&self) -> &ToolResultPruner {
        &self.pruner
    }

    /// Choose the span to shadow, or `None` when there is nothing safe to take.
    ///
    /// Start at the first node that is not the system prompt, keep a tail priced at
    /// `retain_tokens` (the budget's when `None`) verbatim, and walk the cut backwards until no tool
    /// call is separated from its result. Fails with [`ContextError::SurfaceMismatch`] when the
    /// measurement is of a different surface than the store's.
    pub fn plan<S: ContextStore>(
        &self,
        store: &S,
        session: &S::Handle,
        budget: &Budget,
        measurement: &Measurement,
        retain_tokens: Option<u64>,
    ) -> Result<Option<CompactionPlan>, ContextError> {
        let nodes = store.surface(session)?.nodes;
        if nodes.is_empty() {
            return Ok(None);
        }
        if measurement.nodes.len() != nodes.len()
            || measurement
                .nodes
                .iter()
                .zip(&nodes)
                .any(|(node, seq)| node.seq != *seq)
        {
            return Err(ContextError::SurfaceMismatch);
        }
        let priced: HashMap<u64, u64> = measurement
            .nodes
            .iter()
            .map(|node| (node.seq, node.tokens))
            .collect();
        let surface = store.derive_surface(session)?;
        let first_index = usize::from(
            surface
                .first()
                .and_then(|node| node.message.as_ref())
                .is_some_and(|message| message.role == Role::System),
        );

        let retain = retain_tokens.unwrap_or(budget.retain_tokens);
        let mut accumulated = 0u64;
        let mut keep_from = nodes.len();
        for index in (first_index..nodes.len()).rev() {
            accumulated += priced.get(&nodes[index]).copied().unwrap_or(0);
            keep_from = index;
            if accumulated >= retain {
                break;
            }
        }
        if keep_from <= first_index {
            return Ok(None);
        }

        while keep_from > first_index && !tool_pairing_balanced_before(&surface, keep_from) {
            keep_from -= 1;
        }
        if keep_from <= first_index {
            return Ok(None);
        }

        let shadowed_seqs = nodes[first_index..keep_from].to_vec();
        let (Some(&from_seq), Some(&through_seq)) = (shadowed_seqs.first(), shadowed_seqs.last())
        else {
            return Ok(None);
        };
        Ok(Some(CompactionPlan {
            from_seq,
            through_seq,
            shadowed_tokens: shadowed_seqs
                .iter()
                .map(|seq| priced.get(seq).copied().unwrap_or(0))
                .sum(),
            retained_seqs: nodes[keep_from..].to_vec(),
            shadowed_seqs,
        }))
    }

    /// Summarise a planned span and shadow it, or record why it was not shadowed.
    ///
    /// A failed or empty summary, or a checkpoint whose estimate is not below the span's price, is
    /// recorded as `compaction/failed` with `refused: true` and leaves the surface untouched.
    pub async fn compact<S: ContextStore>(
        &self,
        store: &S,
        session: &S::Handle,
        plan: &CompactionPlan,
        options: &CompactOptions<'_>,
    ) -> Result<CompactionOutcome, ContextError> {
        let surface = store.derive_surface(session)?;
        let mut messages: Vec<Message> = Vec::new();
        // The replayed prefix is what the last request carried: the prompt as it stands, then
        // the span.
        if let Some(head) = surface.first().and_then(|node| node.message.as_ref()) {
            if head.role == Role::System {
                messages.push(head.clone());
            }
        }
        for seq in &plan.shadowed_seqs {
            if let Some(node) = surface.iter().find(|node| node.seq == *seq) {
                if let Some(message) = &node.message {
                    messages.push(message.clone());
                }
            }
        }
        messages.push(Message::text(Role::User, COMPACTION_INSTRUCTION));

        let start_seq = store.append(
            session,
            ContextEvent::Start {
                from_seq: plan.from_seq,
                through_seq: plan.through_seq,
                shadowed_seqs: plan.shadowed_seqs.clone(),
                shadowed_token_count: plan.shadowed_tokens,
                estimated_tokens: options.measurement.total_tokens,
                threshold_tokens: options.budget.threshold_tokens,
            }
            .to_value(),
            AppendOptions::default(),
        )?;

        let summary = match options.summarizer.summarize(messages).await {
            Ok(summary) => summary,
            Err(error) => {
                return self.refuse(
                    store,
                    session,
                    plan,
                    options,
                    &format!("the summariser failed — {error}"),
                );
            }
        };
        if js_trim(&summary).is_empty() {
            return self.refuse(
                store,
                session,
                plan,
                options,
                "the summariser returned nothing",
            );
        }

        let checkpoint = frame_summary(&summary);
        let checkpoint_tokens = estimate_message(&checkpoint);
        if checkpoint_tokens >= plan.shadowed_tokens {
            return self.refuse(
                store,
                session,
                plan,
                options,
                &format!(
                    "the summary is not smaller than the span it would shadow ({checkpoint_tokens} estimated tokens >= {})",
                    plan.shadowed_tokens
                ),
            );
        }

        let checkpoint_text = match checkpoint.content.first() {
            Some(ContentPart::Text { text }) => text.clone(),
            _ => summary.clone(),
        };
        let summary_seq = store.append(
            session,
            ContextEvent::Summary {
                from_seq: plan.from_seq,
                through_seq: plan.through_seq,
                summary: checkpoint_text,
                shadowed_seqs: plan.shadowed_seqs.clone(),
                shadowed_token_count: plan.shadowed_tokens,
                estimated_tokens: checkpoint_tokens,
            }
            .to_value(),
            AppendOptions::default(),
        )?;

        // The one surface mutation of the whole transaction: the replacement **is** the
        // checkpoint message, so the model reads the summary exactly once.
        let mut source_event_seqs = vec![start_seq, summary_seq];
        source_event_seqs.extend(plan.shadowed_seqs.iter().copied());
        let replacement_seq = store.append(
            session,
            ContextEvent::Note {
                message: checkpoint,
                origin: origin::COMPACTION.to_string(),
                identity: None,
                files: None,
            }
            .to_value(),
            AppendOptions::replace(
                SeqRange {
                    start_seq: plan.from_seq,
                    end_seq: plan.through_seq,
                },
                source_event_seqs,
            ),
        )?;

        store.append(
            session,
            ContextEvent::End {
                from_seq: plan.from_seq,
                through_seq: plan.through_seq,
                summary_seq,
                replacement_seq,
            }
            .to_value(),
            AppendOptions::default(),
        )?;

        let after = (options.measure)()?;
        store.append(
            session,
            ContextEvent::Measured {
                before: options.measurement.total_tokens,
                after: after.total_tokens,
            }
            .to_value(),
            AppendOptions::default(),
        )?;

        Ok(CompactionOutcome {
            compacted: true,
            reason: None,
            pruned: 0,
            before: options.measurement.total_tokens,
            after: after.total_tokens,
            plan: Some(plan.clone()),
            reason_seq: None,
            summary_seq: Some(summary_seq),
            replacement_seq: Some(replacement_seq),
        })
    }

    /// The whole per-round policy: prune first, then summarise only if still over the trigger.
    ///
    /// With `force`, the trigger and the retained tail are both ignored.
    pub async fn compact_if_needed<S: ContextStore>(
        &self,
        store: &S,
        session: &S::Handle,
        options: &CompactOptions<'_>,
    ) -> Result<CompactionOutcome, ContextError> {
        let force = options.force;
        let before = options.measurement.total_tokens;
        if !force && before < options.budget.threshold_tokens {
            return Ok(CompactionOutcome {
                compacted: false,
                pruned: 0,
                before,
                after: before,
                ..CompactionOutcome::default()
            });
        }

        let pruned = self.pruner.prune_session(store, session)?.pruned;
        let measured = if pruned > 0 {
            (options.measure)()?
        } else {
            options.measurement.clone()
        };
        if !force && measured.total_tokens < options.budget.threshold_tokens {
            return Ok(CompactionOutcome {
                compacted: false,
                pruned,
                before,
                after: measured.total_tokens,
                ..CompactionOutcome::default()
            });
        }

        // Overflow recovery still wants the largest reduction it can take; a retained tail is a
        // preference, and the window has already been exceeded.
        let retain = if force { Some(0) } else { None };
        let Some(plan) = self.plan(store, session, &options.budget, &measured, retain)? else {
            return Ok(CompactionOutcome {
                compacted: false,
                reason: Some(
                    "nothing safe to compact: every span would split a tool call from its result"
                        .to_string(),
                ),
                pruned,
                before,
                after: measured.total_tokens,
                ..CompactionOutcome::default()
            });
        };

        let outcome = self
            .compact(
                store,
                session,
                &plan,
                &CompactOptions {
                    budget: options.budget,
                    measurement: &measured,
                    summarizer: options.summarizer,
                    measure: options.measure,
                    force: options.force,
                },
            )
            .await?;
        Ok(CompactionOutcome { pruned, ..outcome })
    }

    /// Record a refused compaction and report it, leaving the surface exactly as it was.
    fn refuse<S: ContextStore>(
        &self,
        store: &S,
        session: &S::Handle,
        plan: &CompactionPlan,
        options: &CompactOptions<'_>,
        reason: &str,
    ) -> Result<CompactionOutcome, ContextError> {
        let reason_seq = store.append(
            session,
            ContextEvent::Failed {
                from_seq: plan.from_seq,
                through_seq: plan.through_seq,
                refused: true,
                reason: reason.to_string(),
            }
            .to_value(),
            AppendOptions::default(),
        )?;
        Ok(CompactionOutcome {
            compacted: false,
            reason: Some(reason.to_string()),
            pruned: 0,
            before: options.measurement.total_tokens,
            after: options.measurement.total_tokens,
            plan: Some(plan.clone()),
            reason_seq: Some(reason_seq),
            summary_seq: None,
            replacement_seq: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use futures::executor::block_on;

    use super::{
        COMPACTION_INSTRUCTION, CompactOptions, CompactionEngine, SUMMARY_CLOSE_TAG,
        SUMMARY_OPEN_TAG, SummarizeError, frame_summary, tool_pairing_balanced_before,
    };
    use crate::budget::{Budget, BudgetInput, resolve_budget};
    use crate::meter::{Measurement, MeterInput, MeteredMessage, TokenMeter};
    use crate::store::{ContextStore, SurfaceNode};
    use crate::testing::{MemorySession, MemoryStore};
    use crate::types::{ContentPart, Message, Role};

    fn measure(store: &MemoryStore, session: &MemorySession) -> Measurement {
        let surface = store.derive_surface(session).expect("the surface derives");
        let nodes: Vec<MeteredMessage> = surface
            .iter()
            .filter_map(|node| {
                node.message.as_ref().map(|message| MeteredMessage {
                    seq: node.seq,
                    message,
                })
            })
            .collect();
        let generation = store
            .surface(session)
            .expect("the surface folds")
            .content_generation;
        TokenMeter::default().measure(&MeterInput {
            nodes: &nodes,
            tools: &[],
            usage: None,
            generation,
        })
    }

    fn budget(window: u64) -> Budget {
        resolve_budget(&BudgetInput {
            config_window: Some(window),
            ..BudgetInput::default()
        })
        .expect("a configured window resolves")
    }

    fn tool_message(id: &str, text: &str) -> Message {
        Message {
            role: Role::Tool,
            tool_call_id: Some(id.to_string()),
            content: vec![ContentPart::Text {
                text: text.to_string(),
            }],
            source: None,
        }
    }

    fn assistant_call(id: &str) -> Message {
        Message {
            role: Role::Assistant,
            content: vec![ContentPart::ToolCall {
                id: id.to_string(),
                name: "read_file".to_string(),
                arguments: "{\"path\":\"a\"}".to_string(),
            }],
            tool_call_id: None,
            source: None,
        }
    }

    #[test]
    fn a_summary_is_framed_as_one_user_message_with_its_whitespace_trimmed() {
        let message = frame_summary("  the briefing \n");
        assert_eq!(message.role, Role::User);
        assert_eq!(
            message.content,
            vec![ContentPart::Text {
                text: format!("{SUMMARY_OPEN_TAG}\nthe briefing\n{SUMMARY_CLOSE_TAG}")
            }]
        );
        assert_eq!(message.tool_call_id, None);
    }

    #[test]
    fn a_cut_before_an_answered_call_is_unbalanced_and_a_cut_after_its_answer_is_balanced() {
        let system = SurfaceNode {
            seq: 0,
            message: Some(Message::text(Role::System, "be brief")),
        };
        let ask = SurfaceNode {
            seq: 1,
            message: Some(assistant_call("c1")),
        };
        let answer = SurfaceNode {
            seq: 2,
            message: Some(tool_message("c1", "the result")),
        };
        let nodes = [system, ask, answer];
        assert!(tool_pairing_balanced_before(&nodes, 0));
        assert!(
            !tool_pairing_balanced_before(&nodes, 2),
            "the call is cut from its result"
        );
        assert!(
            tool_pairing_balanced_before(&nodes, 3),
            "the answer is inside the cut"
        );
    }

    #[test]
    fn a_call_the_surface_never_answers_does_not_constrain_the_cut() {
        let unanswered = SurfaceNode {
            seq: 0,
            message: Some(assistant_call("never-answered")),
        };
        let next = SurfaceNode {
            seq: 1,
            message: Some(Message::text(Role::User, "next")),
        };
        assert!(tool_pairing_balanced_before(&[unanswered, next], 1));
    }

    /// The verifier's surface: system, user, a tool call answered by a tool result, then two more
    /// turns. The assistant call and its answer land on separate nodes.
    fn call_surface() -> (MemoryStore, MemorySession, Vec<u64>) {
        let store = MemoryStore::new();
        let session = store.open("s");
        let system = store.message(&session, Message::text(Role::System, "be brief"));
        let user = store.message(&session, Message::text(Role::User, "do the thing"));
        store.assistant_chunk(
            &session,
            serde_json::json!({"type": "tool-call", "id": "call-1", "name": "read_file", "arguments": "{\"path\":\"a\"}"}),
        );
        let assistant = store.surface(&session).expect("the surface folds").nodes[2];
        store.assistant_chunk(
            &session,
            serde_json::json!({"type": "done", "finishReason": "tool_calls"}),
        );
        let tool = store.message(&session, tool_message("call-1", "the result"));
        let user2 = store.message(&session, Message::text(Role::User, "and again"));
        let assistant2 = store.message(&session, Message::text(Role::Assistant, "done"));
        (
            store,
            session,
            vec![system, user, assistant, tool, user2, assistant2],
        )
    }

    #[test]
    fn a_plan_never_shadows_the_prompt_and_backs_the_cut_off_a_split_pair() {
        let (store, session, seqs) = call_surface();
        let measurement = measure(&store, &session);
        let priced = |seq: u64| {
            measurement
                .nodes
                .iter()
                .find(|node| node.seq == seq)
                .map(|node| node.tokens)
                .unwrap_or(0)
        };
        // Aim the cut at the tool result's position: the prefix would hold the call unanswered.
        let aimed = priced(seqs[3]) + priced(seqs[4]) + priced(seqs[5]);
        let engine = CompactionEngine::default();
        let surface = store.derive_surface(&session).expect("the surface derives");
        assert!(
            !tool_pairing_balanced_before(&surface, 3),
            "the aimed cut is inside the pair"
        );

        let plan = engine
            .plan(
                &store,
                &session,
                &budget(10_000),
                &measurement,
                Some(aimed - 1),
            )
            .expect("the plan resolves")
            .expect("a plan is chosen");
        assert!(
            !plan.shadowed_seqs.contains(&seqs[0]),
            "the prompt is never shadowed"
        );
        assert_eq!(
            plan.shadowed_seqs.contains(&seqs[2]),
            plan.shadowed_seqs.contains(&seqs[3]),
            "the call and its result are taken together or not at all"
        );
        assert!(
            !plan.shadowed_seqs.contains(&seqs[3]),
            "the cut backed off before the pair"
        );
        assert_eq!(plan.shadowed_seqs, vec![seqs[1]]);
        assert_eq!(plan.retained_seqs, seqs[2..].to_vec());
    }

    #[test]
    fn a_summary_larger_than_its_span_is_refused_and_leaves_the_surface_exactly_as_it_was() {
        let (store, session, seqs) = call_surface();
        let measurement = measure(&store, &session);
        let surface_before = store.surface(&session).expect("the surface folds").nodes;
        let plan = CompactionEngine::default()
            .plan(&store, &session, &budget(10_000), &measurement, Some(0))
            .expect("the plan resolves")
            .expect("a plan is chosen");

        let summarizer = |_messages: Vec<Message>| async move {
            Ok::<String, SummarizeError>("z".repeat(20_000))
        };
        let measure_fn =
            || Ok::<Measurement, crate::error::ContextError>(measure(&store, &session));
        let refused = block_on(CompactionEngine::default().compact(
            &store,
            &session,
            &plan,
            &CompactOptions {
                budget: budget(10_000),
                measurement: &measurement,
                summarizer: &summarizer,
                measure: &measure_fn,
                force: false,
            },
        ))
        .expect("a refusal is a result, not an error");

        assert!(!refused.compacted);
        assert!(refused.reason.unwrap_or_default().contains("not smaller"));
        assert_eq!(
            store.surface(&session).expect("the surface folds").nodes,
            surface_before,
            "the surface is exactly as it was"
        );
        let events = store.read(&session).expect("the log reads");
        assert!(events.iter().any(|event| event.kind == "compaction/failed"));
        assert!(
            events
                .iter()
                .all(|event| event.kind != "compaction/summary")
        );
        let messages = store
            .derive_messages(&session)
            .expect("the messages derive");
        assert!(
            !messages.iter().any(|message| serde_json::to_string(message)
                .unwrap_or_default()
                .contains("zzzz")),
            "no part of the refused summary reached the model"
        );
        assert_eq!(
            plan.shadowed_seqs,
            seqs[1..5].to_vec(),
            "the planned span covered the pair, which the refusal never shadowed"
        );
    }

    #[test]
    fn a_landed_compaction_shadows_the_span_reads_the_checkpoint_once_and_keeps_the_log() {
        let store = MemoryStore::new();
        let session = store.open("s");
        store.message(&session, Message::text(Role::System, "be brief"));
        let first = store.message(&session, Message::text(Role::User, "u".repeat(600)));
        let second = store.message(&session, Message::text(Role::Assistant, "a".repeat(600)));
        let measurement = measure(&store, &session);
        let plan = CompactionEngine::default()
            .plan(&store, &session, &budget(10_000), &measurement, Some(0))
            .expect("the plan resolves")
            .expect("a plan is chosen");
        assert_eq!(plan.shadowed_seqs, vec![first]);
        assert_eq!(plan.retained_seqs, vec![second]);

        let summarizer = |_messages: Vec<Message>| async move {
            Ok::<String, SummarizeError>("brief".to_string())
        };
        let measure_fn =
            || Ok::<Measurement, crate::error::ContextError>(measure(&store, &session));
        let outcome = block_on(CompactionEngine::default().compact(
            &store,
            &session,
            &plan,
            &CompactOptions {
                budget: budget(10_000),
                measurement: &measurement,
                summarizer: &summarizer,
                measure: &measure_fn,
                force: false,
            },
        ))
        .expect("the compaction lands");

        assert!(outcome.compacted);
        assert!(outcome.after < outcome.before);
        let log = store.read(&session).expect("the log reads");
        let kinds: Vec<&str> = log.iter().map(|event| event.kind.as_str()).collect();
        for expected in [
            "compaction/start",
            "compaction/summary",
            "context/note",
            "compaction/end",
            "compaction/measured",
        ] {
            assert!(kinds.contains(&expected), "missing {expected} in {kinds:?}");
        }
        let events = store.read(&session).expect("the log reads");
        assert!(
            events.iter().any(|event| event.kind == "message"
                && event
                    .message()
                    .map(|message| serde_json::to_string(&message)
                        .unwrap_or_default()
                        .contains("uuuu"))
                    .unwrap_or(false)),
            "the shadowed span is still readable in the log"
        );
        let texts: Vec<String> = store
            .derive_messages(&session)
            .expect("the messages derive")
            .into_iter()
            .map(|message| match message.content.first() {
                Some(ContentPart::Text { text }) => text.clone(),
                _ => String::new(),
            })
            .collect();
        assert_eq!(
            texts.len(),
            3,
            "the prompt, the checkpoint in the span's place, and the kept answer"
        );
        assert!(texts[0].contains("be brief"));
        assert_eq!(
            texts
                .iter()
                .filter(|text| text.contains("<compacted-summary>"))
                .count(),
            1,
            "the checkpoint is read exactly once"
        );
        assert!(
            !texts.iter().any(|text| text.contains("uuuu")),
            "the span is not sent beside it"
        );
    }

    #[test]
    fn a_second_compaction_may_shadow_a_span_whose_seqs_are_out_of_order() {
        let store = MemoryStore::new();
        let session = store.open("s");
        store.message(&session, Message::text(Role::System, "be brief"));
        let user = store.message(&session, Message::text(Role::User, "u".repeat(600)));
        let user2 = store.message(&session, Message::text(Role::User, "v".repeat(600)));
        let engine = CompactionEngine::default();
        let summarizer = |_messages: Vec<Message>| async move {
            Ok::<String, SummarizeError>("brief".to_string())
        };

        // First compaction: shadow the first user turn.
        let measurement = measure(&store, &session);
        let plan = engine
            .plan(&store, &session, &budget(10_000), &measurement, Some(0))
            .expect("the plan resolves")
            .expect("a plan is chosen");
        assert_eq!(plan.shadowed_seqs, vec![user]);
        let measure_fn =
            || Ok::<Measurement, crate::error::ContextError>(measure(&store, &session));
        let options = CompactOptions {
            budget: budget(10_000),
            measurement: &measurement,
            summarizer: &summarizer,
            measure: &measure_fn,
            force: false,
        };
        block_on(engine.compact(&store, &session, &plan, &options))
            .expect("the first compaction lands");
        let replacement = store.surface(&session).expect("the surface folds").nodes[1];
        assert!(
            replacement > user2,
            "the replacement is newer than the node it sits beside"
        );
        // A newest node is kept verbatim, so the second span is the two before it.
        store.message(&session, Message::text(Role::User, "after"));

        // Second compaction: the span is [replacement, user2], so its fromSeq is newer than its
        // throughSeq and only a positional reading can fold it.
        let measurement = measure(&store, &session);
        let plan = engine
            .plan(&store, &session, &budget(10_000), &measurement, Some(0))
            .expect("the plan resolves")
            .expect("a plan is chosen");
        assert_eq!(plan.shadowed_seqs, vec![replacement, user2]);
        assert!(plan.from_seq > plan.through_seq);
        let options = CompactOptions {
            budget: budget(10_000),
            measurement: &measurement,
            summarizer: &summarizer,
            measure: &measure_fn,
            force: false,
        };
        let outcome = block_on(engine.compact(&store, &session, &plan, &options))
            .expect("the second compaction lands");
        assert!(outcome.compacted);
        assert_eq!(
            store
                .surface(&session)
                .expect("the surface folds")
                .nodes
                .len(),
            3,
            "the prompt, the new checkpoint, and the newest node kept verbatim"
        );
        let checkpoints = store
            .derive_messages(&session)
            .expect("the messages derive")
            .into_iter()
            .filter(|message| {
                matches!(message.content.first(), Some(ContentPart::Text { text }) if text.contains("<compacted-summary>"))
            })
            .count();
        assert_eq!(
            checkpoints, 1,
            "the model reads the newest checkpoint, not a pile"
        );
    }

    #[test]
    fn pruning_that_clears_the_pressure_pays_for_no_summary() {
        let store = MemoryStore::new();
        let session = store.open("s");
        store.message(&session, Message::text(Role::System, "be brief"));
        store.message(&session, Message::text(Role::User, "do the thing"));
        store.message(&session, tool_message("call-1", &"x".repeat(30_000)));
        let measurement = measure(&store, &session);
        let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let calls_for = calls.clone();
        let summarizer = move |_messages: Vec<Message>| {
            let calls = calls_for.clone();
            async move {
                calls.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                Ok::<String, SummarizeError>("brief".to_string())
            }
        };
        let measure_fn =
            || Ok::<Measurement, crate::error::ContextError>(measure(&store, &session));
        let outcome = block_on(CompactionEngine::default().compact_if_needed(
            &store,
            &session,
            &CompactOptions {
                budget: budget(3000),
                measurement: &measurement,
                summarizer: &summarizer,
                measure: &measure_fn,
                force: false,
            },
        ))
        .expect("the round succeeds");

        assert!(!outcome.compacted);
        assert_eq!(outcome.pruned, 1);
        let events = store.read(&session).expect("the log reads");
        assert!(events.iter().any(|event| event.kind == "compaction/prune"));
        assert!(
            events
                .iter()
                .all(|event| event.kind != "compaction/summary")
        );
        assert_eq!(
            calls.load(std::sync::atomic::Ordering::Relaxed),
            0,
            "the summariser was never asked"
        );
    }

    #[test]
    fn a_conversation_with_nothing_safely_removable_reports_why() {
        let store = MemoryStore::new();
        let session = store.open("s");
        store.message(&session, Message::text(Role::System, "be brief"));
        store.message(&session, Message::text(Role::User, "hello"));
        let measurement = measure(&store, &session);
        let summarizer = |_messages: Vec<Message>| async move {
            Ok::<String, SummarizeError>("brief".to_string())
        };
        let measure_fn =
            || Ok::<Measurement, crate::error::ContextError>(measure(&store, &session));
        let outcome = block_on(CompactionEngine::default().compact_if_needed(
            &store,
            &session,
            &CompactOptions {
                budget: budget(1000),
                measurement: &measurement,
                summarizer: &summarizer,
                measure: &measure_fn,
                force: true,
            },
        ))
        .expect("the round succeeds");
        assert!(!outcome.compacted);
        assert_eq!(
            outcome.reason.as_deref(),
            Some("nothing safe to compact: every span would split a tool call from its result")
        );
        assert!(
            store
                .read(&session)
                .expect("the log reads")
                .iter()
                .all(|event| event.kind != "compaction/start")
        );
    }

    #[test]
    fn the_instruction_the_summariser_is_asked_is_the_typescript_one() {
        assert!(COMPACTION_INSTRUCTION.starts_with("Summarise the conversation above"));
        assert!(COMPACTION_INSTRUCTION.contains("file path"));
        assert_eq!(SUMMARY_OPEN_TAG, "<compacted-summary>");
        assert_eq!(SUMMARY_CLOSE_TAG, "</compacted-summary>");
    }
}
