//! The runtime-context snapshot: the standing facts a model is told, as one sourced user message.
//!
//! A port of the snapshot half of `src/context/service.ts`, following DSH's agent loop: before
//! every request the registered contributions are rendered, and a snapshot that differs from the
//! retained one is **appended** after history (earlier ones stay, superseded); an unchanged one
//! writes nothing. The service records it ([`crate::ContextService::record_runtime_context`]); this
//! module owns its text.

use serde::{Deserialize, Serialize};

/// The `origin` of a runtime-context note.
pub const RUNTIME_CONTEXT_ORIGIN: &str = "runtime-context";
/// The prefix of a full snapshot, so a model with earlier ones in history reads the newest as current.
pub const RUNTIME_CONTEXT_HEADER: &str =
    "Current runtime context. This snapshot supersedes earlier runtime-context snapshots.";
/// What a snapshot says when every contribution has gone away.
pub const CLEARED_RUNTIME_CONTEXT: &str =
    "Current runtime context: none. Earlier runtime-context snapshots no longer apply.";

/// One named contribution, the way DSH attributes each part to its subsystem (`sandbox:policy`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeContextSection {
    /// Which subsystem said it.
    pub name: String,
    /// What it said; an empty text contributes nothing.
    pub text: String,
}

/// The snapshot text: the header and the non-empty sections joined by blank lines, or
/// [`CLEARED_RUNTIME_CONTEXT`] when none has text.
pub fn render_runtime_context(sections: &[RuntimeContextSection]) -> String {
    let body = sections
        .iter()
        .map(|section| section.text.as_str())
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    if body.is_empty() {
        CLEARED_RUNTIME_CONTEXT.to_string()
    } else {
        format!("{RUNTIME_CONTEXT_HEADER}\n\n{body}")
    }
}

#[cfg(test)]
mod tests {
    use super::{
        CLEARED_RUNTIME_CONTEXT, RUNTIME_CONTEXT_HEADER, RuntimeContextSection,
        render_runtime_context,
    };

    fn section(name: &str, text: &str) -> RuntimeContextSection {
        RuntimeContextSection {
            name: name.to_string(),
            text: text.to_string(),
        }
    }

    #[test]
    fn a_snapshot_is_the_header_then_the_sections_in_order() {
        let sections = [
            section(
                "sandbox:policy",
                "Current heddle file policy: workspace-write.",
            ),
            section("workspace", "The session folder is /w."),
        ];
        assert_eq!(
            render_runtime_context(&sections),
            format!(
                "{RUNTIME_CONTEXT_HEADER}\n\nCurrent heddle file policy: workspace-write.\n\nThe session folder is /w."
            )
        );
    }

    #[test]
    fn a_section_with_no_text_contributes_nothing() {
        let sections = [
            section("empty", ""),
            section("sandbox:policy", "Current heddle file policy: read-only."),
        ];
        assert_eq!(
            render_runtime_context(&sections),
            format!("{RUNTIME_CONTEXT_HEADER}\n\nCurrent heddle file policy: read-only.")
        );
    }

    #[test]
    fn no_sections_at_all_clears_the_previous_snapshot() {
        assert_eq!(render_runtime_context(&[]), CLEARED_RUNTIME_CONTEXT);
        assert_eq!(
            render_runtime_context(&[section("empty", "")]),
            CLEARED_RUNTIME_CONTEXT
        );
        assert!(!CLEARED_RUNTIME_CONTEXT.contains(RUNTIME_CONTEXT_HEADER));
    }
}
