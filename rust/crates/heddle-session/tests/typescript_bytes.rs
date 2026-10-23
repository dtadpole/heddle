//! The byte contract, checked against the TypeScript build's own serializer.
//!
//! `heddle-session`'s whole compatibility claim is that an event line is what `JSON.stringify` writes and
//! a meta or definition file is `JSON.stringify(value, null, 2)` plus a newline. Fixed fixtures pin the
//! shapes this build writes today; these tests ask the oracle — the Node on this machine — to serialize
//! the same values and compare the bytes, which is what catches an escaping or number-formatting
//! difference that a fixture written by hand would have copied rather than found.
//!
//! Numbers are limited to the ones the store writes (positions, counts, sizes, booleans) plus simple
//! decimals: the log never carries an arbitrary float, and requiring `1e21` and `0.30000000000000004` to
//! print alike would test a contract nobody made. Everything else — unicode, escapes, nesting, key order
//! — is judged byte for byte.
//!
//! Where Node is absent these tests report skipped rather than failing: a missing oracle is not a failing
//! port, and the fixed fixtures still hold the shape.

use std::path::PathBuf;
use std::process::Command;

/// One value for the oracle to serialize.
struct Case {
    /// The JSON text the oracle parses (raw unicode allowed; it is normalized on both sides).
    text: String,
    /// `JSON.stringify(value, null, 2)` rather than `JSON.stringify(value)`.
    pretty: bool,
}

/// Serialize every case with the Node on this machine, or `None` when there is no Node.
fn oracle(cases: &[Case]) -> Option<Vec<String>> {
    if cases.is_empty() {
        return Some(Vec::new());
    }
    let directory = tempfile::tempdir().ok()?;
    let input = directory.path().join("cases.json");
    let payload: Vec<serde_json::Value> = cases
        .iter()
        .map(|case| serde_json::json!({ "text": case.text, "pretty": case.pretty }))
        .collect();
    std::fs::write(&input, serde_json::to_vec(&payload).ok()?).ok()?;
    let script = directory.path().join("stringify.mjs");
    std::fs::write(
        &script,
        r#"
import { readFileSync } from 'node:fs'
const cases = JSON.parse(readFileSync(process.argv[2], 'utf8'))
process.stdout.write(JSON.stringify(cases.map((one) => {
  const value = JSON.parse(one.text)
  return one.pretty ? JSON.stringify(value, null, 2) + '\n' : JSON.stringify(value)
})) + '\n')
"#,
    )
    .ok()?;
    let output = match Command::new("node").arg(&script).arg(&input).output() {
        Ok(output) => output,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            eprintln!("skipping: node is not installed, so the serializer oracle cannot be run");
            return None;
        }
        Err(error) => panic!("running node failed: {error}"),
    };
    assert!(
        output.status.success(),
        "the oracle failed\nstdout: {}\nstderr: {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).expect("the oracle prints UTF-8");
    Some(
        serde_json::from_str::<Vec<String>>(stdout.trim())
            .unwrap_or_else(|error| panic!("the oracle printed no JSON ({error}): {stdout}")),
    )
}

/// The repository's encoder module, should a test ever need to name it.
fn typescript_transcript() -> PathBuf {
    let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    path.pop();
    path.pop();
    path.pop();
    path.join("src/session/transcript.ts")
}

/// The values the store actually writes, plus the escaping and ordering that are easy to get wrong.
fn cases() -> Vec<(String, bool)> {
    vec![
        // A plain event: the three leading keys, then one field.
        (
            r#"{"seq":0,"at":"2026-10-22T18:17:41.123Z","type":"session/created","cwd":"/home/me/work"}"#
                .to_string(),
            false,
        ),
        // Raw non-ASCII: neither serializer escapes it, and an astral character must stay one pair.
        (
            r#"{"seq":1,"at":"2026-10-22T18:17:42.456Z","type":"message","message":{"role":"user","content":[{"type":"text","text":"项目 😀 café"}]}}"#.to_string(),
            false,
        ),
        // The escaping that matters: quote, backslash, the newline and tab, a C0 control, and DEL.
        (
            "{\"seq\":2,\"at\":\"2026-10-22T18:17:43.789Z\",\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"a\\\"b\\\\c\\nd\\te\\u0001f\\u007fg\"}]}}".to_string(),
            false,
        ),
        // Nesting with the empties, null and booleans, and a key order that is not alphabetical.
        (
            r#"{"seq":3,"at":"2026-10-22T18:17:44.000Z","type":"model/request","endpoint":"alpha","messages":2,"tools":["read_file","write_file"],"breakdown":{"system":10,"tools":[1,2],"messages":{}},"compacted":false,"pruned":null}"#
                .to_string(),
            false,
        ),
        // The characters two JSON writers are most likely to disagree about: the line separators
        // (which ES2019 leaves raw), C1 controls, a no-break space, a byte-order mark, and the
        // shorthand/\u escapes.
        (
            "{\"seq\":4,\"at\":\"2026-10-22T18:17:46.000Z\",\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"a\\u2028b\\u2029c\\u0085d\\u00a0e\\ufefff\\u000bg\\u001fh\"}]}}".to_string(),
            false,
        ),
        // A key that needs escaping, and an integer at JavaScript's exact-integer boundary.
        (
            "{\"seq\":9007199254740991,\"at\":\"2026-10-22T18:17:45.000Z\",\"type\":\"turn/retry\",\"round\":2,\"note key\":\"has a space\",\"decimal\":0.5,\"other\":2.25}".to_string(),
            false,
        ),
    ]
}

