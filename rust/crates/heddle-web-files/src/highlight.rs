//! Syntax highlighting for fenced code and source files — the port of `src/server/highlight.ts`.
//!
//! **One highlighter** colours both a fence inside a document and a source file in the File panel, so a keyword is
//! classified once in the project rather than twice (claim 4 of `_verifiers_/88-file-preview`).
//!
//! # What is kept from the TypeScript build, and what is not
//!
//! The TypeScript build runs `highlight.js`. The Rust port runs a grammar-based Rust highlighter (the choice and its
//! measurement are in the crate's `INDEX.md`), and keeps the three things the rest of the system depends on:
//!
//! - **The class vocabulary is `highlight.js`'s** — `hljs-keyword`, `hljs-string`, `hljs-comment`, `hljs-number`,
//!   `hljs-title`, `hljs-attr`, … — because `page.html`, which both builds serve unchanged, styles those names and
//!   the verifiers match them (`hljs-keyword">def<` for Python, `hljs-comment">// a tiny script<` for JavaScript).
//!   The highlighter's own scope names are mapped onto that vocabulary in one table; the innermost mapped scope wins.
//! - **The registered language set and its aliases are the same**, so [`supports_language`] answers exactly as
//!   `supportsLanguage` does, and an unknown or absent language is still rendered — escaped, unclassified.
//! - **Exact text**: stripping the spans and decoding the entities gives back the input, character for character.
//!   Nothing is re-ordered, dropped or invented.
//!
//! Not kept: the exact span boundaries `highlight.js` would choose. No verifier judges them, and the page's theme
//! colours by class, not by boundary.

/// The grammars this build registers, by the canonical name a fence or the extension table uses.
pub(crate) const GRAMMARS: &[&str] = &[
    "bash",
    "c",
    "cpp",
    "css",
    "diff",
    "go",
    "ini",
    "java",
    "javascript",
    "json",
    "markdown",
    "php",
    "plaintext",
    "python",
    "ruby",
    "rust",
    "sql",
    "typescript",
    "xml",
    "yaml",
];

/// The spellings a fence is likely to use, and the grammar each names. Same table as `highlight.ts`.
pub(crate) const ALIASES: &[(&str, &str)] = &[
    ("sh", "bash"),
    ("shell", "bash"),
    ("zsh", "bash"),
    ("console", "bash"),
    ("js", "javascript"),
    ("jsx", "javascript"),
    ("mjs", "javascript"),
    ("cjs", "javascript"),
    ("node", "javascript"),
    ("ts", "typescript"),
    ("tsx", "typescript"),
    ("py", "python"),
    ("python3", "python"),
    ("yml", "yaml"),
    ("jsonc", "json"),
    ("json5", "json"),
    ("html", "xml"),
    ("svg", "xml"),
    ("xhtml", "xml"),
    ("md", "markdown"),
    ("mdown", "markdown"),
    ("rs", "rust"),
    ("golang", "go"),
    ("c++", "cpp"),
    ("h", "c"),
    ("hpp", "cpp"),
    ("rb", "ruby"),
    ("cfg", "ini"),
    ("conf", "ini"),
    ("text", "plaintext"),
    ("txt", "plaintext"),
    ("plain", "plaintext"),
    ("toml", "ini"),
    ("properties", "ini"),
    ("env", "ini"),
];

/// One run of source text and the class the highlighter gave it — what `code.ts` reads back out of the
/// highlighter's markup, produced here directly so no markup is parsed back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Piece {
    /// The source text, unescaped. Never contains `\n` unless [`Piece::newline`] is set.
    pub(crate) text: String,
    /// The `hljs-*` class (possibly two words, e.g. `hljs-title function_`), or `None` for unclassified text.
    pub(crate) class: Option<&'static str>,
    /// This piece is exactly one `\n`, which is where the line gutter starts a new row.
    pub(crate) newline: bool,
}

/// The source as classified pieces, split at every newline. The concatenated `text` of the result is `code`.
pub(crate) fn highlight_pieces(code: &str, language: Option<&str>) -> Vec<Piece> {
    todo!(
        "classify with the grammar named by `language`, map scopes to hljs classes, split at newlines"
    )
}

/// Highlight a code block: the HTML for the **inside** of a `<pre><code>`.
///
/// Flat `<span class="hljs-…">` runs around escaped text (the five characters of `markdown::escape_html`), which the
/// allow-list in [`crate::sanitize`] accepts because `span` and `class` are on it. A `language` that is absent, not
/// registered, or whose grammar fails is rendered as plain text: escaped, with no span.
pub fn highlight_code(code: &str, language: Option<&str>) -> String {
    todo!("port highlightCode from src/server/highlight.ts")
}

/// Whether a fence's language is one this build can colour — lower-cased and trimmed, aliases resolved.
pub fn supports_language(language: &str) -> bool {
    grammar_for(language).is_some()
}

/// The registered grammar a requested language names, after lower-casing, trimming and resolving an alias.
pub(crate) fn grammar_for(language: &str) -> Option<&'static str> {
    let requested = language.to_lowercase();
    let requested = requested.trim();
    let name = ALIASES
        .iter()
        .find(|(alias, _)| *alias == requested)
        .map_or(requested, |(_, grammar)| grammar);
    GRAMMARS.iter().copied().find(|grammar| *grammar == name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_registered_name_or_alias_is_supported_in_any_case_and_padding() {
        assert!(supports_language("python"));
        assert!(supports_language("  TS "));
        assert!(supports_language("c++"));
        assert!(
            supports_language("toml"),
            "TOML is coloured by the INI grammar, as in highlight.ts"
        );
        assert_eq!(grammar_for("Shell"), Some("bash"));
        assert_eq!(grammar_for("svg"), Some("xml"));
    }

    #[test]
    fn an_unregistered_or_empty_language_is_not_supported() {
        assert!(!supports_language(""));
        assert!(!supports_language("haskell"));
        // The TypeScript build answers `true` here, through `'constructor' in GRAMMARS` reaching Object.prototype, and
        // then falls back to plain text. That is a JavaScript artifact, not the contract: no fence names a grammar so.
        assert!(!supports_language("constructor"));
        assert_eq!(grammar_for("kotlin"), None);
    }

    #[test]
    fn every_alias_names_a_registered_grammar() {
        for (alias, grammar) in ALIASES {
            assert!(
                GRAMMARS.contains(grammar),
                "{alias} names {grammar}, which is not registered"
            );
        }
    }
}
