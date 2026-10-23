//! The one HTTP client every adapter and the model-list reader share.
//!
//! Ported from `src/llm/http.ts`, on `reqwest` (rustls). What carries over, each measured on the TypeScript side:
//!
//! - **Header names go out in Title-Case** (`Content-Type`, `Content-Length`): a local signing proxy forwards a
//!   duplicate `Content-Length` when the caller's copy is not Title-Case, and Cloudflare answers that with a bare
//!   `400`. The client is built with `http1_title_case_headers`, and [`title_case_headers`] normalises configured
//!   names so a configured header and a default one cannot both be sent.
//! - **A plain product `User-Agent`** ([`USER_AGENT`]): Cloudflare's integrity check answers `403` to an absent or
//!   synthetic one.
//! - **What the answer is decides how it is read**, not what was asked for: `text/event-stream` is a stream; an
//!   unlabelled answer to a streaming request is a stream unless its first bytes open a JSON object, and that first
//!   read is replayed so a stream is at most one read behind.
//! - **A forwarding proxy** is `http:` only, to an `http:` target, sent in the proxy's absolute form; anything else
//!   is refused with `PROXY` by name rather than connecting somewhere nobody asked for.
//! - **A non-2xx answer** is a [`ModelError`] carrying the status and the first 400 characters of the body, coded
//!   by [`failure_code`].

use std::pin::Pin;

use std::time::Duration;

use bytes::Bytes;
use futures::{Stream, StreamExt};

use crate::error::ModelError;

/// A response body as it arrives.
pub type ByteStream = Pin<Box<dyn Stream<Item = Result<Bytes, ModelError>> + Send + 'static>>;

/// Socket inactivity, in milliseconds, before a request is abandoned with `TIMEOUT`.
pub const DEFAULT_TIMEOUT_MS: u64 = 120_000;

/// The user agent every request carries.
pub const USER_AGENT: &str = "heddle/0.0.1";

/// The method of one request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Method {
    #[default]
    Post,
    Get,
}

/// What one call needs to say.
#[derive(Debug, Clone, Default)]
pub struct WireRequest {
    pub url: String,
    pub method: Method,
    /// Sent as JSON when present.
    pub body: Option<serde_json::Value>,
    /// Extra headers, merged over the defaults after Title-Casing.
    pub headers: Vec<(String, String)>,
    /// Sent as `Authorization: Bearer …` when present.
    pub api_key: Option<String>,
    /// Ask for an event stream (`Accept: text/event-stream`).
    pub stream: bool,
    /// Socket inactivity before abandoning; [`DEFAULT_TIMEOUT_MS`] when absent.
    pub timeout_ms: Option<u64>,
    /// The endpoint's name, for the error a person reads.
    pub endpoint: String,
    /// An `http:` forwarding proxy, as a URL.
    pub proxy: Option<String>,
}

/// One response: a buffered JSON body (`null` for an empty one), or a streamed body with its status.
pub enum WireResponse {
    Json(serde_json::Value),
    Stream { body: ByteStream, status: u16 },
}

impl std::fmt::Debug for WireResponse {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Json(value) => f.debug_tuple("Json").field(value).finish(),
            Self::Stream { status, .. } => f
                .debug_struct("Stream")
                .field("status", status)
                .finish_non_exhaustive(),
        }
    }
}

