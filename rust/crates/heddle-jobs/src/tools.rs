//! The three model-facing job tools — `job_output`, `job_list`, `job_kill` — with DSH's descriptions, parameter
//! schemas, rendering and texts (`src/jobs/tools.ts`, from `dsh-tool-jobs/lib/index.js`, cited `TOOL:n`).
//!
//! A registry refusal keeps heddle's tool error shape, `{code, message}`, with DSH's message: the model reads
//! `error (JOB_FOREIGN): job <id> belongs to another session` where DSH shows `Error: job <id> belongs to another
//! session`. The codes are the registry's ([`crate::registry::codes`]).

use std::sync::Arc;

use heddle_tools::{Tool, ToolArgs, ToolFailure, ToolResult, ToolRunContext, ToolSpec, tool_fn};
use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::js::json_value;
use crate::registry::{JobError, JobRead, JobRegistry, JobStatus, JobView, KillOutcome, codes};
use crate::ring::{JobChannel, JobChunk};

/// DSH's defaults for `job_output`'s wait (TOOL:88-93).
pub const DEFAULT_WAIT_TIMEOUT_MS: f64 = 30_000.0;
pub const DEFAULT_MAX_WAIT_TIMEOUT_MS: f64 = 600_000.0;

/// DSH's `tool:jobs` prompt section (TOOL:257-261), verbatim. The row adds it to every model request that offers the
/// job tools ([`crate::prompt::with_jobs_section`], through the `model/request` hook).
pub const JOBS_PROMPT_SECTION: &str = "Track every background job id you start. You are notified in-session when a job finishes — do not busy-poll or sleep on one; keep working on independent steps and do not duplicate a running job's work. Before giving a final answer, collect every still-relevant job with job_output (set wait: true only when you are genuinely blocked on it), and job_kill jobs that stopped mattering.";

/// The model-safe projection: no owner, offsets or limits; `detail` is the progress while live, the reason once
/// settled (DSH's `publicJob`, TOOL:28-39).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicJob {
    pub id: String,
    pub kind: String,
    pub label: String,
    pub status: JobStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    pub started_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<u64>,
}

/// DSH's `publicJob`.
pub fn public_job(job: &JobView) -> PublicJob {
    PublicJob {
        id: job.id.clone(),
        kind: job.kind.clone(),
        label: job.label.clone(),
        status: job.status,
        detail: job.progress.clone().or_else(|| job.detail.clone()),
        started_at: job.started_at,
        finished_at: job.finished_at,
    }
}

/// `[status: <s>]` or `[status: <s>, <detail>]` (TOOL:45-47).
pub fn status_line(status: &str, detail: Option<&str>) -> String {
    match detail {
        Some(detail) => format!("[status: {status}, {detail}]"),
        None => format!("[status: {status}]"),
    }
}

fn job_status_line(job: &PublicJob) -> String {
    status_line(job.status.as_str(), job.detail.as_deref())
}

/// One consuming read as the model sees it (TOOL:61-70): stdout and unlabelled chunks in order, then every stderr
/// chunk in one `[stderr]` section; `log` chunks never reach the model; lost bytes end the read with the
/// dropped-output note.
pub fn render_model_delta(chunks: &[JobChunk], lossy: bool, spill_paths: &[String]) -> String {
    let visible: Vec<&JobChunk> = chunks
        .iter()
        .filter(|chunk| chunk.channel != Some(JobChannel::Log))
        .collect();
    let out: String = visible
        .iter()
        .filter(|chunk| chunk.channel != Some(JobChannel::Stderr))
        .map(|chunk| chunk.text.as_str())
        .collect();
    let err: String = visible
        .iter()
        .filter(|chunk| chunk.channel == Some(JobChannel::Stderr))
        .map(|chunk| chunk.text.as_str())
        .collect();
    let separator = if !out.is_empty() && !out.ends_with('\n') {
        "\n"
    } else {
        ""
    };
    let body = if err.is_empty() {
        out
    } else {
        format!("{out}{separator}[stderr]\n{err}")
    };
    if !lossy && !visible.iter().any(|chunk| chunk.gap_before == Some(true)) {
        return body;
    }
    let paths = if spill_paths.is_empty() {
        "(unavailable)".to_owned()
    } else {
        spill_paths.join(", ")
    };
    let notice = format!("[some output was dropped from memory; full output: {paths}]");
    let joint = if !body.is_empty() && !body.ends_with('\n') {
        "\n"
    } else {
        ""
    };
    format!("{body}{joint}{notice}")
}

