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
    let leaf = crate::node_path::basename(stored_path);
    let stripped = strip_upload_stamp(leaf);
    if stripped.is_empty() {
        leaf.to_string()
    } else {
        stripped.to_string()
    }
}

/// `^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-`: the store's time prefix, and the leaf after it.
fn strip_upload_stamp(leaf: &str) -> &str {
    let bytes = leaf.as_bytes();
    // The stamp is 25 bytes, `YYYY-MM-DDTHH-MM-SS-mmmZ-`, and a name must follow it.
    if bytes.len() < 26 {
        return leaf;
    }
    let shape = [
        (0, 4, b'-'),
        (5, 2, b'-'),
        (8, 2, b'T'),
        (11, 2, b'-'),
        (14, 2, b'-'),
        (17, 2, b'-'),
        (20, 3, b'Z'),
    ];
    for (start, count, separator) in shape {
        if !bytes[start..start + count].iter().all(u8::is_ascii_digit) {
            return leaf;
        }
        if bytes[start + count] != separator {
            return leaf;
        }
    }
    if bytes[24] != b'-' {
        return leaf;
    }
    &leaf[25..]
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
    let Some(path) = value.as_str().filter(|path| !path.is_empty()) else {
        return Err(AttachmentInputError(
            "an attachment must be a path".to_string(),
        ));
    };
    let root = std::fs::canonicalize(upload_dir).unwrap_or_else(|_| upload_dir.to_path_buf());
    let canonical = match std::fs::canonicalize(path) {
        Ok(canonical) => canonical,
        Err(_) => {
            return Err(AttachmentInputError(format!(
                "the attached file no longer exists: {path}"
            )));
        }
    };
    let root_text = root.to_string_lossy();
    let canonical_text = canonical.to_string_lossy();
    // The comparison is on the **canonical** path, so a symlink inside the directory that points elsewhere is
    // refused rather than followed.
    if canonical != root && !canonical.starts_with(&root) {
        return Err(AttachmentInputError(format!(
            "an attachment must be inside the upload directory ({root_text})"
        )));
    }
    let metadata = match std::fs::metadata(&canonical) {
        Ok(metadata) => metadata,
        Err(_) => {
            return Err(AttachmentInputError(format!(
                "the attached file no longer exists: {path}"
            )));
        }
    };
    if !metadata.is_file() {
        return Err(AttachmentInputError(format!(
            "an attachment must be a file: {canonical_text}"
        )));
    }
    if metadata.len() > crate::uploads::MAX_UPLOAD_BYTES {
        return Err(AttachmentInputError(format!(
            "the attached file is larger than this server accepts ({} MiB)",
            crate::uploads::MAX_UPLOAD_BYTES / (1024 * 1024)
        )));
    }
    let bytes = std::fs::read(&canonical).map_err(|_| {
        AttachmentInputError(format!(
            "the attached file could not be read: {canonical_text}"
        ))
    })?;
    let sha256 = sha256_hex(&bytes);
    let name = display_name_for_stored(&canonical_text);
    let extension = crate::node_path::extname(&canonical_text).to_lowercase();
    match ImageMediaType::for_extension(&extension) {
        Some(mime_type) => Ok(AttachmentPart::Image {
            name,
            mime_type,
            path: canonical_text.into_owned(),
            bytes: metadata.len(),
            sha256,
        }),
        None => Ok(AttachmentPart::File {
            name,
            path: canonical_text.into_owned(),
            bytes: metadata.len(),
            sha256,
        }),
    }
}

/// The lower-case hex SHA-256 of `bytes`, as the session log records it.
fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::Digest;
    let digest = sha2::Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// Read the attachment list a turn or steer request carries.
