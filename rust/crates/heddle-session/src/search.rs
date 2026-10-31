//! **Content search**: which sessions said a phrase, ranked and quoted the way DSH's sidebar search answers.
//!
//! The port of `src/session/search.ts`, rule for rule; that file states the DSH sources at length. In short, DSH's
//! `session.search({ query })` (dsh-api-session-controller lib/index.js:2010-2123) answers at most 20
//! `{ sessionId, snippet }` rows with `hasMore`, from a SQLite FTS5 index (dsh-session-query-sqlite):
//!
//! - **Corpus**: every listed session with a `cwd`; of its log, the current surface's `user/message` and
//!   `assistant/message` documents — here a `message` event whose role is `user` or `assistant`, or a streamed
//!   answer's chunk run — with text parts and tool calls' name and arguments, each trimmed, joined by newlines.
//! - **Matching**: FTS5 `unicode61` tokens (the tables in [`crate::unicode61`], measured from SQLite) and the query as
//!   one phrase: case-folded, a single diacritic stripped, punctuation separating; never a substring.
//! - **Ranking** (lib/index.js:818-834): per session the document with the most phrase marks, then the fewest code
//!   points, then the latest time, then the highest seq; sessions by those keys, then by id.
//! - **Snippet** (`makeSnippet`, lib/index.js:325-367): whitespace collapsed, 240 code points, the window opening a
//!   third of that before the first match.
//!
//! It is a scan, not an index: a log is read again only when its size or modification time changed, and what is kept
//! between queries is the documents' text and tokens. The store's fold is not used, so a search neither loads every
//! session into it nor takes any writer lock.

use std::borrow::Borrow;
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::SystemTime;

use serde::Serialize;
use serde_json::Value;

use crate::event::SessionEvent;
use crate::store::SessionStore;
use crate::surface::{fold_surface, index_by_seq};
use crate::transcript::decode_transcript;
use crate::unicode61::{DIACRITICS, FOLDS, SEPARATORS};

/// At most this many sessions in one answer (`SESSION_SEARCH_RESULT_LIMIT`, dsh-api-session-controller
/// lib/client.js:357).
pub const SESSION_SEARCH_RESULT_LIMIT: usize = 20;

/// A snippet's bound in code points (`SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS`, lib/client.js:359).
pub const SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS: usize = 240;

/// A query's bound in UTF-16 code units (`SESSION_SEARCH_QUERY_MAX_CHARS`, lib/index.js:1852).
pub const SESSION_SEARCH_QUERY_MAX_CHARS: usize = 500;

/// One session that holds the phrase, and where.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSearchHit {
    pub session_id: String,
    pub snippet: String,
}

/// DSH's `session.search` answer: `{"items":[{"sessionId","snippet"}],"hasMore"}`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSearchPage {
    pub items: Vec<SessionSearchHit>,
    pub has_more: bool,
}

/// A query DSH refuses as `gateway/bad-request`, with DSH's sentence.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct SessionSearchQueryError {
    pub message: String,
}

impl SessionSearchQueryError {
    fn new(message: impl Into<String>) -> Self {
        SessionSearchQueryError {
            message: message.into(),
        }
    }

    /// DSH's error code for every refusal here.
    pub fn code(&self) -> &'static str {
        "gateway/bad-request"
    }
}

/// Whitespace as JavaScript's `trim` and `/\s/` know it: Unicode `White_Space` without U+0085, plus U+FEFF.
pub fn is_js_space(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}

fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_space)
}

/// The controller's own validation, word for word (`normalizeSearchQuery`, lib/index.js:2117-2123).
pub fn normalize_search_query(query: &str) -> Result<String, SessionSearchQueryError> {
    let normalized = js_trim(query);
    if normalized.is_empty() {
        return Err(SessionSearchQueryError::new(
            "session search query must not be empty",
        ));
    }
    if normalized.encode_utf16().count() > SESSION_SEARCH_QUERY_MAX_CHARS {
        return Err(SessionSearchQueryError::new(format!(
            "session search query must contain at most {SESSION_SEARCH_QUERY_MAX_CHARS} UTF-16 code units"
        )));
    }
    if normalized.contains('\0') {
        return Err(SessionSearchQueryError::new(
            "session search query must not contain NUL",
        ));
    }
    Ok(normalized.to_string())
}

