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
    // Separators are removed by taking the basename **after** Windows separators are normalised, so both
    // `C:\Users\me\report.txt` and `../../etc/passwd` become one leaf.
    let normalised = name.replace('\\', "/");
    let leaf = crate::node_path::basename(&normalised).trim();
    let cleaned: String = leaf
        .chars()
        .map(|character| {
            if character.is_control()
                || matches!(
                    character,
                    '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
                )
            {
                '_'
            } else {
                character
            }
        })
        .collect();
    let cleaned = cleaned.trim_start_matches(['.', ' ']).trim();
    if cleaned.is_empty() {
        return "file".to_string();
    }
    let characters: Vec<char> = cleaned.chars().collect();
    if characters.len() <= MAX_LEAF {
        return cleaned.to_string();
    }
    let dot = cleaned.rfind('.');
    let extension: String = match dot {
        Some(dot) if dot > 0 && cleaned.len() - dot <= MAX_EXTENSION => cleaned[dot..].to_string(),
        _ => String::new(),
    };
    let stem_source = if extension.is_empty() {
        cleaned
    } else {
        &cleaned[..dot.unwrap_or(0)]
    };
    let keep = MAX_LEAF - extension.chars().count();
    let stem: String = stem_source.chars().take(keep).collect();
    let result = format!("{stem}{extension}");
    if result.is_empty() {
        "file".to_string()
    } else {
        result
    }
}

/// The time prefix of a stored leaf: JavaScript's `Date.toISOString()` with `:` and `.` replaced by `-`, e.g.
/// `2026-10-18T04-27-03-497Z`. [`crate::attachments::display_name_for_stored`] strips exactly this shape.
pub fn upload_stamp(now: SystemTime) -> String {
    let since_epoch = now
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default();
    let millis = since_epoch.as_millis() as u64;
    let seconds = millis / 1000;
    let microseconds = millis % 1000;
    let days = (seconds / 86_400) as i64;
    let rest = seconds % 86_400;
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}-{:02}-{:02}-{microseconds:03}Z",
        rest / 3600,
        (rest % 3600) / 60,
        rest % 60
    )
}

