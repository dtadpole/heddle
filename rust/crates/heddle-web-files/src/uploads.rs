//! The upload store — the port of `src/server/uploads.ts`.
//!
//! Heddle's substrate for "a file in the conversation" is a **path**: `read_file` opens a path and the sandbox
//! decides whether it may be read. This module is the one place that turns uploaded bytes into such a path:
//!
//! - the file lands under `$HEDDLE_HOME/uploads/`, which the sandbox admits for reading;
//! - the client's name is reduced to one safe leaf ([`safe_upload_name`]) before it is joined, so a hand-made request
//!   cannot choose a path outside that directory;
//! - the leaf is prefixed with the upload time (`2026-10-18T04-27-03-497Z-report.pdf`), and an existing file is never
//!   overwritten (`…-497Z-1-report.pdf`, `-2-`, …), because two files may honestly share a name;
//! - the file is created `0600`: it is the person's data, not the machine's.

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::Serialize;

/// The largest body `POST /api/uploads` accepts: 50 MiB. A local memory guard, not a prompt-size one — what reaches
/// the conversation is the path, so an ordinary Retina screenshot (which passes 10 MiB) must fit.
pub const MAX_UPLOAD_BYTES: u64 = 50 * 1024 * 1024;

/// The longest leaf a name may become, in characters, before the extension is considered.
pub(crate) const MAX_LEAF: usize = 120;

/// The longest extension (with its dot) that is preserved when a name must be cut.
pub(crate) const MAX_EXTENSION: usize = 16;

/// One stored upload, as `POST /api/uploads` answers it: `{"path": …, "name": …, "bytes": …}`, in that order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SavedUpload {
    /// Absolute path — what the agent's `read_file` takes, and what the draft names.
    pub path: String,
    /// The safe leaf the client's name was reduced to (without the time prefix).
    pub name: String,
    pub bytes: u64,
}

/// The directory uploads live in: `<heddle_home>/uploads`. The home is a parameter so a test never touches the
/// operator's.
pub fn upload_directory(heddle_home: &Path) -> PathBuf {
    heddle_home.join("uploads")
}

/// Reduce a client-supplied name to one safe file name.
///
/// In order: `\` becomes `/` and the basename is taken (so `C:\Users\me\report.txt` and `../../etc/passwd` both
/// become a leaf), trimmed; control characters, DEL and `/ \ : * ? " < > |` become `_`; leading dots and white
/// space are removed (never `..`, never hidden); an empty result is `file`; a result longer than 120
/// characters is cut to 120, keeping an extension (dot included) of at most 16 characters.
pub fn safe_upload_name(name: &str) -> String {
    todo!("port safeUploadName from src/server/uploads.ts")
}

/// The time prefix of a stored leaf: JavaScript's `Date.toISOString()` with `:` and `.` replaced by `-`, e.g.
/// `2026-10-18T04-27-03-497Z`. [`crate::attachments::display_name_for_stored`] strips exactly this shape.
pub fn upload_stamp(now: SystemTime) -> String {
    todo!("format as toISOString() with ':' and '.' replaced by '-'")
}

/// Store one upload under `upload_directory(heddle_home)` (created if missing) and answer with its path.
///
/// `now` is a parameter so a test can make two uploads collide on purpose; the route passes `SystemTime::now()`.
/// The file is created exclusively (`create_new`) with mode `0600`, and a collision moves to the next free
/// `-<n>-` name rather than overwriting.
pub fn save_upload(
    heddle_home: &Path,
    name: &str,
    data: &[u8],
    now: SystemTime,
) -> std::io::Result<SavedUpload> {
    todo!("port saveUpload from src/server/uploads.ts")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_upload_directory_is_under_the_given_home() {
        assert_eq!(
            upload_directory(Path::new("/h")),
            PathBuf::from("/h/uploads")
        );
    }

    #[test]
    fn a_saved_upload_serializes_in_the_order_the_page_reads() {
        let saved = SavedUpload {
            path: "/h/uploads/x-a.png".into(),
            name: "a.png".into(),
            bytes: 3,
        };
        assert_eq!(
            serde_json::to_string(&saved).unwrap(),
            r#"{"path":"/h/uploads/x-a.png","name":"a.png","bytes":3}"#
        );
    }

    #[test]
    fn the_ceiling_is_fifty_mebibytes() {
        assert_eq!(MAX_UPLOAD_BYTES, 52_428_800);
    }
}