// -----------------------------------------------------------------------------------------------------------------
// The tokenizer: FTS5 unicode61, from the measured tables.

fn is_separator(cp: u32) -> bool {
    let index = SEPARATORS.partition_point(|&(start, _)| start <= cp);
    index > 0 && cp <= SEPARATORS[index - 1].1
}

fn is_diacritic(cp: u32) -> bool {
    DIACRITICS.binary_search(&cp).is_ok()
}

/// What a token character folds to: lower case, and a letter with one diacritic loses it.
pub fn fold_code_point(cp: u32) -> u32 {
    let index = FOLDS.partition_point(|run| run.0 <= cp);
    if index == 0 {
        return cp;
    }
    let (start, count, step, kind, value) = FOLDS[index - 1];
    let offset = cp - start;
    if !offset.is_multiple_of(step) || offset / step >= count {
        return cp;
    }
    let folded = if kind == 0 {
        i64::from(cp) + value
    } else {
        value
    };
    u32::try_from(folded).unwrap_or(cp)
}

/// One token: its folded text and the code points it spans, `[start, end)`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Token {
    pub text: String,
    pub start: usize,
    pub end: usize,
}

/// Split text, given as code points, the way FTS5's `unicode61` does: a token starts at a token character and runs
/// until a separator; the 25 diacritics continue a token and are dropped from it, but cannot start one.
pub fn tokenize(chars: &[char]) -> Vec<Token> {
    let mut tokens = Vec::new();
    let mut index = 0;
    while index < chars.len() {
        let first = u32::from(chars[index]);
        if is_separator(first) || is_diacritic(first) {
            index += 1;
            continue;
        }
        let start = index;
        let mut text = String::new();
        while index < chars.len() {
            let cp = u32::from(chars[index]);
            if is_diacritic(cp) {
                index += 1;
                continue;
            }
            if is_separator(cp) {
                break;
            }
            text.push(char::from_u32(fold_code_point(cp)).unwrap_or(chars[index]));
            index += 1;
        }
        tokens.push(Token {
            text,
            start,
            end: index,
        });
    }
    tokens
}

// -----------------------------------------------------------------------------------------------------------------
// The corpus: a session's current user and assistant messages.

/// One searchable message: DSH's semantic document for a `user/message` or `assistant/message` on the current surface.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchDocument {
    pub seq: u64,
    /// `user/message` or `assistant/message`.
    pub kind: &'static str,
    /// The event's `at`; both builds write it as `toISOString` does, so ordering the text orders the time.
    pub time: String,
    pub text: String,
}

/// `joinText` (dsh-session-query lib/index.js:586-588): trimmed, empty parts dropped, joined with newlines.
fn join_text(parts: &[String]) -> String {
    parts
        .iter()
        .map(|part| js_trim(part))
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

/// NUL and the reserved highlight markers become U+FFFD before text is indexed (`sanitizeFtsText`, :295-297).
fn sanitize(text: &str) -> String {
    text.chars()
        .map(|c| {
            if matches!(c, '\0' | '\u{fdd0}' | '\u{fdd1}') {
                '\u{fffd}'
            } else {
                c
            }
        })
        .collect()
}

fn string_field<'a>(value: Option<&'a Value>, key: &str) -> &'a str {
    value
        .and_then(|value| value.get(key))
        .and_then(Value::as_str)
        .unwrap_or("")
}

/// A message's text parts and its tool calls' name and arguments, in order (`blockText`, lib/index.js:578-585).
fn message_parts(message: Option<&Value>) -> Vec<String> {
    let Some(content) = message
        .and_then(|message| message.get("content"))
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    let mut parts = Vec::new();
    for part in content {
        match string_field(Some(part), "type") {
            "text" => parts.push(string_field(Some(part), "text").to_string()),
            "tool-call" => {
                parts.push(string_field(Some(part), "name").to_string());
                parts.push(string_field(Some(part), "arguments").to_string());
            }
            _ => {}
        }
    }
    parts
}