/// Send one request and resolve with its response, buffered or streamed (`wire`).
///
/// Errors: `TRANSPORT` (could not send), `TIMEOUT` (socket idle), `PROXY` (refused proxy form), `HTTP` or
/// `CONTEXT_WINDOW_EXCEEDED` (non-2xx), `BAD_BODY` (a JSON answer that is not JSON).
pub async fn wire(request: WireRequest) -> Result<WireResponse, ModelError> {
    let endpoint = request.endpoint.clone();
    let target = reqwest::Url::parse(&request.url).map_err(|error| {
        ModelError::new(
            format!("'{endpoint}' has an address that is not a URL — {error}"),
            endpoint.clone(),
            crate::error::code::TRANSPORT,
        )
        .with_source(error)
    })?;
    let (url, host) = destination(&request, &target)?;
    let idle = Duration::from_millis(request.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS));

    let client = reqwest::Client::builder()
        .http1_title_case_headers()
        .build()
        .map_err(|error| {
            ModelError::new(
                format!("the HTTP client for '{endpoint}' could not be built — {error}"),
                endpoint.clone(),
                crate::error::code::TRANSPORT,
            )
            .with_source(error)
        })?;

    // Defaults first, then the configured headers: a configured name replaces the default in place, as an
    // object spread did. A duplicate Content-Length is what the Title-Case rule exists to prevent.
    let mut headers = vec![
        ("Content-Type".to_string(), "application/json".to_string()),
        (
            "Accept".to_string(),
            if request.stream {
                "text/event-stream".to_string()
            } else {
                "application/json".to_string()
            },
        ),
        ("User-Agent".to_string(), USER_AGENT.to_string()),
    ];
    merge_headers(&mut headers, title_case_headers(&request.headers));
    if let Some(api_key) = &request.api_key {
        merge_headers(
            &mut headers,
            vec![("Authorization".to_string(), format!("Bearer {api_key}"))],
        );
    }
    if let Some(host) = host {
        merge_headers(&mut headers, vec![("Host".to_string(), host)]);
    }

    let method = match request.method {
        Method::Post => reqwest::Method::POST,
        Method::Get => reqwest::Method::GET,
    };
    let mut builder = client.request(method, url);
    for (name, value) in headers {
        builder = builder.header(name, value);
    }
    if let Some(body) = &request.body {
        let encoded = serde_json::to_vec(body).map_err(|error| {
            ModelError::new(
                format!("the request to '{endpoint}' could not be serialized — {error}"),
                endpoint.clone(),
                crate::error::code::TRANSPORT,
            )
            .with_source(error)
        })?;
        builder = builder.body(encoded);
    }

    let response = match tokio::time::timeout(idle, builder.send()).await {
        Err(_) => {
            return Err(ModelError::new(
                format!(
                    "the request to '{endpoint}' timed out after {}ms",
                    idle.as_millis()
                ),
                endpoint,
                crate::error::code::TIMEOUT,
            ));
        }
        Ok(Err(error)) => {
            let timed_out = error.is_timeout();
            return Err(ModelError::new(
                format!("the request to '{endpoint}' could not be sent — {error}"),
                endpoint,
                if timed_out {
                    crate::error::code::TIMEOUT
                } else {
                    crate::error::code::TRANSPORT
                },
            )
            .with_source(error));
        }
        Ok(Ok(response)) => response,
    };

    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        let text = read_text(response, endpoint.clone(), idle).await;
        let excerpt: String = text.chars().take(400).collect();
        let message = if excerpt.is_empty() {
            format!("'{endpoint}' answered {status}")
        } else {
            format!("'{endpoint}' answered {status} — {excerpt}")
        };
        return Err(
            ModelError::new(message, endpoint, failure_code(status, &text)).with_status(status),
        );
    }

    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let looks_streamed = content_type.contains("text/event-stream");

    if looks_streamed {
        return Ok(WireResponse::Stream {
            body: body_stream(response, endpoint, idle),
            status,
        });
    }
    if !request.stream {
        let body = read_text(response, endpoint.clone(), idle).await;
        return Ok(WireResponse::Json(parse_json_text(&body, &endpoint)?));
    }

    // A stream was asked for and the answer is not labelled. The first read decides: one provider answers a
    // single JSON body, another streams an event body with no content type at all.
    let mut body = body_stream(response, endpoint.clone(), idle);
    let Some(first) = body.next().await else {
        return Ok(WireResponse::Json(serde_json::Value::Null));
    };
    let first = first?;
    if String::from_utf8_lossy(&first)
        .trim_start()
        .starts_with('{')
    {
        let mut whole = Vec::from(first.as_ref());
        while let Some(chunk) = body.next().await {
            whole.extend_from_slice(&chunk?);
        }
        return Ok(WireResponse::Json(parse_json_text(
            &String::from_utf8_lossy(&whole),
            &endpoint,
        )?));
    }
    // Replay the peeked read, so a stream is at most one read behind.
    let replay = futures::stream::once(async move { Ok(first) }).chain(body);
    Ok(WireResponse::Stream {
        body: Box::pin(replay),
        status,
    })
}

