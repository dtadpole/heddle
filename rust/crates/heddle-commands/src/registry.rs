//! The host's slash commands: a registry, the line parser and the one way a command runs.
//!
//! Ported from `src/commands/registry.ts`, which is modelled on DSH's `dsh-commands` (`CommandRuntime`). Four
//! rules are DSH's and each is the place a command layer goes quietly wrong:
//!
//! - **A command line is parsed once, here.** `/name` must open the line and end at whitespace or the end
//!   ([`parse_command_line`], the TypeScript `/^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/`); the name is lower-case
//!   (`/^[a-z][a-z0-9_-]*$/`). Everything after the name — the separating whitespace included — is the
//!   command's raw input.
//! - **An unknown name is not a failure.** [`CommandRegistry::execute`] answers `None` and records nothing, so
//!   a caller sends the line on as an ordinary prompt. That is how DSH passes `/skillname` to the model, and
//!   why a typo like `/compcat` reaches the model rather than vanishing.
//! - **A run is two log-only events.** `command/run` is appended before the handler runs and `command/done`
//!   after it, both outside the model's surface: a command is something the person did to the session, not
//!   something said to the model. A handler that fails — an `Err`, or a panic — is a `command/done` of kind
//!   `error`, never a half-written run.
//! - **The handler's words are the result.** It answers [`CommandResult::Success`] or
//!   [`CommandResult::Error`]; the page shows them in the command's row rather than echoing them into the
//!   composer.

use std::collections::HashMap;
use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError, Weak};

use futures::FutureExt;
use futures::future::BoxFuture;
use heddle_session::{AppendOptions, NewEvent, SessionEvent, SessionHandle, SessionStore};
use serde::Serialize;
use serde_json::json;

use crate::text;

/// The name rule, as the TypeScript build prints its regular expression in a refusal.
pub const COMMAND_NAME_RULE: &str = "/^[a-z][a-z0-9_-]*$/";

/// The log event a run starts with, appended before the handler.
pub const COMMAND_RUN_EVENT: &str = "command/run";

/// The log event a run ends with.
pub const COMMAND_DONE_EVENT: &str = "command/done";

/// Whether `name` is a command name: lower-case, starting with a letter (`/^[a-z][a-z0-9_-]*$/`).
pub fn is_command_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    matches!(bytes.next(), Some(b'a'..=b'z'))
        && bytes.all(|byte| matches!(byte, b'a'..=b'z' | b'0'..=b'9' | b'_' | b'-'))
}

/// A parsed command line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedLine {
    /// The command's name, without the slash.
    pub name: String,
    /// Everything after the name, the separating whitespace included.
    pub raw_input: String,
}

/// A parsed command line, or `None` when the line is not one.
///
/// `/name` must open the line; the name is `[a-z][a-z0-9_-]*` and must be followed by the end of the line or by
/// a tab, a line feed, a carriage return or a space — anything else (`/compact:now`, `/usr/bin/env`) is not a
/// command line.
pub fn parse_command_line(line: &str) -> Option<ParsedLine> {
    let rest = line.strip_prefix('/')?;
    let bytes = rest.as_bytes();
    if !matches!(bytes.first(), Some(b'a'..=b'z')) {
        return None;
    }
    let end = bytes
        .iter()
        .position(|byte| !matches!(byte, b'a'..=b'z' | b'0'..=b'9' | b'_' | b'-'))
        .unwrap_or(bytes.len());
    // The look-ahead `(?=$|[\t\n\r ])`. `end` is a character boundary: every byte before it is ASCII.
    match bytes.get(end) {
        None | Some(b'\t' | b'\n' | b'\r' | b' ') => Some(ParsedLine {
            name: rest[..end].to_owned(),
            raw_input: rest[end..].to_owned(),
        }),
        Some(_) => None,
    }
}

/// The label a command shows when it declares none: `compact` reads `Compact`.
pub fn default_label(name: &str) -> String {
    let mut chars = name.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

/// What a command takes after its name, when it takes anything.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CommandInput {
    /// The argument shape a person reads in the menu, for example `<text>` or `[off|message]`.
    pub hint: String,
    /// Whether attachments may travel with the line.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachments: Option<bool>,
}

impl CommandInput {
    /// An input with this hint and no word on attachments.
    pub fn hint(hint: impl Into<String>) -> Self {
        Self {
            hint: hint.into(),
            attachments: None,
        }
    }
}