#[test]
fn an_event_line_is_what_the_oracle_writes() {
    let cases = cases();
    let oracle_cases: Vec<Case> = cases
        .iter()
        .map(|(text, pretty)| Case {
            text: text.clone(),
            pretty: *pretty,
        })
        .collect();
    let Some(expected) = oracle(&oracle_cases) else {
        return;
    };
    for ((text, _), expected) in cases.iter().zip(expected) {
        let event = heddle_session::SessionEvent::from_line(text)
            .unwrap_or_else(|error| panic!("the fixture does not parse ({error}): {text}"));
        assert_eq!(
            event.to_line(),
            expected,
            "the event line differs from JSON.stringify for {text}"
        );
    }
}

/// Meta records, whose bytes are `JSON.stringify(value, null, 2)` plus a newline.
fn meta_cases() -> Vec<String> {
    vec![
        r#"{"id":"session-0000","created":"2026-10-22T18:17:41.123Z","cwd":"/home/me/work","turns":0}"#
            .to_string(),
        r#"{"id":"session-0001","created":"2026-10-22T18:17:41.123Z","cwd":"/项目/café 😀","title":"remember the word loom","turns":3,"pinned":true,"pinnedAt":"2026-10-22T18:18:00.000Z","custom":{"kept":[1,2,3],"empty":{}}}"#
            .to_string(),
        "{\"id\":\"session-0002\",\"created\":\"2026-10-22T18:17:41.123Z\",\"cwd\":\"/x\",\"title\":\"a\\\"b\\\\c\\nd\\te\",\"turns\":1}".to_string(),
    ]
}

#[test]
fn a_meta_file_is_what_the_oracle_pretty_prints() {
    let texts = meta_cases();
    let cases: Vec<Case> = texts
        .iter()
        .map(|text| Case {
            text: text.clone(),
            pretty: true,
        })
        .collect();
    let Some(expected) = oracle(&cases) else {
        return;
    };
    for (text, expected) in texts.iter().zip(expected) {
        let value: serde_json::Value = serde_json::from_str(text).expect("the fixture parses");
        let meta = heddle_session::SessionMeta::from_value(value).expect("the fixture has an id");
        assert_eq!(
            meta.to_file_text(),
            expected,
            "the meta file differs from JSON.stringify(_, null, 2) for {text}"
        );
        // And the record reads back to the same bytes, so an edit cannot silently reorder it.
        let reparsed: serde_json::Value =
            serde_json::from_str(&meta.to_file_text()).expect("the file is JSON");
        let again = heddle_session::SessionMeta::from_value(reparsed).unwrap();
        assert_eq!(again.to_file_text(), expected);
    }
}