/// A streamed answer's parts, settled as DSH settles a stream into one `assistant/message`: consecutive text deltas
/// are one block, a reasoning delta or a tool call ends it, a tool call adds its name and arguments. The time is the
/// run's last chunk — DSH writes its message when the stream settles.
fn chunk_run(by_seq: &HashMap<u64, &SessionEvent>, seq: u64) -> (Vec<String>, String) {
    let mut parts = Vec::new();
    let mut open: Option<String> = None;
    let mut time = String::new();
    let mut index = seq;
    while let Some(event) = by_seq.get(&index) {
        if event.kind != "assistant/chunk" {
            break;
        }
        time.clone_from(&event.at);
        let chunk = event.get("chunk");
        let kind = string_field(chunk, "type");
        if kind == "text-delta" {
            open.get_or_insert_with(String::new)
                .push_str(string_field(chunk, "text"));
            index += 1;
            continue;
        }
        if matches!(kind, "reasoning-delta" | "tool-call" | "done")
            && let Some(text) = open.take()
        {
            parts.push(text);
        }
        if kind == "tool-call" {
            parts.push(string_field(chunk, "name").to_string());
            parts.push(string_field(chunk, "arguments").to_string());
        }
        if kind == "done" {
            break;
        }
        index += 1;
    }
    if let Some(text) = open {
        parts.push(text);
    }
    (parts, time)
}

/// The searchable documents of one log, in surface order. A log whose surface cannot be folded contributes nothing.
pub fn search_documents<E: Borrow<SessionEvent>>(events: &[E]) -> Vec<SearchDocument> {
    let Ok(surface) = fold_surface(events) else {
        return Vec::new();
    };
    let by_seq = index_by_seq(events);
    let mut documents = Vec::new();
    for seq in surface.nodes {
        let Some(event) = by_seq.get(&seq) else {
            continue;
        };
        let (kind, parts, time) = if event.kind == "message" {
            let message = event.get("message");
            let kind = match string_field(message, "role") {
                "user" => "user/message",
                "assistant" => "assistant/message",
                _ => continue,
            };
            (kind, message_parts(message), event.at.clone())
        } else if event.kind == "assistant/chunk" {
            let (parts, time) = chunk_run(&by_seq, seq);
            ("assistant/message", parts, time)
        } else {
            continue;
        };
        let text = join_text(&parts);
        if text.is_empty() {
            continue;
        }
        documents.push(SearchDocument {
            seq,
            kind,
            time,
            text: sanitize(&text),
        });
    }
    documents
}

/// A document split once, so a query only compares tokens.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedDocument {
    pub document: SearchDocument,
    pub chars: Vec<char>,
    pub tokens: Vec<Token>,
}

pub fn prepare_document(document: SearchDocument) -> PreparedDocument {
    let chars: Vec<char> = document.text.chars().collect();
    let tokens = tokenize(&chars);
    PreparedDocument {
        document,
        chars,
        tokens,
    }
}

// -----------------------------------------------------------------------------------------------------------------
// Matching, the snippet and the order.

const OPEN: char = '\u{fdd0}';
const CLOSE: char = '\u{fdd1}';

/// The phrase's occurrences, marked as FTS5's `highlight()` marks them, with the number of marks; `None` when there
/// are none. Overlapping occurrences share one mark and adjacent ones do not (FTS5's `fts5CInstIterNext`).
pub fn mark_phrase(document: &PreparedDocument, phrase: &[String]) -> Option<(usize, String)> {
    let size = phrase.len();
    if size == 0 || document.tokens.len() < size {
        return None;
    }
    let mut groups: Vec<(usize, usize)> = Vec::new();
    for index in 0..=document.tokens.len() - size {
        let equal = phrase
            .iter()
            .enumerate()
            .all(|(offset, word)| document.tokens[index + offset].text == *word);
        if !equal {
            continue;
        }
        match groups.last_mut() {
            Some(last) if index <= last.1 => last.1 = index + size - 1,
            _ => groups.push((index, index + size - 1)),
        }
    }
    if groups.is_empty() {
        return None;
    }
    let mut marked = String::new();
    let mut cursor = 0;
    for &(first, last) in &groups {
        let start = document.tokens[first].start;
        let end = document.tokens[last].end;
        marked.extend(&document.chars[cursor..start]);
        marked.push(OPEN);
        marked.extend(&document.chars[start..end]);
        marked.push(CLOSE);
        cursor = end;
    }
    marked.extend(&document.chars[cursor..]);
    Some((groups.len(), marked))
}

