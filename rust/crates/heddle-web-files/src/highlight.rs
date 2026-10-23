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
    let mut pieces: Vec<Piece> = Vec::new();
    let Some(syntax) = language
        .and_then(grammar_for)
        .and_then(|grammar| syntax_for(grammar, syntax_set()))
    else {
        // No language, or one this build does not register: the text, unclassified, as highlight.js's plaintext.
        push_text(code, None, &mut pieces);
        return merge_adjacent(pieces);
    };
    let set = syntax_set();
    // JSON is classed by its own rules: highlight.js's JSON grammar differs from the general table where a reader
    // sees it (see `json_class`).
    let json = language.and_then(grammar_for) == Some("json");
    let mut parse_state = syntect::parsing::ParseState::new(syntax);
    let mut stack = syntect::parsing::ScopeStack::new();
    for line in code.split_inclusive('\n') {
        let Ok(operations) = parse_state.parse_line(line, set) else {
            // A grammar that refuses its input is a rendering concern, not a reason to lose the block.
            push_text(line, None, &mut pieces);
            continue;
        };
        for (text, operation) in syntect::easy::ScopeRegionIterator::new(&operations, line) {
            if stack.apply(operation).is_err() {
                // `clear_scopes` reaching below the base: keep the text and start the stack again rather than lose it.
                stack = syntect::parsing::ScopeStack::new();
            }
            let class = if json {
                json_class(&stack)
            } else {
                class_for_stack(&stack)
            };
            push_text(text, class, &mut pieces);
        }
    }
    merge_adjacent(pieces)
}

/// The one grammar set, built once. It is read-only afterwards, so every request can share it.
fn syntax_set() -> &'static syntect::parsing::SyntaxSet {
    static SET: std::sync::OnceLock<syntect::parsing::SyntaxSet> = std::sync::OnceLock::new();
    SET.get_or_init(two_face::syntax::extra_newlines)
}

/// The syntax a registered grammar name names, tried by every spelling the set may use for it.
fn syntax_for<'s>(
    grammar: &'static str,
    set: &'s syntect::parsing::SyntaxSet,
) -> Option<&'s syntect::parsing::SyntaxReference> {
    for name in SYNTAX_NAMES
        .iter()
        .find(|(known, _)| *known == grammar)
        .map_or(&[][..], |(_, names)| *names)
    {
        if let Some(syntax) = set.find_syntax_by_name(name) {
            return Some(syntax);
        }
    }
    for extension in SYNTAX_EXTENSIONS
        .iter()
        .find(|(known, _)| *known == grammar)
        .map_or(&[][..], |(_, extensions)| *extensions)
    {
        if let Some(syntax) = set.find_syntax_by_extension(extension) {
            return Some(syntax);
        }
    }
    if grammar == "plaintext" {
        return Some(set.find_syntax_plain_text());
    }
    None
}

/// The grammar's name in the syntax set, and the spellings bat's set may carry instead.
const SYNTAX_NAMES: &[(&str, &[&str])] = &[
    (
        "bash",
        &["Bourne Again Shell (bash)", "Bash", "Shell Script"],
    ),
    ("c", &["C"]),
    ("cpp", &["C++"]),
    ("css", &["CSS"]),
    ("diff", &["Diff"]),
    ("go", &["Go"]),
    ("ini", &["INI"]),
    ("java", &["Java"]),
    ("javascript", &["JavaScript", "JavaScript (Babel)"]),
    ("json", &["JSON"]),
    ("markdown", &["Markdown"]),
    ("php", &["PHP"]),
    ("plaintext", &["Plain Text"]),
    ("python", &["Python"]),
    ("ruby", &["Ruby"]),
    ("rust", &["Rust"]),
    ("sql", &["SQL"]),
    ("typescript", &["TypeScript"]),
    ("xml", &["XML"]),
    ("yaml", &["YAML"]),
];

