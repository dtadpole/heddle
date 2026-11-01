//! `heddle-schedule` — durable reminders a session sets for itself: the four model tools, the rules that compute
//! targets, the store file, the service, the delivery driver that turns a due reminder into a turn, the page's
//! routes, and the time context that tells the model the current time.
//!
//! Ported from the TypeScript build's `src/schedule/` (`errors`, `time`, `cron`, `rules`, `store`, `service`,
//! `delivery`, `tool`, `http`, `time-context`) and `src/plugins/schedule.ts`, which port DSH 0.2.1-rc.2's
//! `dsh-tool-schedule`, `dsh-schedule` and `dsh-time-context`. Judged through the binary by
//! `_verifiers_/50-agentic-loop/check-schedules.mjs`; the unit tests port `test/schedule-*.test.ts`.
//!
//! # Time zones
//!
//! The TypeScript build reads zone offsets from `Intl`. This crate takes no time-zone dependency: [`tzif`] reads the
//! operating system's compiled IANA database (TZif v1-v3 with the POSIX footer rule), and [`time`] converts wall
//! times with DSH's disambiguation — a gap has no instant, an overlap takes the earlier one.
//!
//! # Seams
//!
//! - [`compose::start_row`] builds the row over `heddle-session`, `heddle-agent` and `heddle-tools`, for the binary to
//!   call with one line; [`compose::SchedulePlugin::start_delivery`] is what `heddle web` calls after its sweeps.
//! - [`http::router`] serves `/api/schedule/*` for the server to mount.
//! - [`time_context::record_time_context`] is the per-step clock reading the turn loop records.

#![warn(missing_docs)]

pub mod compose;
pub mod cron;
pub mod delivery;
pub mod errors;
pub mod http;
pub mod js;
pub mod rules;
pub mod service;
pub mod store;
pub mod time;
pub mod time_context;
pub mod tool;
pub mod tzif;

pub use compose::{ScheduleConfig, SchedulePlugin, ScheduleRow, start_row};
pub use delivery::{DeliveryHost, DriverOptions, DriverTimers, ScheduleDriver};
pub use errors::{ScheduleError, ScheduleErrorCode, ScheduleInputError, ScheduleLogError};
pub use rules::{ScheduleRecord, ScheduleRule};
pub use service::{ScheduleService, ScheduleServiceOptions, ServiceError};
pub use store::{ScheduleStore, ScheduleTask};
pub use tool::ScheduleTools;
