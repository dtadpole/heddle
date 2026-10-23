//! The collaboration policy the Lead and its teammates share.
//!
//! Port of `src/team/policy.ts`. DSH injects its `POLICY` into every member's system prompt; heddle writes it
//! once per session as a durable `context/note` with `origin: 'team-policy'`, so the rules survive a restart
//! with the team, appear in the surface exactly once, and are distinguishable from the project's instructions.

use serde_json::{Value, json};

/// The `origin` of the policy note, which is how "already written" is recognised.
pub const TEAM_POLICY_NOTE_ORIGIN: &str = "team-policy";

/// The policy text, verbatim from the TypeScript build.
pub const TEAM_POLICY: &str = "Agent Teams is available in this session. Create teammates only when the user explicitly asks to use Agent Teams or teammates.

The Team Lead and all teammates share one working directory and filesystem; edits are visible to every member immediately. Split write work into disjoint scopes, record the expected scopes on shared tasks, and use task dependencies when work must be ordered. Write-scope overlap is advisory, not a lock.

Use the target returned by spawn_teammate or list_agents for send_message and interrupt_agent, or as the owner when assigning or filtering shared tasks. send_message steers a running target at its nearest step boundary and starts or resumes an inactive one. inactive means no turn is executing; it does not describe task completion, success, failure, or waiting. provisioning means member creation is in progress; failed means it failed. A delivered peer message starts with its stable message id and sender name. A successful send is already durable even when it reports queued; do not resend it.

Shared-task workflow: list, get, claim with the current revision, do the work, then complete. Readiness never starts an owner. Before wait_agent, use list_agents and make sure another required member is running or provisioning; use send_message first when it is inactive. wait_agent observes only changes after it is called, never wakes a member, and returns noProgress when no other member can produce a change. Re-list after waking or timing out.

Spawn and interrupt are the Lead's alone. The Lead must wait for required teammates before giving its final answer.";

/// The event that makes the policy durable in one session, before the store adds `seq` and `at`:
/// `{ type: 'context/note', message: { role: 'system', content: [{ type: 'text', text }] }, origin: 'team-policy' }`.
pub fn policy_note_record() -> Value {
    json!({
        "type": "context/note",
        "message": { "role": "system", "content": [{ "type": "text", "text": TEAM_POLICY }] },
        "origin": TEAM_POLICY_NOTE_ORIGIN,
    })
}

/// Whether a session's log already holds the policy note (a `context/note` with the policy origin).
pub fn has_policy_note(events: &[Value]) -> bool {
    events.iter().any(|event| {
        event.get("type").and_then(Value::as_str) == Some("context/note")
            && event.get("origin").and_then(Value::as_str) == Some(TEAM_POLICY_NOTE_ORIGIN)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_note_is_a_system_context_note_with_the_policy_origin() {
        let note = policy_note_record();
        assert_eq!(note["type"], "context/note");
        assert_eq!(note["origin"], TEAM_POLICY_NOTE_ORIGIN);
        assert_eq!(note["message"]["role"], "system");
        assert_eq!(note["message"]["content"][0]["type"], "text");
        assert_eq!(note["message"]["content"][0]["text"], TEAM_POLICY);
    }

    #[test]
    fn the_policy_is_recognised_only_by_its_origin() {
        let note = policy_note_record();
        assert!(has_policy_note(std::slice::from_ref(&note)));
        let other_note = json!({ "type": "context/note", "origin": "instructions" });
        let policy_text_as_message =
            json!({ "type": "message", "origin": TEAM_POLICY_NOTE_ORIGIN });
        assert!(!has_policy_note(&[other_note, policy_text_as_message]));
        assert!(!has_policy_note(&[]));
    }

    #[test]
    fn the_policy_keeps_the_rules_the_tools_rely_on() {
        // The five paragraphs of the TypeScript text, and the rules a model is held to.
        assert_eq!(TEAM_POLICY.split("\n\n").count(), 5);
        for rule in [
            "Write-scope overlap is advisory, not a lock.",
            "do not resend it.",
            "returns noProgress when no other member can produce a change.",
            "Spawn and interrupt are the Lead's alone.",
        ] {
            assert!(TEAM_POLICY.contains(rule), "the policy states: {rule}");
        }
    }
}