/// A grammar's extensions, the second way the syntax set is asked, for a set that spells names differently.
const SYNTAX_EXTENSIONS: &[(&str, &[&str])] = &[
    ("bash", &["sh"]),
    ("c", &["c"]),
    ("cpp", &["cpp"]),
    ("css", &["css"]),
    ("diff", &["diff"]),
    ("go", &["go"]),
    ("ini", &["ini"]),
    ("java", &["java"]),
    ("javascript", &["js"]),
    ("json", &["json"]),
    ("markdown", &["md"]),
    ("php", &["php"]),
    ("ruby", &["rb"]),
    ("rust", &["rs"]),
    ("sql", &["sql"]),
    ("typescript", &["ts"]),
    ("xml", &["xml"]),
    ("yaml", &["yml"]),
];

/// The scope-to-class table: TextMate scope prefix, then the `highlight.js` class(es) the page styles.
///
/// More specific first within a scope, so `string.regexp` wins over `string`, and the first mapping found walking
/// from the innermost scope outwards wins, which is what "the innermost mapped scope" means.
const CLASSES: &[(&str, &str)] = &[
    ("comment", "hljs-comment"),
    ("keyword", "hljs-keyword"),
    ("storage.type", "hljs-keyword"),
    ("storage.modifier", "hljs-keyword"),
    ("storage", "hljs-keyword"),
    ("string.regexp", "hljs-regexp"),
    ("string.quoted.double", "hljs-string"),
    ("string.quoted.single", "hljs-string"),
    ("string", "hljs-string"),
    ("constant.numeric", "hljs-number"),
    ("constant.character", "hljs-string"),
    ("constant.language", "hljs-literal"),
    ("constant", "hljs-literal"),
    ("variable.language", "hljs-variable language_"),
    ("variable.parameter", "hljs-params"),
    ("variable.other", "hljs-variable"),
    ("variable", "hljs-variable"),
    ("support.function", "hljs-built_in"),
    ("support.class", "hljs-title class_"),
    ("support.type", "hljs-type"),
    ("entity.name.function", "hljs-title function_"),
    ("entity.name.class", "hljs-title class_"),
    ("entity.name.type", "hljs-title class_"),
    ("entity.name.tag", "hljs-tag"),
    ("entity.other.attribute-name", "hljs-attr"),
    ("meta.preprocessor", "hljs-meta"),
    ("meta.tag", "hljs-tag"),
    ("markup.heading", "hljs-section"),
    ("markup.bold", "hljs-strong"),
    ("markup.italic", "hljs-emphasis"),
    ("markup.raw", "hljs-code"),
    ("markup.quote", "hljs-quote"),
    ("markup.inserted", "hljs-addition"),
    ("markup.deleted", "hljs-deletion"),
    ("invalid", "hljs-"),
];

/// The class the innermost mapped scope gives this region, or `None` for text no mapping covers.
fn class_for_stack(stack: &syntect::parsing::ScopeStack) -> Option<&'static str> {
    for scope in stack.scopes.iter().rev() {
        let name = scope.build_string();
        if name.starts_with("string") && is_json_key(stack) {
            // highlight.js gives a JSON object's key its own class, and the page styles it; without this every
            // string in a JSON file — key and value alike — would be one colour.
            return Some("hljs-attr");
        }
        for (prefix, class) in CLASSES {
            if scope_matches(&name, prefix) {
                return Some(class);
            }
        }
    }
    None
}

