//! The doubles the Trajectory routes are judged against.
//!
//! The routes read a session's events, its title and the profile's tools through [`TrajectoryHost`], and the
//! highlighter through [`JsonHighlighter`]. Both are replaced here by fields and an escaper, so a route can be
//! judged in-process, without a session store or a server.

use std::collections::HashMap;

use heddle_web_composer::SessionLookup;
use heddle_web_composer::{ToolSpec, js};
use serde_json::Value;

use crate::inspector::JsonHighlighter;
use crate::routes::TrajectoryHost;

/// A host that answers every Trajectory question from memory.
#[derive(Clone, Default)]
pub struct Host {
    pub sessions: HashMap<String, Vec<Value>>,
    pub titles: HashMap<String, String>,
    pub specs: Vec<ToolSpec>,
}

impl Host {
    pub fn with_session(id: &str, events: Vec<Value>) -> Self {
        let mut host = Self::default();
        host.sessions.insert(id.to_owned(), events);
        host
    }
}

impl SessionLookup for Host {
    fn session_events(&self, id: &str) -> Option<Vec<Value>> {
        self.sessions.get(id).cloned()
    }
}

impl JsonHighlighter for Host {
    fn render_json(&self, source: &str) -> String {
        format!(
            "<code class=\"hljs-json\">{}</code>",
            js::escape_html(source)
        )
    }
}

impl TrajectoryHost for Host {
    fn session_title(&self, id: &str) -> Option<String> {
        self.titles.get(id).cloned()
    }

    fn tool_specs(&self) -> Vec<ToolSpec> {
        self.specs.clone()
    }
}