/// The delta, then the result once (TOOL:216-222).
fn read_text(read: &JobRead) -> String {
    let spill = read.job.output.spill_paths.clone().unwrap_or_default();
    let delta = render_model_delta(&read.chunks, read.lossy, &spill);
    match &read.result {
        None => delta,
        Some(result) => {
            let joint = if !delta.is_empty() && !delta.ends_with('\n') {
                "\n"
            } else {
                ""
            };
            format!("{delta}{joint}{result}")
        }
    }
}

/// `job_output`'s text: the body or `(no new output)`, a newline if needed, then the status line (TOOL:331-337).
pub fn render_job_output(text: &str, job: &PublicJob) -> String {
    let body = if text.is_empty() {
        "(no new output)"
    } else {
        text
    };
    let joint = if body.ends_with('\n') { "" } else { "\n" };
    format!("{body}{joint}{}", job_status_line(job))
}

/// `job_list`'s text (TOOL:356-359). The separator is DSH's em dash.
pub fn render_job_list(jobs: &[PublicJob]) -> String {
    if jobs.is_empty() {
        return "(no background jobs)".to_owned();
    }
    jobs.iter()
        .map(|job| {
            format!(
                "{} [{}] {} — {}",
                job.id,
                job.kind,
                job.status.as_str(),
                job.label
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// `job_kill`'s text (TOOL:398-401).
pub fn render_job_kill(outcome: KillOutcome, job: &PublicJob) -> String {
    match outcome {
        KillOutcome::AlreadyFinished => format!(
            "job {} had already finished {}",
            job.id,
            job_status_line(job)
        ),
        KillOutcome::Requested => format!("requested cancellation of job {}", job.id),
    }
}

/// The non-empty check the schema cannot express (TOOL:202-205).
fn validate_job_id(value: Option<&Value>) -> Result<String, JobError> {
    let id = value.and_then(Value::as_str).unwrap_or("");
    if id.is_empty() {
        let shown = match value {
            None | Some(Value::Null) => "\"\"".to_owned(),
            Some(other) => json_value(other),
        };
        return Err(JobError::new(
            codes::JOB_INVALID_ARGS,
            format!("invalid job_id: expected a non-empty string, got {shown}"),
        ));
    }
    Ok(id.to_owned())
}

/// A registry error as the tool answers it: a refusal keeps `{code, message}`; a failed cancel is the tool's
/// failure, which the registry reports as `TOOL_FAILED` (the TypeScript build rethrows it).
fn refusal(error: JobError) -> Result<ToolResult, ToolFailure> {
    if error.code == codes::JOB_CANCEL_FAILED {
        return Err(ToolFailure::Failed(error.message));
    }
    Ok(ToolResult::refused(error.code, error.message))
}

const JOB_ID_DESCRIPTION: &str = "Job id returned by the tool that started the background work.";

/// Told the id of a job the model itself asked to stop.
pub type ModelKill = Arc<dyn Fn(&str) + Send + Sync>;

/// What the tools are built with.
#[derive(Clone, Default)]
pub struct JobToolOptions {
    /// `job_output`'s wait when `timeout_ms` is absent; DSH's 30000.
    pub wait_timeout_ms: Option<f64>,
    /// The longest wait `job_output` grants; DSH's 600000.
    pub max_wait_timeout_ms: Option<f64>,
    /// Told when the model itself asked a job to stop, so its completion notice is suppressed (TOOL:262, 407).
    pub on_model_kill: Option<ModelKill>,
}

/// The three specs, in DSH's order: `job_output`, `job_list`, `job_kill`.
pub fn job_tool_specs() -> Vec<ToolSpec> {
    vec![
        ToolSpec {
            name: "job_output".into(),
            description: "Read a background job: output since the previous read for stream jobs, or the result of a finished final-output job.".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "job_id": { "type": "string", "description": JOB_ID_DESCRIPTION },
                    "wait": {
                        "type": "boolean",
                        "description": "Block until the job finishes or the timeout expires; a timed-out wait leaves the job running. Defaults to false.",
                    },
                    "timeout_ms": { "type": "number", "description": "Max wait in milliseconds with wait: true. Defaults to and is capped by configuration." },
                },
                "required": ["job_id"],
                "additionalProperties": false,
            }),
        },
        ToolSpec {
            name: "job_list".into(),
            description: "List your background jobs (running and finished) with their ids, kinds, and statuses.".into(),
            parameters: json!({ "type": "object", "properties": {}, "additionalProperties": false }),
        },
        ToolSpec {
            name: "job_kill".into(),
            description: "Request cancellation of a running background job.".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "job_id": { "type": "string", "description": JOB_ID_DESCRIPTION },
                    "reason": { "type": "string", "description": "Optional short reason, recorded in the log and forwarded to the job." },
                },
                "required": ["job_id"],
                "additionalProperties": false,
            }),
        },
    ]
}

