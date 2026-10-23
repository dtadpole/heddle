//! The `tools` and `commands` commands, in the owning crate (D-043).
//!
//! Ported from `runCommand` in `src/cli.ts`. The binary boots the tree, reports failed rows, and dispatches
//! here with the composed registry; this module applies the allow list (the TypeScript `applyToolAllowList`,
//! which runs before every one-shot command) and prints, byte for byte as the TypeScript build does:
//!
//! - `tools`: `heddle: <n> tool(s)`, then `  <name padded to 14> <the description up to its first period>`;
//!   `--json` is `[{ "name", "description" }]`, pretty-printed with two spaces.
//! - `commands`: `heddle: <n> command(s)`, then `  <name padded to 14> — <description>`; `--json` is the same
//!   records.
//!
//! The entry point reads nothing from the process: the binary passes the streams and the registry.

use std::io::Write;

use serde::Serialize;

use crate::registry::ToolRegistry;

/// The command words this crate answers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Command {
    /// `heddle tools`: the tools a turn may call, after the allow list.
    Tools,
    /// `heddle commands`: the commands the registry holds.
    Commands,
}

/// The flags these commands read, named after the TypeScript `Args` fields.
#[derive(Clone, Debug, Default)]
pub struct Args {
    /// `--json`.
    pub json: bool,
}

/// What the commands run against: the booted tree's registry.
pub struct Context<'a> {
    /// The `tools` row's registry, with every plugin and outside component registered.
    pub registry: &'a ToolRegistry,
}

/// One listed tool: the two fields the TypeScript command prints, in its order.
#[derive(Serialize)]
struct Listed<'a> {
    name: &'a str,
    description: &'a str,
}

/// `JSON.stringify(value, null, 2)` followed by a newline.
fn write_json(out: &mut dyn Write, value: &impl Serialize) -> std::io::Result<()> {
    let text = serde_json::to_string_pretty(value).map_err(std::io::Error::other)?;
    writeln!(out, "{text}")
}

/// Run one command; the process exit code.
pub fn run(
    command: Command,
    args: &Args,
    context: &Context<'_>,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> i32 {
    let registry = context.registry;
    // Applied once the tree has loaded, before any command reads the registry; idempotent.
    registry.filter_to(registry.allow_list());
    let written = match command {
        Command::Tools => tools(registry, args, out),
        Command::Commands => commands(registry, args, out),
    };
    match written {
        Ok(()) => 0,
        Err(error) => {
            let _ = writeln!(err, "heddle: {error}");
            1
        }
    }
}

fn tools(registry: &ToolRegistry, args: &Args, out: &mut dyn Write) -> std::io::Result<()> {
    let specs = registry.describe();
    if args.json {
        let listed: Vec<Listed<'_>> = specs
            .iter()
            .map(|spec| Listed {
                name: &spec.name,
                description: &spec.description,
            })
            .collect();
        return write_json(out, &listed);
    }
    writeln!(out, "heddle: {} tool(s)", specs.len())?;
    for spec in &specs {
        // `description.split('.')[0]`: up to the first period, the whole text when there is none.
        let first = spec.description.split('.').next().unwrap_or_default();
        writeln!(out, "  {:<14} {first}", spec.name)?;
    }
    Ok(())
}

