//! The file routes of `src/server/web.ts`, as one `axum::Router` the server mounts.
//!
//! # Mounting
//!
//! One call, for the server or the binary:
//!
//! ```ignore
//! // the server: its own state applied, its token layer already over the merged result
//! let app = heddle_web_files::routes::mount(server_router_with_state_applied, Arc::new(my_host));
//! let app = app.layer(token_layer);
//! ```
//!
//! [`mount`] exists rather than "call [`FilesRoutes::router`] and merge it" because axum only merges two routers
//! that carry the **same** state type, and these routes own theirs ([`FilesRoutes`]): the caller must apply its own
//! state first, which yields `axum::Router<()>`, and then merge. The types a caller reads the answers through are
//! [`FileAnswer`], [`MarkdownAnswer`], [`ErrorAnswer`] and [`SavedUpload`], all public and serialized exactly as the
//! routes write them.
//!
//! The router does **no authentication**: in `web.ts` every one of these routes sits after the token decision, which
//! answers `401` (`unauthorized\n` as `text/plain` for `/api/…`) before any route runs. The server keeps that
//! decision and applies it to the merged router. The router has no fallback, so unknown paths stay the server's.
//!
//! # The routes, and exactly what each answers
//!
//! Every answer carries `cache-control: no-store`. A JSON body is followed by `\n`; "pretty" means
//! `JSON.stringify(value, null, 2)`, which is `serde_json::to_string_pretty`. `{error}` is `{"error": <sentence>}`.
//!
//! | Method and path | Answers |
//! |---|---|
//! | `GET /api/file?path=` | `503 {error}` workspace plugin not loaded · `400 {error}` no path · `400 {error: "<canonical> is not under any workspace root"}` · `200` pretty [`FileReading`] fields then [`Rendered`] fields · `404 {error}` not a file · `415 {error}` not text |
//! | `GET /api/raw?path=` | `400 text "a path is required\n"` · `404 text "no such asset\n"` outside every root, plugin absent, or not a file · `200` the bytes, `content-type` from the inline table (else `application/octet-stream`), `content-length`, `content-disposition: inline` for an inline type, else `attachment; filename="<leaf without ">"` · **every** answer, success or failure, also carries `content-security-policy: sandbox; default-src 'none'` and `x-content-type-options: nosniff` (`FILE_ANSWER_POLICY`, as DSH's file route) |
//! | `GET /api/uploads/{leaf}` | `404 text "no such asset\n"` for an empty leaf, `.`, `..`, a separator, or a path that leaves the canonical upload directory · `200` the bytes, headers as `/api/raw` with the leaf as filename · every answer hardened as `/api/raw`'s |
//! | `POST /api/uploads?name=` | body = the file's bytes · `413 text "the file is larger than this server accepts (50 MiB)\n"` · `400 text "an empty file has nothing to add\n"` · `200` compact [`SavedUpload`] |
//! | `POST /api/markdown` | body `{"text": string}` · `413 text "request too large\n"` over 10 MiB · `400 text "the body must be JSON\n"` · `400 {error: "text is required"}` · `200` compact `{"html": render_markdown(text)}` (no base) |
//! | `POST /api/workspaces/pick` | `501 {error: reason}` when unavailable · `200` pretty [`PickerOutcome`] (`picked` or `cancelled`) |
//! | `GET /api/directories?path=` | `200` pretty [`DirectoryListing`] · `400 {error, code}` (see [`crate::directories`]) |
//! | `POST /api/directories` | body `{"parent", "name"}` · `400 text "the body must be JSON\n"` · `200` pretty `{"path"}` · `409`/`400 {error, code}` |
//!
//! `GET /api/html` is **not** here: it belongs to `heddle-server`, which also serves `/vendor/purify.js`, so the
//! server registers it and this router must not (`Router::merge` rejects an overlapping path with a panic).
//!
//! [`FileReading`]: crate::host::FileReading
//! [`Rendered`]: crate::code::Rendered
//! [`SavedUpload`]: crate::uploads::SavedUpload
//! [`PickerOutcome`]: crate::picker::PickerOutcome
//! [`DirectoryListing`]: crate::directories::DirectoryListing

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;

use axum::body::Body;
use axum::extract::{Path as AxumPath, Query, Request, State};
use axum::http::{StatusCode, header};
use axum::response::Response;
use axum::routing::{get, post};
use serde::{Deserialize, Serialize};

use crate::code::{Rendered, render_source};
use crate::host::{FileReading, FilesHost, WorkspaceAnswer};
use crate::picker::{CommandRunner, PickerOutcome, Platform, SystemRunner, pick_folder};
use crate::uploads::{MAX_UPLOAD_BYTES, save_upload, upload_directory};

/// Every `(method, path)` this router answers, in axum 0.8 path syntax — so the server can assert at boot that no
/// route of its own overlaps one of these, which `Router::merge` would otherwise reject with a panic.
pub const ROUTES: &[(&str, &str)] = &[
    ("GET", "/api/file"),
    ("GET", "/api/raw"),
    ("GET", "/api/uploads/{leaf}"),
    ("POST", "/api/uploads"),
    ("POST", "/api/markdown"),
    ("POST", "/api/workspaces/pick"),
    ("GET", "/api/directories"),
    ("POST", "/api/directories"),
];

/// The file routes, configured: the host they read from and the folder picker they open.
#[derive(Clone)]
pub struct FilesRoutes {
    host: Arc<dyn FilesHost>,
    platform: Platform,
    runner: Arc<dyn CommandRunner>,
}

impl FilesRoutes {
    /// The routes over `host`, with the platform's own folder dialog.
    pub fn new(host: Arc<dyn FilesHost>) -> Self {
        Self {
            host,
            platform: Platform::current(),
            runner: Arc::new(SystemRunner::default()),
        }
    }

    /// Replace the folder dialog — for tests, or a host that has none.
    pub fn with_picker(self, platform: Platform, runner: Arc<dyn CommandRunner>) -> Self {
        Self {
            platform,
            runner,
            ..self
        }
    }

    /// The router, with its state applied, ready for `Router::merge` into the server's router.
    pub fn router(self) -> axum::Router {
        axum::Router::new()
            .route("/api/file", get(file))
            .route("/api/raw", get(raw))
            .route("/api/uploads/{leaf}", get(uploaded))
            .route("/api/uploads", post(store))
            .route("/api/markdown", post(markdown))
            .route("/api/workspaces/pick", post(pick))
            .route(
                "/api/directories",
                get(list_directories).post(create_directory),
            )
            .with_state(self)
    }
}

