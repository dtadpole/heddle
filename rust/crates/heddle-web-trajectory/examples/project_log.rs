//! Project one decoded session log the way the Trajectory view does.
//!
//! The crate INDEX's differential procedure uses this: the same JSONL fed to this example and to
//! `src/server/ledger.ts` must give the same `{ledger, rows, timeline, stats}`. It is a development tool,
//! not part of the crate's API.
//!
//! ```sh
//! zstd -dc session.v2.jsonl.zstd > /tmp/session.jsonl
//! LOCAL_BUILD_SLOTS=2 _tools_/local-build/run run --example project_log \
//!   -p heddle-web-trajectory -- /tmp/session.jsonl
//! ```

use std::fs;

use serde_json::{Value, json};

use heddle_web_trajectory::{
    project_ledger, project_rows, project_session_stats, project_timeline,
};

fn main() {
    let path = std::env::args()
        .nth(1)
        .expect("usage: project_log <session.jsonl>");
    let text = fs::read_to_string(&path).expect("a readable session log");
    let events: Vec<Value> = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).expect("each line is one JSON event"))
        .collect();
    let ledger = project_ledger(&events);
    let rows = project_rows(&ledger);
    let timeline = project_timeline(&ledger);
    let stats = project_session_stats(&events);
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "ledger": ledger,
            "rows": rows,
            "timeline": timeline,
            "stats": stats,
        }))
        .expect("the projections serialise")
    );
}
