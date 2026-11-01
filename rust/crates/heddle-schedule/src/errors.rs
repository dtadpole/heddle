//! The two failures the schedule subsystem raises, with DSH's names and codes (`src/schedule/errors.ts`).
//!
//! - a [`ScheduleInputError`] is a **model- or person-supplied value** that cannot become a record; its code and
//!   message are public, and the tools hand them back verbatim as `{code, message}`;
//! - a [`ScheduleLogError`] is **stored data** that is malformed or contradicts an invariant; it is never shown to a
//!   model as such (the tools withhold it behind `internal_error`) and the store refuses to open over it.

use std::fmt;

/// The public codes a [`ScheduleInputError`] carries, as DSH publishes them (TOOL:175-185).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ScheduleErrorCode {
    /// `invalid_prompt`
    InvalidPrompt,
    /// `invalid_selector`
    InvalidSelector,
    /// `invalid_rule`
    InvalidRule,
    /// `invalid_time_zone`
    InvalidTimeZone,
    /// `not_future`
    NotFuture,
    /// `time_out_of_range`
    TimeOutOfRange,
    /// `frequency_too_high`
    FrequencyTooHigh,
    /// `subagent_session`
    SubagentSession,
    /// `internal_error`
    InternalError,
}

impl ScheduleErrorCode {
    /// The wire spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InvalidPrompt => "invalid_prompt",
            Self::InvalidSelector => "invalid_selector",
            Self::InvalidRule => "invalid_rule",
            Self::InvalidTimeZone => "invalid_time_zone",
            Self::NotFuture => "not_future",
            Self::TimeOutOfRange => "time_out_of_range",
            Self::FrequencyTooHigh => "frequency_too_high",
            Self::SubagentSession => "subagent_session",
            Self::InternalError => "internal_error",
        }
    }
}

impl fmt::Display for ScheduleErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A supplied rule, selector or target session that cannot become a schedule record.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScheduleInputError {
    /// Stable public discriminator.
    pub code: ScheduleErrorCode,
    /// The sentence a model reads.
    pub message: String,
}

impl ScheduleInputError {
    /// An error with this code and sentence.
    pub fn new(code: ScheduleErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    /// `invalid_rule` with this sentence — the most common refusal.
    pub fn rule(message: impl Into<String>) -> Self {
        Self::new(ScheduleErrorCode::InvalidRule, message)
    }
}

impl fmt::Display for ScheduleInputError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ScheduleInputError {}

/// Durable schedule data that is malformed or violates an invariant (DSH's `corrupt_schedule_log`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScheduleLogError {
    /// What is wrong.
    pub message: String,
}

impl ScheduleLogError {
    /// DSH's code for the whole family.
    pub const CODE: &'static str = "corrupt_schedule_log";

    /// An error with this sentence.
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl fmt::Display for ScheduleLogError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ScheduleLogError {}

/// Either failure, for the rules that can raise both (an occurrence decision over a record).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ScheduleError {
    /// A supplied value.
    Input(ScheduleInputError),
    /// Stored data.
    Log(ScheduleLogError),
}

impl ScheduleError {
    /// `String(error)` in the TypeScript build: the class name, a colon, the message.
    pub fn js_string(&self) -> String {
        match self {
            Self::Input(error) => format!("ScheduleInputError: {}", error.message),
            Self::Log(error) => format!("ScheduleLogError: {}", error.message),
        }
    }
}

impl fmt::Display for ScheduleError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Input(error) => error.fmt(f),
            Self::Log(error) => error.fmt(f),
        }
    }
}

impl std::error::Error for ScheduleError {}

impl From<ScheduleInputError> for ScheduleError {
    fn from(error: ScheduleInputError) -> Self {
        Self::Input(error)
    }
}

impl From<ScheduleLogError> for ScheduleError {
    fn from(error: ScheduleLogError) -> Self {
        Self::Log(error)
    }
}