#[test]
fn a_timestamp_is_what_the_oracle_prints() {
    // Reading the oracle here means asking Node for `new Date(ms).toISOString()` on the same instants.
    let millis: [i64; 6] = [
        0,
        1,
        123,
        -1,
        1_700_000_000_123,
        253_402_300_799_999, // 9999-12-31T23:59:59.999Z, the last four-digit year
    ];
    let directory = match tempfile::tempdir() {
        Ok(directory) => directory,
        Err(_) => return,
    };
    let script = directory.path().join("iso.mjs");
    if std::fs::write(
        &script,
        r#"
const millis = JSON.parse(process.argv[2])
process.stdout.write(JSON.stringify(millis.map((ms) => new Date(ms).toISOString())) + '\n')
"#,
    )
    .is_err()
    {
        return;
    }
    let output = match Command::new("node")
        .arg(&script)
        .arg(serde_json::to_string(&millis).expect("millis is JSON"))
        .output()
    {
        Ok(output) => output,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            eprintln!("skipping: node is not installed, so the timestamp oracle cannot be run");
            return;
        }
        Err(error) => panic!("running node failed: {error}"),
    };
    assert!(
        output.status.success(),
        "the timestamp oracle failed\nstderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let expected: Vec<String> =
        serde_json::from_slice(&output.stdout).expect("the oracle prints a JSON array");
    for (ms, expected) in millis.iter().zip(expected) {
        let instant = chrono::DateTime::from_timestamp_millis(*ms)
            .unwrap_or_else(|| panic!("chrono cannot hold {ms}"));
        assert_eq!(
            heddle_session::clock::iso_from(instant),
            expected,
            "the ISO spelling differs from toISOString for {ms} ms"
        );
    }

    // The TypeScript decoder module this suite also uses stays resolvable, so a checkout moved out of
    // the repository fails here rather than in the interop test.
    assert!(
        typescript_transcript().exists(),
        "{} is not here",
        typescript_transcript().display()
    );
}

/// A small deterministic generator, so a failure is reproducible from the seed in the message.
struct Lcg(u64);

impl Lcg {
    fn next(&mut self) -> u32 {
        // Numerical Recipes' constants, truncated to 32 bits: enough to pick code points.
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        (self.0 >> 33) as u32
    }

    fn pick<'a, T>(&mut self, values: &'a [T]) -> &'a T {
        &values[(self.next() as usize) % values.len()]
    }
}

#[test]
fn generated_text_matches_the_oracle() {
    // Ranges chosen for what a conversation actually carries and what an encoder can get wrong: the
    // C0 controls, the ASCII printable range with its quotes and backslashes, Latin-1, a combining
    // mark, Hebrew, CJK, the line separators, and two astral ranges (emoji and mathematical letters).
    let ranges: [(u32, u32); 9] = [
        (0x00, 0x1f),
        (0x20, 0x7e),
        (0xa0, 0xff),
        (0x0300, 0x036f),
        (0x0590, 0x05ff),
        (0x4e00, 0x4e20),
        (0x2028, 0x2029),
        (0x1f300, 0x1f64f),
        (0x1d400, 0x1d7ff),
    ];
    let fixed = [
        '"', '\\', '\n', '\t', '\r', '\u{0}', '\u{1f}', '\u{7f}', '\u{feff}',
    ];
    let mut rng = Lcg(0x5eed_1e55_0f8e_0011);
    let mut cases = Vec::new();
    for index in 0..40u64 {
        let mut text = String::new();
        for _ in 0..12 {
            if rng.next().is_multiple_of(3) {
                text.push(*rng.pick(&fixed));
                continue;
            }
            let (low, high) = *rng.pick(&ranges);
            let mut code = low + rng.next() % (high - low + 1);
            // Skip the surrogate range: a Rust string cannot hold one, and the encoder only meets
            // them when a JavaScript writer produced an unpaired escape.
            if (0xd800..=0xdfff).contains(&code) {
                code = 0x41;
            }
            if let Some(character) = char::from_u32(code) {
                text.push(character);
            }
        }
        cases.push(format!(
            r#"{{"seq":{index},"at":"2026-10-22T18:17:47.000Z","type":"message","message":{{"role":"user","content":[{{"type":"text","text":{}}}]}}}}"#,
            serde_json::to_string(&text).expect("a string is JSON")
        ));
    }
    let oracle_cases: Vec<Case> = cases
        .iter()
        .map(|text| Case {
            text: text.clone(),
            pretty: false,
        })
        .collect();
    let Some(expected) = oracle(&oracle_cases) else {
        return;
    };
    for ((text, expected), index) in cases.iter().zip(expected).zip(0..) {
        let event = heddle_session::SessionEvent::from_line(text).unwrap_or_else(|error| {
            panic!("generated case {index} does not parse ({error}): {text}")
        });
        assert_eq!(
            event.to_line(),
            expected,
            "generated case {index} differs from JSON.stringify: {text}"
        );
    }
}

