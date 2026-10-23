//! The file routes of `src/server/web.ts`, as one `axum::Router` the server mounts.
//!
//! # Mounting
//!
//! ```ignore
//! let files = heddle_web_files::routes::FilesRoutes::new(Arc::new(my_host)).router();
//! let app = server_router.merge(files).layer(token_layer); // the token layer covers these routes too
//! ```
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
//! | `GET /api/raw?path=` | `400 text "a path is required\n"` · `404 text "no such asset\n"` outside every root, plugin absent, or not a file · `200` the bytes, `content-type` from the inline table (else `application/octet-stream`), `content-length`, `content-disposition: inline` for an inline type, else `attachment; filename="<leaf without ">"` |
//! | `GET /api/uploads/{leaf}` | `404 text "no such asset\n"` for an empty leaf, `.`, `..`, a separator, or a path that leaves the canonical upload directory · `200` the bytes, headers as `/api/raw` with the leaf as filename |
//! | `POST /api/uploads?name=` | body = the file's bytes · `413 text "the file is larger than this server accepts (50 MiB)\n"` · `400 text "an empty file has nothing to add\n"` · `200` compact [`SavedUpload`] |
//! | `POST /api/markdown` | body `{"text": string}` · `413 text "request too large\n"` over 10 MiB · `400 text "the body must be JSON\n"` · `400 {error: "text is required"}` · `200` compact `{"html": render_markdown(text)}` (no base) |
//! | `POST /api/workspaces/pick` | `501 {error: reason}` when unavailable · `200` pretty [`PickerOutcome`] (`picked` or `cancelled`) |
//! | `GET /api/html?path=` (proposed, see [`crate::html_preview`]) | `400 {error: "a path is required"}` · `404 {error: "that path is not under any workspace root"}` (also when the plugin is absent) · `404 {error: "not a file"}` · `413 {error: "the document is larger than 4MB"}` · `200` pretty `{"path","html","csp","bytes"}` · `404 {error: "no such document"}` |
//!
//! [`FileReading`]: crate::host::FileReading
//! [`Rendered`]: crate::code::Rendered
//! [`SavedUpload`]: crate::uploads::SavedUpload
//! [`PickerOutcome`]: crate::picker::PickerOutcome

use std::sync::Arc;

use crate::host::FilesHost;
use crate::picker::{CommandRunner, Platform, SystemRunner};

/// Every `(method, path)` this router answers, in axum 0.8 path syntax — so the server can assert at boot that no
/// route of its own overlaps one of these, which `Router::merge` would otherwise reject with a panic.
pub const ROUTES: &[(&str, &str)] = &[
    ("GET", "/api/file"),
    ("GET", "/api/raw"),
    ("GET", "/api/uploads/{leaf}"),
    ("POST", "/api/uploads"),
    ("POST", "/api/markdown"),
    ("POST", "/api/workspaces/pick"),
    ("GET", "/api/html"),
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
        todo!("port the file routes of src/server/web.ts as axum handlers over FilesRoutes")
    }
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

/// Images, video, audio, fonts and PDF — what an `<img>`, a `<video>` or an `@font-face` needs. Nothing a browser
/// would run as a page or a script.
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
