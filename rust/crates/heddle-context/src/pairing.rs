//! Tool-pair repair over the messages a request will carry.
//!
//! A port of `src/context/pairing.ts`. A provider refuses a request whose assistant tool-call
//! message is not followed by one tool message per call, and a turn stopped between a call and its
//! answer leaves exactly that shape in the log. This is the **repair** for a log already written
//! that way, so an affected session can answer again instead of failing every request.

use std::borrow::Cow;
use std::collections::{HashMap, HashSet};

use crate::types::{ContentPart, Message, Role};

/// What a call with no answer anywhere in the list is answered with.
pub const INTERRUPTED_ANSWER: &str =
    "error (INTERRUPTED): the turn ended before this call answered";

/// Return the messages with every assistant tool call followed by its answer, in call order.
///
/// A real answer is **moved** into place, not replaced, so a steering message between a call and
/// its result keeps the result; a call with no answer gets [`INTERRUPTED_ANSWER`]; an answer whose
/// call is absent, and a duplicate answer, are dropped. An already-valid list is returned borrowed.
pub fn repair_tool_pairing(messages: &[crate::types::Message]) -> Cow<'_, [crate::types::Message]> {
    // The first stored answer per call id, wherever it sits in the list.
    let mut answers: HashMap<&str, &Message> = HashMap::new();
    for message in messages {
        if message.role != Role::Tool {
            continue;
        }
        if let Some(id) = message.tool_call_id.as_deref() {
            answers.entry(id).or_insert(message);
        }
    }

    let mut repaired: Vec<Message> = Vec::with_capacity(messages.len());
    let mut placed: HashSet<&str> = HashSet::new();
    for message in messages {
        // An answer is emitted beside the call it belongs to below; here it is a duplicate or an
        // orphan.
        if message.role == Role::Tool {
            continue;
        }
        repaired.push(message.clone());
        if message.role != Role::Assistant {
            continue;
        }
        for part in &message.content {
            let ContentPart::ToolCall(call) = part else {
                continue;
            };
            if !placed.insert(call.id.as_str()) {
                continue;
            }
            match answers.get(call.id.as_str()) {
                Some(answer) => repaired.push((*answer).clone()),
                None => repaired.push(Message {
                    role: Role::Tool,
                    content: vec![ContentPart::Text {
                        text: INTERRUPTED_ANSWER.to_string(),
                    }],
                    tool_call_id: Some(call.id.clone()),
                    source: None,
                }),
            }
        }
    }

    // Already valid: same messages, same order, nothing added or moved.
    if repaired.len() == messages.len() && repaired.iter().zip(messages).all(|(a, b)| a == b) {
        return Cow::Borrowed(messages);
    }
    Cow::Owned(repaired)
}

#[cfg(test)]
mod tests {
    use super::{INTERRUPTED_ANSWER, repair_tool_pairing};
    use crate::types::{ContentPart, Message, Role, text_message};

    fn assistant(ids: &[&str]) -> Message {
        let mut content = vec![ContentPart::Text {
            text: "working".to_string(),
        }];
        for id in ids {
            content.push(ContentPart::ToolCall(crate::types::ToolCall {
                id: (*id).to_string(),
                name: "bash".to_string(),
                arguments: "{}".to_string(),
            }));
        }
        Message {
            role: Role::Assistant,
            content,
            tool_call_id: None,
            source: None,
        }
    }

    fn answer(id: &str, text: &str) -> Message {
        Message {
            role: Role::Tool,
            content: vec![ContentPart::Text {
                text: text.to_string(),
            }],
            tool_call_id: Some(id.to_string()),
            source: None,
        }
    }

    fn shape(messages: &[Message]) -> Vec<(Role, Option<String>)> {
        messages
            .iter()
            .map(|message| (message.role, message.tool_call_id.clone()))
            .collect()
    }

    fn text_of(message: &Message) -> String {
        match message.content.first() {
            Some(ContentPart::Text { text }) => text.clone(),
            _ => String::new(),
        }
    }

    #[test]
    fn a_call_the_turn_never_answered_gets_an_interrupted_answer_before_the_next_message() {
        let broken = vec![assistant(&["c1", "c2"]), answer("c1", "ok")];
        let repaired = repair_tool_pairing(&broken);
        assert_eq!(
            shape(&repaired),
            vec![
                (Role::Assistant, None),
                (Role::Tool, Some("c1".to_string())),
                (Role::Tool, Some("c2".to_string())),
            ]
        );
        assert_eq!(text_of(&repaired[2]), INTERRUPTED_ANSWER);
        // The log-shaped input is not mutated.
        assert_eq!(broken.len(), 2);
    }

    #[test]
    fn a_paired_conversation_is_returned_unchanged_and_no_copy_is_made() {
        let paired = vec![
            assistant(&["c1", "c2"]),
            answer("c1", "ok"),
            answer("c2", "ok"),
            text_message(Role::Assistant, "done"),
        ];
        assert!(matches!(
            repair_tool_pairing(&paired),
            std::borrow::Cow::Borrowed(messages) if std::ptr::eq(messages, paired.as_slice())
        ));
    }

    #[test]
    fn every_call_is_answered_when_the_conversation_ends_on_the_calls() {
        let messages = [assistant(&["c1", "c2", "c3"]), answer("c1", "ok")];
        let repaired = repair_tool_pairing(&messages);
        let ids: Vec<_> = repaired
            .iter()
            .filter(|message| message.role == Role::Tool)
            .map(|message| message.tool_call_id.clone().unwrap_or_default())
            .collect();
        assert_eq!(ids, vec!["c1", "c2", "c3"]);
    }

    #[test]
    fn an_answer_separated_from_its_call_by_a_steering_message_is_moved_not_replaced() {
        let separated = vec![
            assistant(&["c1"]),
            text_message(Role::User, "steer: also check the tests"),
            answer("c1", "the real tool output"),
        ];
        let repaired = repair_tool_pairing(&separated);
        assert_eq!(
            shape(&repaired),
            vec![
                (Role::Assistant, None),
                (Role::Tool, Some("c1".to_string())),
                (Role::User, None),
            ]
        );
        assert_eq!(text_of(&repaired[1]), "the real tool output");
    }

    #[test]
    fn an_answer_whose_question_is_absent_is_dropped_rather_than_sent_as_an_orphan() {
        let messages = [answer("gone", "x"), text_message(Role::User, "next")];
        let repaired = repair_tool_pairing(&messages);
        assert_eq!(shape(&repaired), vec![(Role::User, None)]);
    }

    #[test]
    fn text_that_is_not_a_tool_exchange_is_left_alone() {
        let plain = vec![
            text_message(Role::System, "be brief"),
            text_message(Role::User, "hi"),
            text_message(Role::Assistant, "hello"),
        ];
        assert!(matches!(
            repair_tool_pairing(&plain),
            std::borrow::Cow::Borrowed(messages) if messages.len() == plain.len()
        ));
    }

    #[test]
    fn a_duplicate_answer_is_dropped_and_the_first_one_kept() {
        let duplicated = vec![
            assistant(&["c1"]),
            answer("c1", "first"),
            answer("c1", "second"),
        ];
        let repaired = repair_tool_pairing(&duplicated);
        assert_eq!(
            shape(&repaired),
            vec![
                (Role::Assistant, None),
                (Role::Tool, Some("c1".to_string())),
            ]
        );
        assert_eq!(text_of(&repaired[1]), "first");
    }
}