/// Mount the file routes into a router whose own state is already applied.
///
/// This is the one call a server makes. The caller applies its state first (`axum::Router<()>`), passes the router
/// and the [`FilesHost`] it implements, and puts its token layer over the result: these routes do no authentication
/// of their own, exactly as the TypeScript build's file routes sit after the token decision.
///
/// `Router::merge` panics when a path collides, and the server registers `GET /api/html` and
/// `/vendor/purify.js` itself, so [`ROUTES`] lists only what this call adds; a server can assert the two sets are
/// disjoint at boot instead of meeting the panic.
pub fn mount(router: axum::Router, host: Arc<dyn FilesHost>) -> axum::Router {
    mount_routes(router, FilesRoutes::new(host))
}

/// The same, with the routes configured by the caller — the folder dialog replaced, or a host that has none.
pub fn mount_routes(router: axum::Router, routes: FilesRoutes) -> axum::Router {
    router.merge(routes.router())
}

/// `{"error": <sentence>}`: what every refusal answers, with a newline after the object.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ErrorAnswer {
    pub error: String,
}

/// `POST /api/markdown`'s request: `{"text": …}`. Anything else is `400`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MarkdownRequest {
    pub text: String,
}

/// `POST /api/markdown`'s answer: the document, compact.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MarkdownAnswer {
    pub html: String,
}

/// The query every route that names a file reads. A missing `path` is an answer of its own, not an error.
#[derive(Debug, Default, Deserialize)]
pub struct FileQuery {
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
}

/// The same query, read by the upload route (it uses `name`; the rest ignore it).
pub(crate) type Params = FileQuery;

/// `GET /api/file`'s answer: the reading, then the renderer's decision, flattened into one object.
///
/// The fields are `path`, `name`, `bytes`, `lines`, `text`, `truncated`, then `renderer` and, when the renderer has
/// them, `language` and `html` — absent rather than `null` for a file that has none.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileAnswer {
    #[serde(flatten)]
    pub reading: FileReading,
    #[serde(flatten)]
    pub rendered: Rendered,
}

/// The largest body `POST /api/markdown` accepts.
const MAX_MARKDOWN_BYTES: usize = 10 * 1024 * 1024;

/// `GET /api/file`: one file's text and how to show it.
async fn file(State(files): State<FilesRoutes>, Query(params): Query<Params>) -> Response {
    let Some(path) = params.path.filter(|path| !path.is_empty()) else {
        return json_error(StatusCode::BAD_REQUEST, "a path is required");
    };
    // The path is resolved **before** it is judged, so `..` and a symlink are decided by where they lead rather
    // than by how they are spelled. The host compares canonical paths too; doing it here means a host that forgot
    // cannot turn this route into a read of the whole machine.
    let wanted = canonical_path(Path::new(&path));
    match files.host.workspace_owner(&wanted) {
        WorkspaceAnswer::NotLoaded => {
            return json_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "this profile does not load the workspace plugin",
            );
        }
        WorkspaceAnswer::Outside => {
            return json_error(
                StatusCode::BAD_REQUEST,
                &format!("{} is not under any workspace root", wanted.display()),
            );
        }
        WorkspaceAnswer::Owned => {}
    }
    match files.host.read_file_text(&wanted) {
        Ok(reading) => {
            let rendered = render_source(Path::new(&reading.path), &reading.text);
            let answer = FileAnswer { reading, rendered };
            json(
                StatusCode::OK,
                &format!(
                    "{}
",
                    serde_json::to_string_pretty(&answer).unwrap_or_default()
                ),
            )
        }
        Err(error) => {
            let message = error.to_string();
            let status = if message.contains("is not a file") {
                StatusCode::NOT_FOUND
            } else {
                StatusCode::UNSUPPORTED_MEDIA_TYPE
            };
            json_error(status, &message)
        }
    }
}

/// The policy **every answer of a file route** carries, success or failure, with `nosniff` beside it.
///
/// `/api/raw` and `/api/uploads` serve a workspace's or a person's own bytes on the page's origin, with the session
/// cookie in scope, so whatever a browser can run from such an answer runs as the user. Measured 2026-10-29 (DSH
/// parity R-developer-twelve-16): a workspace SVG served inline and opened directly ran its script, and its
/// `fetch('/api/sessions')` answered 200. DSH answers its own file route with exactly this policy and `nosniff` on
/// every response, because "HTML and SVG files may be opened directly on the authenticated API origin": `sandbox`
/// runs such a document with no script and no origin, `default-src 'none'` lets it load nothing, and `nosniff` keeps
/// a download from being read as a page. A policy on an image or a stylesheet does not affect the page embedding it.
/// `FILE_ANSWER_HEADERS` of `src/server/web.ts`.
pub(crate) const FILE_ANSWER_POLICY: &str = "sandbox; default-src 'none'";

/// Add the file routes' two headers to an answer, whichever way it went.
fn hardened(mut response: Response) -> Response {
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        header::HeaderValue::from_static(FILE_ANSWER_POLICY),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        header::HeaderValue::from_static("nosniff"),
    );
    response
}

/// `GET /api/raw`: a file's bytes, inline only for a type a document embeds, every answer hardened.
async fn raw(State(files): State<FilesRoutes>, Query(params): Query<Params>) -> Response {
    hardened(raw_answer(&files, params.path))
}

fn raw_answer(files: &FilesRoutes, path: Option<String>) -> Response {
    let Some(path) = path.filter(|path| !path.is_empty()) else {
        return text(StatusCode::BAD_REQUEST, "a path is required\n");
    };
    let wanted = canonical_path(Path::new(&path));
    if !owned(&files.host, &wanted) {
        return text(StatusCode::NOT_FOUND, "no such asset\n");
    }
    let leaf = crate::node_path::basename(&wanted.to_string_lossy()).to_string();
    serve_bytes(&wanted, &leaf)
}

/// `GET /api/uploads/{leaf}`: an uploaded file's bytes, confined to the upload directory, every answer hardened.
async fn uploaded(State(files): State<FilesRoutes>, AxumPath(leaf): AxumPath<String>) -> Response {
    hardened(uploaded_answer(&files, &leaf))
}

fn uploaded_answer(files: &FilesRoutes, leaf: &str) -> Response {
    if leaf.is_empty() || leaf == "." || leaf == ".." || leaf.contains('/') || leaf.contains('\\') {
        return text(StatusCode::NOT_FOUND, "no such asset\n");
    }
    let directory = upload_directory(&files.host.heddle_home());
    let wanted = directory.join(leaf);
    if !is_under(&canonical_path(&directory), &canonical_path(&wanted)) {
        return text(StatusCode::NOT_FOUND, "no such asset\n");
    }
    serve_bytes(&wanted, leaf)
}

