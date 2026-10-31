//! The attachment projection: what a provider is actually sent for an attached file or image.
//!
//! Ported from `src/llm/attachments.ts`; DSH's rules. A **non-image file never reaches a provider**: it becomes a
//! deterministic handle naming its saved read-only path. An **image** is sent as bytes only to a route that declares
//! `image` input, otherwise it becomes a text-only placeholder. On an image route the request's images are bounded
//! ([`IMAGE_REQUEST_LIMITS`]): the oldest are replaced with an "omitted to fit" placeholder until the rest fit. Every
//! replacement is stable text, and the bytes are read here, at request time, so the log holds only references.

use crate::types::{ContentPart, FilePart, ImageMediaType, ImagePart, Message};
use heddle_config::EndpointConfig;

/// The media types the projection can send as image content.
pub const IMAGE_MEDIA_TYPES: [ImageMediaType; 4] = [
    ImageMediaType::Png,
    ImageMediaType::Jpeg,
    ImageMediaType::Webp,
    ImageMediaType::Gif,
];

/// One request's image budget.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ImageRequestLimits {
    pub max_images: usize,
    /// Counted as base64 length, which is what a provider's byte allowance counts.
    pub max_bytes: u64,
}

/// The budget every request gets: 20 images, 20 MiB encoded.
pub const IMAGE_REQUEST_LIMITS: ImageRequestLimits = ImageRequestLimits {
    max_images: 20,
    max_bytes: 20 * 1024 * 1024,
};

/// DSH's attachment identity: `sha256:<digest>`.
pub fn attachment_id(sha256: &str) -> String {
    format!("sha256:{sha256}")
}

/// The eight hex characters placeholders show.
pub fn short_digest(sha256: &str) -> &str {
    sha256.get(..8).unwrap_or(sha256)
}

/// Whether the endpoint declares that its model accepts image input (`acceptsImages`). Absent means text only.
pub fn accepts_images(endpoint: &EndpointConfig) -> bool {
    endpoint
        .input_modalities
        .as_ref()
        .is_some_and(|modalities| modalities.iter().any(|modality| modality == "image"))
}

/// JSON-quote text the way the TypeScript build's `JSON.stringify` does in these sentences.
fn quoted(text: &str) -> String {
    serde_json::to_string(text).unwrap_or_else(|_| format!("\"{text}\""))
}

/// The model-facing handle for one verbatim file (`fileHandleText`).
pub fn file_handle_text(part: &FilePart) -> String {
    format!(
        "[File {} ({} bytes, sha256:{}): verbatim read-only copy saved at {}. \
         Read that path with your file tools when its contents are needed; copy it to a writable location before modifying it. \
         When delegating file work, include this saved path in the delegation prompt; only subagents sharing this execution environment can read it.]",
        quoted(&part.name),
        part.bytes,
        short_digest(&part.sha256),
        quoted(&part.path),
    )
}

/// The placeholder for an image a text-only route cannot accept (`textOnlyImageText`).
pub fn text_only_image_text(part: &ImagePart) -> String {
    format!(
        "[image omitted because this model accepts text only; attachment sha256:{}]",
        short_digest(&part.sha256)
    )
}

/// An attachment's identity: its JSON-quoted name and full `sha256:` digest (`imageIdentity`).
pub fn image_identity(part: &ImagePart) -> String {
    format!("{} ({})", quoted(&part.name), attachment_id(&part.sha256))
}

/// The placeholder for an image left behind for the budget (`offloadedImageText`).
pub fn offloaded_image_text(part: &ImagePart) -> String {
    format!(
        "[image omitted to fit request image limits; {}. \
         The stored copy at {} was not sent; read it with your file tools if its contents are needed.]",
        image_identity(part),
        quoted(&part.path),
    )
}

/// What a route is told when an image's saved bytes can no longer be read.
fn unreadable_image_text(part: &ImagePart, reason: &str) -> String {
    format!(
        "[image {} could not be read at {} ({}); attachment sha256:{}. \
         Ask the person to attach it again if it is needed.]",
        quoted(&part.name),
        quoted(&part.path),
        reason,
        short_digest(&part.sha256),
    )
}

/// The wire length of an image's base64 payload, which is what a provider's byte budget counts.
fn base64_length(bytes: u64) -> u64 {
    bytes.div_ceil(3) * 4
}

