//! Environment references: how a value comes from the environment without being written into a tree.
//!
//! Ported from `referencesIn`, `resolveEnv` and `parseScalar` in `src/config/schema.ts`. Two shapes,
//! and the distinction between them is the point:
//!
//! - `!env NAME` — the **whole** value, read so a number stays a number and a boolean a boolean
//!   (`count: !env COUNT` with `COUNT=7` is the number `7`). This is what a port or a flag needs.
//! - `${NAME}` inside a string — textual substitution (`${PREFIX}/v1`). This is what a URL needs.
//!
//! A missing variable is an **error naming it**, never an empty string: a configuration that silently
//! resolves a missing credential to `''` fails somewhere much further away.

use serde_json::Value;

use crate::env::Env;
use crate::error::ConfigError;
use crate::value::LayerValue;

/// Every `${NAME}` reference in `text`, in order, repeats included. A name is
/// `[A-Za-z_][A-Za-z0-9_]*`; anything else between `${` and `}` is not a reference and stays as written.
pub fn references_in(text: &str) -> Vec<String> {
    let _ = text;
    todo!("heddle-config: references_in")
}

/// `value` with every reference resolved, as JSON.
///
/// `file` names the layer in a problem: `{file}: the environment reference !env NAME is not set`, or
/// `${NAME}` for the textual shape; `{file}: include is only allowed as a layer entry, not inside a
/// value` for an [`LayerValue::Include`]. The first problem found is returned.
pub fn resolve_env(value: &LayerValue, file: &str, env: &Env) -> Result<Value, ConfigError> {
    let _ = (value, file, env);
    todo!("heddle-config: resolve_env")
}

/// What an environment string spells, as the TypeScript `parseScalar` read it: `true`, `false` and
/// `null` (after trimming) are those values; an optionally negative decimal integer or fraction
/// (`-?\d+(\.\d+)?`, after trimming) is a number; anything else is the string **untrimmed**.
pub fn parse_scalar(raw: &str) -> Value {
    let _ = raw;
    todo!("heddle-config: parse_scalar")
}
