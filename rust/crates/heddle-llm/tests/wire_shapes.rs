//! The three wire shapes end to end: request builder, HTTP transport and fold, against local doubles.
//!
//! The unit tests judge each half separately (the builder's body, the fold's vocabulary). These drive the
//! whole path a verifier sees — a real socket speaking the provider's route — because the failure this
//! catches is the join: a request the route would refuse, a header the proxy would mangle, or a body the
//! fold cannot parse. Everything here is offline and spends nothing.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};

use futures::StreamExt;
use heddle_llm::{
    Chunk, ContentPart, EndpointConfig, EndpointKind, GenerateRequest, Message, ModelService, Role,
    StreamPrinter, StreamPrinterOptions, ToolCall, adapter_for, types::user_message,
};

/// A one-shot HTTP double in a background thread: reads each whole request (head and body), answers with
/// `reply`'s bytes, and keeps the request so a test can assert what went on the wire.
struct Double {
    base_url: String,
    seen: Arc<Mutex<Vec<String>>>,
}

impl Double {
    fn start(reply: impl Fn(&str) -> Vec<u8> + Send + Sync + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("binds a loopback port");
        let address = listener.local_addr().expect("has an address");
        let seen = Arc::new(Mutex::new(Vec::new()));
        let recorded = seen.clone();
        let reply = Arc::new(reply);
        std::thread::spawn(move || {
            for socket in listener.incoming() {
                let Ok(mut socket) = socket else { return };
                let recorded = recorded.clone();
                let reply = reply.clone();
                std::thread::spawn(move || {
                    let mut request = Vec::new();
                    let mut buffer = [0u8; 1024];
                    let mut head_end = None;
                    while head_end.is_none() {
                        match socket.read(&mut buffer) {
                            Ok(0) | Err(_) => break,
                            Ok(count) => {
                                request.extend_from_slice(&buffer[..count]);
                                head_end = request
                                    .windows(4)
                                    .position(|window| window == b"\r\n\r\n")
                                    .map(|at| at + 4);
                            }
                        }
                    }
                    if let Some(head_end) = head_end {
                        // The body follows the head; its length is stated by the client, since reqwest knows it.
                        let head =
                            String::from_utf8_lossy(&request[..head_end]).to_ascii_lowercase();
                        let length = head
                            .lines()
                            .find_map(|line| line.strip_prefix("content-length:"))
                            .and_then(|value| value.trim().parse::<usize>().ok())
                            .unwrap_or(0);
                        while request.len() < head_end + length {
                            match socket.read(&mut buffer) {
                                Ok(0) | Err(_) => break,
                                Ok(count) => request.extend_from_slice(&buffer[..count]),
                            }
                        }
                    }
                    let request = String::from_utf8_lossy(&request).into_owned();
                    recorded.lock().expect("records").push(request.clone());
                    let _ = socket.write_all(&reply(&request));
                    let _ = socket.flush();
                });
            }
        });
        Self {
            base_url: format!("http://{address}"),
            seen,
        }
    }

    fn requests(&self) -> Vec<String> {
        self.seen.lock().expect("reads").clone()
    }
}

fn reply(content_type: &str, body: &str) -> Vec<u8> {
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
    .into_bytes()
}

fn endpoint(name: &str, kind: EndpointKind, base_url: &str, model: &str) -> EndpointConfig {
    EndpointConfig {
        name: name.to_string(),
        kind,
        base_url: base_url.to_string(),
        model: Some(model.to_string()),
        models: None,
        reasoning: None,
        project: None,
        region: None,
        api_key: None,
        api_key_file: None,
        headers: None,
        stream: None,
        max_output_tokens: None,
        context_window: None,
        capabilities: None,
        input_modalities: None,
        proxy: None,
        timeout_ms: None,
    }
}

fn ask(name: &str, text: &str) -> GenerateRequest {
    GenerateRequest {
        endpoint: name.to_string(),
        messages: vec![user_message(text)],
        ..GenerateRequest::default()
    }
}