/// Where the page's menu lists a command when nothing has been typed: DSH's two sections.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CommandSection {
    /// `add`
    Add,
    /// `commands`
    Commands,
}

/// Something the page does after a successful run, because only the page can do it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum CommandAction {
    /// `{kind: "download", href}`: download what `href` serves.
    Download {
        /// The route to download.
        href: String,
    },
}

/// A handler's answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CommandResult {
    /// `{kind: "success", text?, sourceEventSeq?, action?}`.
    Success {
        /// What the command's row shows.
        text: Option<String>,
        /// The log event the run produced, when there is one to point at.
        source_event_seq: Option<u64>,
        /// What the page does next.
        action: Option<CommandAction>,
    },
    /// `{kind: "error", text}`.
    Error {
        /// Why.
        text: String,
    },
}

impl CommandResult {
    /// A success with nothing to say.
    pub fn success() -> Self {
        CommandResult::Success {
            text: None,
            source_event_seq: None,
            action: None,
        }
    }

    /// A success with words.
    pub fn success_text(text: impl Into<String>) -> Self {
        CommandResult::Success {
            text: Some(text.into()),
            source_event_seq: None,
            action: None,
        }
    }

    /// A refusal or a failure.
    pub fn error(text: impl Into<String>) -> Self {
        CommandResult::Error { text: text.into() }
    }

    /// The same success pointing at a log event; an error is unchanged.
    pub fn with_source_event_seq(self, seq: u64) -> Self {
        match self {
            CommandResult::Success { text, action, .. } => CommandResult::Success {
                text,
                source_event_seq: Some(seq),
                action,
            },
            error => error,
        }
    }

    /// The same success with an action for the page; an error is unchanged.
    pub fn with_action(self, next: CommandAction) -> Self {
        match self {
            CommandResult::Success {
                text,
                source_event_seq,
                ..
            } => CommandResult::Success {
                text,
                source_event_seq,
                action: Some(next),
            },
            error => error,
        }
    }

    /// `success` or `error`.
    pub fn kind(&self) -> &'static str {
        match self {
            CommandResult::Success { .. } => "success",
            CommandResult::Error { .. } => "error",
        }
    }

    /// The words, when there are any.
    pub fn text(&self) -> Option<&str> {
        match self {
            CommandResult::Success { text, .. } => text.as_deref(),
            CommandResult::Error { text } => Some(text),
        }
    }

    /// The log event a success points at.
    pub fn source_event_seq(&self) -> Option<u64> {
        match self {
            CommandResult::Success {
                source_event_seq, ..
            } => *source_event_seq,
            CommandResult::Error { .. } => None,
        }
    }

    /// The page's next step, on a success.
    pub fn action(&self) -> Option<&CommandAction> {
        match self {
            CommandResult::Success { action, .. } => action.as_ref(),
            CommandResult::Error { .. } => None,
        }
    }
}

/// What a handler is given for one run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandContext {
    /// The session the line was typed in.
    pub session: SessionHandle,
    /// This run's id, `cmd-<8 hex>-<n>`.
    pub command_id: String,
    /// Everything after the name, the separating whitespace included.
    pub raw_input: String,
    /// The raw input with surrounding whitespace removed: what most commands read.
    pub args: String,
}

/// What a handler answers: its result, or the failure a TypeScript handler would have thrown — which the run
/// records as a result of kind `error` with that sentence.
pub type HandlerOutcome = Result<CommandResult, String>;

/// A command's handler: one run, as a future that owns what it needs.
pub type CommandHandler =
    Arc<dyn Fn(CommandContext) -> BoxFuture<'static, HandlerOutcome> + Send + Sync>;

/// One command, as a plugin registers it.
#[derive(Clone)]
pub struct CommandDefinition {
    /// The name, `[a-z][a-z0-9_-]*`.
    pub name: String,
    /// What the menu says it does; not blank.
    pub description: String,
    /// The name a person reads in the menu; [`default_label`] when absent.
    pub label: Option<String>,
    /// The menu section; `add` when the command takes input, else `commands`, when absent.
    pub section: Option<CommandSection>,
    /// What it takes after its name.
    pub input: Option<CommandInput>,
    /// `false` keeps the raw input out of the log (DSH's `/feedback`). `true` by default.
    pub record_input: bool,
    /// The run.
    pub handler: CommandHandler,
}