/// `POST /api/uploads?name=`: the browser's bytes, stored under the harness's own home.
async fn store(
    State(files): State<FilesRoutes>,
    Query(params): Query<Params>,
    request: Request,
) -> Response {
    let limit = MAX_UPLOAD_BYTES as usize;
    let body = match axum::body::to_bytes(request.into_body(), limit + 1).await {
        Ok(body) => body,
        Err(_) => return too_large_upload(),
    };
    if body.len() > limit {
        return too_large_upload();
    }
    if body.is_empty() {
        return text(
            StatusCode::BAD_REQUEST,
            "an empty file has nothing to add\n",
        );
    }
    let name = params.name.as_deref().unwrap_or("file");
    match save_upload(&files.host.heddle_home(), name, &body, SystemTime::now()) {
        Ok(saved) => json(
            StatusCode::OK,
            &format!("{}\n", serde_json::to_string(&saved).unwrap_or_default()),
        ),
        Err(error) => text(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("the file could not be stored: {error}\n"),
        ),
    }
}

/// The `413` answer `POST /api/uploads` gives, with the ceiling the sentence names.
fn too_large_upload() -> Response {
    text(
        StatusCode::PAYLOAD_TOO_LARGE,
        &format!(
            "the file is larger than this server accepts ({} MiB)\n",
            MAX_UPLOAD_BYTES / (1024 * 1024)
        ),
    )
}

/// `POST /api/markdown`: draw the body's text as a document.
async fn markdown(request: Request) -> Response {
    let body = match axum::body::to_bytes(request.into_body(), MAX_MARKDOWN_BYTES + 1).await {
        Ok(body) => body,
        Err(_) => return text(StatusCode::PAYLOAD_TOO_LARGE, "request too large\n"),
    };
    if body.len() > MAX_MARKDOWN_BYTES {
        return text(StatusCode::PAYLOAD_TOO_LARGE, "request too large\n");
    }
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(&body) else {
        return text(StatusCode::BAD_REQUEST, "the body must be JSON\n");
    };
    let Some(text) = value.get("text").and_then(serde_json::Value::as_str) else {
        return json_error(StatusCode::BAD_REQUEST, "text is required");
    };
    let html = crate::markdown::render_markdown(text, crate::markdown::MarkdownOptions::default());
    json(
        StatusCode::OK,
        &format!(
            "{}\n",
            serde_json::to_string(&serde_json::json!({ "html": html })).unwrap_or_default()
        ),
    )
}

/// `POST /api/workspaces/pick`: the platform's own dialog, one decision.
async fn pick(State(files): State<FilesRoutes>) -> Response {
    let outcome = pick_folder(&files.platform, files.runner.as_ref()).await;
    match &outcome {
        PickerOutcome::Unavailable { reason } => json_error(StatusCode::NOT_IMPLEMENTED, reason),
        _ => json(
            StatusCode::OK,
            &format!(
                "{}\n",
                serde_json::to_string_pretty(&outcome).unwrap_or_default()
            ),
        ),
    }
}

/// `GET /api/directories?path=`: one directory level for the page's own folder chooser.
async fn list_directories(
    Query(query): Query<std::collections::HashMap<String, String>>,
) -> Response {
    let home = crate::directories::home_dir();
    match crate::directories::list_directory(query.get("path").map(String::as_str), &home) {
        Ok(listing) => json(
            StatusCode::OK,
            &format!(
                "{}\n",
                serde_json::to_string_pretty(&listing).unwrap_or_default()
            ),
        ),
        Err(error) => directory_refusal(&error),
    }
}

/// `POST /api/directories` `{parent, name}`: one new child folder, non-recursive.
async fn create_directory(request: Request) -> Response {
    let body = match axum::body::to_bytes(request.into_body(), MAX_MARKDOWN_BYTES + 1).await {
        Ok(body) => body,
        Err(_) => return text(StatusCode::PAYLOAD_TOO_LARGE, "request too large\n"),
    };
    if body.len() > MAX_MARKDOWN_BYTES {
        return text(StatusCode::PAYLOAD_TOO_LARGE, "request too large\n");
    }
    let value = if body.is_empty() {
        serde_json::Value::Object(serde_json::Map::new())
    } else {
        match serde_json::from_slice::<serde_json::Value>(&body) {
            Ok(value) => value,
            Err(_) => return text(StatusCode::BAD_REQUEST, "the body must be JSON\n"),
        }
    };
    let field = |name: &str| value.get(name).and_then(serde_json::Value::as_str);
    let home = crate::directories::home_dir();
    match crate::directories::create_directory(field("parent"), field("name"), &home) {
        Ok(path) => json(
            StatusCode::OK,
            &format!(
                "{}\n",
                serde_json::to_string_pretty(&serde_json::json!({ "path": path }))
                    .unwrap_or_default()
            ),
        ),
        Err(error) => directory_refusal(&error),
    }
}

/// `{"error", "code"}` with the refusal's own status.
fn directory_refusal(error: &crate::directories::DirectoryError) -> Response {
    json(
        StatusCode::from_u16(error.status).unwrap_or(StatusCode::BAD_REQUEST),
        &format!(
            "{{\"error\":{},\"code\":{}}}\n",
            serde_json::to_string(&error.message).unwrap_or_default(),
            serde_json::to_string(error.code).unwrap_or_default()
        ),
    )
}

/// Whether `path` is a file inside a registered workspace root.
fn owned(host: &Arc<dyn FilesHost>, path: &Path) -> bool {
    host.workspace_owner(path) == WorkspaceAnswer::Owned
}

/// Serve one file's bytes with the type its extension names, and a download for anything a browser would run.
fn serve_bytes(path: &Path, download_name: &str) -> Response {
    let metadata = match std::fs::metadata(path) {
        Ok(metadata) if metadata.is_file() => metadata,
        _ => return text(StatusCode::NOT_FOUND, "no such asset\n"),
    };
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(_) => return text(StatusCode::NOT_FOUND, "no such asset\n"),
    };
    let inline = inline_content_type(&path.to_string_lossy());
    let disposition = match inline {
        Some(_) => "inline".to_string(),
        None => format!(
            "attachment; filename=\"{}\"",
            download_name.replace('"', "")
        ),
    };
    let content_type = inline.unwrap_or("application/octet-stream");
    let mut response = Response::new(Body::from(bytes));
    *response.status_mut() = StatusCode::OK;
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_static(content_type),
    );
    if let Ok(value) = header::HeaderValue::from_str(&metadata.len().to_string()) {
        headers.insert(header::CONTENT_LENGTH, value);
    }
    if let Ok(value) = header::HeaderValue::from_str(&disposition) {
        headers.insert(header::CONTENT_DISPOSITION, value);
    }
    no_store(&mut response);
    response
}

/// A plain-text answer, which is what a route that failed before reading JSON says.
fn text(status: StatusCode, body: &str) -> Response {
    let mut response = Response::new(Body::from(body.to_string()));
    *response.status_mut() = status;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    no_store(&mut response);
    response
}

/// A JSON answer. Every JSON body is followed by a newline, as the TypeScript routes do.
fn json(status: StatusCode, body: &str) -> Response {
    let mut response = Response::new(Body::from(body.to_string()));
    *response.status_mut() = status;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_static("application/json; charset=utf-8"),
    );
    no_store(&mut response);
    response
}