fn commands(registry: &ToolRegistry, args: &Args, out: &mut dyn Write) -> std::io::Result<()> {
    let commands = registry.describe_commands();
    if args.json {
        return write_json(out, &commands);
    }
    writeln!(out, "heddle: {} command(s)", commands.len())?;
    for command in &commands {
        writeln!(out, "  {:<14} — {}", command.name, command.description)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use futures::future::BoxFuture;

    use super::*;
    use crate::config::ToolsConfig;
    use crate::registry::tests::gates;
    use crate::tool::{Command as RegistryCommand, ToolContext, ToolResult, tool_fn};
    use crate::upstream::{SandboxMode, ToolSpec};

    fn run_to_strings(command: Command, json: bool, registry: &ToolRegistry) -> (i32, String) {
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = run(
            command,
            &Args { json },
            &Context { registry },
            &mut out,
            &mut err,
        );
        assert!(err.is_empty(), "{}", String::from_utf8_lossy(&err));
        (code, String::from_utf8(out).unwrap())
    }

    fn registry(allow: &[&str]) -> ToolRegistry {
        ToolRegistry::from_config(
            gates(SandboxMode::WorkspaceWrite),
            &ToolsConfig {
                allow: allow.iter().map(|name| (*name).to_owned()).collect(),
                ..ToolsConfig::default()
            },
        )
    }

    #[test]
    fn only_the_tools_the_configuration_allows_are_listed_with_a_readable_description() {
        // 40-pluggable-tools: `--profile <p> tools --json` with `allow: [read_file]` lists exactly that tool,
        // and its description is longer than ten characters.
        let (code, out) = run_to_strings(Command::Tools, true, &registry(&["read_file"]));
        assert_eq!(code, 0);
        let listed: Vec<serde_json::Value> = serde_json::from_str(&out).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0]["name"], "read_file");
        assert!(listed[0]["description"].as_str().unwrap().len() > 10);
        assert_eq!(
            listed[0].as_object().unwrap().keys().collect::<Vec<_>>(),
            ["name", "description"],
            "only the two fields the TypeScript command prints"
        );
    }

    #[test]
    fn the_json_listing_is_pretty_printed_with_two_spaces_and_a_newline() {
        let (_, out) = run_to_strings(Command::Tools, true, &registry(&["list_dir"]));
        assert_eq!(
            out,
            "[\n  {\n    \"name\": \"list_dir\",\n    \"description\": \"List the entries of a directory inside the workspace, one per line, directories marked with a trailing slash.\"\n  }\n]\n"
        );
    }

    #[test]
    fn the_text_listing_pads_the_name_and_cuts_the_description_at_its_first_period() {
        let (code, out) = run_to_strings(Command::Tools, false, &registry(&[]));
        assert_eq!(code, 0);
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines[0], "heddle: 4 tool(s)");
        assert_eq!(
            lines[1],
            "  write_file     Write text to a file, creating parent directories as needed"
        );
        assert_eq!(lines[4].split_whitespace().next(), Some("bash"));
        assert!(lines[4].starts_with("  bash           Run a shell command"));
    }

    #[test]
    fn a_replacement_registered_under_a_taken_name_is_the_one_listed() {
        // 40-pluggable-tools: exactly one `read_file`, described as the replacement.
        let registry = registry(&["read_file", "shadow_read"]);
        registry
            .register(tool_fn(
                ToolSpec {
                    name: "read_file".into(),
                    description: "the project's own read_file, which wins".into(),
                    parameters: serde_json::json!({ "type": "object", "properties": {} }),
                },
                |_args, _ctx| Box::pin(async { Ok(ToolResult::ok("the replacement ran")) }),
            ))
            .unwrap();
        let (_, out) = run_to_strings(Command::Tools, true, &registry);
        let listed: Vec<serde_json::Value> = serde_json::from_str(&out).unwrap();
        let read_file: Vec<_> = listed
            .iter()
            .filter(|tool| tool["name"] == "read_file")
            .collect();
        assert_eq!(read_file.len(), 1);
        assert!(
            read_file[0]["description"]
                .as_str()
                .unwrap()
                .contains("wins")
        );
    }

    struct Echo;

    impl RegistryCommand for Echo {
        fn name(&self) -> &str {
            "echo"
        }
        fn description(&self) -> &str {
            "say it back"
        }
        fn run<'a>(&'a self, args: Vec<String>, _: ToolContext) -> BoxFuture<'a, ToolResult> {
            Box::pin(async move { ToolResult::ok(args.join(" ")) })
        }
    }

    #[test]
    fn commands_are_listed_with_an_em_dash_or_as_json_records() {
        let registry = registry(&[]);
        let (code, out) = run_to_strings(Command::Commands, false, &registry);
        assert_eq!(code, 0);
        assert_eq!(out, "heddle: 0 command(s)\n");
        registry.register_command(Arc::new(Echo));
        let (_, out) = run_to_strings(Command::Commands, false, &registry);
        assert_eq!(
            out,
            "heddle: 1 command(s)\n  echo           — say it back\n"
        );
        let (_, out) = run_to_strings(Command::Commands, true, &registry);
        assert_eq!(
            out,
            "[\n  {\n    \"name\": \"echo\",\n    \"description\": \"say it back\"\n  }\n]\n"
        );
    }
}
