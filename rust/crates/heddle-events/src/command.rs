//! `heddle hooks [--json]`: the command this crate owns (D-043), behind the binary's entry-point convention.
//!
//! The oracle is the `hooks` branch of `src/cli.ts`; `60-hooks`' first check runs `hooks --json`, parses the
//! array, and requires `model/request`, `model/stream`, `tools/pre-execute`, `tools/post-execute` and
//! `agent/pre-step`, with at least four waterfalls. The binary adds one dispatch line and the capability; the
//! text and the JSON are written here, from [`points`](crate::points).

use std::io::Write;

use crate::points::{hook_points_json, hook_points_text};

/// The command words this crate answers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Command {
    /// `hooks`: the hook points this build emits.
    Hooks,
}

/// The flags `hooks` reads, named after the TypeScript `Args` field.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Args {
    /// `--json`: `JSON.stringify(points, null, 2)` and a newline.
    pub json: bool,
}

/// What `hooks` runs against: nothing — the catalog is the build's, not the profile's, so the command answers
/// even when the configured tree is broken.
#[derive(Clone, Copy, Debug, Default)]
pub struct Context;

/// Write the answer to `out`; return the exit code. `0` done, `1` with `heddle: <sentence>` on `err` when the
/// answer cannot be written.
pub fn run(
    command: Command,
    args: &Args,
    context: &Context,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> i32 {
    let _ = context;
    match command {
        Command::Hooks => {
            let text = if args.json {
                hook_points_json()
            } else {
                hook_points_text()
            };
            match out.write_all(text.as_bytes()) {
                Ok(()) => 0,
                // A closed pipe is not the command's failure; anything else is said once.
                Err(error) if error.kind() == std::io::ErrorKind::BrokenPipe => 0,
                Err(error) => {
                    let _ = writeln!(err, "heddle: could not write the hook points: {error}");
                    1
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn answer(json: bool) -> (i32, String, String) {
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = run(Command::Hooks, &Args { json }, &Context, &mut out, &mut err);
        (
            code,
            String::from_utf8(out).unwrap(),
            String::from_utf8(err).unwrap(),
        )
    }

    #[test]
    fn hooks_json_is_what_the_hooks_verifier_parses() {
        let (code, out, err) = answer(true);
        assert_eq!(code, 0);
        assert_eq!(err, "");
        let points: serde_json::Value = serde_json::from_str(&out).unwrap();
        let points = points.as_array().expect("an array of points");
        let names: Vec<&str> = points
            .iter()
            .map(|point| point["name"].as_str().unwrap())
            .collect();
        for wanted in [
            "model/request",
            "model/stream",
            "tools/pre-execute",
            "tools/post-execute",
            "agent/pre-step",
        ] {
            assert!(names.contains(&wanted), "{wanted} is listed; saw {names:?}");
        }
        let waterfalls = points
            .iter()
            .filter(|point| point["mode"] == "waterfall")
            .count();
        assert!(
            waterfalls >= 4,
            "the rewriting points are waterfalls; saw {waterfalls}"
        );
        assert!(out.starts_with(
            "[\n  {\n    \"name\": \"agent/pre-step\",\n    \"mode\": \"waterfall\",\n"
        ));
        assert!(
            out.ends_with("}\n]\n"),
            "JSON.stringify(points, null, 2) and a newline"
        );
    }

    #[test]
    fn hooks_text_is_the_typescript_commands_bytes() {
        let (code, out, err) = answer(false);
        assert_eq!(code, 0);
        assert_eq!(err, "");
        assert_eq!(
            out,
            "heddle: 6 hook point(s)\n\
             \x20 agent/pre-step       waterfall  before a round request is built; may replace messages or tools\n\
             \x20 model/request        waterfall  before an adapter is chosen; may replace the request\n\
             \x20 model/stream         waterfall  around the adapter stream; may yield its own chunks\n\
             \x20 tools/pre-execute    waterfall  before a tool runs; may refuse it\n\
             \x20 tools/post-execute   waterfall  after a tool runs; may replace the result\n\
             \x20 session/event        emit       after an event reaches the session file\n"
        );
    }

    struct Failing(std::io::ErrorKind);

    impl Write for Failing {
        fn write(&mut self, _buf: &[u8]) -> std::io::Result<usize> {
            Err(std::io::Error::new(self.0, "no room"))
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn a_write_failure_is_said_once_and_a_closed_pipe_is_not_a_failure() {
        let mut err = Vec::new();
        let code = run(
            Command::Hooks,
            &Args::default(),
            &Context,
            &mut Failing(std::io::ErrorKind::Other),
            &mut err,
        );
        assert_eq!(code, 1);
        assert_eq!(
            String::from_utf8(err).unwrap(),
            "heddle: could not write the hook points: no room\n"
        );
        let mut err = Vec::new();
        let code = run(
            Command::Hooks,
            &Args::default(),
            &Context,
            &mut Failing(std::io::ErrorKind::BrokenPipe),
            &mut err,
        );
        assert_eq!(code, 0);
        assert!(err.is_empty());
    }
}