/// highlight.js's classes for JSON, which differ from the general table in what a reader sees.
///
/// Measured against the TypeScript build (highlight.js 11) on `{"command":"ls","nested":{"a":[1,2.5,true,null]}}`:
/// every `{ } [ ] : ,` is an `hljs-punctuation` token, `true`/`false`/`null` are `hljs-keyword` (not
/// `hljs-literal`), and a key is `hljs-attr` at **any** depth. A decimal point is part of its number, and a quote is
/// part of its string, so neither becomes punctuation.
fn json_class(stack: &syntect::parsing::ScopeStack) -> Option<&'static str> {
    let names: Vec<String> = stack
        .scopes
        .iter()
        .map(|scope| scope.build_string())
        .collect();
    let any = |prefix: &str| names.iter().any(|name| scope_matches(name, prefix));
    if any("comment") {
        return Some("hljs-comment");
    }
    if any("string") {
        return Some(if is_json_key(stack) {
            "hljs-attr"
        } else {
            "hljs-string"
        });
    }
    if any("constant.numeric") || any("meta.number") {
        return Some("hljs-number");
    }
    if any("constant.language") {
        return Some("hljs-keyword");
    }
    if names
        .last()
        .is_some_and(|innermost| scope_matches(innermost, "punctuation"))
    {
        return Some("hljs-punctuation");
    }
    None
}

/// Whether the stack sits on an object's key rather than on a value, in the JSON grammar's own scopes.
///
/// The **innermost** key or value scope decides: a key inside an object that is itself a value is still a key.
/// (Letting an enclosing value win classed every nested key as a string — measured against highlight.js.)
fn is_json_key(stack: &syntect::parsing::ScopeStack) -> bool {
    let mut in_dictionary = false;
    for scope in stack.scopes.iter().rev() {
        let name = scope.build_string();
        if name.starts_with("meta.mapping.value")
            || name.starts_with("meta.structure.dictionary.value")
        {
            return false;
        }
        if name.starts_with("meta.mapping.key") || name.starts_with("meta.structure.dictionary.key")
        {
            return true;
        }
        if name.starts_with("meta.structure.dictionary") {
            in_dictionary = true;
        }
    }
    in_dictionary
}

/// `name == prefix`, or `name` begins with `prefix` and continues at a scope boundary — so `keyword` covers
/// `keyword.control.flow`, and does not cover `keywordish`.
fn scope_matches(name: &str, prefix: &str) -> bool {
    match name.strip_prefix(prefix) {
        Some(rest) => rest.is_empty() || rest.starts_with('.') || rest.starts_with(' '),
        None => false,
    }
}

/// Append `text`, split at every newline so a piece never holds one.
fn push_text(text: &str, class: Option<&'static str>, pieces: &mut Vec<Piece>) {
    if text.is_empty() {
        return;
    }
    let mut start = 0usize;
    for (index, character) in text.char_indices() {
        if character != '\n' {
            continue;
        }
        if index > start {
            pieces.push(Piece {
                text: text[start..index].to_string(),
                class,
                newline: false,
            });
        }
        pieces.push(Piece {
            text: "\n".to_string(),
            class: None,
            newline: true,
        });
        start = index + 1;
    }
    if start < text.len() {
        pieces.push(Piece {
            text: text[start..].to_string(),
            class,
            newline: false,
        });
    }
}

/// Join runs that carry the same class, so a token split by the grammar still reaches the page as one span.
///
/// Punctuation is never joined: highlight.js writes each `}` or `,` as its own token, so `}}` is two spans.
fn merge_adjacent(pieces: Vec<Piece>) -> Vec<Piece> {
    let mut merged: Vec<Piece> = Vec::with_capacity(pieces.len());
    for piece in pieces {
        match merged.last_mut() {
            Some(last)
                if !last.newline
                    && !piece.newline
                    && last.class == piece.class
                    && piece.class != Some("hljs-punctuation") =>
            {
                last.text.push_str(&piece.text);
            }
            _ => merged.push(piece),
        }
    }
    merged
}