/// Add headers, replacing a name that is already present so a configured header and a default cannot both go out.
/// Names are compared after Title-Casing, which is how they reach the wire.
fn merge_headers(headers: &mut Vec<(String, String)>, extra: Vec<(String, String)>) {
    for (name, value) in extra {
        if let Some(existing) = headers.iter_mut().find(|(existing, _)| *existing == name) {
            existing.1 = value;
        } else {
            headers.push((name, value));
        }
    }
}

/// Where a request actually goes and which host it names, in the proxy's absolute form.
fn destination(
    request: &WireRequest,
    target: &reqwest::Url,
) -> Result<(String, Option<String>), ModelError> {
    let endpoint = &request.endpoint;
    let Some(proxy) = &request.proxy else {
        return Ok((request.url.clone(), None));
    };
    let proxy_url = reqwest::Url::parse(proxy).map_err(|error| {
        ModelError::new(
            format!("'{endpoint}' is configured with a proxy that is not a URL — {error}"),
            endpoint.clone(),
            crate::error::code::PROXY,
        )
        .with_source(error)
    })?;
    if proxy_url.scheme() != "http" {
        return Err(ModelError::new(
            format!(
                "'{endpoint}' is configured with a {} proxy; only an http forwarding proxy is supported",
                proxy_url.scheme()
            ),
            endpoint.clone(),
            crate::error::code::PROXY,
        ));
    }
    if target.scheme() != "http" {
        return Err(ModelError::new(
            format!(
                "'{endpoint}' is an {} endpoint behind a proxy; point the endpoint at the forwarding agent itself",
                target.scheme()
            ),
            endpoint.clone(),
            crate::error::code::PROXY,
        ));
    }
    let host = target.host_str().map(|host| match target.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_string(),
    });
    // The request is addressed to the proxy and names the target absolutely: a proxy's own form.
    let mut proxied = proxy_url;
    proxied.set_path(target.path());
    proxied.set_query(target.query());
    Ok((proxied.to_string(), host))
}

/// A response body as the client reads it, with the socket-inactivity timeout applied to every read.
fn body_stream(response: reqwest::Response, endpoint: String, idle: Duration) -> ByteStream {
    let upstream: futures::stream::BoxStream<'static, Result<Bytes, reqwest::Error>> =
        Box::pin(response.bytes_stream());
    Box::pin(futures::stream::unfold(
        (upstream, endpoint, idle, false),
        |(mut upstream, endpoint, idle, done)| async move {
            if done {
                return None;
            }
            match tokio::time::timeout(idle, upstream.next()).await {
                Err(_) => Some((
                    Err(ModelError::new(
                        format!(
                            "the request to '{endpoint}' timed out after {}ms",
                            idle.as_millis()
                        ),
                        endpoint.clone(),
                        crate::error::code::TIMEOUT,
                    )),
                    (upstream, endpoint, idle, true),
                )),
                Ok(None) => None,
                Ok(Some(Ok(bytes))) => Some((Ok(bytes), (upstream, endpoint, idle, false))),
                Ok(Some(Err(error))) => {
                    let timed_out = error.is_timeout();
                    Some((
                        Err(ModelError::new(
                            format!("the request to '{endpoint}' could not be read — {error}"),
                            endpoint.clone(),
                            if timed_out {
                                crate::error::code::TIMEOUT
                            } else {
                                crate::error::code::TRANSPORT
                            },
                        )
                        .with_source(error)),
                        (upstream, endpoint, idle, true),
                    ))
                }
            }
        },
    ))
}

/// Read a whole body as text; a read failure is not a JSON error but a transport one.
async fn read_text(response: reqwest::Response, endpoint: String, idle: Duration) -> String {
    let mut body = body_stream(response, endpoint, idle);
    let mut whole = Vec::new();
    while let Some(chunk) = body.next().await {
        match chunk {
            Ok(chunk) => whole.extend_from_slice(&chunk),
            // A failed read of an error body leaves what was read; the status is what a person needs.
            Err(_) => break,
        }
    }
    String::from_utf8_lossy(&whole).into_owned()
}

