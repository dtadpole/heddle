//! The background half of `bash`: the seam the jobs row (`heddle-jobs`) attaches to.
//!
//! Ported from `src/tools/builtin.ts` (`BashBackground`, `attachBashBackground`). DSH's `bash` shows
//! `run_in_background` only when a job registry is loaded and hands such a call to the registry
//! (`dsh-tool-bash/lib/index.js:514-517, 673-685`). The tools row builds `bash` without knowing about jobs, so the
//! seam is keyed by the one object both rows already share — the sandbox gate the `bash` tool was built over,
//! which is the registry's own ([`ToolRegistry::sandbox`](crate::ToolRegistry::sandbox)). While a runner is
//! attached, `bash`'s schema carries `run_in_background` and a call that sets it is handed to the runner; with none
//! attached the schema and the foreground run are exactly what they were, and a background call is refused with
//! DSH's "background jobs unavailable" sentence, adapted.

use std::sync::{Arc, Mutex, Weak};

use futures::future::BoxFuture;

use crate::gates::SandboxGate;
use crate::tool::{ToolArgs, ToolFailure, ToolResult, ToolRunContext};

/// DSH's description of `run_in_background`, verbatim (`dsh-tool-bash/lib/index.js:514-517`).
///
/// The TypeScript build passes the property from the jobs row; here the `bash` tool's two schemas are built once,
/// so the text lives beside them and `heddle-jobs` re-exports it.
pub const RUN_IN_BACKGROUND_DESCRIPTION: &str = "Run in the background and return a job id immediately (collect with job_output, stop with job_kill). No timeout applies.";

/// The code and sentence of a background call when no runner is attached (DSH's refusal, adapted).
pub const JOB_UNAVAILABLE: &str = "JOB_UNAVAILABLE";

/// The sentence a background call is refused with when no jobs row is loaded.
pub const NO_JOBS_ROW_MESSAGE: &str =
    "background jobs unavailable: load the jobs row (src/plugins/jobs.ts)";

/// What the jobs row attaches: start one command as a background job and answer the tool result.
pub trait BashBackground: Send + Sync {
    /// Start the call as a background job. `sandbox` is the gate rooted at the call's folder — the one a foreground
    /// run confines through — so a background command is confined by exactly the same path
    /// ([`launch_shell`](crate::builtin::launch_shell)).
    fn start(
        &self,
        args: ToolArgs,
        context: ToolRunContext,
        sandbox: Arc<dyn SandboxGate>,
    ) -> BoxFuture<'static, Result<ToolResult, ToolFailure>>;

    /// Whether foreground calls are handed to [`BashBackground::run_foreground`]: DSH's `promoteOnTimeout`. `false`
    /// unless the runner says so, which keeps the foreground run, and its wall-time kill, with the tool.
    fn promotes(&self) -> bool {
        false
    }

    /// Run a foreground call as a job (DSH's `promoteOnTimeout`: with a registry, every call registers its process as
    /// a job at its start). Answers `render`'s result when the command ends within the wall time, and the promoted
    /// answer when it outlives it and keeps running as a job. `None` means the job could not be registered, and the
    /// tool runs the call in the foreground with the wall-time kill, as DSH falls back.
    fn run_foreground(
        &self,
        run: ForegroundRun,
    ) -> BoxFuture<'static, Option<Result<ToolResult, ToolFailure>>> {
        let _ = run;
        Box::pin(async { None })
    }
}

/// One foreground call handed to [`BashBackground::run_foreground`].
pub struct ForegroundRun {
    pub args: ToolArgs,
    pub context: ToolRunContext,
    /// The gate rooted at the call's folder, which the settled command is classified by.
    pub sandbox: Arc<dyn SandboxGate>,
    /// The confined argv, from [`crate::launch_shell`]: the job runs exactly what the foreground would have.
    pub launch: crate::builtin::ShellLaunch,
    /// The call's wall time, already validated and capped.
    pub limit_ms: u64,
    /// `bash`'s own answer for a command that ended ([`crate::builtin::shell_result`], bound to this call).
    pub render: Box<dyn FnOnce(crate::builtin::ShellEnd) -> ToolResult + Send>,
}

struct Attached {
    gate: Weak<dyn SandboxGate>,
    background: Arc<dyn BashBackground>,
}

/// Every attachment, keyed by the gate it was attached for. A gate that is gone takes its entry with it on the
/// next lookup, as the TypeScript `WeakMap` would.
static ATTACHED: Mutex<Vec<Attached>> = Mutex::new(Vec::new());

fn attached() -> std::sync::MutexGuard<'static, Vec<Attached>> {
    ATTACHED
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The runner attached for the `bash` tools built over `sandbox`, if any.
pub fn background_for(sandbox: &Arc<dyn SandboxGate>) -> Option<Arc<dyn BashBackground>> {
    let key = Arc::downgrade(sandbox);
    let mut entries = attached();
    entries.retain(|entry| entry.gate.strong_count() > 0);
    entries
        .iter()
        .find(|entry| Weak::ptr_eq(&entry.gate, &key))
        .map(|entry| Arc::clone(&entry.background))
}

/// The detach [`attach_bash_background`] answers: removes the attachment if it is still the one it made.
pub struct BashBackgroundDetach {
    gate: Weak<dyn SandboxGate>,
    background: Weak<dyn BashBackground>,
}

impl BashBackgroundDetach {
    /// Detach; a second call, or a call after another runner replaced this one, does nothing.
    pub fn detach(&self) {
        attached().retain(|entry| {
            !(Weak::ptr_eq(&entry.gate, &self.gate)
                && Weak::ptr_eq(&Arc::downgrade(&entry.background), &self.background))
        });
    }
}

/// Attach a background runner for the `bash` tools built over `sandbox` (the registry's
/// [`sandbox`](crate::ToolRegistry::sandbox)); a later attachment replaces an earlier one.
pub fn attach_bash_background(
    sandbox: &Arc<dyn SandboxGate>,
    background: Arc<dyn BashBackground>,
) -> BashBackgroundDetach {
    let gate = Arc::downgrade(sandbox);
    let detach = BashBackgroundDetach {
        gate: gate.clone(),
        background: Arc::downgrade(&background),
    };
    let mut entries = attached();
    entries.retain(|entry| entry.gate.strong_count() > 0 && !Weak::ptr_eq(&entry.gate, &gate));
    entries.push(Attached { gate, background });
    detach
}