/// The civil date `days` after 1970-01-01, by Howard Hinnant's `civil_from_days`, so no calendar crate is needed.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let shifted = days + 719_468;
    let era = if shifted >= 0 {
        shifted
    } else {
        shifted - 146_096
    } / 146_097;
    let day_of_era = (shifted - era * 146_097) as u64;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era as i64 + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * month_prime + 2) / 5 + 1) as u32;
    let month = if month_prime < 10 {
        month_prime + 3
    } else {
        month_prime - 9
    } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
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
    let safe = safe_upload_name(name);
    let directory = upload_directory(heddle_home);
    std::fs::create_dir_all(&directory)?;
    let stamp = upload_stamp(now);
    let mut attempt = 0usize;
    loop {
        let leaf = if attempt == 0 {
            format!("{stamp}-{safe}")
        } else {
            format!("{stamp}-{attempt}-{safe}")
        };
        let path = directory.join(&leaf);
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&path) {
            Ok(mut file) => {
                use std::io::Write;
                file.write_all(data)?;
                return Ok(SavedUpload {
                    path: path.to_string_lossy().into_owned(),
                    name: safe,
                    bytes: data.len() as u64,
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                attempt += 1;
                if attempt > 1_000 {
                    return Err(error);
                }
            }
            Err(error) => return Err(error),
        }
    }
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

    #[test]
    fn a_path_on_the_clients_machine_is_reduced_to_one_leaf() {
        assert_eq!(safe_upload_name("C:\\Users\\me\\report.txt"), "report.txt");
        assert_eq!(safe_upload_name("../../etc/passwd"), "passwd");
        assert_eq!(safe_upload_name("/a/b/c.png"), "c.png");
        assert_eq!(safe_upload_name("  spaced  "), "spaced");
        assert_eq!(safe_upload_name(""), "file");
        assert_eq!(
            safe_upload_name("..."),
            "file",
            "leading dots are never a path"
        );
        assert_eq!(safe_upload_name(".."), "file");
        assert_eq!(safe_upload_name(".hidden"), "hidden", "and never hidden");
        assert_eq!(safe_upload_name("a:b*c?d\"e<f>g|h"), "a_b_c_d_e_f_g_h");
        assert_eq!(
            safe_upload_name("tab\there"),
            "tab_here",
            "a control character is replaced"
        );
    }

    #[test]
    fn a_long_name_is_cut_keeping_its_extension() {
        let name = format!("{}.pdf", "a".repeat(300));
        let safe = safe_upload_name(&name);
        assert_eq!(safe.chars().count(), MAX_LEAF);
        assert!(safe.ends_with(".pdf"), "the extension survives: {safe}");
        let long_extension = format!("{}.{}", "a".repeat(200), "b".repeat(30));
        let safe = safe_upload_name(&long_extension);
        assert_eq!(safe.chars().count(), MAX_LEAF);
        assert!(
            !safe.contains(".bbb"),
            "an extension over 16 characters is not kept: {safe}"
        );
    }

    #[test]
    fn the_stamp_is_javascripts_iso_string_with_two_characters_replaced() {
        // 1_700_000_000 s is 2023-11-14T22:13:20Z; the milliseconds are the last three digits of the stamp.
        let at = SystemTime::UNIX_EPOCH + std::time::Duration::from_millis(1_700_000_000_000 + 497);
        assert_eq!(upload_stamp(at), "2023-11-14T22-13-20-497Z");
        assert_eq!(
            upload_stamp(SystemTime::UNIX_EPOCH),
            "1970-01-01T00-00-00-000Z"
        );
    }

    fn scratch_home(name: &str) -> PathBuf {
        let home = std::env::temp_dir().join(format!("hd-web-files-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        home
    }

    #[test]
    fn an_upload_lands_under_the_home_with_a_time_prefix() {
        let home = scratch_home("upload");
        let saved = save_upload(&home, "shot.png", b"png", SystemTime::UNIX_EPOCH).unwrap();
        assert_eq!(saved.name, "shot.png");
        assert_eq!(saved.bytes, 3);
        assert_eq!(
            saved.path,
            home.join("uploads")
                .join("1970-01-01T00-00-00-000Z-shot.png")
                .to_string_lossy()
        );
        assert_eq!(std::fs::read(&saved.path).unwrap(), b"png");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn a_second_upload_of_the_same_name_is_not_written_over() {
        let home = scratch_home("collide");
        let first = save_upload(&home, "a.txt", b"one", SystemTime::UNIX_EPOCH).unwrap();
        let second = save_upload(&home, "a.txt", b"two", SystemTime::UNIX_EPOCH).unwrap();
        assert_ne!(first.path, second.path, "the second gets its own path");
        assert!(
            second.path.contains("1970-01-01T00-00-00-000Z-1-a.txt"),
            "{}",
            second.path
        );
        assert_eq!(std::fs::read(&first.path).unwrap(), b"one");
        assert_eq!(std::fs::read(&second.path).unwrap(), b"two");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[cfg(unix)]
    #[test]
    fn an_upload_is_created_for_its_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let home = scratch_home("mode");
        let saved = save_upload(&home, "private.txt", b"x", SystemTime::UNIX_EPOCH).unwrap();
        let mode = std::fs::metadata(&saved.path).unwrap().permissions().mode();
        assert_eq!(
            mode & 0o777,
            0o600,
            "the file is the person's data: {mode:o}"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn civil_dates_are_the_proleptic_gregorian_calendar() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(19_723), (2024, 1, 1));
        assert_eq!(civil_from_days(-1), (1969, 12, 31));
        assert_eq!(civil_from_days(20_619), (2026, 6, 15));
        assert_eq!(civil_from_days(19_675), (2023, 11, 14));
    }
}
