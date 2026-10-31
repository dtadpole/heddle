//! A session's **automatic title**, the way DSH makes one — the port of `src/session/title.ts`
//! (R-developer-eight-12, parity row C6).
//!
//! DSH mounts `dsh-session-title` with the first-prompt model provider (`dsh-session-title-first-prompt-llm`) in its
//! base profile (`dsh-base/cordis.patch.yml:60-77`). The fallback name comes from the first message at once (here
//! [`title_from`](crate::title_from), written by `user_content`); the provider then asks the session's own route for a
//! title without delaying the turn, and the answer replaces the fallback:
//!
//! - **When**: on the session's first eligible human message (a `user` message with no `source` and visible text) in a
//!   session with no title and no parent (`onUserMessage`, dsh-session-title lib/index.js:380-404); the call starts
//!   once the turn's own `model/request` is on record, on that request's endpoint and model (`onRequestHeader`,
//!   :406-416). DSH titles nothing when a session is created, so every path that opens a session for a turn — a
//!   blank row, the turn route, the CLI's `--turn` — opens it untitled (#68: the turn route and the CLI used to name
//!   it with the prompt cut to 60 characters, which read as a person's name, so no call ever started). A title given
//!   at creation (`session new --title`, a definition) is a person's.
//! - **What it sends**: the first-prompt system prompt and the one message framed as JSON (first-prompt
//!   lib/index.js:44-56), within [`MAX_INPUT_BYTES`], [`MAX_OUTPUT_TOKENS`] and [`TIMEOUT`], tagged
//!   [`SESSION_TITLE_PURPOSE`] (`dsh-session-title-llm` lib/index.js:160-220).
//! - **How it is cleaned**: [`title_from_answer`] — the first non-empty line without wrapping emphasis, controls
//!   removed, whitespace collapsed, cut to [`MAX_TITLE_BYTES`] on a code point; only a `stop` finish with text counts.
//! - **What stops it**: a person's rename ([`SessionTitles::supersede`], called by `SessionService::rename`), as DSH's
//!   `rename()` supersedes in-flight work (:295-311).
//! - **On failure**: the fallback stays; nothing is retried (:433-445).
//!
//! The title is written by the store's own `rename`, so both builds leave the same meta bytes. The coordinator lives on
//! the store, because a server builds more than one `SessionService` over one store and a rename through any of them
//! must supersede. It is idle until [`SessionService::attach_titles`](crate::SessionService::attach_titles) gives it a
//! model; the binary does that where it composes the turn runtime.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, PoisonError, Weak};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use crate::event::{SessionEvent, SessionHandle};
use crate::message::{ContentPart, Message, Role};
use crate::store::SessionStore;

/// `session-title.maxTitleBytes` (`dsh-base/cordis.patch.yml`): the most UTF-8 bytes an accepted title holds.
pub const MAX_TITLE_BYTES: usize = 80;
/// `session-title-llm.targetWords`.
pub const TARGET_WORDS: u32 = 5;
/// `session-title-llm.targetCjkCharacters`.
pub const TARGET_CJK_CHARACTERS: u32 = 10;
/// `session-title-llm.maxInputBytes`: a longer framed input is not sent.
pub const MAX_INPUT_BYTES: usize = 4096;
/// `session-title-llm.maxOutputTokens`: a ceiling against runaway output, not a length target.
pub const MAX_OUTPUT_TOKENS: u64 = 4096;
/// `session-title-llm.timeoutMs`: an answer later than this is a failure.
pub const TIMEOUT: Duration = Duration::from_secs(60);
/// The purpose the title call carries; a scripted step answers it by this tag.
pub const SESSION_TITLE_PURPOSE: &str = "session-title";