/// `{"error": <sentence>}` with the newline every JSON body carries.
fn json_error(status: StatusCode, message: &str) -> Response {
    json(
        status,
        &format!(
            "{}\n",
            serde_json::to_string(&ErrorAnswer {
                error: message.to_string()
            })
            .unwrap_or_default()
        ),
    )
}

/// Every file answer is `no-store`: a workspace file changes under the panel.
fn no_store(response: &mut Response) {
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-store"),
    );
}

/// The canonical form of a path — symlinks resolved — or its lexically resolved form when it does not exist.
///
/// `realpath` where the file is there, `path.resolve` where it is not, which is `canonicalPath` of `src/paths.ts`
/// and the order that keeps the refusal sentences stable for a file that has been deleted.
fn canonical_path(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| crate::docs::resolve_lexically(path))
}

/// Whether `child` is inside `parent` (`..` and symlinks already resolved by the caller).
fn is_under(parent: &Path, child: &Path) -> bool {
    child != parent && child.starts_with(parent)
}

/// The type a document may embed inline, by lower-cased extension, or `None` for anything a browser should not run
/// in this origin (served as a download instead) — `inlineContentType` of `src/server/web.ts`.
pub(crate) fn inline_content_type(path: &str) -> Option<&'static str> {
    let extension = crate::node_path::extname(path).to_lowercase();
    INLINE_TYPES
        .iter()
        .find(|(known, _)| *known == extension)
        .map(|(_, mime)| *mime)
}