impl std::fmt::Debug for CommandDefinition {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CommandDefinition")
            .field("name", &self.name)
            .field("description", &self.description)
            .field("label", &self.label)
            .field("section", &self.section)
            .field("input", &self.input)
            .field("record_input", &self.record_input)
            .finish_non_exhaustive()
    }
}

impl CommandDefinition {
    /// A command whose handler answers a future.
    pub fn new<F>(name: impl Into<String>, description: impl Into<String>, handler: F) -> Self
    where
        F: Fn(CommandContext) -> BoxFuture<'static, HandlerOutcome> + Send + Sync + 'static,
    {
        Self {
            name: name.into(),
            description: description.into(),
            label: None,
            section: None,
            input: None,
            record_input: true,
            handler: Arc::new(handler),
        }
    }

    /// A command whose handler answers at once.
    pub fn sync<F>(name: impl Into<String>, description: impl Into<String>, handler: F) -> Self
    where
        F: Fn(CommandContext) -> HandlerOutcome + Send + Sync + 'static,
    {
        Self::new(name, description, move |context| {
            let outcome = handler(context);
            futures::future::ready(outcome).boxed()
        })
    }

    /// The same command with a menu label.
    pub fn label(mut self, label: impl Into<String>) -> Self {
        self.label = Some(label.into());
        self
    }

    /// The same command in a menu section.
    pub fn section(mut self, section: CommandSection) -> Self {
        self.section = Some(section);
        self
    }

    /// The same command taking input.
    pub fn input(mut self, input: CommandInput) -> Self {
        self.input = Some(input);
        self
    }

    /// The same command, keeping (or not) its raw input in `command/run`.
    pub fn record_input(mut self, record: bool) -> Self {
        self.record_input = record;
        self
    }
}

/// A command as the page lists it: everything but the handler.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CommandDescriptor {
    /// The name.
    pub name: String,
    /// The label.
    pub label: String,
    /// The description.
    pub description: String,
    /// The section.
    pub section: CommandSection,
    /// The input, when it takes any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<CommandInput>,
}

/// One finished run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandExecution {
    /// `cmd-<8 hex>-<n>`.
    pub command_id: String,
    /// The command that ran.
    pub name: String,
    /// What its handler answered.
    pub result: CommandResult,
    /// The `command/done` event's sequence number in the session log.
    pub seq: u64,
}

/// The part of the session store a run writes to.
pub trait CommandLog: Send + Sync {
    /// Append one event and answer it as recorded; an error is the store's sentence.
    fn append_event(
        &self,
        session: &SessionHandle,
        event: NewEvent,
    ) -> Result<Arc<SessionEvent>, String>;
}

impl CommandLog for SessionStore {
    fn append_event(
        &self,
        session: &SessionHandle,
        event: NewEvent,
    ) -> Result<Arc<SessionEvent>, String> {
        self.append(session, event, AppendOptions::default())
            .map_err(|error| error.to_string())
    }
}

/// Why a command could not be registered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegistrationError(pub String);

impl std::fmt::Display for RegistrationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for RegistrationError {}

type CommandMap = Mutex<HashMap<String, Arc<CommandDefinition>>>;

/// Removes one registration — and only that one: a command registered again under the same name after this
/// one was removed is left alone.
#[derive(Debug)]
pub struct Disposer {
    commands: Weak<CommandMap>,
    definition: Arc<CommandDefinition>,
}

impl Disposer {
    /// Remove the command this disposer was returned for, if it is still the registered one.
    pub fn dispose(self) {
        let Some(commands) = self.commands.upgrade() else {
            return;
        };
        let mut commands = commands.lock().unwrap_or_else(PoisonError::into_inner);
        if commands
            .get(&self.definition.name)
            .is_some_and(|current| Arc::ptr_eq(current, &self.definition))
        {
            commands.remove(&self.definition.name);
        }
    }
}

/// The registry of host commands.
///
/// Names are unique: registering a name twice is refused, because two handlers for one line would make which
/// one runs an accident of load order. [`CommandRegistry::register`] returns a [`Disposer`], so a plugin's
/// commands can leave with it.
pub struct CommandRegistry {
    commands: Arc<CommandMap>,
    prefix: String,
    count: AtomicU64,
}

impl std::fmt::Debug for CommandRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CommandRegistry")
            .field("prefix", &self.prefix)
            .finish_non_exhaustive()
    }
}

