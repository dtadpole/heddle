---
title: The outside-component protocol
version: 0.2.0
description: How the Rust heddle binary speaks to an outside tool (part 4) and, later, an outside hook listener (part 6) — a process declared in configuration, spoken to as line-delimited JSON-RPC 2.0 on stdio.
grounded_in:
  - source: rust/ULTIMATE_GOAL.md, part 4 (an outside tool is a process declared in configuration, spoken to as line-delimited JSON on stdio) and part 6 (an outside listener uses the part-4 protocol)
  - source: _verifiers_/40-pluggable-tools/check-tools.mjs, the out-of-repository, shadowing and malformed-spec checks this protocol must let a process satisfy
  - source: src/tools/service.ts and src/plugins/tools.ts, the registration rule and gate order an outside tool goes through
---

# The outside-component protocol

The TypeScript build loads an outside tool as a module named by a layer file and lets it call
`ctx.tools.register` and `ctx.sandbox.assertWritable` in process. The Rust binary cannot load a module, so an
outside component is **a process**: configuration declares it, the binary starts it, and this protocol carries
what the module did in process. The types are [`src/protocol.rs`](src/protocol.rs); starting and forwarding is
[`src/outside.rs`](src/outside.rs).

## Framing

- One **JSON-RPC 2.0** message per line, UTF-8, terminated by `\n`. JSON escapes newlines inside strings, so a
  line never contains a raw one.
- Host → component on the child's **stdin**; component → host on its **stdout**. **stderr** is free text that the
  host logs as `outside <row>: <line>`; it is never parsed.
- Each side numbers its own requests; the two id spaces are independent. A line that is not a JSON-RPC 2.0
  message is a protocol error: the host logs it and fails the call it was waiting on.
- The child's environment is the host's plus the row's `env`, plus `HEDDLE_COMPONENT_PROTOCOL=heddle-component/1`.
  Its working directory is the folder of its **component manifest** (`<name>.component.yml`: `program`, `args`,
  `config`), so the arguments a manifest writes relative to itself (`args: [./tool.mjs]`) resolve wherever the
  manifest is referenced from. Every error, log line and `initialize` names the configuration **row's id**, the same
  name `config --validate` and the boot's failed-row report use — not the manifest's file name.

## Lifecycle

1. **`initialize`** (request, host → component), the first message:
   `{"protocol":"heddle-component/1","row":"<row id>","config":<the row's config>,"workspaceRoot":"/abs","mode":"workspace-write"}`.
   The component answers `{"tools":[{"name","description","parameters"}, ...]}` — and, for part 6, `"listeners"`,
   whose entries `heddle-events` defines. No answer within 10 s fails the row.
2. **Registration.** Each declared tool goes through `ToolRegistry::register`, the rule a built-in obeys: a blank
   name or description **fails the row** with the registry's sentence (`a tool must be registered with a name`,
   `the tool '<name>' must be registered with a description`), so the run fails where the configuration is
   written; a name already taken **displaces** the earlier tool in place; the allow list judges it like any other.
3. **Calls** — see below — for as long as the binary runs.
4. **`shutdown`** (request, answered `null`), then **`exit`** (notification). The host kills a process that has
   not exited 2 s after each step. A process that exits early fails every pending call and every later one with
   `TOOL_FAILED` naming the row; it is not restarted.

## A call

Every gate runs **in the host before the component sees the call**: unknown name, approval, `tools/pre-execute`,
escalation, and the mode resolution. The component is then sent:

```json
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"shout","args":{"text":"from the plugin"},
 "context":{"cwd":"/abs/work","mode":"workspace-write","session":"<id>","workspaceRoot":"/abs/work"}}}
```

and answers with a tool result in its JSON shape — `{"output": "...", "error"?: {"code","message"}, "data"?: {...}}`:

```json
{"jsonrpc":"2.0","id":4,"result":{"output":"wrote shout.txt"}}
```

A JSON-RPC **error** answer becomes `TOOL_FAILED` with its message, unless its `data.code` is `"SANDBOX"`, which
becomes the `SANDBOX` refusal. The result then passes `tools/post-execute` in the host like any other.

**Stopping.** When the call's turn is stopped, the host sends `{"jsonrpc":"2.0","method":"$/cancelRequest","params":{"id":4}}`
and stops waiting. The component should end the work; any answer that arrives later is dropped.

## The back-channel

While a call runs, the component may ask the host what an in-process plugin asked `ctx.sandbox`:

```json
{"jsonrpc":"2.0","id":"s1","method":"sandbox/assertWritable","params":{"path":"shout.txt","call":4}}
```

`call` names the `tools/call` the question belongs to, and the path is judged under **that call's mode** (the
deployment mode when absent). Admitted: `{"result":{"path":"/abs/work/shout.txt"}}`. Refused: an error with code
`-32001` and `data: {"code":"SANDBOX","path","mode"}` — which the component can return as its call's error to
have the call reported as `SANDBOX`. `sandbox/assertReadable` is the same for reads.

`{"jsonrpc":"2.0","method":"log","params":{"message":"...","call":4}}` writes one line to the call's log.

## Error codes

JSON-RPC's own (`-32700` parse, `-32600` invalid request, `-32601` method not found, `-32602` invalid params,
`-32603` internal), plus `-32001` sandbox denied and `-32800` request cancelled.

## Reserved for part 6

`initialize`'s `listeners` field and the `hooks/call` method belong to `heddle-events`, which defines a listener
entry and the params and result per hook mode (`emit`, `parallel`, `bail`, `waterfall`). One process may provide
tools and listeners over one connection; `OutsideComponent::request` is public for that reason.

## The fixture this has to satisfy

`40-pluggable-tools`'s out-of-repository check, as a process: a script declared by a layer row registers
`shout` (`initialize` → `{"tools":[{"name":"shout","description":"Write a shout file containing the text, uppercased.","parameters":{...}}]}`),
and on `tools/call` asks `sandbox/assertWritable` for `shout.txt`, writes the upper-cased text there, and answers
`{"output":"wrote shout.txt"}`. The shadowing check is the same script declaring `read_file`; the malformed-spec
check declares `{"name":"","description":""}`.

## Read next

[`INDEX.md`](INDEX.md) for the crate and its port plan; [`../../ULTIMATE_GOAL.md`](../../ULTIMATE_GOAL.md) for the
parts.