async fn collect(stream: heddle_llm::ChunkStream) -> Vec<Result<Chunk, heddle_llm::ModelError>> {
    stream.collect().await
}

#[tokio::test(flavor = "multi_thread")]
async fn the_chat_shape_streams_reasoning_content_and_an_assembled_tool_call() {
    let sse = concat!(
        "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"hm\"}}]}\n\n",
        "data: {\"choices\":[{\"delta\":{\"content\":\"an\"}}]}\n\n",
        "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"bash\",\"arguments\":\"{\\\"command\\\":\"}}]}}]}\n\n",
        "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"\\\"ls\\\"}\"}}]}}]}\n\n",
        "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":4}}\n\n",
        "data: [DONE]\n\n"
    );
    let double = Double::start(move |_| reply("text/event-stream", sse));
    let adapter = adapter_for(endpoint(
        "chat",
        EndpointKind::OpenaiChat,
        &double.base_url,
        "m",
    ))
    .expect("a chat adapter");
    let chunks = collect(adapter.stream(ask("chat", "go"))).await;
    assert_eq!(
        chunks
            .iter()
            .filter_map(|item| item.as_ref().ok())
            .cloned()
            .collect::<Vec<_>>(),
        vec![
            Chunk::ReasoningDelta { text: "hm".into() },
            Chunk::TextDelta { text: "an".into() },
            Chunk::ToolCallDelta {
                index: 0,
                id: Some("call_1".into()),
                name: Some("bash".into()),
                arguments_delta: "{\"command\":".into(),
            },
            Chunk::ToolCallDelta {
                index: 0,
                id: None,
                name: None,
                arguments_delta: "\"ls\"}".into(),
            },
            Chunk::ToolCall(ToolCall {
                id: "call_1".into(),
                name: "bash".into(),
                arguments: "{\"command\":\"ls\"}".into(),
            }),
            Chunk::Done {
                finish_reason: "tool_calls".into(),
                usage: Some(heddle_llm::TokenUsage {
                    input_tokens: Some(10),
                    output_tokens: Some(4),
                    ..heddle_llm::TokenUsage::default()
                }),
            },
        ]
    );
    let seen = double.requests().join("\n");
    assert!(
        seen.starts_with("POST /chat/completions HTTP/1.1"),
        "{seen}"
    );
    assert!(
        seen.to_lowercase()
            .contains("content-type: application/json"),
        "{seen}"
    );
    assert!(
        seen.contains("\"stream\":true"),
        "the body asks for a stream: {seen}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn the_chat_shape_reduces_a_json_only_answer_to_the_same_chunks() {
    let body = r#"{"choices":[{"message":{"reasoning_content":"hm","content":"plain answer"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}"#;
    let double = Double::start(move |_| reply("application/json", body));
    let mut endpoint = endpoint("chat", EndpointKind::OpenaiChat, &double.base_url, "m");
    endpoint.stream = Some(false);
    let adapter = adapter_for(endpoint).expect("a chat adapter");
    let chunks = collect(adapter.stream(ask("chat", "go"))).await;
    assert_eq!(
        chunks
            .iter()
            .filter_map(|item| item.as_ref().ok())
            .cloned()
            .collect::<Vec<_>>(),
        vec![
            Chunk::ReasoningDelta { text: "hm".into() },
            Chunk::TextDelta {
                text: "plain answer".into()
            },
            Chunk::Done {
                finish_reason: "stop".into(),
                usage: Some(heddle_llm::TokenUsage {
                    input_tokens: Some(3),
                    output_tokens: Some(2),
                    ..heddle_llm::TokenUsage::default()
                }),
            },
        ]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn the_responses_shape_streams_text_reasoning_and_a_restated_call() {
    let sse = concat!(
        "data: {\"type\":\"response.output_text.delta\",\"delta\":\"an\"}\n\n",
        "data: {\"type\":\"response.reasoning_summary_text.delta\",\"delta\":\"hm\"}\n\n",
        "data: {\"type\":\"response.output_item.added\",\"item\":{\"type\":\"function_call\",\"id\":\"fc_1\",\"call_id\":\"call_1\",\"name\":\"bash\"}}\n\n",
        "data: {\"type\":\"response.function_call_arguments.delta\",\"item_id\":\"fc_1\",\"delta\":\"{\\\"command\\\":\\\"ls\\\"}\"}\n\n",
        "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"usage\":{\"input_tokens\":5,\"output_tokens\":2},\"output\":[{\"type\":\"function_call\",\"call_id\":\"call_1\",\"name\":\"bash\",\"arguments\":\"{\\\"command\\\":\\\"ls\\\"}\"}]}}\n\n"
    );
    let double = Double::start(move |_| reply("text/event-stream", sse));
    let adapter = adapter_for(endpoint(
        "codex",
        EndpointKind::OpenaiResponses,
        &double.base_url,
        "m",
    ))
    .expect("a responses adapter");
    let chunks = collect(adapter.stream(ask("codex", "go"))).await;
    let chunks: Vec<Chunk> = chunks
        .into_iter()
        .map(|item| item.expect("streams"))
        .collect();
    assert_eq!(chunks.len(), 4, "{chunks:?}");
    assert_eq!(chunks[0], Chunk::TextDelta { text: "an".into() });
    assert_eq!(chunks[1], Chunk::ReasoningDelta { text: "hm".into() });
    assert_eq!(
        chunks[2],
        Chunk::ToolCall(ToolCall {
            id: "call_1".into(),
            name: "bash".into(),
            arguments: "{\"command\":\"ls\"}".into(),
        })
    );
    assert_eq!(
        chunks[3],
        Chunk::Done {
            finish_reason: "tool_calls".into(),
            usage: Some(heddle_llm::TokenUsage {
                input_tokens: Some(5),
                output_tokens: Some(2),
                ..heddle_llm::TokenUsage::default()
            }),
        }
    );
    let seen = double.requests().join("\n");
    assert!(seen.starts_with("POST /responses HTTP/1.1"), "{seen}");
    assert!(seen.contains("\"store\":false"), "{seen}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_body_that_ends_without_a_terminal_event_is_not_a_finished_answer() {
    let sse = "data: {\"type\":\"response.output_text.delta\",\"delta\":\"cut\"}\n\n";
    let double = Double::start(move |_| reply("text/event-stream", sse));
    let adapter = adapter_for(endpoint(
        "codex",
        EndpointKind::OpenaiResponses,
        &double.base_url,
        "m",
    ))
    .expect("a responses adapter");
    let chunks = collect(adapter.stream(ask("codex", "go"))).await;
    assert_eq!(
        chunks.last().and_then(|item| item.as_ref().ok()),
        Some(&Chunk::Done {
            finish_reason: "stream_ended".into(),
            usage: None
        })
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn the_anthropic_shape_streams_thinking_and_a_tool_use_block() {
    let sse = concat!(
        "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":12}}}\n\n",
        "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_1\",\"name\":\"list_dir\"}}\n\n",
        "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"path\\\":\\\".\\\"}\"}}\n\n",
        "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"text_delta\",\"text\":\"checking\"}}\n\n",
        "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":2,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"hm\"}}\n\n",
        "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"},\"usage\":{\"output_tokens\":7}}\n\n",
        "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"
    );
    let double = Double::start(move |_| reply("text/event-stream", sse));
    let mut endpoint = endpoint(
        "claude",
        EndpointKind::AnthropicVertex,
        &double.base_url,
        "claude-model",
    );
    endpoint.project = Some("a-project".into());
    endpoint.region = Some("global".into());
    let adapter = adapter_for(endpoint).expect("an anthropic adapter");
    let chunks = collect(adapter.stream(ask("claude", "go"))).await;
    let chunks: Vec<Chunk> = chunks
        .into_iter()
        .map(|item| item.expect("streams"))
        .collect();
    assert_eq!(
        chunks,
        vec![
            Chunk::TextDelta {
                text: "checking".into()
            },
            Chunk::ReasoningDelta { text: "hm".into() },
            Chunk::ToolCall(ToolCall {
                id: "toolu_1".into(),
                name: "list_dir".into(),
                arguments: "{\"path\":\".\"}".into(),
            }),
            Chunk::Done {
                finish_reason: "tool_calls".into(),
                usage: Some(heddle_llm::TokenUsage {
                    input_tokens: Some(12),
                    output_tokens: Some(7),
                    ..heddle_llm::TokenUsage::default()
                }),
            },
        ]
    );
    let seen = double.requests().join("\n");
    assert!(
        seen.starts_with(
            "POST /projects/a-project/locations/global/publishers/anthropic/models/claude-model:streamRawPredict HTTP/1.1"
        ),
        "{seen}"
    );
}

/// The stream a person watches: the same chunks, printed as they arrive, and counted for `--json`.
#[tokio::test(flavor = "multi_thread")]
async fn the_service_stream_can_be_printed_as_it_arrives() {
    let sse = concat!(
        "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"live reasoning\"}}]}\n\n",
        "data: {\"choices\":[{\"delta\":{\"content\":\"live content\"}}]}\n\n",
        "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
        "data: [DONE]\n\n"
    );
    let double = Double::start(move |_| reply("text/event-stream", sse));
    let service = ModelService::new(vec![endpoint(
        "chat",
        EndpointKind::OpenaiChat,
        &double.base_url,
        "m",
    )])
    .expect("registers the endpoint");
    let generated = service.generate(ask("chat", "go")).await.expect("answers");
    assert_eq!(generated.text, "live content");
    assert_eq!(generated.reasoning, "live reasoning");

    let printed = Arc::new(Mutex::new(String::new()));
    let sink = printed.clone();
    let mut printer = StreamPrinter::with_writer(StreamPrinterOptions::new("s1"), move |text| {
        sink.lock().expect("buffer").push_str(text);
    });
    let mut stream = service.stream(ask("chat", "go")).expect("streams");
    while let Some(item) = stream.next().await {
        let chunk = item.expect("streams");
        if let Chunk::Done { .. } = chunk {
            printer.observe("s1", &serde_json::json!({ "type": "assistant/completed" }));
            continue;
        }
        printer.observe(
            "s1",
            &serde_json::json!({ "type": "assistant/chunk", "chunk": chunk }),
        );
    }
    let summary = printer.summary();
    assert!(summary.text_deltas > 0, "{summary:?}");
    assert!(summary.reasoning_deltas > 0, "{summary:?}");
    assert!(summary.completed);
    let printed = printed.lock().expect("buffer").clone();
    assert!(printed.contains("[reasoning] live reasoning"), "{printed}");
    assert!(printed.contains("live content"), "{printed}");
}

#[test]
fn a_message_type_is_available_as_the_crate_exports_it() {
    // A compile-time check of the re-exports heddle-context and heddle-session build against.
    let message: Message = Message::new(Role::User, vec![ContentPart::text("hi")]);
    assert_eq!(message.role, Role::User);
}

/// A double that writes its answer in two stages, holding the end open, so "printed early" is measurable.
fn staged_double(first: Vec<u8>, rest: Vec<u8>, pause: std::time::Duration) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").expect("binds a loopback port");
    let address = listener.local_addr().expect("has an address");
    std::thread::spawn(move || {
        for socket in listener.incoming() {
            let Ok(mut socket) = socket else { return };
            let mut head = Vec::new();
            let mut buffer = [0u8; 1024];
            while !head.windows(4).any(|window| window == b"\r\n\r\n") {
                match socket.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(count) => head.extend_from_slice(&buffer[..count]),
                }
            }
            let _ = socket.write_all(&first);
            let _ = socket.flush();
            std::thread::sleep(pause);
            let _ = socket.write_all(&rest);
            let _ = socket.flush();
        }
    });
    format!("http://{address}")
}

