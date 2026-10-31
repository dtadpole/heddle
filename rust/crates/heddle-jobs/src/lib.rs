//! `heddle-jobs` — background jobs a session starts and collects later.
//!
//! Ported from the TypeScript build's `src/jobs/*.ts` and `src/plugins/jobs.ts`, which port DSH's `dsh-jobs-local`
//! (the registry), `dsh-tool-jobs` (the tools and the notice), `dsh-tool-bash` (`run_in_background`) and
//! `dsh-api-job-controller` (the person's job API). A model calls `bash` with `run_in_background: true`, gets
//! `started background job <id>` at once, and goes on working; it reads the output later with `job_output`, lists its
//! jobs with `job_list` and stops one with `job_kill`. When a job ends on its own, the session is told with a
//! completion notice, which starts a turn if the session is idle. Judged through the `heddle` binary by
//! `_verifiers_/50-agentic-loop/check-jobs.mjs`.
//!
//! | Module | What it is |
//! |---|---|
//! | [`ring`] | the output ring: absolute UTF-8 offsets, UTF-8-safe retention, lossy non-consuming reads |
//! | [`registry`] | [`JobRegistry`]: statuses, ids, preflight, the cap, the pump, reads, kill, wait, remove, events |
//! | [`tools`] | `job_output`, `job_list`, `job_kill`: DSH's descriptions, schemas and renderings |
//! | [`bash`] | background `bash`: the process-group producer and the runner attached to the tools row's `bash` |
//! | [`notice`] | the completion notice and its delivery: wake or inject, serialized per session |
//! | [`prompt`] | DSH's `tool:jobs` prompt section, added to a request that offers the job tools (`model/request`) |
//! | [`http`] | the page's routes under `/api/jobs` |
//! | [`compose`] | the `jobs` row, for the binary |
//! | [`js`] | the JavaScript number semantics the refusal sentences lean on |

pub mod bash;
pub mod compose;
pub mod http;
pub mod js;
pub mod notice;
pub mod prompt;
pub mod registry;
pub mod ring;
pub mod tools;

pub use compose::{JobsConfig, JobsPlugin, JobsRow, JobsTeardown, start_row};
pub use notice::{NoticeDelivery, NoticeHost, NoticeSource, notice_source, notice_text};
pub use prompt::{JobsPromptSection, PromptSectionHooks, attach_prompt_section, with_jobs_section};
pub use registry::{
    JobError, JobEvent, JobHandle, JobHooks, JobOutcome, JobRead, JobRegistry, JobRegistryOptions,
    JobSpec, JobStatus, JobToolCall, JobView, KillOutcome, OutcomeStatus, SettleCause,
};
pub use ring::{AppendOptions, JobChannel, JobChunk, OutputRing, RingRead};