/// `normalizeMarkedText` (lib/index.js:349-367): whitespace collapsed, markers removed, where the first match starts.
fn normalize_marked_text(marked: &str) -> (Vec<char>, usize) {
    let mut characters: Vec<char> = Vec::new();
    let mut match_start: Option<usize> = None;
    for character in marked.chars() {
        if character == OPEN {
            if match_start.is_none() {
                match_start = Some(characters.len());
            }
            continue;
        }
        if character == CLOSE {
            continue;
        }
        if is_js_space(character) {
            if characters.last().is_some_and(|last| *last != ' ') {
                characters.push(' ');
            }
        } else {
            characters.push(character);
        }
    }
    if characters.last() == Some(&' ') {
        characters.pop();
    }
    (characters, match_start.unwrap_or(0))
}

/// `makeSnippet` (lib/index.js:325-348), line for line; lengths are code points (`…` is one).
pub fn make_snippet(marked: &str, max_chars: usize) -> String {
    let (characters, match_start) = normalize_marked_text(marked);
    if characters.len() <= max_chars {
        return characters.into_iter().collect();
    }
    if max_chars == 1 {
        return "…".to_string();
    }
    let length = characters.len();
    let max = max_chars as isize;
    let matched_index = match_start.min(length - 1);
    let mut start = matched_index.saturating_sub(max_chars / 3);
    let prefix = if start > 0 { "…" } else { "" };
    let prefix_length = prefix.chars().count() as isize;
    let mut suffix = "…";
    let mut content_length = max - prefix_length - 1;
    if content_length < 1 {
        start = matched_index;
        suffix = "";
        content_length = max - prefix_length;
    } else if matched_index as isize >= start as isize + content_length {
        start = (matched_index as isize - content_length + 1) as usize;
    }
    let mut end = length.min(start + content_length as usize);
    if end == length {
        suffix = "";
        content_length = max - prefix_length;
        start = (end as isize - content_length).max(0) as usize;
    }
    end = length.min(start + content_length as usize);
    let body: String = characters[start..end].iter().collect();
    format!("{prefix}{body}{suffix}")
}

/// `truncateUnicodeCodePoints` (dsh-api-session-controller lib/index.js:1886-1895).
fn truncate_code_points(value: &str, maximum: usize) -> String {
    value.chars().take(maximum).collect()
}

/// The query's phrase: whitespace collapsed and sanitized as the provider does (`normalizeQuery`, :368-374), then
/// tokenized.
pub fn query_phrase(normalized_query: &str) -> Vec<String> {
    let mut collapsed = String::new();
    let mut in_space = false;
    for c in normalized_query.chars() {
        if is_js_space(c) {
            if !in_space {
                collapsed.push(' ');
            }
            in_space = true;
        } else {
            collapsed.push(c);
            in_space = false;
        }
    }
    let chars: Vec<char> = sanitize(&collapsed).chars().collect();
    tokenize(&chars)
        .into_iter()
        .map(|token| token.text)
        .collect()
}

struct Candidate<'a> {
    session_id: &'a str,
    match_count: usize,
    length: usize,
    time: &'a str,
    seq: u64,
    marked: String,
}

/// A session's best document: most marks, fewest code points, latest, highest seq (lib/index.js:824-827).
fn better_event(left: &Candidate<'_>, right: &Candidate<'_>) -> Ordering {
    right
        .match_count
        .cmp(&left.match_count)
        .then(left.length.cmp(&right.length))
        .then(right.time.cmp(left.time))
        .then(right.seq.cmp(&left.seq))
}

/// The sessions' order: the same keys, then the id (lib/index.js:832).
fn better_session(left: &Candidate<'_>, right: &Candidate<'_>) -> Ordering {
    right
        .match_count
        .cmp(&left.match_count)
        .then(left.length.cmp(&right.length))
        .then(right.time.cmp(left.time))
        .then(left.session_id.cmp(right.session_id))
}