/// Highlight a code block: the HTML for the **inside** of a `<pre><code>`.
///
/// Flat `<span class="hljs-…">` runs around escaped text (the five characters of `markdown::escape_html`), which the
/// allow-list in [`crate::sanitize`] accepts because `span` and `class` are on it. A `language` that is absent, not
/// registered, or whose grammar fails is rendered as plain text: escaped, with no span.
pub fn highlight_code(code: &str, language: Option<&str>) -> String {
    let mut html = String::with_capacity(code.len() + 32);
    for piece in highlight_pieces(code, language) {
        if piece.newline {
            html.push('\n');
            continue;
        }
        match piece.class {
            Some(class) => {
                html.push_str("<span class=\"");
                html.push_str(class);
                html.push_str("\">");
                html.push_str(&crate::markdown::escape_html(&piece.text));
                html.push_str("</span>");
            }
            None => html.push_str(&crate::markdown::escape_html(&piece.text)),
        }
    }
    html
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

    #[test]
    fn every_registered_grammar_resolves_to_a_syntax() {
        // A name this build claims to colour but the syntax set does not carry would silently render as plaintext.
        for grammar in GRAMMARS {
            assert!(
                syntax_for(grammar, syntax_set()).is_some(),
                "{grammar} has no syntax in the set"
            );
        }
    }

    /// The text of the pieces, joined — which must equal what went in, character for character.
    fn text_of(code: &str, language: Option<&str>) -> String {
        highlight_pieces(code, language)
            .into_iter()
            .map(|piece| piece.text)
            .collect()
    }

    #[test]
    fn a_registered_language_is_coloured() {
        let json = highlight_code("{\"a\": 1}", Some("json"));
        assert!(
            json.contains("hljs-"),
            "the highlighter emits its own spans"
        );
        assert!(
            json.contains("hljs-attr"),
            "a JSON object's key is classified as an attribute: {json}"
        );
        assert!(
            json.contains("hljs-number"),
            "and its number as a number: {json}"
        );
    }

    #[test]
    fn the_spellings_a_fence_actually_uses_resolve_to_the_same_grammar() {
        assert_eq!(
            highlight_code("const x = 1", Some("ts")),
            highlight_code("const x = 1", Some("typescript"))
        );
        assert_eq!(
            highlight_code("x: 1", Some("yml")),
            highlight_code("x: 1", Some("yaml"))
        );
        assert_eq!(
            highlight_code("// hi", Some("JS")),
            highlight_code("// hi", Some("javascript")),
            "the alias and the case are both resolved"
        );
    }

    #[test]
    fn nothing_is_lost_for_any_grammar() {
        // The invariant the whole page depends on: strip the spans and the source is exactly what it was.
        let samples = [
            ("print(\"hi\")  # note\n", "python"),
            ("const x = `a${1}`\n", "javascript"),
            ("{\"a\": [1, true, null]}\n", "json"),
            ("key: value\n- item\n", "yaml"),
            ("echo \"$HOME\" | grep -q .\n", "bash"),
            ("fn main() { println!(\"x\"); }\n", "rust"),
            ("<div class=\"x\">a &amp; b</div>\n", "xml"),
            (".a { color: red }\n", "css"),
            ("| a | b |\n|---|---|\n| 1 | 2 |\n", "markdown"),
            ("\ttabbed 文字\n\nblank above\n", "plaintext"),
        ];
        for (source, language) in samples {
            assert_eq!(
                text_of(source, Some(language)),
                source,
                "{language} lost or changed text"
            );
        }
        assert_eq!(text_of("no language\n", None), "no language\n");
    }

    #[test]
    fn a_language_that_is_not_registered_still_renders_its_code() {
        let html = highlight_code("+++[>+<]>", Some("brainfuck"));
        assert!(html.contains("+++"), "the code is there");
        assert!(!html.contains("hljs-keyword"), "with no grammar applied");
    }

    #[test]
    fn code_with_no_language_at_all_is_escaped_rather_than_interpreted() {
        let html = highlight_code("<script>alert(1)</script>", Some(""));
        assert!(!html.contains("<script>"), "the tags are entities");
        assert!(html.contains("&lt;script&gt;"), "and the text is readable");
        assert!(
            highlight_code("it's", Some("")).contains("it&#39;s"),
            "a quote is escaped as its entity"
        );
    }

    #[test]
    fn the_three_strings_the_verifiers_judge_are_produced() {
        // `_verifiers_/88-file-preview` and `80-web-ui` match these; they are the reason the class vocabulary is
        // highlight.js's rather than the grammar's own.
        let python = highlight_code("def f(x):\n    return x\n", Some("python"));
        assert!(
            python.contains("hljs-keyword\">def<"),
            "python's `def` is a keyword: {python}"
        );
        let javascript = highlight_code("// a tiny script\nlet a = 1\n", Some("javascript"));
        assert!(
            javascript.contains("hljs-comment\">// a tiny script<"),
            "a line comment is one comment span: {javascript}"
        );
        let package = highlight_code("{\n  \"name\": \"x\",\n  \"version\": 2\n}\n", Some("json"));
        let classes: std::collections::BTreeSet<&str> = package
            .split("class=\"")
            .skip(1)
            .filter_map(|rest| rest.split('"').next())
            .collect();
        assert!(
            classes.len() > 1,
            "a source file holds more than one kind of token: {classes:?}"
        );
    }

    #[test]
    fn a_block_comment_spanning_lines_keeps_its_class_on_both() {
        let pieces = highlight_pieces("/* one\ntwo */\nx\n", Some("c"));
        let commented: Vec<&str> = pieces
            .iter()
            .filter(|piece| piece.class == Some("hljs-comment") && !piece.newline)
            .map(|piece| piece.text.as_str())
            .collect();
        assert!(
            commented.contains(&"/* one") && commented.contains(&"two */"),
            "both lines are comments: {commented:?}"
        );
    }

    #[test]
    fn json_is_classed_as_highlight_js_classes_it() {
        // The input developer-eleven's real-server probe compared against the TypeScript build: three classes
        // differed — punctuation was bare, true/null were literals, and a nested key was a string.
        let html = highlight_code(
            r#"{"command":"ls","nested":{"a":[1,2.5,true,null]}}"#,
            Some("json"),
        );
        let has = |fragment: &str| html.contains(fragment);
        assert!(
            has(r#"<span class="hljs-attr">&quot;command&quot;</span>"#),
            "a top-level key: {html}"
        );
        assert!(
            has(r#"<span class="hljs-attr">&quot;a&quot;</span>"#),
            "a nested key is a key too: {html}"
        );
        assert!(
            has(r#"<span class="hljs-string">&quot;ls&quot;</span>"#),
            "a value is a string: {html}"
        );
        assert!(has(r#"<span class="hljs-keyword">true</span>"#), "{html}");
        assert!(has(r#"<span class="hljs-keyword">null</span>"#), "{html}");
        assert!(
            has(r#"<span class="hljs-number">2.5</span>"#),
            "a decimal point stays inside its number: {html}"
        );
        assert!(has(r#"<span class="hljs-punctuation">{</span>"#), "{html}");
        assert!(
            has(
                r#"<span class="hljs-punctuation">}</span><span class="hljs-punctuation">}</span>"#
            ),
            "each brace is its own token, as highlight.js writes it: {html}"
        );
        assert_eq!(
            text_of(
                r#"{"command":"ls","nested":{"a":[1,2.5,true,null]}}"#,
                Some("json")
            ),
            r#"{"command":"ls","nested":{"a":[1,2.5,true,null]}}"#,
            "and nothing is lost"
        );
    }

    #[test]
    fn a_newline_piece_is_exactly_one_newline_and_never_classified() {
        for piece in highlight_pieces("a\nb\n", Some("python")) {
            if piece.newline {
                assert_eq!(piece.text, "\n");
                assert_eq!(piece.class, None);
            } else {
                assert!(!piece.text.contains('\n'));
            }
        }
    }
}