///
/// Absent (`None` or JSON `null`) is no attachments. Anything else must be an array of at most
/// [`MAX_ATTACHMENTS`] paths, each read by [`read_attachment`]; one bad entry refuses the whole request.
pub fn read_attachments(
    upload_dir: &Path,
    value: Option<&serde_json::Value>,
) -> Result<Vec<AttachmentPart>, AttachmentInputError> {
    let Some(value) = value.filter(|value| !value.is_null()) else {
        return Ok(Vec::new());
    };
    let Some(entries) = value.as_array() else {
        return Err(AttachmentInputError(
            "attachments must be an array of paths".to_string(),
        ));
    };
    if entries.len() > MAX_ATTACHMENTS {
        return Err(AttachmentInputError(format!(
            "one message may carry at most {MAX_ATTACHMENTS} attachments"
        )));
    }
    entries
        .iter()
        .map(|entry| read_attachment(upload_dir, entry))
        .collect()
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
    let mut attachments = Vec::new();
    for part in content {
        let kind = match part.get("type").and_then(serde_json::Value::as_str) {
            Some(kind @ ("image" | "file")) => kind,
            _ => continue,
        };
        let path = part.get("path").and_then(serde_json::Value::as_str);
        let leaf = path.map_or("", crate::node_path::basename);
        if leaf.is_empty() {
            continue;
        }
        let bytes = part
            .get("bytes")
            .and_then(serde_json::Value::as_f64)
            .filter(|bytes| bytes.is_finite() && *bytes >= 0.0)
            .map_or(0, |bytes| bytes as u64);
        let name = part
            .get("name")
            .and_then(serde_json::Value::as_str)
            .filter(|name| !name.is_empty())
            .unwrap_or(leaf);
        let mime_type = part
            .get("mimeType")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("application/octet-stream");
        attachments.push(TurnAttachment {
            kind: kind.to_string(),
            name: name.to_string(),
            mime_type: mime_type.to_string(),
            bytes,
            url: format!("/api/uploads/{}", crate::markdown::percent_encode(leaf)),
        });
    }
    attachments
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

    fn scratch(name: &str) -> std::path::PathBuf {
        let base = std::env::temp_dir().join(format!(
            "hd-attachments-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(base.join("uploads")).unwrap();
        base
    }

    #[test]
    fn the_store_stamp_is_removed_from_a_display_name() {
        assert_eq!(
            display_name_for_stored("/h/uploads/2026-10-18T04-27-03-497Z-report.pdf"),
            "report.pdf"
        );
        assert_eq!(
            display_name_for_stored("/h/uploads/report.pdf"),
            "report.pdf"
        );
        assert_eq!(
            display_name_for_stored("/h/uploads/2026-10-18T04-27-03-497Z-"),
            "2026-10-18T04-27-03-497Z-",
            "nothing would remain, so the leaf is kept"
        );
        assert_eq!(
            display_name_for_stored("/h/uploads/2026-10-18-report.pdf"),
            "2026-10-18-report.pdf",
            "a stamp that is not the store's shape is a name"
        );
    }

    #[test]
    fn an_image_in_the_upload_directory_becomes_an_image_part() {
        let base = scratch("image");
        let directory = base.join("uploads");
        let path = directory.join("2026-10-18T04-27-03-497Z-shot.png");
        std::fs::write(&path, b"abc").unwrap();
        let part = read_attachment(&directory, &serde_json::json!(path.to_string_lossy())).unwrap();
        assert_eq!(
            part,
            AttachmentPart::Image {
                name: "shot.png".into(),
                mime_type: ImageMediaType::Png,
                path: std::fs::canonicalize(&path)
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
                bytes: 3,
                // The SHA-256 of "abc", which is what the session log stores as the file's identity.
                sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad".into(),
            }
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn anything_that_is_not_a_raster_is_a_file_part() {
        let base = scratch("file");
        let directory = base.join("uploads");
        let path = directory.join("doc.pdf");
        std::fs::write(&path, b"%PDF").unwrap();
        let part = read_attachment(&directory, &serde_json::json!(path.to_string_lossy())).unwrap();
        match part {
            AttachmentPart::File { name, bytes, .. } => {
                assert_eq!(name, "doc.pdf");
                assert_eq!(bytes, 4);
            }
            other => panic!("expected a file part, got {other:?}"),
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn every_refusal_names_what_is_wrong() {
        let base = scratch("refusals");
        let directory = base.join("uploads");
        let outside = base.join("elsewhere.txt");
        std::fs::write(&outside, b"x").unwrap();

        let message =
            |value: serde_json::Value| read_attachment(&directory, &value).unwrap_err().to_string();
        assert_eq!(
            message(serde_json::json!(7)),
            "an attachment must be a path"
        );
        assert_eq!(
            message(serde_json::json!("")),
            "an attachment must be a path"
        );
        assert!(
            message(serde_json::json!(
                directory.join("gone.png").to_string_lossy()
            ))
            .starts_with("the attached file no longer exists: "),
            "a missing file says so"
        );
        assert!(
            message(serde_json::json!(outside.to_string_lossy()))
                .starts_with("an attachment must be inside the upload directory ("),
            "a file outside the directory is refused"
        );
        assert!(
            message(serde_json::json!(directory.to_string_lossy()))
                .starts_with("an attachment must be a file: "),
            "a directory is not an attachment"
        );

        let huge = directory.join("huge.bin");
        std::fs::File::create(&huge)
            .unwrap()
            .set_len(crate::uploads::MAX_UPLOAD_BYTES + 1)
            .unwrap();
        assert!(
            message(serde_json::json!(huge.to_string_lossy()))
                .contains("larger than this server accepts"),
            "over the ceiling is refused"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_out_of_the_directory_is_refused_rather_than_followed() {
        let base = scratch("symlink");
        let directory = base.join("uploads");
        let outside = base.join("secret.txt");
        std::fs::write(&outside, b"secret").unwrap();
        let link = directory.join("link.txt");
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        let error =
            read_attachment(&directory, &serde_json::json!(link.to_string_lossy())).unwrap_err();
        assert!(
            error
                .to_string()
                .starts_with("an attachment must be inside the upload directory"),
            "{error}"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn the_batch_rule_is_absent_empty_and_bounded() {
        let base = scratch("batch");
        let directory = base.join("uploads");
        assert_eq!(read_attachments(&directory, None).unwrap(), vec![]);
        assert_eq!(
            read_attachments(&directory, Some(&serde_json::Value::Null)).unwrap(),
            vec![]
        );
        let not_an_array = read_attachments(&directory, Some(&serde_json::json!("x"))).unwrap_err();
        assert_eq!(
            not_an_array.to_string(),
            "attachments must be an array of paths"
        );
        let too_many = serde_json::json!(vec!["/a"; MAX_ATTACHMENTS + 1]);
        let error = read_attachments(&directory, Some(&too_many)).unwrap_err();
        assert_eq!(
            error.to_string(),
            format!("one message may carry at most {MAX_ATTACHMENTS} attachments")
        );
        let one_bad_entry = serde_json::json!(["", ""]);
        assert!(
            read_attachments(&directory, Some(&one_bad_entry)).is_err(),
            "one bad entry refuses the batch"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn the_transcript_cards_read_the_recorded_metadata() {
        let content = serde_json::json!([
            { "type": "image", "name": "shot.png", "mimeType": "image/png", "path": "/h/uploads/2026-10-18T04-27-03-497Z-shot.png", "bytes": 12 },
            { "type": "file", "path": "/h/uploads/a b.pdf", "bytes": 0 },
            { "type": "text", "text": "not an attachment" },
            { "type": "file", "path": "" }
        ]);
        let parts: Vec<serde_json::Value> = content.as_array().unwrap().clone();
        let cards = attachments_of(&parts);
        assert_eq!(cards.len(), 2, "{cards:?}");
        assert_eq!(cards[0].kind, "image");
        assert_eq!(cards[0].name, "shot.png");
        assert_eq!(cards[0].mime_type, "image/png");
        assert_eq!(cards[0].bytes, 12);
        assert_eq!(
            cards[0].url,
            "/api/uploads/2026-10-18T04-27-03-497Z-shot.png"
        );
        assert_eq!(cards[1].kind, "file");
        assert_eq!(cards[1].name, "a b.pdf", "a missing name is the leaf");
        assert_eq!(cards[1].mime_type, "application/octet-stream");
        assert_eq!(
            cards[1].url, "/api/uploads/a%20b.pdf",
            "the leaf is encoded for the route"
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