/// Parse one body as JSON, or say which endpoint answered with something else.
fn parse_json_text(text: &str, endpoint: &str) -> Result<serde_json::Value, ModelError> {
    if text.is_empty() {
        return Ok(serde_json::Value::Null);
    }
    serde_json::from_str(text).map_err(|error| {
        ModelError::new(
            format!("'{endpoint}' answered with a body that is not JSON — {error}"),
            endpoint,
            crate::error::code::BAD_BODY,
        )
        .with_source(error)
    })
}

/// Header names in Title-Case (`titleCaseHeaders`): each letter after the start or a `-` is upper-cased; values and
/// order are kept.
pub fn title_case_headers(headers: &[(String, String)]) -> Vec<(String, String)> {
    headers
        .iter()
        .map(|(name, value)| {
            let mut titled = String::with_capacity(name.len());
            let mut boundary = true;
            for letter in name.chars() {
                if boundary {
                    titled.extend(letter.to_uppercase());
                } else {
                    titled.push(letter);
                }
                boundary = letter == '-';
            }
            (titled, value.clone())
        })
        .collect()
}

/// Whether a body says the request did not fit the model's window. The provider wordings differ, so the matching
/// happens once, here, and everything above reads the code.
fn says_context_too_long(body: &str) -> bool {
    let body = body.to_lowercase();
    const PHRASES: [&str; 6] = [
        "context_length_exceeded",
        "context length exceeded",
        "maximum context length",
        "context window",
        "too many tokens",
        "reduce the length of the messages",
    ];
    if PHRASES.iter().any(|phrase| body.contains(phrase)) {
        return true;
    }
    let mut rest = body.as_str();
    while let Some(at) = rest.find("exceeds the ") {
        let tail = &rest[at + "exceeds the ".len()..];
        let tail = tail
            .strip_prefix("model's ")
            .or_else(|| tail.strip_prefix("models "))
            .unwrap_or(tail);
        let tail = tail.strip_prefix("maximum ").unwrap_or(tail);
        if tail.starts_with("context") {
            return true;
        }
        rest = &rest[at + 1..];
    }
    false
}

