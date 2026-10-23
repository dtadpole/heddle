//! The message shapes this crate reads and writes — `heddle-llm`'s types, re-exported under the names
//! this crate's callers already use.
//!
//! They mirror `src/llm/types.ts` field for field, including the JSON the session log stores, and they
//! belong to `heddle-llm`, which declares them once for every crate that reads a log or builds a
//! request. A difference in shape is settled with that crate's owner, not worked around here.
//!
//! [`text_message`] is the one helper this crate adds: a message of one text block is what every note it writes
//! is, and `heddle-llm`'s constructor takes the parts vector.

pub use heddle_llm::types::describe_content;
pub use heddle_llm::{
    CONTEXT_WINDOW_EXCEEDED, ContentPart, FilePart, ImageMediaType, ImagePart, Message, Role,
    TokenUsage, ToolCall, ToolSpec,
};

/// A message of one text part.
pub(crate) fn text_message(role: Role, text: impl Into<String>) -> Message {
    Message::new(role, vec![ContentPart::Text { text: text.into() }])
}

#[cfg(test)]
mod tests {
    use super::{
        ContentPart, FilePart, ImageMediaType, ImagePart, Message, Role, ToolCall,
        describe_content, text_message,
    };
    use serde_json::json;

    fn image(name: &str) -> ContentPart {
        ContentPart::Image(ImagePart {
            name: name.to_string(),
            mime_type: ImageMediaType::Png,
            path: "/tmp/a.png".to_string(),
            bytes: 1,
            sha256: "00".to_string(),
            data: None,
        })
    }

    fn file(name: &str) -> ContentPart {
        ContentPart::File(FilePart {
            name: name.to_string(),
            path: "/tmp/a.txt".to_string(),
            bytes: 1,
            sha256: "00".to_string(),
        })
    }

    #[test]
    fn a_text_message_carries_one_text_part() {
        let message = text_message(Role::User, "hello");
        assert_eq!(message.role, Role::User);
        assert_eq!(
            message.content,
            vec![ContentPart::Text {
                text: "hello".to_string()
            }]
        );
        assert_eq!(message.tool_call_id, None);
        assert_eq!(message.source, None);
    }

    #[test]
    fn describe_content_renders_a_tool_call_and_joins_parts_without_a_separator() {
        let parts = [
            ContentPart::ToolCall(ToolCall {
                id: "call-1".to_string(),
                name: "read".to_string(),
                arguments: "{\"path\":\"a\"}".to_string(),
            }),
            ContentPart::Text {
                text: " and ".to_string(),
            },
            ContentPart::Text {
                text: "done".to_string(),
            },
        ];
        assert_eq!(describe_content(&parts), "→ read {\"path\":\"a\"} and done");
    }

    #[test]
    fn describe_content_names_attachments_and_keeps_reasoning_text() {
        let parts = [
            ContentPart::Reasoning {
                text: "think".to_string(),
            },
            image("a.png"),
            file("b.txt"),
        ];
        assert_eq!(describe_content(&parts), "think[image a.png][file b.txt]");
        assert_eq!(describe_content(&[]), "");
    }

    #[test]
    fn a_message_round_trips_the_log_shape_without_optional_fields() {
        let message = text_message(Role::User, "hi");
        let value = serde_json::to_value(&message).expect("a message serialises");
        assert_eq!(
            value,
            json!({ "role": "user", "content": [{ "type": "text", "text": "hi" }] })
        );
        let back: Message = serde_json::from_value(value).expect("a message reads back");
        assert_eq!(back, message);
    }
}