impl Default for CommandRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl CommandRegistry {
    /// An empty registry whose run ids share one random `cmd-<8 hex>` prefix.
    pub fn new() -> Self {
        Self {
            commands: Arc::new(Mutex::new(HashMap::new())),
            prefix: format!("cmd-{}", text::random_hex8()),
            count: AtomicU64::new(0),
        }
    }

    /// Add one command; refused when the name is malformed, the description blank, or the name taken.
    pub fn register(&self, definition: CommandDefinition) -> Result<Disposer, RegistrationError> {
        if !is_command_name(&definition.name) {
            return Err(RegistrationError(format!(
                "command name '{}' must be lower-case and start with a letter ({COMMAND_NAME_RULE})",
                definition.name
            )));
        }
        if text::trim(&definition.description).is_empty() {
            return Err(RegistrationError(format!(
                "command '{}' needs a description",
                definition.name
            )));
        }
        let mut commands = self.commands.lock().unwrap_or_else(PoisonError::into_inner);
        if commands.contains_key(&definition.name) {
            return Err(RegistrationError(format!(
                "a command named '{}' is already registered",
                definition.name
            )));
        }
        let definition = Arc::new(definition);
        commands.insert(definition.name.clone(), Arc::clone(&definition));
        Ok(Disposer {
            commands: Arc::downgrade(&self.commands),
            definition,
        })
    }

    /// Whether a name is registered.
    pub fn has(&self, name: &str) -> bool {
        self.commands
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .contains_key(name)
    }

    /// Every command, sorted by name as `localeCompare` sorts: what `GET /api/commands` answers.
    pub fn list(&self) -> Vec<CommandDescriptor> {
        let mut definitions: Vec<Arc<CommandDefinition>> = self
            .commands
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .values()
            .cloned()
            .collect();
        definitions.sort_by(|left, right| text::locale_compare(&left.name, &right.name));
        definitions
            .iter()
            .map(|definition| CommandDescriptor {
                name: definition.name.clone(),
                label: definition
                    .label
                    .clone()
                    .unwrap_or_else(|| default_label(&definition.name)),
                description: definition.description.clone(),
                section: definition.section.unwrap_or(if definition.input.is_some() {
                    CommandSection::Add
                } else {
                    CommandSection::Commands
                }),
                input: definition.input.clone(),
            })
            .collect()
    }

    /// Run a line in a session, or answer `None` when it is not a registered command.
    ///
    /// `None` writes nothing: the line was never a command, and the caller sends it on as a prompt. An `Err`
    /// is the session log refusing an append; a handler's own failure is a result of kind `error`.
    pub async fn execute(
        &self,
        log: &dyn CommandLog,
        session: &SessionHandle,
        line: &str,
    ) -> Result<Option<CommandExecution>, String> {
        let Some(parsed) = parse_command_line(line) else {
            return Ok(None);
        };
        let definition = self
            .commands
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(&parsed.name)
            .cloned();
        let Some(definition) = definition else {
            return Ok(None);
        };

        let number = self.count.fetch_add(1, Ordering::SeqCst) + 1;
        let command_id = format!("{}-{number}", self.prefix);
        let args = text::trim(&parsed.raw_input).to_owned();
        let mut run = NewEvent::new(COMMAND_RUN_EVENT)
            .field("commandId", command_id.clone())
            .field("name", definition.name.clone());
        if definition.record_input && !args.is_empty() {
            run = run.field("args", args.clone());
        }
        log.append_event(session, run.field("source", json!({"kind": "user"})))?;

        let context = CommandContext {
            session: session.clone(),
            command_id: command_id.clone(),
            raw_input: parsed.raw_input,
            args,
        };
        let handler = Arc::clone(&definition.handler);
        // The handler is called inside the guarded future, so a panic while building its future is caught too.
        let run = AssertUnwindSafe(async move { handler(context).await }).catch_unwind();
        let result = match run.await {
            Ok(Ok(result)) => result,
            Ok(Err(message)) => CommandResult::error(message),
            Err(payload) => CommandResult::error(panic_message(payload.as_ref())),
        };

        let mut done = NewEvent::new(COMMAND_DONE_EVENT)
            .field("commandId", command_id.clone())
            .field("kind", result.kind());
        if let Some(text) = result.text() {
            done = done.field("text", text);
        }
        if let Some(seq) = result.source_event_seq() {
            done = done.field("sourceEventSeq", seq);
        }
        let done = log.append_event(session, done)?;
        Ok(Some(CommandExecution {
            command_id,
            name: definition.name.clone(),
            result,
            seq: done.seq,
        }))
    }
}