/// Images, video, audio, fonts, PDF and stylesheets — what an `<img>`, a `<video>`, an `@font-face` or a
/// `<link rel="stylesheet">` needs. Nothing a browser would run as a page or a script.
///
/// A stylesheet is here because an HTML preview's `<link rel="stylesheet">` is rewritten to `/api/raw`, and a browser
/// refuses a stylesheet whose type is not `text/css` in a standards-mode document: measured 2026-10-29 (DSH parity
/// R-developer-twelve-14), a preview's relative CSS never applied because it arrived as a download type.
pub(crate) const INLINE_TYPES: &[(&str, &str)] = &[
    (".png", "image/png"),
    (".jpg", "image/jpeg"),
    (".jpeg", "image/jpeg"),
    (".gif", "image/gif"),
    (".webp", "image/webp"),
    (".avif", "image/avif"),
    (".bmp", "image/bmp"),
    (".ico", "image/x-icon"),
    (".svg", "image/svg+xml"),
    (".mp4", "video/mp4"),
    (".webm", "video/webm"),
    (".mp3", "audio/mpeg"),
    (".ogg", "audio/ogg"),
    (".wav", "audio/wav"),
    (".woff", "font/woff"),
    (".woff2", "font/woff2"),
    (".ttf", "font/ttf"),
    (".otf", "font/otf"),
    (".pdf", "application/pdf"),
    (".css", "text/css; charset=utf-8"),
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_image_is_served_inline_with_its_type() {
        assert_eq!(inline_content_type("/w/heddle.svg"), Some("image/svg+xml"));
        assert_eq!(inline_content_type("/w/SHOT.PNG"), Some("image/png"));
        assert_eq!(inline_content_type("/w/doc.pdf"), Some("application/pdf"));
    }

    #[test]
    fn a_stylesheet_is_served_inline_as_css_so_an_html_preview_can_apply_it() {
        // DSH parity R-developer-twelve-14: served as a download type, a preview's relative CSS never applied.
        assert_eq!(
            inline_content_type("/w/style.css"),
            Some("text/css; charset=utf-8")
        );
        assert_eq!(
            inline_content_type("/w/THEME.CSS"),
            Some("text/css; charset=utf-8")
        );
    }

    #[test]
    fn anything_a_browser_would_run_is_not_inline() {
        for path in [
            "/w/page.html",
            "/w/app.js",
            "/w/README.md",
            "/w/data.json",
            "/w/LICENSE",
            "/w/x.xhtml",
        ] {
            assert_eq!(inline_content_type(path), None, "{path} is a download");
        }
    }

    // ---- the routes, one test per row of the table above -------------------------------------------------------

    use crate::host::FileReadError;
    use axum::Router;
    use axum::http::{HeaderMap, Request as HttpRequest, StatusCode as Status};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    /// A host over a real temporary tree: the routes read bytes and text through it, and nothing touches the
    /// operator's home.
    struct DoubleHost {
        home: PathBuf,
        root: PathBuf,
        loaded: bool,
        /// Judge containment on the string the request wrote, as a host that forgot to canonicalise would.
        naive: bool,
        reads: std::sync::Mutex<Vec<String>>,
    }

    impl FilesHost for DoubleHost {
        fn heddle_home(&self) -> PathBuf {
            self.home.clone()
        }

        fn workspace_owner(&self, path: &Path) -> WorkspaceAnswer {
            if !self.loaded {
                return WorkspaceAnswer::NotLoaded;
            }
            if self.naive {
                let asked = path.to_string_lossy();
                let root = self.root.to_string_lossy();
                return if asked == root || asked.starts_with(&format!("{root}/")) {
                    WorkspaceAnswer::Owned
                } else {
                    WorkspaceAnswer::Outside
                };
            }
            let canonical = canonical_path(path);
            if is_under(&canonical_path(&self.root), &canonical) {
                WorkspaceAnswer::Owned
            } else {
                WorkspaceAnswer::Outside
            }
        }

        fn read_file_text(&self, path: &Path) -> Result<FileReading, FileReadError> {
            self.reads
                .lock()
                .unwrap()
                .push(path.to_string_lossy().into_owned());
            read_for_test(path)
        }
    }

    /// `readFileText`, as the session tree answers it: 404 for a non-file, 415 for bytes that are not UTF-8.
    fn read_for_test(path: &Path) -> Result<FileReading, FileReadError> {
        let canonical = canonical_path(path);
        let name = crate::node_path::basename(&canonical.to_string_lossy()).to_string();
        let metadata = std::fs::metadata(&canonical).map_err(|_| {
            FileReadError::NotAFile(format!("{} is not a file", canonical.display()))
        })?;
        if !metadata.is_file() {
            return Err(FileReadError::NotAFile(format!(
                "{} is not a file",
                canonical.display()
            )));
        }
        let bytes = std::fs::read(&canonical).map_err(|_| {
            FileReadError::NotAFile(format!("{} is not a file", canonical.display()))
        })?;
        let text = String::from_utf8(bytes).map_err(|_| {
            FileReadError::NotText(format!(
                "{} is not UTF-8 text, so it has no text to show",
                canonical.display()
            ))
        })?;
        let lines = text.lines().count() as u64;
        Ok(FileReading {
            path: canonical.to_string_lossy().into_owned(),
            name,
            bytes: metadata.len(),
            lines,
            text,
            truncated: false,
        })
    }

    /// A scratch workspace with the fixture files the checks read, and a fresh home beside it.
    fn scratch(name: &str) -> (PathBuf, DoubleHost) {
        let base = std::env::temp_dir().join(format!(
            "hd-files-routes-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let root = base.join("workspace");
        let home = base.join("home");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(
            root.join("AGENTS.md"),
            "# Title\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n",
        )
        .unwrap();
        std::fs::write(root.join("package.json"), "{\"a\": 1}\n").unwrap();
        std::fs::write(root.join("cordis.yml"), "key: value\n").unwrap();
        std::fs::write(root.join("LICENSE"), "the license text\n").unwrap();
        std::fs::write(
            root.join("heddle.svg"),
            "<svg xmlns=\"http://www.w3.org/2000/svg\"><rect width=\"40\" height=\"40\"/></svg>",
        )
        .unwrap();
        std::fs::write(
            root.join("page.html"),
            "<h1>Fixture</h1><img src=\"heddle.svg\">",
        )
        .unwrap();
        std::fs::write(root.join("binary.bin"), [0xffu8, 0xfe, 0x00]).unwrap();
        std::fs::create_dir_all(root.join("folder")).unwrap();
        let host = DoubleHost {
            home,
            root: root.clone(),
            loaded: true,
            naive: false,
            reads: std::sync::Mutex::new(Vec::new()),
        };
        (base, host)
    }

    fn routes_of(host: DoubleHost) -> Router {
        FilesRoutes::new(Arc::new(host)).router()
    }

    fn app_with_picker(host: DoubleHost, answers: &[(&'static str, CommandResult)]) -> Router {
        let runner = Arc::new(AnsweringRunner {
            answers: answers.iter().cloned().collect(),
        });
        FilesRoutes::new(Arc::new(host))
            .with_picker(Platform::MacOs, runner)
            .router()
    }

    struct AnsweringRunner {
        answers: std::collections::HashMap<&'static str, CommandResult>,
    }

    impl crate::picker::CommandRunner for AnsweringRunner {
        fn run<'a>(
            &'a self,
            command: &'a str,
            _args: &'a [String],
        ) -> crate::picker::BoxFuture<'a, CommandResult> {
            let answer = self.answers.get(command).cloned().unwrap_or(CommandResult {
                stdout: String::new(),
                stderr: format!("{command}: command not found"),
                code: 127,
            });
            Box::pin(async move { answer })
        }
    }

    use crate::picker::CommandResult;

    async fn call(
        app: Router,
        method: &str,
        uri: &str,
        body: Option<Vec<u8>>,
    ) -> (Status, HeaderMap, Vec<u8>) {
        let request = HttpRequest::builder()
            .method(method)
            .uri(uri)
            .body(Body::from(body.unwrap_or_default()))
            .unwrap();
        let response = app.oneshot(request).await.unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .to_vec();
        (status, headers, bytes)
    }

    fn body_text(bytes: &[u8]) -> String {
        String::from_utf8_lossy(bytes).into_owned()
    }

    fn query(path: &str) -> String {
        format!("/api/file?path={}", crate::markdown::percent_encode(path))
    }

    #[tokio::test]
    async fn a_document_is_answered_with_its_reading_and_its_markup() {
        let (base, host) = scratch("file-doc");
        let document = host.root.join("AGENTS.md");
        let (status, headers, bytes) = call(
            routes_of(host),
            "GET",
            &query(&document.to_string_lossy()),
            None,
        )
        .await;
        assert_eq!(status, Status::OK);
        assert_eq!(
            headers
                .get(header::CACHE_CONTROL)
                .unwrap()
                .to_str()
                .unwrap(),
            "no-store"
        );
        let answer: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(answer["renderer"], "markdown");
        assert!(
            answer["html"].as_str().unwrap().contains("<h1>"),
            "{answer}"
        );
        assert!(
            answer["html"].as_str().unwrap().contains("<table>"),
            "{answer}"
        );
        assert!(
            answer["text"].as_str().unwrap().contains("# Title"),
            "{answer}"
        );
        assert!(answer["html"].is_string());
        assert!(
            answer.get("language").is_none(),
            "a document has no language"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[tokio::test]
    async fn a_source_file_is_answered_as_code_with_its_language() {
        let (base, host) = scratch("file-code");
        let path = host.root.join("package.json");
        let (status, _, bytes) = call(
            routes_of(host),
            "GET",
            &query(&path.to_string_lossy()),
            None,
        )
        .await;
        assert_eq!(status, Status::OK);
        let answer: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(answer["renderer"], "code");
        assert_eq!(answer["language"], "json");
        assert!(
            answer["html"].as_str().unwrap().contains("hljs-"),
            "{answer}"
        );
        assert!(
            answer["html"].as_str().unwrap().contains("class=\"ln\""),
            "{answer}"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[tokio::test]
    async fn a_file_with_no_renderer_is_text_with_no_markup() {
        let (base, host) = scratch("file-text");
        let path = host.root.join("LICENSE");
        let (status, _, bytes) = call(
            routes_of(host),
            "GET",
            &query(&path.to_string_lossy()),
            None,
        )
        .await;
        assert_eq!(status, Status::OK);
        let answer: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(answer["renderer"], "text");
        assert!(
            answer.get("html").is_none(),
            "html is absent, not null: {answer}"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[tokio::test]
    async fn every_way_a_file_route_refuses_is_a_status() {
        let (base, host) = scratch("file-refusals");
        let root = host.root.clone();
        let routes = routes_of(host);
        let (status, _, bytes) = call(routes.clone(), "GET", "/api/file", None).await;
        assert_eq!(status, Status::BAD_REQUEST);
        assert_eq!(body_text(&bytes), "{\"error\":\"a path is required\"}\n");
        let (status, _, bytes) = call(routes.clone(), "GET", &query("/etc/passwd"), None).await;
        assert_eq!(status, Status::BAD_REQUEST);
        assert!(
            body_text(&bytes).contains("is not under any workspace root"),
            "{}",
            body_text(&bytes)
        );
        let (status, _, _) = call(
            routes.clone(),
            "GET",
            &query(&root.join("folder").to_string_lossy()),
            None,
        )
        .await;
        assert_eq!(status, Status::NOT_FOUND, "a folder is not a file");
        let (status, _, bytes) = call(
            routes.clone(),
            "GET",
            &query(&root.join("binary.bin").to_string_lossy()),
            None,
        )
        .await;
        assert_eq!(status, Status::UNSUPPORTED_MEDIA_TYPE);
        assert!(
            body_text(&bytes).contains("not UTF-8 text"),
            "{}",
            body_text(&bytes)
        );
        let (base2, mut host) = scratch("file-unloaded");
        host.loaded = false;
        let (status, _, _) = call(
            routes_of(host),
            "GET",
            &query(&root.to_string_lossy()),
            None,
        )
        .await;
        assert_eq!(status, Status::SERVICE_UNAVAILABLE);
        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::remove_dir_all(&base2);
    }

    #[tokio::test]
    async fn a_documents_image_is_served_inline_with_its_type() {
        let (base, host) = scratch("raw-image");
        let path = host.root.join("heddle.svg");
        let (status, headers, bytes) = call(
            routes_of(host),
            "GET",
            &format!(
                "/api/raw?path={}",
                crate::markdown::percent_encode(&path.to_string_lossy())
            ),
            None,
        )
        .await;
        assert_eq!(status, Status::OK);
        assert_eq!(
            headers.get(header::CONTENT_TYPE).unwrap().to_str().unwrap(),
            "image/svg+xml"
        );
        assert_eq!(
            headers
                .get(header::CONTENT_DISPOSITION)
                .unwrap()
                .to_str()
                .unwrap(),
            "inline"
        );
        assert_eq!(
            headers
                .get(header::CONTENT_LENGTH)
                .unwrap()
                .to_str()
                .unwrap(),
            bytes.len().to_string()
        );
        assert!(bytes.starts_with(b"<svg"));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[tokio::test]
    async fn every_answer_of_a_file_route_is_sandboxed_and_never_sniffed() {
        // DSH parity R-developer-twelve-16: a workspace SVG opened directly ran its script with the session's access.
        // DSH answers its file route with this policy and nosniff on every response; so do both of heddle's.
        let (base, host) = scratch("raw-hardened");
        let root = host.root.clone();
        let uploads = upload_directory(&host.heddle_home());
        std::fs::create_dir_all(&uploads).unwrap();
        std::fs::write(
            uploads.join("stored.svg"),
            "<svg xmlns=\"http://www.w3.org/2000/svg\"/>",
        )
        .unwrap();
        let app = routes_of(host);
        let raw = |name: &str| {
            format!(
                "/api/raw?path={}",
                crate::markdown::percent_encode(&root.join(name).to_string_lossy())
            )
        };
        let cases = [
            ("an inline SVG", raw("heddle.svg"), Status::OK),
            ("a download", raw("AGENTS.md"), Status::OK),
            ("a missing file", raw("missing.txt"), Status::NOT_FOUND),
            (
                "a request without a path",
                "/api/raw?path=".to_owned(),
                Status::BAD_REQUEST,
            ),
            (
                "an uploaded SVG",
                "/api/uploads/stored.svg".to_owned(),
                Status::OK,
            ),
            (
                "a missing upload",
                "/api/uploads/no-such-file.svg".to_owned(),
                Status::NOT_FOUND,
            ),
        ];
        for (what, uri, status) in cases {
            let (got, headers, _) = call(app.clone(), "GET", &uri, None).await;
            assert_eq!(got, status, "{what}");
            assert_eq!(
                headers
                    .get(header::CONTENT_SECURITY_POLICY)
                    .map(|value| value.to_str().unwrap()),
                Some(FILE_ANSWER_POLICY),
                "{what} is sandboxed with no sources"
            );
            assert_eq!(
                headers
                    .get(header::X_CONTENT_TYPE_OPTIONS)
                    .map(|value| value.to_str().unwrap()),
                Some("nosniff"),
                "{what} is never sniffed"
            );
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    #[tokio::test]
    async fn a_file_a_browser_would_run_is_offered_as_a_download() {
        let (base, host) = scratch("raw-download");
        let path = host.root.join("AGENTS.md");
        let (status, headers, _) = call(
            routes_of(host),
            "GET",
            &format!(
                "/api/raw?path={}",
                crate::markdown::percent_encode(&path.to_string_lossy())
            ),
            None,
        )
        .await;
        assert_eq!(status, Status::OK);
        assert_eq!(
            headers.get(header::CONTENT_TYPE).unwrap().to_str().unwrap(),
            "application/octet-stream"
        );
        assert_eq!(
            headers
                .get(header::CONTENT_DISPOSITION)
                .unwrap()
                .to_str()
                .unwrap(),
            "attachment; filename=\"AGENTS.md\""
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[tokio::test]
    async fn a_path_outside_every_root_is_not_served() {
        let (base, host) = scratch("raw-outside");
        let routes = routes_of(host);
        let (status, _, bytes) = call(routes.clone(), "GET", "/api/raw", None).await;
        assert_eq!(status, Status::BAD_REQUEST);
        assert_eq!(body_text(&bytes), "a path is required\n");
        let (status, _, bytes) = call(
            routes,
            "GET",
            &format!(
                "/api/raw?path={}",
                crate::markdown::percent_encode("/etc/passwd")
            ),
            None,
        )
        .await;
        assert_eq!(status, Status::NOT_FOUND);
        assert_eq!(body_text(&bytes), "no such asset\n");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[tokio::test]
    async fn an_upload_is_stored_and_served_back_from_the_upload_directory() {
        let (base, host) = scratch("uploads");
        let home = host.home.clone();
        let routes = routes_of(host);
        let (status, _, bytes) = call(
            routes.clone(),
            "POST",
            "/api/uploads?name=shot.png",
            Some(b"png".to_vec()),
        )
        .await;
        assert_eq!(status, Status::OK);
        let saved: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(saved["name"], "shot.png");
        assert_eq!(saved["bytes"], 3);
        assert!(
            saved["path"]
                .as_str()
                .unwrap()
                .starts_with(&home.join("uploads").to_string_lossy().to_string())
        );
        let path = saved["path"].as_str().unwrap();
        let leaf = crate::node_path::basename(path);
        let (status, headers, served) =
            call(routes.clone(), "GET", &format!("/api/uploads/{leaf}"), None).await;
        assert_eq!(status, Status::OK);
        assert_eq!(
            headers.get(header::CONTENT_TYPE).unwrap().to_str().unwrap(),
            "image/png"
        );
        assert_eq!(served, b"png");
        // A hand-made request cannot walk out of the directory.
        for leaf in ["..", ".", "a/b", "%2e%2e"] {
            let (status, _, _) =
                call(routes.clone(), "GET", &format!("/api/uploads/{leaf}"), None).await;
            assert_eq!(status, Status::NOT_FOUND, "{leaf}");
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    #[tokio::test]
    async fn an_empty_upload_is_refused() {
        let (base, host) = scratch("uploads-empty");
        let (status, _, bytes) = call(
            routes_of(host),
            "POST",
            "/api/uploads?name=a.txt",
            Some(Vec::new()),
        )
        .await;
        assert_eq!(status, Status::BAD_REQUEST);
        assert_eq!(body_text(&bytes), "an empty file has nothing to add\n");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[tokio::test]
    async fn text_is_drawn_as_a_document_in_compact_json() {
        let (base, host) = scratch("markdown");
        let (status, headers, bytes) = call(
            routes_of(host),
            "POST",
            "/api/markdown",
            Some(br##"{"text":"# Hi"}"##.to_vec()),
        )
        .await;
        assert_eq!(status, Status::OK);
        assert_eq!(
            headers.get(header::CONTENT_TYPE).unwrap().to_str().unwrap(),
            "application/json; charset=utf-8"
        );
        assert_eq!(body_text(&bytes), "{\"html\":\"<h1>Hi</h1>\\n\"}\n");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[tokio::test]
    async fn a_markdown_body_that_is_not_json_or_has_no_text_is_refused() {
        let (base, host) = scratch("markdown-refusals");
        let routes = routes_of(host);
        let (status, _, bytes) = call(
            routes.clone(),
            "POST",
            "/api/markdown",
            Some(b"not json".to_vec()),
        )
        .await;
        assert_eq!(status, Status::BAD_REQUEST);
        assert_eq!(body_text(&bytes), "the body must be JSON\n");
        let (status, _, bytes) = call(
            routes.clone(),
            "POST",
            "/api/markdown",
            Some(b"{}".to_vec()),
        )
        .await;
        assert_eq!(status, Status::BAD_REQUEST);
        assert_eq!(body_text(&bytes), "{\"error\":\"text is required\"}\n");
        let huge = format!("{{\"text\":\"{}\"}}", "a".repeat(10 * 1024 * 1024 + 1));
        let (status, _, bytes) =
            call(routes, "POST", "/api/markdown", Some(huge.into_bytes())).await;
        assert_eq!(status, Status::PAYLOAD_TOO_LARGE);
        assert_eq!(body_text(&bytes), "request too large\n");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[tokio::test]
    async fn a_picked_folder_is_an_answer_and_an_unavailable_host_is_a_501() {
        let (base, host) = scratch("pick");
        let routes = app_with_picker(
            host,
            &[(
                "osascript",
                CommandResult {
                    stdout: "/Users/me/work/\n".into(),
                    stderr: String::new(),
                    code: 0,
                },
            )],
        );
        let (status, _, bytes) = call(routes, "POST", "/api/workspaces/pick", None).await;
        assert_eq!(status, Status::OK);
        assert_eq!(
            body_text(&bytes),
            "{\n  \"kind\": \"picked\",\n  \"path\": \"/Users/me/work\"\n}\n"
        );
        let (base2, host2) = scratch("pick-unavailable");
        let routes = app_with_picker(host2, &[]);
        let (status, _, bytes) = call(routes, "POST", "/api/workspaces/pick", None).await;
        assert_eq!(status, Status::NOT_IMPLEMENTED);
        assert!(
            body_text(&bytes).contains("the directory picker failed"),
            "{}",
            body_text(&bytes)
        );
        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::remove_dir_all(&base2);
    }

    /// A layer the caller might put over the merged router — the token decision, in miniature.
    async fn stamp(request: axum::extract::Request, next: axum::middleware::Next) -> Response {
        let mut response = next.run(request).await;
        response.headers_mut().insert(
            axum::http::header::HeaderName::from_static("x-stamped"),
            axum::http::HeaderValue::from_static("yes"),
        );
        response
    }

    #[tokio::test]
    async fn mount_merges_into_a_router_whose_own_state_is_applied_and_a_layer_covers_both() {
        // The one call the server makes: its state applied, then mount, then its token layer over the result.
        let (base, host) = scratch("mount");
        let document = host.root.join("AGENTS.md");
        let caller = Router::new()
            .route("/api/health", get(|| async { "ok" }))
            .with_state(());
        let app =
            crate::routes::mount(caller, Arc::new(host)).layer(axum::middleware::from_fn(stamp));

        let (status, headers, bytes) = call(app.clone(), "GET", "/api/health", None).await;
        assert_eq!(status, Status::OK);
        assert_eq!(body_text(&bytes), "ok");
        assert_eq!(
            headers.get("x-stamped").unwrap().to_str().unwrap(),
            "yes",
            "the caller's layer covers its own route"
        );
        let (status, headers, _) =
            call(app, "GET", &query(&document.to_string_lossy()), None).await;
        assert_eq!(status, Status::OK, "and the mounted file routes answer");
        assert_eq!(
            headers.get("x-stamped").unwrap().to_str().unwrap(),
            "yes",
            "the caller's layer covers the mounted routes too"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[tokio::test]
    async fn mount_routes_takes_the_routes_the_caller_configured() {
        let (base, host) = scratch("mount-routes");
        let routes = FilesRoutes::new(Arc::new(host)).with_picker(
            Platform::MacOs,
            Arc::new(AnsweringRunner {
                answers: [(
                    "osascript",
                    CommandResult {
                        stdout: "/Users/me/picked\n".into(),
                        stderr: String::new(),
                        code: 0,
                    },
                )]
                .into_iter()
                .collect(),
            }),
        );
        let app = crate::routes::mount_routes(Router::new(), routes);
        let (status, _, bytes) = call(app, "POST", "/api/workspaces/pick", None).await;
        assert_eq!(status, Status::OK);
        assert!(
            body_text(&bytes).contains("/Users/me/picked"),
            "{}",
            body_text(&bytes)
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[tokio::test]
    async fn the_router_answers_real_http_over_a_listener() {
        // `oneshot` proves the routes; this proves they work behind hyper, with the percent-encoded query a browser
        // sends, which is what the panel and the verifier do.
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let (base, host) = scratch("http");
        let document = host.root.join("AGENTS.md");
        let app = routes_of(host);
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let mut stream = tokio::net::TcpStream::connect(address).await.unwrap();
        let request = format!(
            "GET {} HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\r\n",
            query(&document.to_string_lossy())
        );
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut response = Vec::new();
        stream.read_to_end(&mut response).await.unwrap();
        let text = String::from_utf8_lossy(&response);
        assert!(text.starts_with("HTTP/1.1 200"), "{text}");
        assert!(text.contains("\"renderer\""), "{text}");
        assert!(text.contains("markdown"), "{text}");
        assert!(text.contains("cache-control: no-store"), "{text}");

        server.abort();
        let _ = std::fs::remove_dir_all(&base);
    }

    #[tokio::test]
    async fn an_upload_whose_name_needs_encoding_is_served_by_its_encoded_leaf() {
        let (base, host) = scratch("upload-encoded");
        let directory = host.home.join("uploads");
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join("a b.png"), b"png").unwrap();
        let (status, headers, bytes) =
            call(routes_of(host), "GET", "/api/uploads/a%20b.png", None).await;
        assert_eq!(status, Status::OK, "{}", body_text(&bytes));
        assert_eq!(
            headers.get(header::CONTENT_TYPE).unwrap().to_str().unwrap(),
            "image/png"
        );
        assert_eq!(bytes, b"png");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[tokio::test]
    async fn a_path_that_walks_out_with_dot_dot_is_refused_even_by_a_host_that_judges_the_string() {
        // The route resolves the path before asking, so `..` is decided by where it leads. A host that compares the
        // raw string would otherwise answer "owned" for `<root>/../outside.txt` and the bytes would be served.
        let (base, mut host) = scratch("traversal");
        host.naive = true;
        let root = host.root.clone();
        let outside = base.join("outside.txt");
        std::fs::write(&outside, b"not in the workspace").unwrap();
        let sneaky = format!("{}/../outside.txt", root.display());

        let routes = routes_of(host);
        let (status, _, bytes) = call(
            routes.clone(),
            "GET",
            &format!("/api/raw?path={}", crate::markdown::percent_encode(&sneaky)),
            None,
        )
        .await;
        assert_eq!(
            status,
            Status::NOT_FOUND,
            "no such asset: {}",
            body_text(&bytes)
        );
        let (status, _, bytes) = call(routes, "GET", &query(&sneaky), None).await;
        assert_eq!(status, Status::BAD_REQUEST, "{}", body_text(&bytes));
        assert!(
            body_text(&bytes).contains("is not under any workspace root"),
            "{}",
            body_text(&bytes)
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_symlink_inside_the_workspace_is_judged_by_where_it_leads() {
        let (base, mut host) = scratch("workspace-symlink");
        host.naive = true;
        let root = host.root.clone();
        let outside = base.join("secret.txt");
        std::fs::write(&outside, b"secret").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("link.txt")).unwrap();

        let routes = routes_of(host);
        let (status, _, _) = call(
            routes.clone(),
            "GET",
            &format!(
                "/api/raw?path={}",
                crate::markdown::percent_encode(&root.join("link.txt").to_string_lossy())
            ),
            None,
        )
        .await;
        assert_eq!(
            status,
            Status::NOT_FOUND,
            "the link leads out of the workspace"
        );
        let (status, _, _) = call(
            routes,
            "GET",
            &query(&root.join("link.txt").to_string_lossy()),
            None,
        )
        .await;
        assert_eq!(status, Status::BAD_REQUEST);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn the_route_list_leaves_the_servers_own_paths_alone() {
        // developer-ten registers these in heddle-server; an overlap would panic in `Router::merge`.
        for (method, path) in [("GET", "/api/html"), ("GET", "/vendor/purify.js")] {
            assert!(
                !ROUTES.contains(&(method, path)),
                "{method} {path} is the server's route, not this crate's"
            );
        }
    }

    #[tokio::test]
    async fn the_file_answer_has_the_documented_fields_in_order() {
        let (base, host) = scratch("shape");
        let document = host.root.join("AGENTS.md");
        let (status, _, bytes) = call(
            routes_of(host),
            "GET",
            &query(&document.to_string_lossy()),
            None,
        )
        .await;
        assert_eq!(status, Status::OK);
        let body = body_text(&bytes);
        // One object: the reading's six fields, then the renderer's, in the order the page reads them.
        assert!(body.starts_with("{\n  \"path\": "), "{body}");
        let order = [
            "\"name\"",
            "\"bytes\"",
            "\"lines\"",
            "\"text\"",
            "\"truncated\"",
            "\"renderer\"",
            "\"html\"",
        ];
        let mut at = 0usize;
        for field in order {
            let found = body[at..]
                .find(field)
                .map(|offset| at + offset)
                .unwrap_or_else(|| panic!("{field} missing from {body}"));
            assert!(found >= at, "{field} is out of order in {body}");
            at = found + field.len();
        }
        // And the typed shape the server reads it through round-trips.
        let answer: FileAnswer = serde_json::from_str(&body).unwrap();
        assert_eq!(
            answer.rendered.renderer,
            crate::code::RendererName::Markdown
        );
        assert_eq!(answer.reading.name, "AGENTS.md");
        let again: FileAnswer =
            serde_json::from_str(&serde_json::to_string(&answer).unwrap()).unwrap();
        assert_eq!(again, answer);
        let error: ErrorAnswer =
            serde_json::from_str("{\"error\":\"a path is required\"}").unwrap();
        assert_eq!(error.error, "a path is required");
        let request: MarkdownRequest = serde_json::from_str("{\"text\":\"# Hi\"}").unwrap();
        assert_eq!(request.text, "# Hi");
        assert_eq!(
            serde_json::to_string(&MarkdownAnswer {
                html: "<h1>Hi</h1>\n".into()
            })
            .unwrap(),
            "{\"html\":\"<h1>Hi</h1>\\n\"}"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[tokio::test]
    async fn an_upload_over_the_ceiling_is_refused_with_the_ceiling_named() {
        let (base, host) = scratch("upload-too-large");
        let oversized = vec![b'a'; crate::uploads::MAX_UPLOAD_BYTES as usize + 1];
        let (status, _, bytes) = call(
            routes_of(host),
            "POST",
            "/api/uploads?name=big.bin",
            Some(oversized),
        )
        .await;
        assert_eq!(status, Status::PAYLOAD_TOO_LARGE);
        assert_eq!(
            body_text(&bytes),
            "the file is larger than this server accepts (50 MiB)\n"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[tokio::test]
    async fn an_upload_that_cannot_be_stored_says_so() {
        let (base, host) = scratch("upload-failure");
        // A file where the upload directory should be: the store cannot be created, which is the 500 path.
        std::fs::write(host.home.join("uploads"), b"in the way").unwrap();
        let (status, _, bytes) = call(
            routes_of(host),
            "POST",
            "/api/uploads?name=a.txt",
            Some(b"x".to_vec()),
        )
        .await;
        assert_eq!(status, Status::INTERNAL_SERVER_ERROR);
        assert!(
            body_text(&bytes).starts_with("the file could not be stored: "),
            "{}",
            body_text(&bytes)
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn an_upload_leaf_that_is_a_symlink_out_of_the_directory_is_not_served() {
        let (base, host) = scratch("upload-symlink");
        let directory = host.home.join("uploads");
        std::fs::create_dir_all(&directory).unwrap();
        let outside = base.join("secret.txt");
        std::fs::write(&outside, b"secret").unwrap();
        std::os::unix::fs::symlink(&outside, directory.join("link.txt")).unwrap();
        let (status, _, bytes) = call(routes_of(host), "GET", "/api/uploads/link.txt", None).await;
        assert_eq!(status, Status::NOT_FOUND);
        assert_eq!(body_text(&bytes), "no such asset\n");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn the_route_list_has_no_duplicates() {
        for (index, route) in ROUTES.iter().enumerate() {
            assert!(
                !ROUTES[index + 1..].contains(route),
                "{route:?} is listed twice"
            );
        }
    }
}
