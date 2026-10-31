//! What the tests run against: a real session store in a temporary folder, and the router called in-process.

use std::path::PathBuf;
use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::http::{Method, Request};
use axum::response::Response;
use heddle_config::Env;
use heddle_session::{CreateOptions, Events, SessionHandle, SessionStore};
use tower::ServiceExt;

use crate::mode::PlanLog;

/// A session store under a fresh temporary folder, with one session in it; the folder goes with it.
pub struct Fixture {
    pub root: PathBuf,
    pub store: Arc<SessionStore>,
    pub handle: SessionHandle,
}

impl Fixture {
    pub fn new(label: &str) -> Self {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "heddle-plan-{label}-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&root);
        let work = root.join("work");
        std::fs::create_dir_all(&work).expect("the work folder is created");
        let store = Arc::new(SessionStore::new(
            &root.join("sessions").display().to_string(),
            &Env::default(),
        ));
        let handle = store
            .create(CreateOptions {
                cwd: Some(work.display().to_string()),
                ..CreateOptions::default()
            })
            .expect("a session is created");
        Self {
            root,
            store,
            handle,
        }
    }

    /// The store as the log a change writes to.
    pub fn log(&self) -> &dyn PlanLog {
        self.store.as_ref()
    }

    /// The session's events so far.
    pub fn events(&self) -> Events {
        self.store.read(&self.handle).expect("the log reads")
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// Read a response body as text.
pub async fn body_text(response: Response) -> String {
    let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .expect("the body fits");
    String::from_utf8(bytes.to_vec()).expect("a UTF-8 body")
}

/// Send one request through a router, the way the server's handler would.
pub async fn call(router: Router, method: Method, uri: &str) -> Response {
    router
        .oneshot(
            Request::builder()
                .method(method)
                .uri(uri)
                .body(Body::empty())
                .expect("a valid request"),
        )
        .await
        .expect("the router answers")
}
