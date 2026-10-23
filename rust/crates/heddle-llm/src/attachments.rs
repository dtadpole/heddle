//! The attachment projection: what a provider is actually sent for an attached file or image.
//!
//! Ported from `src/llm/attachments.ts`; DSH's rules. A **non-image file never reaches a provider**: it becomes a
//! deterministic handle naming its saved read-only path. An **image** is sent as bytes only to a route that declares
//! `image` input, otherwise it becomes a text-only placeholder. On an image route the request's images are bounded
//! ([`IMAGE_REQUEST_LIMITS`]): the oldest are replaced with an "omitted to fit" placeholder until the rest fit. Every
//! replacement is stable text, and the bytes are read here, at request time, so the log holds only references.

use crate::endpoint::EndpointConfig;
use crate::types::{FilePart, ImageMediaType, ImagePart, Message};

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

/// The model-facing handle for one verbatim file (`fileHandleText`).
pub fn file_handle_text(part: &FilePart) -> String {
    let _ = part;
    todo!("port fileHandleText")
}

/// The placeholder for an image a text-only route cannot accept (`textOnlyImageText`).
pub fn text_only_image_text(part: &ImagePart) -> String {
    let _ = part;
    todo!("port textOnlyImageText")
}

/// An attachment's identity: its JSON-quoted name and full `sha256:` digest (`imageIdentity`).
pub fn image_identity(part: &ImagePart) -> String {
    let _ = part;
    todo!("port imageIdentity")
}

/// The placeholder for an image left behind for the budget (`offloadedImageText`).
pub fn offloaded_image_text(part: &ImagePart) -> String {
    let _ = part;
    todo!("port offloadedImageText")
}

/// Project every message's content for one endpoint (`projectAttachments`). Applied after the `model/request` hook
/// and before the adapter, so no adapter sees a file part or image bytes a route cannot take.
pub fn project_attachments(
    messages: &[Message],
    endpoint: &EndpointConfig,
    limits: ImageRequestLimits,
) -> Vec<Message> {
    let _ = (messages, endpoint, limits);
    todo!("port projectAttachments")
}

/// Standard base64 with padding, for an image's bytes.
#[allow(dead_code)] // called by `project_attachments` once it is ported
pub(crate) fn base64_encode(bytes: &[u8]) -> String {
    let _ = bytes;
    todo!("base64 for image data")
}
