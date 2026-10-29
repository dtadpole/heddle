---
title: The machine configuration file
version: 1.0.0
description: The shape of the machine-local endpoint file both builds read, with a worked example in the three wire formats, how a secret is referenced, and how a seat or a second service points at the same file.
grounded_in:
  - source: src/local-config.ts, src/endpoints.ts and src/llm/types.ts — the file's precedence, the endpoint ladder and the two-tier model catalogue
  - source: rust/crates/heddle-config/src/local.rs — the port reads the same file and refuses a mapping where a list belongs
  - source: a machine configured on 2026-10-29 by mirroring the provider list of a local DSH profile, then judged with this tool and 98-model-endpoints
---

# The machine configuration file

Endpoint addresses, model ids and anything credential-shaped belong to the **machine**, never to this repository.
Both builds read one JSON file from outside the checkout, first match wins:

1. `$HEDDLE_CONFIG`, when it is set and non-empty;
2. `$HEDDLE_HOME/heddle.json`, which is `~/.heddle/heddle.json` when `HEDDLE_HOME` is unset.

A missing file is not an error (the offline `scripted` default still boots); a file that is not a JSON object fails
loudly, naming the path.

## Example

Three endpoints, one per wire format this validation knows (Chat Completions, Responses, the Anthropic publisher
route). Every value is a placeholder.

```json
{
  "default": "deepseek-official",
  "exclude": ["scripted"],
  "endpoints": [
    {
      "name": "deepseek-official",
      "kind": "openai-chat",
      "baseUrl": "https://api.deepseek.com",
      "apiKeyFile": "/absolute/path/to/.heddle/keys/deepseek.api.key",
      "model": "deepseek-flash",
      "capabilities": ["tools", "reasoning"],
      "models": [
        {
          "id": "deepseek-flash",
          "name": "DeepSeek Flash",
          "reasoning": {
            "default": "high",
            "levels": [
              { "id": "low", "name": "Low", "value": "low" },
              { "id": "high", "name": "High", "value": "high" },
              { "id": "max", "name": "Max", "value": "max" }
            ]
          }
        }
      ]
    },
    {
      "name": "responses-gateway",
      "kind": "openai-responses",
      "baseUrl": "https://gateway.example.com/v1",
      "apiKeyFile": "/absolute/path/to/.heddle/keys/gateway.api.key",
      "model": "gpt-5",
      "maxOutputTokens": 32000,
      "models": [
        { "id": "gpt-5", "name": "GPT-5", "contextWindow": 272000, "reasoning": { "levels": [
          { "id": "low", "name": "Low", "value": "low" },
          { "id": "high", "name": "High", "value": "high" }
        ] } }
      ]
    },
    {
      "name": "claude-publisher",
      "kind": "anthropic-vertex",
      "baseUrl": "https://publisher.example.com/v1",
      "project": "example-project",
      "region": "global",
      "apiKeyFile": "/absolute/path/to/.heddle/keys/publisher.token",
      "model": "claude-sonnet-4-5",
      "inputModalities": ["text", "image"],
      "models": [
        { "id": "claude-sonnet-4-5", "name": "Claude Sonnet 4.5", "contextWindow": 200000, "reasoning": { "levels": [
          { "id": "low", "name": "Low", "value": "low" },
          { "id": "high", "name": "High", "value": "high" }
        ] } }
      ]
    }
  ]
}
```

## The rules the example follows

- **`endpoints` is a list** of endpoint objects. The doc comment in `src/local-config.ts` shows a mapping by name;
  the TypeScript model plugin iterates a list and the Rust port refuses a mapping with a sentence, so write a list.
- **`kind` is one of** `openai-chat` (`<baseUrl>/chat/completions`, effort as `reasoning_effort`, reasoning read
  from `reasoning_content`), `openai-responses` (`<baseUrl>/responses`, `reasoning.effort` plus
  `reasoning.summary`), `anthropic-vertex` (`<baseUrl>/projects/<project>/locations/<region>/publishers/anthropic/
  models/<model>:streamRawPredict`) or `scripted`. There is no plain Anthropic Messages kind (`<baseUrl>/v1/messages`):
  a gateway that only streams Claude incrementally on that route can be reached through its Chat Completions route,
  if it has one, but 98-model-endpoints will then judge the streaming it actually gets.
- **A secret is a path or a variable, never a value in the file.** `apiKeyFile` is read and trimmed at start and
  sent as `Authorization: Bearer`; keep the file mode 600 and give an **absolute** path, so a seat with another
  working directory or another `HEDDLE_HOME` reads the same file. The `HEDDLE_<ENDPOINT>_API_KEY` /
  `_API_KEY_FILE` environment overrides apply only to an endpoint that restates a default or a layer row, not to
  one this file alone declares (both builds), so for a machine endpoint the file path is the reference.
- **`models` is the catalogue the page's model pane shows**, in the declared order; `model` is the endpoint's
  default. A level's `value` is what goes on the wire; `value: null` is a displayed level that sends nothing. A
  model's own `reasoning` replaces the endpoint's rather than merging.
- **`contextWindow` and `inputModalities`**: declare them when the route does not publish them. Left out, the
  server asks the route's own model list (`/models`) and uses what it says.
- **`default`** names the endpoint a turn uses when nothing else does. The TypeScript build honours it; the Rust
  port currently reads the default only from the profile's model row, so its page shows no default for a file-only
  nomination.
- **`exclude`** removes endpoint names after every layer, including the repository's offline `scripted`.

## Pointing more than one service at one file

- A process with `HEDDLE_HOME` and `HEDDLE_CONFIG` unset reads `~/.heddle/heddle.json`.
- A service with its own `HEDDLE_HOME` (a preview, a scratch server) either sets `HEDDLE_CONFIG` to the machine
  file or links `$HEDDLE_HOME/heddle.json` to it. A link keeps one file to edit.
- The validation record (`model-validation.json`) is read from `$HEDDLE_HOME`, so run `npm run validate:endpoints`
  and `98-model-endpoints` with the same `HEDDLE_HOME` (usually unset).
- The server reads the file at start: restart a running server to pick up an edit.

## After an edit

Any change to an endpoint's name, kind, address, model ids or level values changes the fingerprint, so
`98-model-endpoints` fails until `npm run validate:endpoints` runs again (see [INDEX.md](INDEX.md)). A partial run
(`--endpoint`, `--model`) rewrites the record with only the models it ran, so finish with a full run.
