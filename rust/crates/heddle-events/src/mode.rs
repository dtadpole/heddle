//! The dispatch modes, as Cordis names them.

use std::fmt;

use serde::{Deserialize, Serialize};

/// How one named event is dispatched — Cordis's `DispatchMode`.
///
/// Serialized lower-case (`"waterfall"`), which is the `mode` field `heddle hooks --json` prints and the
/// `60-hooks` verifier reads.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    /// Every listener runs synchronously; return values are ignored and nothing is awaited. Observation.
    Emit,
    /// Every listener runs concurrently and all are awaited; their failures are collected.
    Parallel,
    /// Listeners are awaited in order until one returns a value (Cordis's "bail value").
    Serial,
    /// Listeners run synchronously in order until one returns a value.
    Bail,
    /// Listeners are composed around a final default: each gets a [`Next`](crate::Next) and decides whether
    /// the rest of the chain runs. The mode a hook that rewrites or refuses is written in.
    Waterfall,
}

impl Mode {
    /// The lower-case name, as serialized.
    pub const fn as_str(self) -> &'static str {
        match self {
            Mode::Emit => "emit",
            Mode::Parallel => "parallel",
            Mode::Serial => "serial",
            Mode::Bail => "bail",
            Mode::Waterfall => "waterfall",
        }
    }
}

impl fmt::Display for Mode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::Mode;

    #[test]
    fn a_mode_serializes_as_the_name_cordis_and_the_verifier_use() {
        for (mode, name) in [
            (Mode::Emit, "emit"),
            (Mode::Parallel, "parallel"),
            (Mode::Serial, "serial"),
            (Mode::Bail, "bail"),
            (Mode::Waterfall, "waterfall"),
        ] {
            assert_eq!(mode.as_str(), name);
            assert_eq!(mode.to_string(), name);
            assert_eq!(serde_json::to_string(&mode).unwrap(), format!("\"{name}\""));
            assert_eq!(
                serde_json::from_str::<Mode>(&format!("\"{name}\"")).unwrap(),
                mode
            );
        }
    }
}