/// JavaScript's `\s` (with the `u` flag), which every TypeScript rule here trims and collapses by.
fn is_js_space(character: char) -> bool {
    matches!(
        character,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// `/(?:\u001B\]|\u009D)(?:(?!\u0007|\u001B\\)[\s\S])*(?:\u0007|\u001B\\|$)/gu`: an OSC sequence runs to the first BEL
/// or ESC `\`, or to the end of the text.
fn strip_osc(chars: &[char]) -> Vec<char> {
    let mut out = Vec::with_capacity(chars.len());
    let mut index = 0;
    while index < chars.len() {
        let start = if chars[index] == '\u{1b}' && chars.get(index + 1) == Some(&']') {
            Some(index + 2)
        } else if chars[index] == '\u{9d}' {
            Some(index + 1)
        } else {
            None
        };
        let Some(mut at) = start else {
            out.push(chars[index]);
            index += 1;
            continue;
        };
        loop {
            match chars.get(at) {
                None => break,
                Some('\u{7}') => {
                    at += 1;
                    break;
                }
                Some('\u{1b}') if chars.get(at + 1) == Some(&'\\') => {
                    at += 2;
                    break;
                }
                Some(_) => at += 1,
            }
        }
        index = at;
    }
    out
}

/// `/(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/gu`: a CSI sequence with its parameters, intermediates and final byte.
fn strip_csi(chars: &[char]) -> Vec<char> {
    let mut out = Vec::with_capacity(chars.len());
    let mut index = 0;
    while index < chars.len() {
        let start = if chars[index] == '\u{1b}' && chars.get(index + 1) == Some(&'[') {
            Some(index + 2)
        } else if chars[index] == '\u{9b}' {
            Some(index + 1)
        } else {
            None
        };
        if let Some(mut at) = start {
            while chars.get(at).is_some_and(|c| ('0'..='?').contains(c)) {
                at += 1;
            }
            while chars.get(at).is_some_and(|c| (' '..='/').contains(c)) {
                at += 1;
            }
            if chars.get(at).is_some_and(|c| ('@'..='~').contains(c)) {
                index = at + 1;
                continue;
            }
        }
        out.push(chars[index]);
        index += 1;
    }
    out
}

/// `/\u001B[@-_]/gu`: the remaining two-character ESC sequences.
fn strip_esc(chars: &[char]) -> Vec<char> {
    let mut out = Vec::with_capacity(chars.len());
    let mut index = 0;
    while index < chars.len() {
        if chars[index] == '\u{1b}'
            && chars
                .get(index + 1)
                .is_some_and(|c| ('@'..='_').contains(c))
        {
            index += 2;
            continue;
        }
        out.push(chars[index]);
        index += 1;
    }
    out
}

/// Non-whitespace C0/C1 controls, and the directional and invisible controls that can make a title deceptive.
fn is_removed_control(character: char) -> bool {
    matches!(
        character,
        '\u{0}'..='\u{8}'
            | '\u{b}'
            | '\u{c}'
            | '\u{e}'..='\u{1f}'
            | '\u{7f}'..='\u{9f}'
            | '\u{200b}'
            | '\u{200e}'
            | '\u{200f}'
            | '\u{202a}'..='\u{202e}'
            | '\u{2060}'..='\u{2064}'
            | '\u{2066}'..='\u{206f}'
            | '\u{feff}'
    )
}

/// DSH's `cleanTitleText`: controls removed, then one trimmed line with whitespace runs collapsed to a space.
fn clean_title_text(input: &str) -> String {
    let chars: Vec<char> = input.chars().collect();
    let chars = strip_esc(&strip_csi(&strip_osc(&chars)));
    let mut out = String::with_capacity(chars.len());
    let mut in_space = false;
    for character in chars.into_iter().filter(|c| !is_removed_control(*c)) {
        if is_js_space(character) {
            in_space = true;
            continue;
        }
        if in_space && !out.is_empty() {
            out.push(' ');
        }
        in_space = false;
        out.push(character);
    }
    out
}

/// The longest leading code-point prefix of `input` within `max_bytes` UTF-8 bytes (DSH's `truncateTitleUtf8`).
pub fn truncate_title_utf8(input: &str, max_bytes: usize) -> String {
    if input.len() <= max_bytes {
        return input.to_string();
    }
    let mut end = 0;
    for (at, character) in input.char_indices() {
        if at + character.len_utf8() > max_bytes {
            break;
        }
        end = at + character.len_utf8();
    }
    input[..end].to_string()
}

/// DSH's `normalizeSessionTitle`: a terminal-safe one-line title within `max_bytes`, possibly empty.
pub fn normalize_session_title(input: &str, max_bytes: usize) -> String {
    truncate_title_utf8(&clean_title_text(input), max_bytes)
        .trim_end_matches(is_js_space)
        .to_string()
}

/// The first-prompt provider's system instruction (first-prompt lib/index.js:44-52), with DSH's targets.
pub fn session_title_system_prompt() -> String {
    [
        "Create a concise title for an AI coding-assistant session from the supplied human messages.".to_string(),
        "Return only the title on one line, **in plain text of natural language**, with no quotes, prefix, explanation, Markdown, XML, or terminal control codes. No code is allowed.".to_string(),
        "Use the language of the messages.".to_string(),
        format!(
            "Aim for about {TARGET_WORDS} words in non-CJK languages or {TARGET_CJK_CHARACTERS} CJK characters."
        ),
        "If the messages give little to name, still return a short best-effort title, such as Greeting, instead of explaining.".to_string(),
    ]
    .join("\n")
}

/// The one message framed as JSON, so its text cannot break the structure (`frameMessages`, first-prompt :54-56).
pub fn session_title_input(seq: u64, text: &str) -> String {
    format!(
        "Generate the session title from this JSON array of human messages:\n{}",
        json!([{ "seq": seq, "text": text }])
    )
}

/// DSH's `titleFromOutput`: the first non-empty line, without asterisk emphasis that wraps that whole line
/// (`/^(\*{1,3})(\S(?:.*\S)?)\1$/u`, the longest marker tried first, kept as written when the inner text holds it).
pub fn title_from_output(text: &str) -> String {
    let line = text
        .split('\n')
        .map(|piece| piece.strip_suffix('\r').unwrap_or(piece))
        .map(|piece| piece.trim_matches(is_js_space))
        .find(|piece| !piece.is_empty())
        .unwrap_or("");
    let leading = line.chars().take_while(|c| *c == '*').count().min(3);
    for width in (1..=leading).rev() {
        let marker = &line[..width];
        if line.len() < 2 * width + 1 || !line.ends_with(marker) {
            continue;
        }
        let inner = &line[width..line.len() - width];
        let first = inner.chars().next();
        let last = inner.chars().next_back();
        let terminators = inner
            .chars()
            .any(|c| matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}'));
        if first.is_none_or(is_js_space) || last.is_none_or(is_js_space) || terminators {
            continue;
        }
        return if inner.contains(marker) {
            line.to_string()
        } else {
            inner.to_string()
        };
    }
    line.to_string()
}

/// What a model call answered, as the model service's `generate` collects it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TitleAnswer {
    pub text: String,
    pub finish_reason: String,
    /// How many tool calls the answer carried; any is a refusal.
    pub tool_calls: usize,
}

/// The accepted title from one answer, or the reason it is none (DSH's `titleFromResponse` then `validateResult`).
pub fn title_from_answer(answer: &TitleAnswer) -> Result<String, String> {
    if answer.finish_reason != "stop" {
        return Err(if answer.finish_reason == "tool_calls" {
            "session-title-llm: title output must contain text only".to_string()
        } else {
            format!(
                "session-title-llm: title output ended with {}",
                answer.finish_reason
            )
        });
    }
    if answer.tool_calls > 0 {
        return Err("session-title-llm: title output must contain text only".to_string());
    }
    let title = normalize_session_title(&title_from_output(&answer.text), usize::MAX);
    if title.is_empty() {
        return Err("session-title-llm: title model produced no text".to_string());
    }
    let accepted = normalize_session_title(&title, MAX_TITLE_BYTES);
    if accepted.is_empty() {
        return Err("session-title provider returned an empty title".to_string());
    }
    Ok(accepted)
}

/// The text a recorded message offers a title (DSH's `sessionTitleUserMessageOf`): a `user` message with no `source`,
/// whose text parts joined by line breaks keep a visible character.
pub fn title_text_of(message: &Value) -> Option<String> {
    let message = message.as_object()?;
    if message.get("role").and_then(Value::as_str) != Some("user") || message.contains_key("source")
    {
        return None;
    }
    let parts = message.get("content")?.as_array()?;
    let text = parts
        .iter()
        .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n");
    (!normalize_session_title(&text, usize::MAX).is_empty()).then_some(text)
}

/// Where one title call's answer goes; called once, from whatever thread the model answered on.
pub type TitleDone = Box<dyn FnOnce(Result<TitleAnswer, String>) + Send + 'static>;

/// The model a title is asked of. `generate` must not block its caller: it starts the call and answers through `done`.
pub trait TitleModel: Send + Sync {
    fn generate(&self, request: heddle_llm::GenerateRequest, done: TitleDone);
}

/// One title call, as [`LlmTitles`] hands it to the runtime.
pub type TitleTask = Pin<Box<dyn Future<Output = ()> + Send + 'static>>;

/// How [`LlmTitles`] runs a call: the process's async runtime, handed in by whoever composes it.
pub type TitleSpawn = Arc<dyn Fn(TitleTask) + Send + Sync>;

/// The [`TitleModel`] over the deployment's model service: one `generate` call, run on the given runtime.
pub struct LlmTitles {
    models: Arc<heddle_llm::ModelService>,
    spawn: TitleSpawn,
}

impl LlmTitles {
    /// Ask `models`, running each call through `spawn`.
    pub fn new(models: Arc<heddle_llm::ModelService>, spawn: TitleSpawn) -> Self {
        Self { models, spawn }
    }
}

impl TitleModel for LlmTitles {
    fn generate(&self, request: heddle_llm::GenerateRequest, done: TitleDone) {
        let models = Arc::clone(&self.models);
        (self.spawn)(Box::pin(async move {
            let answer = models
                .generate(request)
                .await
                .map(|generated| TitleAnswer {
                    text: generated.text,
                    finish_reason: generated.finish_reason,
                    tool_calls: generated.tool_calls.len(),
                })
                .map_err(|error| error.to_string());
            done(answer);
        }));
    }
}

/// A session's meta record as the title rules read it: straight from its own file.
fn meta_of(handle: &SessionHandle) -> Option<Value> {
    let text = std::fs::read_to_string(&handle.meta).ok()?;
    serde_json::from_str::<Value>(&text)
        .ok()
        .filter(Value::is_object)
}

fn title_of(meta: Option<&Value>) -> String {
    meta.and_then(|meta| meta.get("title"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

struct Pending {
    revision: u64,
    seq: u64,
    text: String,
}

#[derive(Default)]
struct WorkState {
    revision: u64,
    pending: Option<Pending>,
}

#[derive(Default)]
struct Inner {
    model: Option<Arc<dyn TitleModel>>,
    store: Weak<SessionStore>,
    work: HashMap<String, WorkState>,
}

/// The scheduling half of DSH's `SessionTitleService`, for one store. See the module documentation.
#[derive(Default)]
pub struct SessionTitles {
    inner: Mutex<Inner>,
}

impl std::fmt::Debug for SessionTitles {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SessionTitles")
            .field("attached", &self.attached())
            .finish_non_exhaustive()
    }
}

impl SessionTitles {
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Give the coordinator its model and the store it renames in. A second attach replaces the first.
    pub fn attach(&self, store: Weak<SessionStore>, model: Arc<dyn TitleModel>) {
        let mut inner = self.lock();
        inner.store = store;
        inner.model = Some(model);
    }

    /// Whether a model is attached, which is whether a first prompt can earn a generated title.
    pub fn attached(&self) -> bool {
        self.lock().model.is_some()
    }

    /// Drop the model and abandon everything pending: an answer still running lands nowhere.
    pub fn detach(&self) {
        let mut inner = self.lock();
        inner.model = None;
        for state in inner.work.values_mut() {
            state.pending = None;
            state.revision += 1;
        }
    }

    /// A person named the session: nothing pending starts, and an answer in flight lands nowhere.
    pub fn supersede(&self, id: &str) {
        if let Some(state) = self.lock().work.get_mut(id) {
            state.pending = None;
            state.revision += 1;
        }
    }

    /// One appended event, handed over by the store after it is on disk. A first eligible message marks its session
    /// as waiting; the session's next `model/request` starts the call on that request's endpoint and model.
    pub(crate) fn observe(
        &self,
        store: &SessionStore,
        handle: &SessionHandle,
        event: &SessionEvent,
    ) {
        match event.kind.as_str() {
            "message" => self.on_message(store, handle, event),
            "model/request" => self.on_model_request(handle, event),
            _ => {}
        }
    }

    fn on_message(&self, store: &SessionStore, handle: &SessionHandle, event: &SessionEvent) {
        if self.lock().model.is_none() {
            return;
        }
        let Some(text) = event.get("message").and_then(title_text_of) else {
            return;
        };
        let Some(meta) = meta_of(handle) else {
            return;
        };
        if !title_of(Some(&meta)).trim().is_empty() || meta.get("parentSession").is_some() {
            return;
        }
        let Ok(events) = store.read(handle) else {
            return;
        };
        let eligible = events
            .iter()
            .filter(|one| one.kind == "message")
            .filter(|one| one.get("message").and_then(title_text_of).is_some())
            .count();
        if eligible != 1 {
            return;
        }
        let mut inner = self.lock();
        let state = inner.work.entry(handle.id.clone()).or_default();
        state.revision += 1;
        state.pending = Some(Pending {
            revision: state.revision,
            seq: event.seq,
            text,
        });
    }

    fn on_model_request(&self, handle: &SessionHandle, event: &SessionEvent) {
        let (pending, model, store) = {
            let mut inner = self.lock();
            let Some(model) = inner.model.clone() else {
                return;
            };
            let store = inner.store.clone();
            let Some(state) = inner.work.get_mut(&handle.id) else {
                return;
            };
            if state
                .pending
                .as_ref()
                .is_none_or(|pending| pending.seq >= event.seq)
            {
                return;
            }
            let Some(pending) = state.pending.take() else {
                return;
            };
            (pending, model, store)
        };
        let Some(endpoint) = event
            .get("endpoint")
            .and_then(Value::as_str)
            .filter(|endpoint| !endpoint.is_empty())
        else {
            return;
        };
        let model_id = event
            .get("model")
            .and_then(Value::as_str)
            .filter(|model| !model.is_empty())
            .map(str::to_string);
        let input = session_title_input(pending.seq, &pending.text);
        if input.len() > MAX_INPUT_BYTES {
            return;
        }
        // What stood when the call began — the fallback the first message wrote; an answer replaces only that.
        let expected = title_of(meta_of(handle).as_ref());
        let request = heddle_llm::GenerateRequest {
            endpoint: endpoint.to_string(),
            model: model_id,
            messages: vec![
                Message::new(
                    Role::System,
                    vec![ContentPart::Text {
                        text: session_title_system_prompt(),
                    }],
                ),
                Message::new(Role::User, vec![ContentPart::Text { text: input }]),
            ],
            max_output_tokens: Some(MAX_OUTPUT_TOKENS),
            session_id: Some(handle.id.clone()),
            purpose: Some(SESSION_TITLE_PURPOSE.to_string()),
            ..heddle_llm::GenerateRequest::default()
        };
        let id = handle.id.clone();
        let revision = pending.revision;
        let started = Instant::now();
        model.generate(
            request,
            Box::new(move |answer: Result<TitleAnswer, String>| {
                let Some(store) = store.upgrade() else {
                    return;
                };
                if started.elapsed() > TIMEOUT {
                    return;
                }
                let Ok(answer) = answer else {
                    return;
                };
                let Ok(title) = title_from_answer(&answer) else {
                    return;
                };
                store
                    .titles()
                    .accept(&store, &id, revision, &expected, &title);
            }),
        );
    }

    /// Write `title` if the call is still current and the session still carries the name it started from.
    fn accept(&self, store: &SessionStore, id: &str, revision: u64, expected: &str, title: &str) {
        let inner = self.lock();
        if inner.model.is_none() || inner.work.get(id).map(|state| state.revision) != Some(revision)
        {
            return;
        }
        // The guard is held across the write, so a rename cannot supersede between the check and the write.
        let _ = store.rename_if_title(id, expected, title);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::service::{SessionConfig, SessionService, StartOptions, title_from};
    use crate::store::ModelRequestRecord;
    use heddle_config::Env;

    const PROMPT: &str = "Please summarise the quarterly revenue figures for the northern region and compare them with last year, thanks.";

    fn stop(text: &str) -> TitleAnswer {
        TitleAnswer {
            text: text.to_string(),
            finish_reason: "stop".to_string(),
            tool_calls: 0,
        }
    }

    /// A model whose answer the test decides; it keeps every request, and answers at once unless told to hold.
    type Answer = Box<dyn FnMut() -> Result<TitleAnswer, String> + Send>;

    struct Fake {
        answer: Mutex<Answer>,
        requests: Mutex<Vec<heddle_llm::GenerateRequest>>,
        hold: bool,
        held: Mutex<Vec<TitleDone>>,
    }

    impl Fake {
        fn new(
            answer: impl FnMut() -> Result<TitleAnswer, String> + Send + 'static,
            hold: bool,
        ) -> Arc<Self> {
            Arc::new(Self {
                answer: Mutex::new(Box::new(answer)),
                requests: Mutex::new(Vec::new()),
                hold,
                held: Mutex::new(Vec::new()),
            })
        }

        fn answer(&self) -> Result<TitleAnswer, String> {
            let mut answer = self.answer.lock().unwrap();
            (*answer)()
        }

        fn release(&self) {
            let held: Vec<TitleDone> = std::mem::take(&mut *self.held.lock().unwrap());
            for done in held {
                let answer = self.answer();
                done(answer);
            }
        }
    }

    impl TitleModel for Fake {
        fn generate(&self, request: heddle_llm::GenerateRequest, done: TitleDone) {
            self.requests.lock().unwrap().push(request);
            if self.hold {
                self.held.lock().unwrap().push(done);
            } else {
                let answer = self.answer();
                done(answer);
            }
        }
    }

    fn service(dir: &tempfile::TempDir, fake: &Arc<Fake>) -> SessionService {
        let config = SessionConfig {
            root: Some(dir.path().join("sessions").to_string_lossy().into_owned()),
        };
        let service = SessionService::new(&config, &Env::default(), None);
        service.attach_titles(Arc::clone(fake) as Arc<dyn TitleModel>);
        service
    }

    fn start(service: &SessionService, dir: &tempfile::TempDir) -> SessionHandle {
        service
            .start(StartOptions {
                cwd: Some(dir.path().to_string_lossy().into_owned()),
                ..StartOptions::default()
            })
            .expect("a session")
    }

    fn request(service: &SessionService, handle: &SessionHandle, model: Option<&str>) {
        service
            .store()
            .model_request(
                handle,
                &ModelRequestRecord {
                    endpoint: "scripted".to_string(),
                    model: model.map(str::to_string),
                    reasoning_effort: None,
                    messages: 1,
                    tools: Vec::new(),
                    estimated_tokens: None,
                    threshold_tokens: None,
                    pruned: None,
                    compacted: None,
                    breakdown: None,
                    generation: None,
                },
            )
            .expect("the request record");
    }

    fn title(service: &SessionService, handle: &SessionHandle) -> Option<String> {
        service
            .meta(&handle.id)
            .and_then(|meta| meta.title().map(str::to_string))
    }

    #[test]
    fn a_title_is_cleaned_the_way_dsh_cleans_one() {
        assert_eq!(
            title_from_output("\n\n  Quarterly revenue review  \nbecause you asked"),
            "Quarterly revenue review"
        );
        assert_eq!(
            title_from_output("**Quarterly revenue**"),
            "Quarterly revenue"
        );
        assert_eq!(title_from_output("***x***"), "x");
        assert_eq!(title_from_output("**a*"), "**a*");
        assert_eq!(title_from_output("a **bold** word"), "a **bold** word");
        assert_eq!(
            normalize_session_title("\u{1b}[31mRed\u{1b}[0m \u{202e}title\u{7}  here ", 80),
            "Red title here"
        );
        assert_eq!(
            normalize_session_title("\u{1b}]0;window title\u{7}Shown", 80),
            "Shown"
        );
        assert_eq!(normalize_session_title(&"é".repeat(50), 80), "é".repeat(40));
        assert_eq!(
            normalize_session_title(&format!("{} b", "a".repeat(79)), 80),
            "a".repeat(79)
        );
        assert_eq!(
            title_from_answer(&stop("  **Quarterly revenue comparison**\nmore words")),
            Ok("Quarterly revenue comparison".to_string())
        );
        let cut = TitleAnswer {
            finish_reason: "length".to_string(),
            ..stop("x")
        };
        assert!(title_from_answer(&cut).is_err());
        let tool = TitleAnswer {
            finish_reason: "tool_calls".to_string(),
            tool_calls: 1,
            ..stop("")
        };
        assert!(title_from_answer(&tool).is_err());
        assert!(title_from_answer(&stop("  \n\u{200b} ")).is_err());
        assert_eq!(
            session_title_input(3, "a \"quoted\"\nline"),
            "Generate the session title from this JSON array of human messages:\n[{\"seq\":3,\"text\":\"a \\\"quoted\\\"\\nline\"}]"
        );
    }

    #[test]
    fn the_first_prompt_is_titled_on_the_turns_own_route_and_replaces_the_fallback() {
        let dir = tempfile::tempdir().unwrap();
        let fake = Fake::new(|| Ok(stop("Quarterly revenue comparison")), false);
        let service = service(&dir, &fake);
        let handle = start(&service, &dir);
        service.user(&handle, PROMPT, None).unwrap();
        assert_eq!(
            title(&service, &handle),
            Some(title_from(PROMPT)),
            "the fallback at once"
        );
        assert!(
            fake.requests.lock().unwrap().is_empty(),
            "no call before the turn's request"
        );

        request(&service, &handle, Some("the-model"));
        let requests = fake.requests.lock().unwrap().clone();
        assert_eq!(requests.len(), 1);
        let asked = &requests[0];
        let first_seq = service
            .store()
            .read(&handle)
            .unwrap()
            .iter()
            .find(|event| event.kind == "message")
            .unwrap()
            .seq;
        assert_eq!(asked.endpoint, "scripted");
        assert_eq!(asked.model.as_deref(), Some("the-model"));
        assert_eq!(asked.max_output_tokens, Some(4096));
        assert_eq!(asked.purpose.as_deref(), Some("session-title"));
        assert_eq!(asked.session_id.as_deref(), Some(handle.id.as_str()));
        assert_eq!(asked.messages.len(), 2);
        assert_eq!(asked.messages[0].role, Role::System);
        assert_eq!(
            asked.messages[0].content,
            vec![ContentPart::Text {
                text: session_title_system_prompt()
            }]
        );
        assert_eq!(
            asked.messages[1].content,
            vec![ContentPart::Text {
                text: session_title_input(first_seq, PROMPT)
            }]
        );
        assert!(
            session_title_system_prompt()
                .contains("Aim for about 5 words in non-CJK languages or 10 CJK characters.")
        );
        assert_eq!(
            title(&service, &handle).as_deref(),
            Some("Quarterly revenue comparison")
        );

        service
            .user(&handle, "a second prompt does not retitle", None)
            .unwrap();
        request(&service, &handle, None);
        assert_eq!(
            fake.requests.lock().unwrap().len(),
            1,
            "only the first prompt earns a call"
        );
    }

    #[test]
    fn a_rename_during_generation_pins_the_name_even_when_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let fake = Fake::new(|| Ok(stop("Quarterly revenue comparison")), true);
        let service = service(&dir, &fake);
        let handle = start(&service, &dir);
        service.user(&handle, PROMPT, None).unwrap();
        request(&service, &handle, None);
        let automatic = title(&service, &handle).unwrap();
        // Another service over the same store, as the web server builds one: its rename supersedes too.
        let other = SessionService::from_store(Arc::clone(service.store()));
        other.rename(&handle.id, &automatic).unwrap();
        fake.release();
        assert_eq!(title(&service, &handle), Some(automatic));

        let next = start(&service, &dir);
        service.user(&next, PROMPT, None).unwrap();
        service.rename(&next.id, "named by a person").unwrap();
        request(&service, &next, None);
        fake.release();
        assert_eq!(
            fake.requests.lock().unwrap().len(),
            1,
            "a rename before the request means no call"
        );
        assert_eq!(title(&service, &next).as_deref(), Some("named by a person"));
    }

    #[test]
    fn named_sessions_children_and_goal_rounds_get_no_generated_title() {
        let dir = tempfile::tempdir().unwrap();
        let fake = Fake::new(|| Ok(stop("Generated")), false);
        let service = service(&dir, &fake);
        let named = service
            .start(StartOptions {
                cwd: Some(dir.path().to_string_lossy().into_owned()),
                title: Some("given at creation".to_string()),
                ..StartOptions::default()
            })
            .unwrap();
        service.user(&named, PROMPT, None).unwrap();
        request(&service, &named, None);
        let goal = start(&service, &dir);
        service
            .user(
                &goal,
                "round 1",
                Some(json!({"kind": "goal", "goalId": "g", "revision": 1, "round": 1})),
            )
            .unwrap();
        request(&service, &goal, None);
        let child = service
            .store()
            .create(crate::meta::CreateOptions {
                cwd: Some(dir.path().to_string_lossy().into_owned()),
                parent_session: Some(named.id.clone()),
                ..crate::meta::CreateOptions::default()
            })
            .unwrap();
        service.user(&child, PROMPT, None).unwrap();
        request(&service, &child, None);
        assert!(fake.requests.lock().unwrap().is_empty());
        assert_eq!(
            title(&service, &named).as_deref(),
            Some("given at creation")
        );
        assert_eq!(title(&service, &child), Some(title_from(PROMPT)));
    }

    #[test]
    fn a_failed_cut_off_empty_or_oversized_title_leaves_the_fallback() {
        for case in 0..3 {
            let dir = tempfile::tempdir().unwrap();
            let fake = Fake::new(
                move || match case {
                    0 => Err("provider down".to_string()),
                    1 => Ok(TitleAnswer {
                        finish_reason: "length".to_string(),
                        ..stop("Half a tit")
                    }),
                    _ => Ok(stop("   ")),
                },
                false,
            );
            let service = service(&dir, &fake);
            let handle = start(&service, &dir);
            service.user(&handle, PROMPT, None).unwrap();
            request(&service, &handle, None);
            assert_eq!(fake.requests.lock().unwrap().len(), 1);
            assert_eq!(title(&service, &handle), Some(title_from(PROMPT)));
        }
        let dir = tempfile::tempdir().unwrap();
        let fake = Fake::new(|| Ok(stop("never asked")), false);
        let service = service(&dir, &fake);
        let handle = start(&service, &dir);
        let long = "word ".repeat(900);
        service.user(&handle, &long, None).unwrap();
        request(&service, &handle, None);
        assert!(
            fake.requests.lock().unwrap().is_empty(),
            "an input over maxInputBytes is not sent"
        );
        assert_eq!(title(&service, &handle), Some(title_from(&long)));
    }

    #[test]
    fn a_store_with_no_model_keeps_the_plain_name_and_a_detach_abandons_a_call() {
        let dir = tempfile::tempdir().unwrap();
        let config = SessionConfig {
            root: Some(dir.path().join("sessions").to_string_lossy().into_owned()),
        };
        let plain = SessionService::new(&config, &Env::default(), None);
        let handle = start(&plain, &dir);
        plain.user(&handle, PROMPT, None).unwrap();
        request(&plain, &handle, None);
        assert!(!plain.store().titles().attached());
        assert_eq!(title(&plain, &handle), Some(title_from(PROMPT)));

        let fake = Fake::new(|| Ok(stop("Too late")), true);
        plain.attach_titles(Arc::clone(&fake) as Arc<dyn TitleModel>);
        let next = start(&plain, &dir);
        plain.user(&next, PROMPT, None).unwrap();
        request(&plain, &next, None);
        plain.store().titles().detach();
        fake.release();
        assert_eq!(title(&plain, &next), Some(title_from(PROMPT)));
    }
}