/// The `model/request` record, built by Node exactly as the TypeScript build builds it: the store's
/// `{ seq, at, ...event }` around the agent loop's literal (`src/agent/loop.ts`, `modelRequest(...)`), with
/// its conditional spreads. The key order on disk comes from that literal, not from any type declaration,
/// so this is the check that `ModelRequestRecord`'s field order is the loop's.
#[test]
fn a_model_request_line_is_what_the_typescript_loop_writes() {
    use heddle_session::{ModelRequestBreakdown, ModelRequestRecord, SessionStore};

    let home = match tempfile::tempdir() {
        Ok(home) => home,
        Err(_) => return,
    };
    let store = SessionStore::new(
        home.path().to_str().expect("a UTF-8 temp path"),
        &heddle_config::Env::default(),
    );
    let handle = store
        .create(heddle_session::CreateOptions {
            cwd: Some("/home/me/work".to_string()),
            ..Default::default()
        })
        .expect("a session");

    // Every field the loop can write, then the minimal record (no model, no level, no context facts).
    let full = ModelRequestRecord {
        endpoint: "scripted".to_string(),
        model: Some("m1".to_string()),
        reasoning_effort: Some("high".to_string()),
        messages: 3,
        tools: vec!["read_file".to_string(), "write_file".to_string()],
        estimated_tokens: Some(1200),
        threshold_tokens: Some(96000),
        pruned: Some(0),
        compacted: Some(false),
        breakdown: Some(ModelRequestBreakdown {
            system: Some(400),
            tools: Some(300),
            messages: Some(500),
        }),
        generation: Some(4),
    };
    let minimal = ModelRequestRecord {
        endpoint: "scripted".to_string(),
        messages: 1,
        tools: Vec::new(),
        ..Default::default()
    };
    let written: Vec<_> = [&full, &minimal]
        .iter()
        .map(|record| store.model_request(&handle, record).expect("an append"))
        .collect();

    let directory = match tempfile::tempdir() {
        Ok(directory) => directory,
        Err(_) => return,
    };
    let script = directory.path().join("model-request.mjs");
    std::fs::write(
        &script,
        r#"
const cases = JSON.parse(process.argv[2])
const lines = cases.map(({ seq, at, options, report, generation, tools, messages }) => {
  // src/agent/loop.ts: ctx.session.store.modelRequest(options.session, { ... })
  const request = {
    endpoint: options.endpoint,
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.reasoningEffort !== undefined ? { reasoningEffort: options.reasoningEffort } : {}),
    messages,
    tools,
    estimatedTokens: report.estimatedTokens,
    thresholdTokens: report.thresholdTokens,
    pruned: report.pruned,
    compacted: report.compacted,
    breakdown: report.breakdown,
    generation,
  }
  // src/session/store.ts: modelRequest appends { type: 'model/request', ...request }, and append writes
  // { seq, at, ...event }.
  return JSON.stringify({ seq, at, ...{ type: 'model/request', ...request } })
})
process.stdout.write(JSON.stringify(lines) + '\n')
"#,
    )
    .expect("the script is written");

    let cases = serde_json::json!([
        {
            "seq": written[0].seq, "at": written[0].at,
            "options": { "endpoint": "scripted", "model": "m1", "reasoningEffort": "high" },
            "messages": 3, "tools": ["read_file", "write_file"],
            "report": {
                "estimatedTokens": 1200, "thresholdTokens": 96000, "pruned": 0, "compacted": false,
                "breakdown": { "system": 400, "tools": 300, "messages": 500 }
            },
            "generation": 4
        },
        {
            "seq": written[1].seq, "at": written[1].at,
            "options": { "endpoint": "scripted" },
            "messages": 1, "tools": [],
            "report": {},
            "generation": null
        }
    ]);
    let output = match Command::new("node")
        .arg(&script)
        .arg(cases.to_string())
        .output()
    {
        Ok(output) => output,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            eprintln!("skipping: node is not installed, so the model/request oracle cannot be run");
            return;
        }
        Err(error) => panic!("running node failed: {error}"),
    };
    assert!(
        output.status.success(),
        "the model/request oracle failed\nstderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let expected: Vec<String> =
        serde_json::from_slice(&output.stdout).expect("the oracle prints a JSON array");

    // The minimal case passes `generation: null` to Node, which JSON.stringify would write; the loop always
    // has a generation, so the real minimal record omits only what the loop's spreads omit. Compare the full
    // case whole, and the minimal case with the absent `generation` removed on the oracle side.
    assert_eq!(
        written[0].to_line(),
        expected[0],
        "the full model/request line differs from the TypeScript loop's"
    );
    let minimal_expected = expected[1].replace(",\"generation\":null", "");
    assert_eq!(
        written[1].to_line(),
        minimal_expected,
        "the minimal model/request line differs from the TypeScript loop's"
    );
    // And the file holds exactly those bytes, framed: a reader of the log sees the oracle's line.
    let decoded = heddle_session::decode_transcript(&store.bytes(&handle));
    assert_eq!(decoded.lines[decoded.lines.len() - 2], expected[0]);
}