/// Read one stored image and attach its base64 bytes, degrading to text when the file cannot be read.
fn materialize_image(part: &ImagePart) -> ContentPart {
    match std::fs::read(&part.path) {
        Ok(bytes) => {
            let mut with_data = part.clone();
            with_data.data = Some(base64_encode(&bytes));
            ContentPart::Image(with_data)
        }
        Err(error) => ContentPart::Text {
            text: unreadable_image_text(part, &error.to_string()),
        },
    }
}

/// Project one content part for the provider boundary.
fn project_part(part: &ContentPart, images_accepted: bool) -> ContentPart {
    match part {
        ContentPart::File(file) => ContentPart::Text {
            text: file_handle_text(file),
        },
        ContentPart::Image(image) if image.data.is_none() => {
            if images_accepted {
                materialize_image(image)
            } else {
                ContentPart::Text {
                    text: text_only_image_text(image),
                }
            }
        }
        other => other.clone(),
    }
}

/// Project every message's content for one endpoint (`projectAttachments`). Applied after the `model/request` hook
/// and before the adapter, so no adapter sees a file part or image bytes a route cannot take.
pub fn project_attachments(
    messages: &[Message],
    endpoint: &EndpointConfig,
    limits: ImageRequestLimits,
) -> Vec<Message> {
    let images_accepted = accepts_images(endpoint);
    let mut projected: Vec<Message> = messages
        .iter()
        .map(|message| Message {
            role: message.role,
            tool_call_id: message.tool_call_id.clone(),
            content: message
                .content
                .iter()
                .map(|part| project_part(part, images_accepted))
                .collect(),
            source: message.source.clone(),
        })
        .collect();

    // Only a route that accepts images has a budget to enforce: on a text-only route every image has already
    // become the capability placeholder, and nothing was sent to fit.
    if !images_accepted {
        return projected;
    }

    // Every retained image in request order, with the encoded size the budget counts.
    let mut occurrences: Vec<(usize, usize, u64)> = Vec::new();
    for (message_index, message) in projected.iter().enumerate() {
        for (part_index, part) in message.content.iter().enumerate() {
            if let ContentPart::Image(image) = part
                && image.data.is_some()
            {
                occurrences.push((message_index, part_index, base64_length(image.bytes)));
            }
        }
    }
    let total: u64 = occurrences.iter().map(|(_, _, bytes)| *bytes).sum();
    let mut remove = 0;
    let mut removed_bytes = 0;
    while remove < occurrences.len()
        && (occurrences.len() - remove > limits.max_images
            || total - removed_bytes > limits.max_bytes)
    {
        removed_bytes += occurrences[remove].2;
        remove += 1;
    }

    for &(message_index, part_index, _) in &occurrences[..remove] {
        let text = match &projected[message_index].content[part_index] {
            ContentPart::Image(image) => offloaded_image_text(image),
            _ => continue,
        };
        projected[message_index].content[part_index] = ContentPart::Text { text };
    }
    projected
}