fn data(entries: impl IntoIterator<Item = (&'static str, Value)>) -> Map<String, Value> {
    entries
        .into_iter()
        .map(|(key, value)| (key.to_owned(), value))
        .collect()
}

/// Build the three tools over one registry. The caller is always the session the call runs in, never an argument.
/// `Err` when the default wait exceeds the cap.
pub fn job_tools(jobs: JobRegistry, options: JobToolOptions) -> Result<Vec<Arc<dyn Tool>>, String> {
    let wait_default = options.wait_timeout_ms.unwrap_or(DEFAULT_WAIT_TIMEOUT_MS);
    let wait_cap = options
        .max_wait_timeout_ms
        .unwrap_or(DEFAULT_MAX_WAIT_TIMEOUT_MS);
    if wait_default > wait_cap {
        return Err(format!(
            "jobs: waitTimeoutMs ({}) exceeds maxWaitTimeoutMs ({})",
            crate::js::json_number(wait_default),
            crate::js::json_number(wait_cap)
        ));
    }
    let mut specs = job_tool_specs().into_iter();
    let output_spec = specs.next().expect("three specs");
    let list_spec = specs.next().expect("three specs");
    let kill_spec = specs.next().expect("three specs");

    let reader = jobs.clone();
    let job_output = tool_fn(
        output_spec,
        move |args: ToolArgs, context: ToolRunContext| {
            let jobs = reader.clone();
            Box::pin(async move {
                let caller = context.session.as_ref().map(|session| session.id.clone());
                let caller = caller.as_deref();
                let id = match validate_job_id(args.get("job_id")) {
                    Ok(id) => id,
                    Err(error) => return refusal(error),
                };
                if args.get("wait") == Some(&Value::Bool(true)) {
                    let requested = args
                        .get("timeout_ms")
                        .and_then(Value::as_f64)
                        .unwrap_or(wait_default);
                    if let Err(error) = jobs
                        .wait(&id, requested.min(wait_cap), caller, context.cancel.clone())
                        .await
                    {
                        return refusal(error);
                    }
                }
                match jobs.read(&id, caller) {
                    Ok(read) => {
                        let job = public_job(&read.job);
                        Ok(ToolResult::ok(render_job_output(&read_text(&read), &job))
                            .with_data(data([("job", json!(job))])))
                    }
                    Err(error) => refusal(error),
                }
            })
        },
    );

    let lister = jobs.clone();
    let job_list = tool_fn(
        list_spec,
        move |_args: ToolArgs, context: ToolRunContext| {
            let jobs = lister.clone();
            Box::pin(async move {
                let caller = context.session.as_ref().map(|session| session.id.as_str());
                let list: Vec<PublicJob> = jobs.list(caller).iter().map(public_job).collect();
                Ok(ToolResult::ok(render_job_list(&list)).with_data(data([("jobs", json!(list))])))
            })
        },
    );

    let killer = jobs;
    let on_model_kill = options.on_model_kill;
    let job_kill = tool_fn(kill_spec, move |args: ToolArgs, context: ToolRunContext| {
        let jobs = killer.clone();
        let on_model_kill = on_model_kill.clone();
        Box::pin(async move {
            let caller = context.session.as_ref().map(|session| session.id.clone());
            let caller = caller.as_deref();
            let id = match validate_job_id(args.get("job_id")) {
                Ok(id) => id,
                Err(error) => return refusal(error),
            };
            let reason = args.get("reason").and_then(Value::as_str);
            // Marked before the job can settle, so the model's own kill never sends a notice.
            let outcome = match jobs.kill_with(&id, caller, reason, || {
                if let Some(notify) = &on_model_kill {
                    notify(&id);
                }
            }) {
                Ok(outcome) => outcome,
                Err(error) => return refusal(error),
            };
            match jobs.get(&id, caller) {
                Ok(view) => {
                    let job = public_job(&view);
                    let answer = match outcome {
                        KillOutcome::AlreadyFinished => "already-finished",
                        KillOutcome::Requested => "cancellation-requested",
                    };
                    Ok(ToolResult::ok(render_job_kill(outcome, &job))
                        .with_data(data([("outcome", json!(answer)), ("job", json!(job))])))
                }
                Err(error) => refusal(error),
            }
        })
    });

    Ok(vec![job_output, job_list, job_kill])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chunk(at: u64, text: &str, channel: Option<JobChannel>, gap: Option<bool>) -> JobChunk {
        JobChunk {
            at,
            text: text.into(),
            channel,
            gap_before: gap,
        }
    }

    #[test]
    fn the_delta_renders_stdout_then_one_stderr_section_and_ends_a_lossy_read_with_the_note() {
        use JobChannel::{Log, Stderr, Stdout};
        assert_eq!(
            render_model_delta(
                &[
                    chunk(0, "out", Some(Stdout), None),
                    chunk(3, "err\n", Some(Stderr), None),
                    chunk(7, "narration", Some(Log), None),
                    chunk(16, " more\n", Some(Stdout), None),
                ],
                false,
                &[]
            ),
            "out more\n[stderr]\nerr\n"
        );
        assert_eq!(
            render_model_delta(&[chunk(0, "x", Some(Stdout), None)], false, &[]),
            "x"
        );
        assert_eq!(
            render_model_delta(&[chunk(0, "e", Some(Stderr), None)], false, &[]),
            "[stderr]\ne"
        );
        assert_eq!(
            render_model_delta(&[chunk(9, "tail", None, None)], true, &[]),
            "tail\n[some output was dropped from memory; full output: (unavailable)]"
        );
        assert_eq!(
            render_model_delta(
                &[chunk(9, "tail\n", None, Some(true))],
                false,
                &["/a".into(), "/b".into()]
            ),
            "tail\n[some output was dropped from memory; full output: /a, /b]"
        );
        assert_eq!(status_line("running", None), "[status: running]");
        assert_eq!(
            status_line("completed", Some("exit code: 3")),
            "[status: completed, exit code: 3]"
        );
        assert_eq!(render_job_list(&[]), "(no background jobs)");
    }

    #[test]
    fn the_three_tools_carry_dsh_descriptions_and_parameter_schemas() {
        let specs = job_tool_specs();
        let by = |name: &str| specs.iter().find(|spec| spec.name == name).unwrap();
        assert_eq!(
            by("job_output").description,
            "Read a background job: output since the previous read for stream jobs, or the result of a finished final-output job."
        );
        assert_eq!(
            by("job_output").parameters["properties"],
            json!({
                "job_id": { "type": "string", "description": "Job id returned by the tool that started the background work." },
                "wait": { "type": "boolean", "description": "Block until the job finishes or the timeout expires; a timed-out wait leaves the job running. Defaults to false." },
                "timeout_ms": { "type": "number", "description": "Max wait in milliseconds with wait: true. Defaults to and is capped by configuration." },
            })
        );
        assert_eq!(by("job_output").parameters["required"], json!(["job_id"]));
        assert_eq!(
            by("job_list").description,
            "List your background jobs (running and finished) with their ids, kinds, and statuses."
        );
        assert_eq!(by("job_list").parameters["properties"], json!({}));
        assert_eq!(
            by("job_kill").description,
            "Request cancellation of a running background job."
        );
        assert_eq!(
            by("job_kill").parameters["properties"],
            json!({
                "job_id": { "type": "string", "description": "Job id returned by the tool that started the background work." },
                "reason": { "type": "string", "description": "Optional short reason, recorded in the log and forwarded to the job." },
            })
        );
        // Byte-identical with the TypeScript build's JSON, key order included.
        assert_eq!(
            serde_json::to_string(&by("job_list").parameters).unwrap(),
            r#"{"type":"object","properties":{},"additionalProperties":false}"#
        );
        assert_eq!(
            specs
                .iter()
                .map(|spec| spec.name.as_str())
                .collect::<Vec<_>>(),
            ["job_output", "job_list", "job_kill"]
        );
    }

    #[test]
    fn an_empty_job_id_names_what_was_given() {
        assert_eq!(
            validate_job_id(Some(&json!(""))).unwrap_err().message,
            "invalid job_id: expected a non-empty string, got \"\""
        );
        assert_eq!(
            validate_job_id(None).unwrap_err().message,
            "invalid job_id: expected a non-empty string, got \"\""
        );
        assert_eq!(
            validate_job_id(Some(&json!(7))).unwrap_err().message,
            "invalid job_id: expected a non-empty string, got 7"
        );
        assert!(
            job_tools(
                JobRegistry::default(),
                JobToolOptions {
                    wait_timeout_ms: Some(10.0),
                    max_wait_timeout_ms: Some(5.0),
                    on_model_kill: None,
                }
            )
            .is_err()
        );
    }
}
