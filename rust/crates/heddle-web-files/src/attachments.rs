//! The server half of an attachment — the port of `src/server/attachments.ts`, plus the transcript card of
//! `attachmentsOf` in `src/server/web.ts`.
//!
//! The browser only says **which stored file**; the server decides the display name, byte size, sha256 and media
//! type. That is the security rule — a hand-made request must not point a message at a file outside the upload
//! directory — and the descriptive rule: the block a request projection reads later is the one the server measured.
//! The session log therefore stores a reference (the path), never bytes.

use std::path::Path;

use serde::{Deserialize, Serialize};

/// The most files one message may carry.
pub const MAX_ATTACHMENTS: usize = 10;

/// A raster type the request projection can send as image content.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ImageMediaType {
    #[serde(rename = "image/png")]
    Png,
    #[serde(rename = "image/jpeg")]
    Jpeg,
    #[serde(rename = "image/webp")]
    Webp,
    #[serde(rename = "image/gif")]
    Gif,
}

impl ImageMediaType {
    /// The type a lower-cased extension (with its dot) names: `.png`, `.jpg`/`.jpeg`, `.webp`, `.gif`.
    pub fn for_extension(extension: &str) -> Option<Self> {
        match extension {
            ".png" => Some(Self::Png),
            ".jpg" | ".jpeg" => Some(Self::Jpeg),
            ".webp" => Some(Self::Webp),
            ".gif" => Some(Self::Gif),
            _ => None,
        }
    }

    /// The MIME string, as serialized.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Png => "image/png",
            Self::Jpeg => "image/jpeg",
            Self::Webp => "image/webp",
            Self::Gif => "image/gif",
        }
    }
}

/// One attachment, as the user message's content records it.
///
/// Serializes to exactly the `image` and `file` content parts of the TypeScript session log —
/// `{"type":"image","name":…,"mimeType":…,"path":…,"bytes":…,"sha256":…}` and
/// `{"type":"file","name":…,"path":…,"bytes":…,"sha256":…}`, fields in that order — so the session and request
/// crates can store and read it unchanged.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum AttachmentPart {
    Image {
        /// The name the person attached (the stored leaf without its time prefix).
        name: String,
        #[serde(rename = "mimeType")]
        mime_type: ImageMediaType,
        /// The canonical absolute path inside the upload directory.
        path: String,
        bytes: u64,
        /// Lower-case hex SHA-256 of the bytes at the time they were attached.
        sha256: String,
    },
    File {
        name: String,
        path: String,
        bytes: u64,
        sha256: String,
    },
}

/// A refused attachment, with a sentence a person can act on. The routes answer it as `400`.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct AttachmentInputError(pub String);

/// The name a person attached, recovered from the store's leaf: the `YYYY-MM-DDTHH-MM-SS-mmmZ-` prefix removed, or
/// the leaf itself when nothing would remain.
pub fn display_name_for_stored(stored_path: &str) -> String {
    todo!("port displayNameForStored from src/server/attachments.ts")
}

/// Read one attachment reference into its content block.
///
/// Every failure is a named refusal, in this order: not a non-empty string (`an attachment must be a path`); no
/// longer on disk; outside `upload_dir` **after** canonicalising both (so a symlink inside the directory that points
/// elsewhere is refused, not followed); not a regular file; larger than [`crate::uploads::MAX_UPLOAD_BYTES`].
pub fn read_attachment(
    upload_dir: &Path,
    value: &serde_json::Value,
) -> Result<AttachmentPart, AttachmentInputError> {
    todo!("port readAttachment from src/server/attachments.ts")
}

/// Read the attachment list a turn or steer request carries.
///
/// Absent (`None` or JSON `null`) is no attachments. Anything else must be an array of at most
/// [`MAX_ATTACHMENTS`] paths, each read by [`read_attachment`]; one bad entry refuses the whole request.
pub fn read_attachments(
    upload_dir: &Path,
    value: Option<&serde_json::Value>,
) -> Result<Vec<AttachmentPart>, AttachmentInputError> {
    todo!("port readAttachments from src/server/attachments.ts")
}

/// A file one message carries, as a transcript card shows it: `{"kind","name","mimeType","bytes","url"}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TurnAttachment {
    /// `image` or `file`, from the content part's `type`.
    pub kind: String,
    pub name: String,
    #[serde(rename = "mimeType")]
    pub mime_type: String,
    pub bytes: u64,
    /// `/api/uploads/<encoded leaf>` — served by [`crate::routes`].
    pub url: String,
}

/// The transcript cards for a message's content parts — `attachmentsOf` of `src/server/web.ts`, offered to the
/// session projection because the URL it builds is this crate's route.
///
/// Only `image` and `file` parts with a non-empty path leaf count; a missing name is the leaf, a missing MIME type is
/// `application/octet-stream`, a missing or non-finite size is 0.
pub fn attachments_of(content: &[serde_json::Value]) -> Vec<TurnAttachment> {
    todo!("port attachmentsOf from src/server/web.ts")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_image_part_serializes_as_the_session_log_records_it() {
        let part = AttachmentPart::Image {
            name: "shot.png".into(),
            mime_type: ImageMediaType::Png,
            path: "/h/uploads/2026-10-18T04-27-03-497Z-shot.png".into(),
            bytes: 12,
            sha256: "ab".into(),
        };
        assert_eq!(
            serde_json::to_string(&part).unwrap(),
            r#"{"type":"image","name":"shot.png","mimeType":"image/png","path":"/h/uploads/2026-10-18T04-27-03-497Z-shot.png","bytes":12,"sha256":"ab"}"#
        );
    }

    #[test]
    fn a_file_part_serializes_without_a_media_type_and_reads_back() {
        let part = AttachmentPart::File {
            name: "a.pdf".into(),
            path: "/h/uploads/a.pdf".into(),
            bytes: 1,
            sha256: "cd".into(),
        };
        let json = serde_json::to_string(&part).unwrap();
        assert_eq!(
            json,
            r#"{"type":"file","name":"a.pdf","path":"/h/uploads/a.pdf","bytes":1,"sha256":"cd"}"#
        );
        assert_eq!(serde_json::from_str::<AttachmentPart>(&json).unwrap(), part);
    }

    #[test]
    fn image_types_follow_the_lower_cased_extension() {
        assert_eq!(
            ImageMediaType::for_extension(".jpeg"),
            Some(ImageMediaType::Jpeg)
        );
        assert_eq!(
            ImageMediaType::for_extension(".jpg").map(ImageMediaType::as_str),
            Some("image/jpeg")
        );
        assert_eq!(
            ImageMediaType::for_extension(".svg"),
            None,
            "an SVG is a file, not image content"
        );
        assert_eq!(
            ImageMediaType::for_extension(".PNG"),
            None,
            "the caller lower-cases"
        );
    }

    #[test]
    fn a_turn_attachment_serializes_as_the_transcript_card_reads_it() {
        let card = TurnAttachment {
            kind: "image".into(),
            name: "a.png".into(),
            mime_type: "image/png".into(),
            bytes: 5,
            url: "/api/uploads/x-a.png".into(),
        };
        assert_eq!(
            serde_json::to_string(&card).unwrap(),
            r#"{"kind":"image","name":"a.png","mimeType":"image/png","bytes":5,"url":"/api/uploads/x-a.png"}"#
        );
    }
}