/// Standard base64 with padding, for an image's bytes.
pub(crate) fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut encoded = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let first = u32::from(chunk[0]);
        let second = u32::from(chunk.get(1).copied().unwrap_or(0));
        let third = u32::from(chunk.get(2).copied().unwrap_or(0));
        let triple = (first << 16) | (second << 8) | third;
        encoded.push(char::from(ALPHABET[((triple >> 18) & 63) as usize]));
        encoded.push(char::from(ALPHABET[((triple >> 12) & 63) as usize]));
        encoded.push(if chunk.len() > 1 {
            char::from(ALPHABET[((triple >> 6) & 63) as usize])
        } else {
            '='
        });
        encoded.push(if chunk.len() > 2 {
            char::from(ALPHABET[(triple & 63) as usize])
        } else {
            '='
        });
    }
    encoded
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;
    use crate::types::ToolCall;
    use heddle_config::EndpointKind;

    const DIGEST: &str = "abababababababababababababababababababababababababababababababab";

    fn endpoint(modalities: Option<&[&str]>) -> EndpointConfig {
        EndpointConfig {
            name: "probe".into(),
            kind: EndpointKind::OpenaiChat,
            base_url: "http://127.0.0.1:1".into(),
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
            input_modalities: modalities.map(|list| {
                list.iter()
                    .map(|modality| (*modality).to_string())
                    .collect()
            }),
            proxy: None,
            timeout_ms: None,
            prompt_cache: None,
        }
    }

    fn image_part(path: &Path) -> ImagePart {
        ImagePart {
            name: "shot.png".into(),
            mime_type: ImageMediaType::Png,
            path: path.to_string_lossy().into_owned(),
            bytes: 4,
            sha256: DIGEST.into(),
            data: None,
        }
    }

    fn file_part() -> FilePart {
        FilePart {
            name: "notes.md".into(),
            path: "/tmp/notes.md".into(),
            bytes: 12,
            sha256: DIGEST.into(),
        }
    }

    fn message(content: Vec<ContentPart>) -> Message {
        Message::new(crate::types::Role::User, content)
    }

    /// A temporary image on disk, removed when the test ends.
    struct TempImage {
        path: PathBuf,
        dir: PathBuf,
    }

    impl Drop for TempImage {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn with_image(bytes: &[u8], run: impl FnOnce(&Path)) {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "heddle-attachments-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).expect("creates the temp dir");
        let path = dir.join("shot.png");
        std::fs::write(&path, bytes).expect("writes the image");
        let image = TempImage { path, dir };
        run(&image.path);
    }

    #[test]
    fn a_non_image_file_is_a_deterministic_handle_naming_the_saved_read_only_path() {
        assert_eq!(
            file_handle_text(&file_part()),
            format!(
                "[File \"notes.md\" (12 bytes, sha256:{}): verbatim read-only copy saved at \"/tmp/notes.md\". \
                 Read that path with your file tools when its contents are needed; copy it to a writable location before modifying it. \
                 When delegating file work, include this saved path in the delegation prompt; only subagents sharing this execution environment can read it.]",
                &DIGEST[..8]
            )
        );
    }

    #[test]
    fn an_image_sent_to_a_text_only_route_is_a_deterministic_placeholder() {
        assert_eq!(
            text_only_image_text(&image_part(Path::new("/tmp/shot.png"))),
            format!(
                "[image omitted because this model accepts text only; attachment sha256:{}]",
                &DIGEST[..8]
            )
        );
    }

    #[test]
    fn image_capability_is_declared_per_endpoint_and_defaults_to_text() {
        assert!(
            !accepts_images(&endpoint(None)),
            "no declaration means text only"
        );
        assert!(!accepts_images(&endpoint(Some(&["text"]))));
        assert!(accepts_images(&endpoint(Some(&["text", "image"]))));
    }

    #[test]
    fn the_projection_keeps_an_image_only_for_a_route_that_declares_image_input() {
        let bytes = [0x89, 0x50, 0x4e, 0x47];
        with_image(&bytes, |path| {
            let vision = project_attachments(
                &[message(vec![ContentPart::Image(image_part(path))])],
                &endpoint(Some(&["text", "image"])),
                IMAGE_REQUEST_LIMITS,
            );
            match &vision[0].content[0] {
                ContentPart::Image(kept) => assert_eq!(
                    kept.data.as_deref(),
                    Some(base64_encode(&bytes).as_str()),
                    "with the encoded bytes"
                ),
                other => panic!("the vision route keeps the image part, got {other:?}"),
            }
            let text = project_attachments(
                &[message(vec![ContentPart::Image(image_part(path))])],
                &endpoint(None),
                IMAGE_REQUEST_LIMITS,
            );
            assert_eq!(
                text[0].content[0],
                ContentPart::Text {
                    text: text_only_image_text(&image_part(path))
                }
            );
        });
    }

    #[test]
    fn the_projection_replaces_every_file_with_its_handle_even_on_a_vision_route() {
        with_image(&[0x89], |path| {
            let projected = project_attachments(
                &[message(vec![
                    ContentPart::File(file_part()),
                    ContentPart::Image(image_part(path)),
                ])],
                &endpoint(Some(&["text", "image"])),
                IMAGE_REQUEST_LIMITS,
            );
            match &projected[0].content[0] {
                ContentPart::Text { text } => {
                    assert!(
                        text.contains("verbatim read-only copy saved at"),
                        "the file is its handle: {text}"
                    )
                }
                other => panic!("the file is text, got {other:?}"),
            }
            assert!(
                matches!(projected[0].content[1], ContentPart::Image(_)),
                "and the image still travels"
            );
        });
    }

    #[test]
    fn an_unreadable_image_degrades_to_text_instead_of_failing_the_turn() {
        let projected = project_attachments(
            &[message(vec![ContentPart::Image(image_part(Path::new(
                "/nonexistent/shot.png",
            )))])],
            &endpoint(Some(&["text", "image"])),
            IMAGE_REQUEST_LIMITS,
        );
        match &projected[0].content[0] {
            ContentPart::Text { text } => {
                assert!(text.contains("could not be read"), "{text}");
                assert!(text.contains("shot.png"), "{text}");
            }
            other => panic!("the request is still sendable, got {other:?}"),
        }
    }

    #[test]
    fn text_reasoning_and_tool_call_blocks_pass_through_untouched() {
        let content = vec![
            ContentPart::text("look"),
            ContentPart::reasoning("thinking"),
            ContentPart::ToolCall(ToolCall {
                id: "c1".into(),
                name: "bash".into(),
                arguments: "{}".into(),
            }),
        ];
        let messages = [Message::new(crate::types::Role::Assistant, content.clone())];
        assert_eq!(
            project_attachments(&messages, &endpoint(None), IMAGE_REQUEST_LIMITS)[0].content,
            content
        );
    }

    #[test]
    fn an_image_budget_offloads_the_oldest_image_first_with_the_placeholder_naming_it() {
        with_image(&[0x89], |path| {
            let named = |name: &str| {
                let mut part = image_part(path);
                part.name = name.into();
                ContentPart::Image(part)
            };
            let messages = [
                message(vec![named("first.png")]),
                message(vec![named("second.png")]),
                message(vec![named("third.png")]),
            ];
            let projected = project_attachments(
                &messages,
                &endpoint(Some(&["text", "image"])),
                ImageRequestLimits {
                    max_images: 2,
                    max_bytes: 64 * 1024 * 1024,
                },
            );
            match &projected[0].content[0] {
                ContentPart::Text { text } => {
                    assert!(
                        text.starts_with(&format!(
                            "[image omitted to fit request image limits; \"first.png\" (sha256:{}). ",
                            DIGEST
                        )),
                        "the placeholder uses the attachment identity and wording: {text}"
                    );
                    assert!(text.contains("was not sent"), "{text}");
                }
                other => panic!("the oldest image is offloaded, got {other:?}"),
            }
            assert!(matches!(projected[1].content[0], ContentPart::Image(_)));
            assert!(matches!(projected[2].content[0], ContentPart::Image(_)));
        });
    }

    #[test]
    fn an_image_byte_budget_offloads_as_many_of_the_oldest_images_as_the_encoded_bytes_require() {
        with_image(&[0x89], |path| {
            let one = |index: usize| {
                let mut part = image_part(path);
                part.name = format!("{index}.png");
                part.bytes = 900;
                ContentPart::Image(part)
            };
            // Each image is ceil(900/3)*4 = 1200 encoded bytes; two fit 2500, three do not.
            let messages = [
                message(vec![one(0)]),
                message(vec![one(1)]),
                message(vec![one(2)]),
            ];
            let projected = project_attachments(
                &messages,
                &endpoint(Some(&["text", "image"])),
                ImageRequestLimits {
                    max_images: 10,
                    max_bytes: 2500,
                },
            );
            assert!(matches!(projected[0].content[0], ContentPart::Text { .. }));
            assert!(matches!(projected[1].content[0], ContentPart::Image(_)));
            assert!(matches!(projected[2].content[0], ContentPart::Image(_)));
        });
    }

    #[test]
    fn the_budget_never_turns_a_text_only_route_into_an_offload_and_never_touches_a_file() {
        with_image(&[0x89], |path| {
            let messages = [message(vec![
                ContentPart::File(file_part()),
                ContentPart::Image(image_part(path)),
            ])];
            let projected = project_attachments(
                &messages,
                &endpoint(None),
                ImageRequestLimits {
                    max_images: 0,
                    max_bytes: 0,
                },
            );
            match &projected[0].content[0] {
                ContentPart::Text { text } => assert!(
                    text.contains("verbatim read-only copy saved at"),
                    "the file keeps its handle: {text}"
                ),
                other => panic!("the file keeps its handle, got {other:?}"),
            }
            match &projected[0].content[1] {
                ContentPart::Text { text } => {
                    assert!(text.contains("accepts text only"), "{text}");
                    assert!(
                        !text.contains("to fit request image limits"),
                        "for the capability reason rather than the budget: {text}"
                    );
                }
                other => panic!("the image is a text-only placeholder, got {other:?}"),
            }
        });
    }

    #[test]
    fn base64_is_standard_with_padding() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64_encode(&[0x89, 0x50, 0x4e, 0x47]), "iVBORw==");
        assert_eq!(
            base64_encode(&[0xff, 0xff, 0xff, 0xff]),
            "/////w==",
            "every bit pattern encodes"
        );
    }
}