/// Rank prepared sessions for an already-normalized query: at most 20, and whether a 21st matched.
pub fn rank_sessions<'a>(
    sessions: impl IntoIterator<Item = (&'a str, &'a [PreparedDocument])>,
    normalized_query: &str,
) -> SessionSearchPage {
    let phrase = query_phrase(normalized_query);
    if phrase.is_empty() {
        return SessionSearchPage::default();
    }
    let mut best: Vec<Candidate<'a>> = Vec::new();
    for (session_id, documents) in sessions {
        let mut top: Option<Candidate<'a>> = None;
        for prepared in documents {
            let Some((match_count, marked)) = mark_phrase(prepared, &phrase) else {
                continue;
            };
            let candidate = Candidate {
                session_id,
                match_count,
                length: prepared.chars.len(),
                time: &prepared.document.time,
                seq: prepared.document.seq,
                marked,
            };
            let replace = top
                .as_ref()
                .is_none_or(|current| better_event(&candidate, current) == Ordering::Less);
            if replace {
                top = Some(candidate);
            }
        }
        if let Some(top) = top {
            best.push(top);
        }
    }
    best.sort_by(better_session);
    SessionSearchPage {
        has_more: best.len() > SESSION_SEARCH_RESULT_LIMIT,
        items: best
            .iter()
            .take(SESSION_SEARCH_RESULT_LIMIT)
            .map(|hit| SessionSearchHit {
                session_id: hit.session_id.to_string(),
                snippet: truncate_code_points(
                    &make_snippet(&hit.marked, SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS),
                    SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS,
                ),
            })
            .collect(),
    }
}

// -----------------------------------------------------------------------------------------------------------------
// The index over a store.

/// One log's prepared documents and the file facts they were read at.
#[derive(Debug)]
struct CachedLog {
    key: (String, u64, Option<SystemTime>),
    documents: Arc<Vec<PreparedDocument>>,
}

/// A store's sessions, searchable: each log's prepared documents, kept until the log's size or time changes.
///
/// The log is read straight from its file and decoded on its own, so a search neither fills the store's fold with
/// every session nor repairs or locks anything: a torn tail is simply not read.
#[derive(Debug, Default)]
pub struct SessionSearchIndex {
    cache: Mutex<HashMap<String, CachedLog>>,
}

impl SessionSearchIndex {
    pub fn new() -> Self {
        SessionSearchIndex::default()
    }

    /// DSH's `session.search`: the query validated with DSH's sentences, then the ranked page.
    pub fn search(
        &self,
        store: &SessionStore,
        query: &str,
    ) -> Result<SessionSearchPage, SessionSearchQueryError> {
        let normalized = normalize_search_query(query)?;
        let mut corpus: Vec<(String, Arc<Vec<PreparedDocument>>)> = Vec::new();
        let mut cache = self.cache.lock().unwrap_or_else(PoisonError::into_inner);
        let mut seen: HashSet<String> = HashSet::new();
        for meta in store.list() {
            // DSH searches the visible sessions only: those whose header carries a `cwd` (lib/index.js:2018).
            if meta.cwd().is_empty() {
                continue;
            }
            let Some(handle) = store.open(meta.id()) else {
                continue;
            };
            let documents = documents_of(&mut cache, meta.id(), &handle.transcript);
            seen.insert(meta.id().to_string());
            corpus.push((meta.id().to_string(), documents));
        }
        cache.retain(|id, _| seen.contains(id));
        drop(cache);
        Ok(rank_sessions(
            corpus
                .iter()
                .map(|(id, documents)| (id.as_str(), documents.as_slice())),
            &normalized,
        ))
    }
}

fn documents_of(
    cache: &mut HashMap<String, CachedLog>,
    id: &str,
    transcript: &str,
) -> Arc<Vec<PreparedDocument>> {
    let Ok(metadata) = std::fs::metadata(transcript) else {
        return Arc::new(Vec::new());
    };
    let key = (
        transcript.to_string(),
        metadata.len(),
        metadata.modified().ok(),
    );
    if let Some(cached) = cache.get(id)
        && cached.key == key
    {
        return Arc::clone(&cached.documents);
    }
    let documents = Arc::new(read_documents(transcript));
    cache.insert(
        id.to_string(),
        CachedLog {
            key,
            documents: Arc::clone(&documents),
        },
    );
    documents
}