/// The claim 20-streaming makes: a delta is seen before the provider has finished writing.
#[tokio::test(flavor = "multi_thread")]
async fn a_delta_is_printed_while_the_provider_is_still_writing() {
    let first = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n{}",
        "data: {\"choices\":[{\"delta\":{\"content\":\"early\"}}]}\n\n"
    )
    .into_bytes();
    let rest = concat!(
        "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
        "data: [DONE]\n\n"
    )
    .as_bytes()
    .to_vec();
    let base_url = staged_double(first, rest, std::time::Duration::from_millis(400));
    let service = ModelService::new(vec![endpoint(
        "chat",
        EndpointKind::OpenaiChat,
        &base_url,
        "m",
    )])
    .expect("registers the endpoint");

    let printed: Arc<Mutex<Vec<(std::time::Instant, String)>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = printed.clone();
    let mut printer = StreamPrinter::with_writer(StreamPrinterOptions::new("s1"), move |text| {
        sink.lock()
            .expect("buffer")
            .push((std::time::Instant::now(), text.to_string()));
    });

    let started = std::time::Instant::now();
    let mut stream = service.stream(ask("chat", "go")).expect("streams");
    while let Some(item) = stream.next().await {
        let chunk = item.expect("streams");
        if let Chunk::Done { .. } = chunk {
            printer.observe("s1", &serde_json::json!({ "type": "assistant/completed" }));
            continue;
        }
        printer.observe(
            "s1",
            &serde_json::json!({ "type": "assistant/chunk", "chunk": chunk }),
        );
    }
    let ended = started.elapsed();
    let printed = printed.lock().expect("buffer").clone();
    let first_text = printed
        .iter()
        .find(|(_, text)| text.contains("early"))
        .map(|(at, _)| *at)
        .expect("the first delta was printed");
    assert!(
        first_text.duration_since(started) + std::time::Duration::from_millis(200) < ended,
        "the first delta arrived at {:?} and the run ended at {ended:?}: it did not wait for the end",
        first_text.duration_since(started)
    );
    assert_eq!(printer.summary().text_deltas, 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_publisher_route_that_answers_without_a_stream_is_a_bad_body() {
    let double = Double::start(|_| reply("application/json", r#"{"ok":true}"#));
    let mut endpoint = endpoint(
        "claude",
        EndpointKind::AnthropicVertex,
        &double.base_url,
        "claude-model",
    );
    endpoint.project = Some("a-project".into());
    endpoint.region = Some("global".into());
    let adapter = adapter_for(endpoint).expect("an anthropic adapter");
    let error = collect(adapter.stream(ask("claude", "go")))
        .await
        .into_iter()
        .find_map(Result::err)
        .expect("a failure");
    assert_eq!(error.code, "BAD_BODY");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_provider_failure_inside_the_anthropic_stream_is_remote() {
    let body = "event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"try again\"}}\n\n";
    let double = Double::start(move |_| reply("text/event-stream", body));
    let mut endpoint = endpoint(
        "claude",
        EndpointKind::AnthropicVertex,
        &double.base_url,
        "claude-model",
    );
    endpoint.project = Some("a-project".into());
    endpoint.region = Some("global".into());
    let adapter = adapter_for(endpoint).expect("an anthropic adapter");
    let error = collect(adapter.stream(ask("claude", "go")))
        .await
        .into_iter()
        .find_map(Result::err)
        .expect("a failure");
    assert_eq!(error.code, "REMOTE");
    assert!(error.to_string().contains("'claude'"), "{error}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_json_only_endpoint_still_reaches_the_service_as_deltas() {
    let body =
        r#"{"choices":[{"message":{"content":"unstreamed answer"},"finish_reason":"stop"}]}"#;
    let double = Double::start(move |_| reply("application/json", body));
    let mut endpoint = endpoint("chat", EndpointKind::OpenaiChat, &double.base_url, "m");
    endpoint.stream = Some(false);
    let service = ModelService::new(vec![endpoint]).expect("registers the endpoint");
    let generated = service.generate(ask("chat", "go")).await.expect("answers");
    assert_eq!(generated.text, "unstreamed answer");
    assert_eq!(generated.finish_reason, "stop");
}

/// An image on disk, removed with the test.
struct TempImage {
    path: std::path::PathBuf,
    dir: std::path::PathBuf,
}

impl Drop for TempImage {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn image_file(bytes: &[u8]) -> TempImage {
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let dir = std::env::temp_dir().join(format!(
        "heddle-wire-image-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&dir).expect("creates the temp dir");
    let path = dir.join("shot.png");
    std::fs::write(&path, bytes).expect("writes the image");
    TempImage { path, dir }
}

/// Capability discovery, the attachment projection and the Chat wire in one path: an image reaches a route that
/// declared image input **in the provider's own model list**, and a text turn never pays for the read.
#[tokio::test(flavor = "multi_thread")]
async fn an_image_turn_discovers_the_routes_capability_and_sends_the_image() {
    let double = Double::start(|request| {
        if request.starts_with("GET /models") {
            reply(
                "application/json",
                r#"{"data":[{"id":"m","input_modalities":["text","image"]}]}"#,
            )
        } else {
            reply(
                "text/event-stream",
                "data: {\"choices\":[{\"delta\":{\"content\":\"described\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n",
            )
        }
    });
    let image = image_file(&[0x89, 0x50, 0x4e, 0x47]);
    let service = ModelService::new(vec![endpoint(
        "chat",
        EndpointKind::OpenaiChat,
        &double.base_url,
        "m",
    )])
    .expect("registers the endpoint");

    let request = GenerateRequest {
        endpoint: "chat".into(),
        messages: vec![Message::new(
            Role::User,
            vec![
                ContentPart::text("look"),
                ContentPart::Image(heddle_llm::ImagePart {
                    name: "shot.png".into(),
                    mime_type: heddle_llm::ImageMediaType::Png,
                    path: image.path.to_string_lossy().into_owned(),
                    bytes: 4,
                    sha256: "ab".repeat(32),
                    data: None,
                }),
            ],
        )],
        ..GenerateRequest::default()
    };
    let generated = service.generate(request).await.expect("answers");
    assert_eq!(generated.text, "described");

    let requests = double.requests();
    assert_eq!(
        requests
            .iter()
            .filter(|request| request.starts_with("GET /models"))
            .count(),
        1,
        "the provider's list is read once for the capability"
    );
    let chat = requests
        .iter()
        .find(|request| request.starts_with("POST /chat/completions"))
        .expect("the call went out");
    assert!(
        chat.contains("data:image/png;base64,"),
        "the image travels as a data URL: {chat}"
    );

    // A text-only turn on the same service must not read the model list again.
    service
        .generate(ask("chat", "plain"))
        .await
        .expect("answers");
    assert_eq!(
        double
            .requests()
            .iter()
            .filter(|request| request.starts_with("GET /models"))
            .count(),
        1,
        "a turn without an image never costs a model-list read"
    );
}

/// `20-streaming`'s "recorded" and "live" checks, against a double built frame for frame like the verifier's own
/// `chatDouble` (`_tools_/verify-runner/lib.mjs`): a reasoning frame, a pause, then **one** finish frame whose
/// `delta` is the whole assistant message, then `[DONE]`. The endpoint says `stream: false`, as `httpConfig` does
/// there, and the double answers an event stream anyway — so the answer must be read as what it is.
#[tokio::test(flavor = "multi_thread")]
async fn the_verifiers_chat_double_streams_even_to_an_endpoint_that_asked_for_json() {
    let first = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n{}",
        "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"recorded reasoning\"},\"finish_reason\":null}]}\n\n"
    )
    .into_bytes();
    let rest = concat!(
        "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":\"recorded content\"},\"finish_reason\":\"stop\"}]}\n\n",
        "data: [DONE]\n\n"
    )
    .as_bytes()
    .to_vec();
    let base_url = staged_double(first, rest, std::time::Duration::from_millis(400));
    let mut configured = endpoint("double", EndpointKind::OpenaiChat, &base_url, "double");
    configured.stream = Some(false);
    let service = ModelService::new(vec![configured]).expect("registers the endpoint");

    // The binary's `--stream` view, fed the turn's chunks as the session would append them.
    let stderr: Arc<Mutex<Vec<(std::time::Instant, String)>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = stderr.clone();
    struct Timed(Arc<Mutex<Vec<(std::time::Instant, String)>>>);
    impl Write for Timed {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().expect("buffer").push((
                std::time::Instant::now(),
                String::from_utf8_lossy(bytes).into_owned(),
            ));
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut view = heddle_llm::command::print_stream("s1", Box::new(Timed(sink)));

    let started = std::time::Instant::now();
    let mut stream = service
        .stream(ask("double", "say something"))
        .expect("streams");
    let mut text = String::new();
    while let Some(item) = stream.next().await {
        let chunk = item.expect("streams");
        if let Chunk::TextDelta { text: delta } = &chunk {
            text.push_str(delta);
        }
        let event = if matches!(chunk, Chunk::Done { .. }) {
            serde_json::json!({ "type": "assistant/completed" })
        } else {
            serde_json::json!({ "type": "assistant/chunk", "chunk": chunk })
        };
        view.observe("s1", &event.to_string());
    }
    let ended = started.elapsed();
    view.dispose();

    assert_eq!(text, "recorded content", "the answer reached the caller");
    let summary: serde_json::Value =
        serde_json::from_str(&view.summary_json()).expect("the summary is JSON");
    assert!(summary["textDeltas"].as_u64() > Some(0), "{summary}");
    assert!(summary["reasoningDeltas"].as_u64() > Some(0), "{summary}");
    assert_eq!(summary["completed"], serde_json::json!(true));

    let printed = stderr.lock().expect("buffer").clone();
    let reasoning_at = printed
        .iter()
        .find(|(_, text)| text.contains("[reasoning]"))
        .map(|(at, _)| *at)
        .expect("a reasoning delta was printed");
    assert!(
        reasoning_at.duration_since(started) + std::time::Duration::from_millis(200) < ended,
        "the first delta was printed at {:?}, the turn ended at {ended:?}: it did not wait for the end",
        reasoning_at.duration_since(started)
    );
    let all: String = printed.iter().map(|(_, text)| text.as_str()).collect();
    assert!(
        all.find("[reasoning]") < all.find("recorded content"),
        "reasoning before content: {all}"
    );
}

/// `10-llm-backends`' default check: with no endpoint named, the configuration's default answers even though it
/// is not first, and the first endpoint is never reached.
#[tokio::test(flavor = "multi_thread")]
async fn with_no_endpoint_named_the_configured_default_answers_and_the_first_is_never_reached() {
    let sse = |content: &str| {
        format!(
            "data: {{\"choices\":[{{\"delta\":{{\"role\":\"assistant\",\"content\":\"{content}\"}},\"finish_reason\":\"stop\"}}]}}\n\ndata: [DONE]\n\n"
        )
    };
    let first_body = sse("the first endpoint answered");
    let chosen_body = sse("the default endpoint answered");
    let first = Double::start(move |_| reply("text/event-stream", &first_body));
    let chosen = Double::start(move |_| reply("text/event-stream", &chosen_body));
    let mut first_endpoint = endpoint("first", EndpointKind::OpenaiChat, &first.base_url, "double");
    first_endpoint.stream = Some(true);
    let mut chosen_endpoint = endpoint(
        "chosen",
        EndpointKind::OpenaiChat,
        &chosen.base_url,
        "double",
    );
    chosen_endpoint.stream = Some(true);
    let service =
        ModelService::from_configuration(vec![first_endpoint, chosen_endpoint], Some("chosen"))
            .expect("registers the endpoints");

    let endpoint =
        heddle_llm::command::turn_endpoint(None, &service.names(), service.nominated().as_deref())
            .expect("a default exists");
    assert_eq!(endpoint, "chosen");
    let generated = service
        .generate(ask(&endpoint, "say something"))
        .await
        .expect("answers");
    assert_eq!(generated.text, "the default endpoint answered");
    assert!(
        first.requests().is_empty(),
        "the first endpoint in the list was never reached"
    );
    assert_eq!(chosen.requests().len(), 1);
}