/// A panic's message, as a thrown error's `message` would read.
fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
    payload
        .downcast_ref::<String>()
        .cloned()
        .or_else(|| {
            payload
                .downcast_ref::<&str>()
                .map(|text| (*text).to_owned())
        })
        .unwrap_or_else(|| "the command failed".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::Fixture;
    use heddle_session::fold_surface;
    use serde_json::Value;

    fn succeed() -> CommandDefinition {
        CommandDefinition::sync("ok", "fine", |_| Ok(CommandResult::success()))
    }

    #[test]
    fn a_command_line_is_slash_name_at_the_start_ending_at_whitespace_or_the_end() {
        let parsed = |name: &str, raw: &str| {
            Some(ParsedLine {
                name: name.to_owned(),
                raw_input: raw.to_owned(),
            })
        };
        assert_eq!(parse_command_line("/compact"), parsed("compact", ""));
        assert_eq!(
            parse_command_line("/goal ship the table"),
            parsed("goal", " ship the table")
        );
        assert_eq!(
            parse_command_line("/goal\nline two"),
            parsed("goal", "\nline two")
        );
        assert_eq!(parse_command_line("/goal\tx"), parsed("goal", "\tx"));
        assert_eq!(parse_command_line("/goal\rx"), parsed("goal", "\rx"));
        assert_eq!(parse_command_line("/Compact"), None, "names are lower-case");
        assert_eq!(
            parse_command_line("/compact:now"),
            None,
            "the name ends at whitespace, not punctuation"
        );
        assert_eq!(
            parse_command_line(" /compact"),
            None,
            "the line must open with the slash"
        );
        assert_eq!(parse_command_line("/"), None);
        assert_eq!(parse_command_line("see /compact"), None);
        assert_eq!(
            parse_command_line("/usr/bin/env"),
            None,
            "a path is not a command"
        );
        assert_eq!(parse_command_line("/9x"), None);
        assert_eq!(
            parse_command_line("/x\u{a0}y"),
            None,
            "only the four whitespace characters end a name"
        );
        assert_eq!(parse_command_line("/a-b_c9 z"), parsed("a-b_c9", " z"));
        assert_eq!(default_label("compact"), "Compact");
        assert_eq!(default_label(""), "");
    }

    #[test]
    fn the_registry_refuses_a_malformed_name_an_empty_description_and_a_second_command_of_one_name()
    {
        let registry = CommandRegistry::new();
        let bad = registry
            .register(CommandDefinition::sync("Bad", "x", |_| {
                Ok(CommandResult::success())
            }))
            .unwrap_err();
        assert!(bad.0.contains("lower-case"), "{bad}");
        assert_eq!(
            bad.0,
            "command name 'Bad' must be lower-case and start with a letter (/^[a-z][a-z0-9_-]*$/)"
        );
        let digit = registry
            .register(CommandDefinition::sync("9x", "x", |_| {
                Ok(CommandResult::success())
            }))
            .unwrap_err();
        assert!(digit.0.contains("start with a letter"), "{digit}");
        let blank = registry
            .register(CommandDefinition::sync("ok", "  ", |_| {
                Ok(CommandResult::success())
            }))
            .unwrap_err();
        assert_eq!(blank.0, "command 'ok' needs a description");
        let dispose = registry.register(succeed()).unwrap();
        let again = registry
            .register(CommandDefinition::sync("ok", "again", |_| {
                Ok(CommandResult::success())
            }))
            .unwrap_err();
        assert_eq!(again.0, "a command named 'ok' is already registered");
        dispose.dispose();
        assert!(!registry.has("ok"), "the disposer removes it");
        let second = registry
            .register(CommandDefinition::sync("ok", "fine again", |_| {
                Ok(CommandResult::success())
            }))
            .unwrap();
        assert!(registry.has("ok"));

        // A disposer only removes its own registration.
        let stale = registry.register(CommandDefinition::sync("other", "o", |_| {
            Ok(CommandResult::success())
        }));
        let stale = stale.unwrap();
        second.dispose();
        assert!(!registry.has("ok"));
        registry.register(succeed()).unwrap();
        stale.dispose();
        assert!(registry.has("ok"), "another command's disposer leaves it");
        assert!(!registry.has("other"));
    }

    #[test]
    fn the_list_is_sorted_labelled_and_sectioned_and_carries_no_handler() {
        let registry = CommandRegistry::new();
        registry
            .register(CommandDefinition::sync("zeta", "z", |_| {
                Ok(CommandResult::success())
            }))
            .unwrap();
        registry
            .register(
                CommandDefinition::sync("alpha", "a", |_| Ok(CommandResult::success()))
                    .input(CommandInput::hint("<text>")),
            )
            .unwrap();
        registry
            .register(
                CommandDefinition::sync("mid", "m", |_| Ok(CommandResult::success()))
                    .label("Middle")
                    .section(CommandSection::Add),
            )
            .unwrap();
        assert_eq!(
            serde_json::to_value(registry.list()).unwrap(),
            json!([
                {"name": "alpha", "label": "Alpha", "description": "a", "section": "add", "input": {"hint": "<text>"}},
                {"name": "mid", "label": "Middle", "description": "m", "section": "add"},
                {"name": "zeta", "label": "Zeta", "description": "z", "section": "commands"},
            ])
        );
        // The key order is the TypeScript build's, as the page's JSON reads it.
        assert_eq!(
            serde_json::to_string(&registry.list()[0]).unwrap(),
            r#"{"name":"alpha","label":"Alpha","description":"a","section":"add","input":{"hint":"<text>"}}"#
        );
    }

    #[tokio::test]
    async fn an_unknown_word_is_not_a_command_nothing_runs_and_nothing_is_written() {
        let fixture = Fixture::new("unknown");
        let registry = CommandRegistry::new();
        registry
            .register(CommandDefinition::sync("compact", "c", |_| {
                panic!("must not run")
            }))
            .unwrap();
        let before = fixture.events().len();
        for line in ["/compcat", "hello /compact", "/Compact"] {
            assert_eq!(
                registry
                    .execute(fixture.log(), &fixture.handle, line)
                    .await
                    .unwrap(),
                None,
                "{line}"
            );
        }
        assert_eq!(fixture.events().len(), before);
    }

    #[tokio::test]
    async fn a_run_is_command_run_then_command_done_and_neither_takes_a_place_on_the_surface() {
        let fixture = Fixture::new("run");
        let registry = CommandRegistry::new();
        let seen = Arc::new(Mutex::new(Vec::<String>::new()));
        let record = Arc::clone(&seen);
        registry
            .register(
                CommandDefinition::sync("echo", "say it back", move |context| {
                    record
                        .lock()
                        .unwrap()
                        .extend([context.raw_input.clone(), context.command_id.clone()]);
                    Ok(CommandResult::success_text(context.args).with_source_event_seq(0))
                })
                .input(CommandInput::hint("<text>")),
            )
            .unwrap();
        let surface_before = fold_surface(fixture.events().as_slice()).unwrap().nodes;
        let execution = registry
            .execute(fixture.log(), &fixture.handle, "/echo  hello there ")
            .await
            .unwrap()
            .expect("a registered command runs");
        assert_eq!(execution.name, "echo");
        let id = &execution.command_id;
        assert!(
            id.len() == "cmd-".len() + 8 + 2
                && id.starts_with("cmd-")
                && id[4..12].bytes().all(|byte| byte.is_ascii_hexdigit())
                && id.ends_with("-1"),
            "DSH-shaped id: cmd-<8hex>-<n>, got {id}"
        );
        assert_eq!(
            execution.result,
            CommandResult::Success {
                text: Some("hello there".to_owned()),
                source_event_seq: Some(0),
                action: None,
            }
        );
        assert_eq!(
            *seen.lock().unwrap(),
            vec!["  hello there ".to_owned(), execution.command_id.clone()],
            "the raw input keeps its whitespace"
        );

        let events = fixture.events();
        let run = events
            .iter()
            .find(|event| event.kind == COMMAND_RUN_EVENT)
            .expect("command/run");
        let done = events
            .iter()
            .find(|event| event.kind == COMMAND_DONE_EVENT)
            .expect("command/done");
        assert_eq!(run.get("commandId"), Some(&json!(execution.command_id)));
        assert_eq!(run.get("name"), Some(&json!("echo")));
        assert_eq!(run.get("args"), Some(&json!("hello there")));
        assert_eq!(run.get("source"), Some(&json!({"kind": "user"})));
        assert!(
            run.seq < done.seq,
            "run is written before the handler, done after"
        );
        assert_eq!(done.get("kind"), Some(&json!("success")));
        assert_eq!(done.get("text"), Some(&json!("hello there")));
        assert_eq!(done.get("sourceEventSeq"), Some(&json!(0)));
        assert_eq!(execution.seq, done.seq);
        assert_eq!(
            fold_surface(events.as_slice()).unwrap().nodes,
            surface_before,
            "a command is not part of the conversation"
        );
        // The bytes keep the TypeScript build's key order.
        let line = run.to_line();
        let body = line.split_once(r#""type":"command/run","#).unwrap().1;
        assert_eq!(
            body,
            format!(
                r#""commandId":"{}","name":"echo","args":"hello there","source":{{"kind":"user"}}}}"#,
                execution.command_id
            )
        );

        let second = registry
            .execute(fixture.log(), &fixture.handle, "/echo again")
            .await
            .unwrap()
            .unwrap();
        assert!(
            second.command_id.ends_with("-2"),
            "ids count up within one registry"
        );
        assert_eq!(
            second.command_id[..12],
            execution.command_id[..12],
            "one prefix per registry"
        );
    }

    #[tokio::test]
    async fn a_run_without_input_records_no_args() {
        let fixture = Fixture::new("noargs");
        let registry = CommandRegistry::new();
        registry.register(succeed()).unwrap();
        registry
            .execute(fixture.log(), &fixture.handle, "/ok   ")
            .await
            .unwrap()
            .unwrap();
        let events = fixture.events();
        let run = events
            .iter()
            .find(|event| event.kind == COMMAND_RUN_EVENT)
            .unwrap();
        assert_eq!(run.get("args"), None, "blank input is not recorded");
        let done = events
            .iter()
            .find(|event| event.kind == COMMAND_DONE_EVENT)
            .unwrap();
        assert_eq!(done.get("text"), None);
        assert_eq!(done.get("sourceEventSeq"), None);
    }

    #[tokio::test]
    async fn a_handler_that_fails_is_a_run_that_ended_in_error_recorded_as_such() {
        let fixture = Fixture::new("boom");
        let registry = CommandRegistry::new();
        registry
            .register(CommandDefinition::sync("boom", "fails", |_| {
                Err("the disk is full".to_owned())
            }))
            .unwrap();
        let execution = registry
            .execute(fixture.log(), &fixture.handle, "/boom")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(execution.result, CommandResult::error("the disk is full"));
        let events = fixture.events();
        let done = events
            .iter()
            .find(|event| event.kind == COMMAND_DONE_EVENT)
            .unwrap();
        assert_eq!(done.get("kind"), Some(&json!("error")));
        assert_eq!(done.get("text"), Some(&json!("the disk is full")));
        assert_eq!(done.get("sourceEventSeq"), None);
    }

    #[tokio::test]
    async fn a_handler_that_panics_is_still_a_whole_run() {
        let fixture = Fixture::new("panic");
        let registry = CommandRegistry::new();
        registry
            .register(CommandDefinition::sync("boom", "fails", |_| {
                panic!("the disk is full")
            }))
            .unwrap();
        let execution = registry
            .execute(fixture.log(), &fixture.handle, "/boom")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(execution.result, CommandResult::error("the disk is full"));
        let kinds: Vec<Value> = fixture
            .events()
            .iter()
            .filter(|event| event.kind.starts_with("command/"))
            .map(|event| json!(event.kind))
            .collect();
        assert_eq!(kinds, [json!("command/run"), json!("command/done")]);
    }

    #[test]
    fn a_result_is_shaped_as_the_typescript_union() {
        let error = CommandResult::error("no").with_source_event_seq(3);
        assert_eq!(error.source_event_seq(), None, "an error carries no seq");
        assert_eq!(error.kind(), "error");
        assert_eq!(error.text(), Some("no"));
        let action = CommandAction::Download {
            href: "/x".to_owned(),
        };
        assert_eq!(
            serde_json::to_value(&action).unwrap(),
            json!({"kind": "download", "href": "/x"})
        );
        let success = CommandResult::success().with_action(action.clone());
        assert_eq!(success.action(), Some(&action));
        assert_eq!(success.text(), None);
        assert_eq!(
            CommandResult::error("no").with_action(action).action(),
            None
        );
    }
}