/// The code one failed response deserves (`failureCode`): `CONTEXT_WINDOW_EXCEEDED` for a `400`, `413` or `422`
/// whose body says the request did not fit (OpenAI's `context_length_exceeded`, "maximum context length",
/// "context window", "too many tokens", "reduce the length of the messages", "exceeds the model's context"),
/// otherwise `HTTP`. Case-insensitive.
pub fn failure_code(status: u16, body: &str) -> &'static str {
    if matches!(status, 400 | 413 | 422) && says_context_too_long(body) {
        crate::error::CONTEXT_WINDOW_EXCEEDED
    } else {
        crate::error::code::HTTP
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::CONTEXT_WINDOW_EXCEEDED;

    fn headers(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(name, value)| ((*name).to_string(), (*value).to_string()))
            .collect()
    }

    #[test]
    fn header_names_go_out_in_title_case_with_their_values_and_order_kept() {
        assert_eq!(
            title_case_headers(&headers(&[
                ("content-type", "application/json"),
                ("content-length", "3"),
                ("x-api-version", "2024-01-01"),
            ])),
            headers(&[
                ("Content-Type", "application/json"),
                ("Content-Length", "3"),
                ("X-Api-Version", "2024-01-01"),
            ])
        );
        // Names that are already titled are unchanged, and an odd name keeps what it has.
        assert_eq!(
            title_case_headers(&headers(&[("Authorization", "Bearer x"), ("x-", "y")])),
            headers(&[("Authorization", "Bearer x"), ("X-", "y")])
        );
        assert_eq!(title_case_headers(&[]), Vec::new());
    }

    #[test]
    fn a_window_refusal_is_recognised_by_the_code_the_harness_recovers_on() {
        assert_eq!(
            failure_code(400, r#"{"error":{"code":"context_length_exceeded"}}"#),
            CONTEXT_WINDOW_EXCEEDED
        );
        assert_eq!(
            failure_code(400, "This model's maximum context length is 8192 tokens"),
            CONTEXT_WINDOW_EXCEEDED
        );
        assert_eq!(
            failure_code(413, "the request would exceed the context window"),
            CONTEXT_WINDOW_EXCEEDED
        );
        assert_eq!(
            failure_code(422, "Please reduce the length of the messages"),
            CONTEXT_WINDOW_EXCEEDED
        );
        assert_eq!(
            failure_code(400, "too many tokens in the request"),
            CONTEXT_WINDOW_EXCEEDED
        );
        assert_eq!(
            failure_code(400, "request exceeds the model's context limit"),
            CONTEXT_WINDOW_EXCEEDED
        );
        // Case does not matter.
        assert_eq!(
            failure_code(400, "CONTEXT_LENGTH_EXCEEDED"),
            CONTEXT_WINDOW_EXCEEDED
        );
    }

    #[test]
    fn every_other_failure_is_an_http_failure() {
        assert_eq!(failure_code(400, "bad request"), "HTTP");
        assert_eq!(
            failure_code(401, "context window"),
            "HTTP",
            "the status decides too"
        );
        assert_eq!(failure_code(500, "context window"), "HTTP");
        assert_eq!(failure_code(503, ""), "HTTP");
        // A phrase that is not the window refusal stays HTTP.
        assert_eq!(
            failure_code(400, "the tool exceeded its output budget"),
            "HTTP"
        );
    }

    /// A one-shot HTTP double: answers every request with the reply its handler builds, and records the request.
    struct Server {
        url: String,
        seen: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
        handle: tokio::task::JoinHandle<()>,
    }

    impl Server {
        async fn start(reply: impl Fn(&str) -> String + Send + Sync + 'static) -> Self {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};

            let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
                .await
                .expect("binds a loopback port");
            let address = listener.local_addr().expect("has an address");
            let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
            let recorded = seen.clone();
            let reply = std::sync::Arc::new(reply);
            let handle = tokio::spawn(async move {
                loop {
                    let Ok((mut socket, _)) = listener.accept().await else {
                        return;
                    };
                    let reply = reply.clone();
                    let recorded = recorded.clone();
                    tokio::spawn(async move {
                        let mut buffer = Vec::new();
                        let mut read = [0u8; 1024];
                        while !buffer.windows(4).any(|window| window == b"\r\n\r\n") {
                            match socket.read(&mut read).await {
                                Ok(0) | Err(_) => break,
                                Ok(count) => buffer.extend_from_slice(&read[..count]),
                            }
                        }
                        let head = String::from_utf8_lossy(&buffer).into_owned();
                        recorded.lock().expect("records").push(head.clone());
                        let _ = socket.write_all(reply(&head).as_bytes()).await;
                        let _ = socket.flush().await;
                    });
                }
            });
            Self {
                url: format!("http://{address}"),
                seen,
                handle,
            }
        }

        fn seen(&self) -> Vec<String> {
            self.seen.lock().expect("reads").clone()
        }
    }

    impl Drop for Server {
        fn drop(&mut self) {
            self.handle.abort();
        }
    }

    fn reply(status: &str, content_type: Option<&str>, body: &str) -> String {
        let mut head = format!("HTTP/1.1 {status}\r\n");
        if let Some(content_type) = content_type {
            head.push_str(&format!("Content-Type: {content_type}\r\n"));
        }
        format!(
            "{head}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    fn request(url: &str) -> WireRequest {
        WireRequest {
            url: url.to_string(),
            endpoint: "chat".into(),
            ..WireRequest::default()
        }
    }

    #[tokio::test]
    async fn a_json_answer_is_buffered_and_its_headers_go_out_in_title_case() {
        let server =
            Server::start(|_| reply("200 OK", Some("application/json"), r#"{"ok":true}"#)).await;
        let answer = wire(WireRequest {
            url: format!("{}/chat/completions", server.url),
            body: Some(serde_json::json!({ "model": "m" })),
            headers: vec![("x-api-version".into(), "1".into())],
            api_key: Some("secret".into()),
            ..request("")
        })
        .await
        .expect("answers");
        match answer {
            WireResponse::Json(value) => assert_eq!(value, serde_json::json!({ "ok": true })),
            other => panic!("a JSON answer is buffered, got {other:?}"),
        }
        let seen = server.seen().join("\n");
        assert!(
            seen.starts_with("POST /chat/completions HTTP/1.1"),
            "{seen}"
        );
        assert!(seen.contains("Content-Type: application/json"), "{seen}");
        assert!(seen.contains("User-Agent: heddle/0.0.1"), "{seen}");
        assert!(seen.contains("Authorization: Bearer secret"), "{seen}");
        assert!(seen.contains("X-Api-Version: 1"), "{seen}");
        assert!(seen.contains(r#"{"model":"m"}"#), "{seen}");
    }

    #[tokio::test]
    async fn a_window_refusal_keeps_its_status_and_the_recoverable_code() {
        let server = Server::start(|_| {
            reply(
                "400 Bad Request",
                Some("application/json"),
                r#"{"error":{"code":"context_length_exceeded"}}"#,
            )
        })
        .await;
        let error = wire(request(&format!("{}/chat", server.url)))
            .await
            .expect_err("fails");
        assert_eq!(error.code, CONTEXT_WINDOW_EXCEEDED);
        assert_eq!(error.status, Some(400));
        assert!(error.to_string().contains("answered 400"), "{error}");
    }

    #[tokio::test]
    async fn a_streamed_answer_is_handed_back_as_bytes() {
        let body = "data: one\n\ndata: two\n\n";
        let server = Server::start(move |_| reply("200 OK", Some("text/event-stream"), body)).await;
        let answer = wire(WireRequest {
            stream: true,
            ..request(&format!("{}/chat", server.url))
        })
        .await
        .expect("answers");
        match answer {
            WireResponse::Stream { body, status } => {
                assert_eq!(status, 200);
                let whole: Vec<u8> = futures::executor::block_on(body.collect::<Vec<_>>())
                    .into_iter()
                    .map(|item| item.expect("reads"))
                    .flat_map(|bytes| bytes.to_vec())
                    .collect();
                assert_eq!(
                    String::from_utf8_lossy(&whole),
                    "data: one\n\ndata: two\n\n"
                );
            }
            other => panic!("a labelled stream is streamed, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn an_unlabelled_answer_to_a_streaming_request_is_read_as_what_it_is() {
        // A provider that ignores `stream` and answers one JSON body.
        let json_server = Server::start(|_| reply("200 OK", None, r#"{"ok":true}"#)).await;
        match wire(WireRequest {
            stream: true,
            ..request(&format!("{}/chat", json_server.url))
        })
        .await
        .expect("answers")
        {
            WireResponse::Json(value) => assert_eq!(value, serde_json::json!({ "ok": true })),
            other => panic!("a JSON body is buffered, got {other:?}"),
        }

        // A provider that streams an event body with no content type at all.
        let stream_server = Server::start(|_| reply("200 OK", None, "data: one\n\n")).await;
        match wire(WireRequest {
            stream: true,
            ..request(&format!("{}/chat", stream_server.url))
        })
        .await
        .expect("answers")
        {
            WireResponse::Stream { body, .. } => {
                let whole: Vec<u8> = futures::executor::block_on(body.collect::<Vec<_>>())
                    .into_iter()
                    .map(|item| item.expect("reads"))
                    .flat_map(|bytes| bytes.to_vec())
                    .collect();
                assert_eq!(String::from_utf8_lossy(&whole), "data: one\n\n");
            }
            other => panic!("an event body is streamed, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn an_answer_that_is_not_json_is_a_bad_body() {
        let server = Server::start(|_| reply("200 OK", Some("application/json"), "not json")).await;
        let error = wire(request(&format!("{}/chat", server.url)))
            .await
            .expect_err("fails");
        assert_eq!(error.code, crate::error::code::BAD_BODY);
        assert!(error.to_string().contains("not JSON"), "{error}");
    }

    #[tokio::test]
    async fn a_refused_proxy_form_is_named_rather_than_connected() {
        let error = wire(WireRequest {
            proxy: Some("https://proxy.example:443".into()),
            ..request("http://gateway.example/v1/chat")
        })
        .await
        .expect_err("refused");
        assert_eq!(error.code, crate::error::code::PROXY);
        assert!(error.to_string().contains("only an http"), "{error}");

        // An https target through a plaintext forwarding proxy would need CONNECT, which this client does not do.
        let error = wire(WireRequest {
            proxy: Some("http://127.0.0.1:9".into()),
            ..request("https://gateway.example/v1/chat")
        })
        .await
        .expect_err("refused");
        assert_eq!(error.code, crate::error::code::PROXY);
        assert!(error.to_string().contains("forwarding agent"), "{error}");
    }
}
