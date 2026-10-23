//! The deterministic backend the checks run against, and the reason they spend nothing.
//!
//! Ported from `scriptedAdapter` in `src/llm/adapters.ts`. The endpoint's `baseUrl` names a JSON file
//! `{"steps": [...]}` (a leading `~` is the home directory). It reads no clock and calls nothing.
//!
//! - Steps are filtered by **purpose** (`step.purpose`, default `"turn"`, against `request.purpose`, default
//!   `"turn"`) and then handed out by **round** (`request.round`, default 0): one step per call, so a script is a
//!   sequence, not a repeat. A missing step answers nothing and finishes `stop`.
//! - A step may carry `reasoning`, `text`, `toolCall: {name, arguments}` (emitted as id `call-<name>` with the
//!   arguments re-serialized), `finishReason` (default `tool_calls` with a call, else `stop`), or
//!   `error: {code?, status?, message?}`, which fails the call instead (code default `SCRIPT`).
//! - The file is read on every call, so a check may rewrite it between turns.

use std::path::PathBuf;

use crate::adapter::{Adapter, ChunkStream};
use crate::endpoint::EndpointConfig;
use crate::error::ModelError;
use crate::types::{Chunk, GenerateRequest};

/// The scripted adapter for one endpoint.
#[derive(Debug, Clone)]
pub struct ScriptedAdapter {
    endpoint: EndpointConfig,
}

impl ScriptedAdapter {
    pub fn new(endpoint: EndpointConfig) -> Self {
        Self { endpoint }
    }
}

impl Adapter for ScriptedAdapter {
    fn endpoint(&self) -> &EndpointConfig {
        &self.endpoint
    }

    fn stream(&self, request: GenerateRequest) -> ChunkStream {
        let _ = request;
        todo!("port scriptedAdapter")
    }
}

/// The script's path: `base_url` with a leading `~` replaced by the home directory.
pub fn script_path(base_url: &str) -> PathBuf {
    let _ = base_url;
    todo!("port the ~ expansion")
}

/// Read and parse the script (`SCRIPT` when it cannot be read or is not JSON). Steps are kept as raw JSON so a
/// malformed step reads as an empty one, as it does in the TypeScript build.
pub fn load_script(endpoint: &EndpointConfig) -> Result<serde_json::Value, ModelError> {
    let _ = endpoint;
    todo!("port the script read")
}

/// The chunks one call produces from a parsed script, or the error its step names.
pub fn scripted_chunks(
    script: &serde_json::Value,
    request: &GenerateRequest,
    endpoint_name: &str,
) -> Result<Vec<Chunk>, ModelError> {
    let _ = (script, request, endpoint_name);
    todo!("port the step selection and emission")
}
