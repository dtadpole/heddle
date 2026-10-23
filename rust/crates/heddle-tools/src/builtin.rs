//! The tools this harness ships: `write_file`, `read_file`, `list_dir`, `bash`.
//!
//! Ported from `src/tools/builtin.ts`. Four tools, because the claim is that the extension point works,
//! not that the catalogue is large. Every spec description is copied verbatim from the TypeScript build:
//! it is what the model is told, so the two binaries must tell it the same thing.

use std::sync::Arc;

use crate::gates::SandboxGate;
use crate::tool::Tool;

/// What the built-ins are built with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BuiltinOptions {
    /// Default wall time of a `bash` call, in milliseconds; a call may name its own `timeoutMs`.
    pub bash_timeout_ms: u64,
}

impl Default for BuiltinOptions {
    fn default() -> Self {
        Self {
            bash_timeout_ms: 30_000,
        }
    }
}

/// The most combined output a `bash` result carries before it is cut, in characters.
pub const BASH_OUTPUT_LIMIT: usize = 20_000;

/// Build the four standard tools around one sandbox, in the order `heddle tools` lists them:
/// `write_file`, `read_file`, `list_dir`, `bash`.
///
/// Each goes through the registry's gates like any other tool; inside `run`, the file tools resolve their
/// path with the sandbox under the call's mode (a refusal is `SANDBOX`), and `bash` confines its exact argv
/// or refuses with `SANDBOX_UNAVAILABLE` — never runs unconfined in a confined mode.
pub fn builtin_tools(sandbox: Arc<dyn SandboxGate>, options: BuiltinOptions) -> Vec<Arc<dyn Tool>> {
    todo!("port builtinTools: write_file, read_file, list_dir, bash")
}

/// The two schema fields a mutating tool advertises when the sandbox can confine: `sandbox_permissions`
/// (an enum of [`SandboxGate::escalation_targets`]) and `justification`. Empty when nothing can confine,
/// because an offered escalation a host cannot enforce is a prompt whose grant could not run.
pub fn escalation_fields(sandbox: &dyn SandboxGate) -> serde_json::Map<String, serde_json::Value> {
    todo!("port escalationFields")
}

/// Cut a command's combined output at [`BASH_OUTPUT_LIMIT`] characters, marking the cut with
/// `"\n… truncated"`.
///
/// The TypeScript build counts UTF-16 code units; this counts `char`s, so a cut never splits a character.
/// The two agree on every ASCII output, which is what the verifiers produce.
pub fn truncate_output(combined: &str) -> String {
    todo!("port the 20 000-character cut of the bash tool")
}