/// A log's prepared documents; a log that does not parse is not searchable, and costs the others nothing.
fn read_documents(transcript: &str) -> Vec<PreparedDocument> {
    let Ok(bytes) = std::fs::read(transcript) else {
        return Vec::new();
    };
    let decoded = decode_transcript(&bytes);
    let mut events = Vec::with_capacity(decoded.lines.len());
    for line in &decoded.lines {
        match SessionEvent::from_line(line) {
            Ok(event) => events.push(event),
            Err(_) => return Vec::new(),
        }
    }
    search_documents(&events)
        .into_iter()
        .map(prepare_document)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::message::{ContentPart, Message, Role};
    use crate::meta::CreateOptions;
    use serde_json::{Map, json};

    fn doc(text: &str, seq: u64, time: &str) -> PreparedDocument {
        prepare_document(SearchDocument {
            seq,
            kind: "assistant/message",
            time: time.to_string(),
            text: text.to_string(),
        })
    }

    fn plain(text: &str) -> PreparedDocument {
        doc(text, 1, "2026-10-30T00:00:00.000Z")
    }

    fn marked(text: &str, query: &str) -> Option<(usize, String)> {
        mark_phrase(&plain(text), &query_phrase(query))
    }

    #[test]
    fn the_query_is_refused_with_dshs_sentences() {
        let refusal = |query: &str| normalize_search_query(query).map_err(|error| error.message);
        assert_eq!(
            refusal("   "),
            Err("session search query must not be empty".to_string())
        );
        assert_eq!(
            refusal(&"q".repeat(501)),
            Err("session search query must contain at most 500 UTF-16 code units".to_string())
        );
        assert_eq!(
            refusal(&format!(" {} ", "q".repeat(500))),
            Ok("q".repeat(500))
        );
        assert_eq!(
            refusal("a\0b"),
            Err("session search query must not contain NUL".to_string())
        );
        assert_eq!(
            normalize_search_query("  quokka ledger \n").unwrap(),
            "quokka ledger"
        );
        // Measured in UTF-16 units, as JavaScript's `length` is: 250 emoji are 500 units, 251 are 502.
        assert!(normalize_search_query(&"😀".repeat(250)).is_ok());
        assert!(normalize_search_query(&"😀".repeat(251)).is_err());
    }

    #[test]
    fn a_phrase_is_matched_by_tokens_never_as_a_substring() {
        assert_eq!(query_phrase("Quokka   LEDGER"), vec!["quokka", "ledger"]);
        assert_eq!(
            marked("The Quökka-Ledger balanced.", "quokka ledger"),
            Some((1, "The \u{fdd0}Quökka-Ledger\u{fdd1} balanced.".to_string()))
        );
        assert_eq!(marked("quokkaledger", "quokka ledger"), None);
        assert_eq!(marked("quokka and the ledger", "quokka ledger"), None);
        assert_eq!(marked("ledger quokka", "quokka ledger"), None);
        assert_eq!(marked("anything", "!!! ---"), None);
        let words: Vec<String> = tokenize(
            &"e\u{301}te\u{301} \u{301}x İstanbul"
                .chars()
                .collect::<Vec<_>>(),
        )
        .into_iter()
        .map(|token| token.text)
        .collect();
        assert_eq!(words, vec!["ete", "x", "istanbul"]);
        assert_eq!(
            marked("quokka quokka, quokka", "quokka quokka").map(|(count, _)| count),
            Some(1),
            "overlapping occurrences share one mark"
        );
        assert_eq!(
            marked("quokka x quokka", "quokka").map(|(count, _)| count),
            Some(2)
        );
    }

    #[test]
    fn the_tables_fold_and_separate_as_sqlite_does() {
        // Values measured from SQLite through `test/session-search.test.ts`, which holds both tables to it.
        assert_eq!(fold_code_point(u32::from('A')), u32::from('a'));
        assert_eq!(fold_code_point(u32::from('Ö')), u32::from('o'));
        assert_eq!(fold_code_point(u32::from('ǖ')), u32::from('ǖ'));
        assert_eq!(fold_code_point(0x10400), 0x10428);
        assert!(is_separator(u32::from('_')));
        assert!(is_separator(u32::from('-')));
        assert!(!is_separator(u32::from('日')));
        assert!(is_diacritic(0x301));
        assert!(!is_diacritic(0x338) && is_separator(0x338));
    }

    #[test]
    fn the_snippet_is_dshs() {
        let short = marked("  The   quokka\n\nledger  ", "quokka").unwrap().1;
        assert_eq!(make_snippet(&short, 240), "The quokka ledger");

        let text = format!("{} quokka ledger {}", "x".repeat(150), "y".repeat(150));
        let middle = marked(&text, "quokka ledger").unwrap().1;
        let cut = make_snippet(&middle, 240);
        assert_eq!(
            cut,
            format!("…{} quokka ledger {}…", "x".repeat(79), "y".repeat(144))
        );
        assert_eq!(cut.chars().count(), 240);

        let late = marked(&format!("{} quokka", "y".repeat(300)), "quokka")
            .unwrap()
            .1;
        assert_eq!(
            make_snippet(&late, 240),
            format!("…{} quokka", "y".repeat(232))
        );

        let wide = marked(&format!("{}quokka", "😀 ".repeat(130)), "quokka")
            .unwrap()
            .1;
        assert_eq!(make_snippet(&wide, 240).chars().count(), 240);
    }

    #[test]
    fn a_session_is_ranked_by_its_best_message() {
        let t = |second: u32| format!("2026-10-30T00:00:{second:02}.000Z");
        let sessions = [
            ("session-c", vec![doc("one quokka here", 1, &t(1))]),
            (
                "session-a",
                vec![doc(
                    "two quokka quokka marks, a longer message than the rest",
                    1,
                    &t(0),
                )],
            ),
            ("session-b", vec![doc("one quokka here", 1, &t(5))]),
            ("session-d", vec![doc("one quokka here", 1, &t(1))]),
            (
                "session-e",
                vec![
                    doc("one quokka, but longer", 1, &t(0)),
                    doc("no match at all", 2, &t(0)),
                ],
            ),
            ("session-f", vec![doc("nothing", 1, &t(0))]),
        ];
        let page = rank_sessions(
            sessions
                .iter()
                .map(|(id, documents)| (*id, documents.as_slice())),
            "quokka",
        );
        let order: Vec<&str> = page
            .items
            .iter()
            .map(|item| item.session_id.as_str())
            .collect();
        assert_eq!(
            order,
            [
                "session-a",
                "session-b",
                "session-c",
                "session-d",
                "session-e"
            ]
        );
        assert!(!page.has_more);

        let many: Vec<(String, Vec<PreparedDocument>)> = (0..=SESSION_SEARCH_RESULT_LIMIT)
            .map(|index| (format!("session-{index:02}"), vec![plain("a quokka")]))
            .collect();
        let page = rank_sessions(
            many.iter()
                .map(|(id, documents)| (id.as_str(), documents.as_slice())),
            "quokka",
        );
        assert_eq!(page.items.len(), 20);
        assert!(page.has_more);
        assert_eq!(
            serde_json::to_value(&page.items[0]).unwrap(),
            json!({"sessionId": "session-00", "snippet": "a quokka"})
        );
    }

    fn event(seq: u64, kind: &str, fields: serde_json::Value) -> SessionEvent {
        let fields = match fields {
            serde_json::Value::Object(object) => object,
            _ => Map::new(),
        };
        SessionEvent {
            seq,
            at: format!("2026-10-30T00:00:{seq:02}.000Z"),
            kind: kind.to_string(),
            fields,
        }
    }

    #[test]
    fn the_corpus_is_the_current_user_and_assistant_messages() {
        let text = |role: &str, text: &str| json!({"message": {"role": role, "content": [{"type": "text", "text": text}]}});
        let chunk = |value: serde_json::Value| json!({ "chunk": value });
        let mut replacement = text("user", "summary");
        replacement["surfaceOp"] = json!({"op": "replace", "startSeq": 9, "endSeq": 10});
        let events = vec![
            event(0, "session/created", json!({"cwd": "/w"})),
            event(1, "context/note", text("user", "quokka note")),
            event(
                2,
                "message",
                text("user", "  the user asked about a quokka  "),
            ),
            event(
                3,
                "assistant/chunk",
                chunk(json!({"type": "reasoning-delta", "text": "thinking of quokka"})),
            ),
            event(
                4,
                "assistant/chunk",
                chunk(json!({"type": "text-delta", "text": "Quo"})),
            ),
            event(
                5,
                "assistant/chunk",
                chunk(json!({"type": "text-delta", "text": "kka ledger"})),
            ),
            event(
                6,
                "assistant/chunk",
                chunk(
                    json!({"type": "tool-call", "id": "c1", "name": "read_file", "arguments": "{\"path\":\"q.md\"}"}),
                ),
            ),
            event(
                7,
                "assistant/chunk",
                chunk(json!({"type": "done", "finishReason": "tool-calls"})),
            ),
            event(
                8,
                "message",
                json!({"message": {"role": "tool", "toolCallId": "c1", "content": [{"type": "text", "text": "quokka in a tool result"}]}}),
            ),
            event(9, "message", text("user", "an old quokka question")),
            event(10, "message", text("assistant", "an old quokka answer")),
            event(11, "message", replacement),
        ];
        let documents = search_documents(&events);
        let seen: Vec<(u64, &str, &str)> = documents
            .iter()
            .map(|document| (document.seq, document.kind, document.text.as_str()))
            .collect();
        assert_eq!(
            seen,
            vec![
                (2, "user/message", "the user asked about a quokka"),
                (
                    3,
                    "assistant/message",
                    "Quokka ledger\nread_file\n{\"path\":\"q.md\"}"
                ),
                (11, "user/message", "summary"),
            ]
        );
        assert_eq!(documents[1].time, "2026-10-30T00:00:07.000Z");
    }

    fn message(role: Role, text: &str) -> Message {
        Message {
            role,
            tool_call_id: None,
            content: vec![ContentPart::Text {
                text: text.to_string(),
            }],
            source: None,
        }
    }

    #[test]
    fn the_index_searches_a_real_store_and_reads_a_written_log_again() {
        let dir = tempfile::tempdir().expect("a temp directory");
        let root = dir.path().join("store");
        let store = SessionStore::new(root.to_str().unwrap(), &heddle_config::Env::default());
        let open = |name: &str| {
            store
                .create(CreateOptions {
                    cwd: Some(dir.path().join(name).to_string_lossy().into_owned()),
                    ..CreateOptions::default()
                })
                .unwrap()
        };
        let first = open("work-one");
        store
            .message(&first, message(Role::User, "what lives in the hills?"))
            .unwrap();
        store
            .message(
                &first,
                message(
                    Role::Assistant,
                    "The marsupial ledger lists a quokka colony.",
                ),
            )
            .unwrap();
        let second = open("work-two");
        store
            .message(&second, message(Role::User, "and the ledger?"))
            .unwrap();

        let index = SessionSearchIndex::new();
        assert_eq!(
            index.search(&store, "Quokka Colony").unwrap(),
            SessionSearchPage {
                items: vec![SessionSearchHit {
                    session_id: first.id.clone(),
                    snippet: "The marsupial ledger lists a quokka colony.".to_string(),
                }],
                has_more: false,
            }
        );
        let ids = |page: SessionSearchPage| -> Vec<String> {
            page.items.into_iter().map(|item| item.session_id).collect()
        };
        assert_eq!(
            ids(index.search(&store, "ledger").unwrap()),
            vec![second.id.clone(), first.id.clone()]
        );
        store
            .message(
                &second,
                message(Role::Assistant, "a quokka colony, twice: quokka colony"),
            )
            .unwrap();
        assert_eq!(
            ids(index.search(&store, "quokka colony").unwrap()),
            vec![second.id.clone(), first.id.clone()]
        );
        assert_eq!(
            index.search(&store, " ").unwrap_err().code(),
            "gateway/bad-request"
        );
    }
}
