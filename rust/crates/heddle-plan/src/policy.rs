//! The guidance a request carries while its session is in plan mode — DSH's `plan:policy` section, verbatim from
//! the `plan-mode` row of its base profile (`dsh-base/cordis.patch.yml`), read 2026-10-29.
//!
//! Ported from `src/plan/policy.ts`, byte for byte (a test compares the two). Plan mode is **guidance, not
//! enforcement**, in DSH and here: no tool is removed or blocked, because the tool catalog stays the same across
//! modes for request-cache stability. What stops an edit is this text, then the sandbox and the approval policy,
//! exactly as in DSH.

use heddle_llm::{ContentPart, GenerateRequest, Message, Role};

/// DSH's `plan:policy` section, verbatim: six paragraphs joined by blank lines.
pub const PLAN_POLICY_SECTION: &str = concat!(
    "You are in plan mode. Stay in plan mode until the user approves your plan through exit_plan_mode or switches the session mode. Imperative language to implement changes means plan the implementation, not execute it. A user's conversational agreement — including an answer confirming something you asked — approves nothing and does not end plan mode; fold the confirmed decision into the plan and submit it through exit_plan_mode.",
    "\n\n",
    "Explore first. Use non-mutating reads, searches, static analysis, and checks to ground the plan in the actual repository. Do not edit or write files, change configuration, run formatters or code generation that rewrites tracked files, commit, or otherwise carry out the plan. Prefer existing functions and patterns over new machinery.",
    "\n\n",
    "The tool catalog stays the same across modes for request-cache stability. These plan-mode rules override any later tool description or guidance that suggests using mutation tools; those tools remain listed only to keep the request shape stable. Do not use todo_write to track this planning phase: it tracks implementation after an approved plan, while the plan itself belongs in exit_plan_mode.",
    "\n\n",
    "Resolve discoverable facts by inspection. Use ask_user_question only for user-owned choices or material ambiguity that inspection cannot answer. Do not ask the user where code lives or how current behavior works when you can find out.",
    "\n\n",
    "Make the plan decision-complete: state the goal and success criteria; group implementation changes by subsystem; identify public API, schema, and data-flow changes; cover edge cases, failure modes, tests, acceptance criteria, and explicit assumptions. Keep it concise enough to review but detailed enough that another engineer can implement it without making design decisions.",
    "\n\n",
    "When ready, call exit_plan_mode with the complete plan markdown, starting with a # title. Make exit_plan_mode the only and final tool call in that assistant response: it presents the plan for approval, and implementation begins only in a later step after approval. Do not paste the final plan as a plain reply or ask \"should I proceed?\" through prose or ask_user_question. If review rejects it, incorporate the feedback and present again. If the review channel is unavailable or aborted, stay in plan mode and ask the user to switch modes manually; do not proceed with implementation.",
);

/// The request with the plan-mode section added as a system message, after the system messages it already opens
/// with.
///
/// A separate message rather than an edit of the deployment's own system prompt, so the prompt the session recorded
/// is never rewritten, and every adapter already knows how to carry several system messages (the Anthropic shapes
/// join them into one top-level `system`; the OpenAI shapes send them in order).
pub fn with_plan_policy(request: GenerateRequest) -> GenerateRequest {
    with_policy_section(request, PLAN_POLICY_SECTION)
}

/// [`with_plan_policy`] with another section's text (the TypeScript `withPlanPolicy(request, section)`).
pub fn with_policy_section(mut request: GenerateRequest, section: &str) -> GenerateRequest {
    let policy = Message::new(Role::System, vec![ContentPart::text(section)]);
    let at = request
        .messages
        .iter()
        .position(|message| message.role != Role::System)
        .unwrap_or(request.messages.len());
    request.messages.insert(at, policy);
    request
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The template literal `src/plan/policy.ts` exports, read from the tree.
    fn typescript_section() -> String {
        let source = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../src/plan/policy.ts"
        ))
        .expect("src/plan/policy.ts reads");
        let opening = "export const PLAN_POLICY_SECTION = `";
        let start = source.find(opening).expect("the export") + opening.len();
        let length = source[start..].find('`').expect("the closing backtick");
        let literal = &source[start..start + length];
        assert!(
            !literal.contains('\\') && !literal.contains("${"),
            "the literal has no escapes or substitutions, so its text is its value"
        );
        literal.to_owned()
    }

    fn text(role: Role, text: &str) -> Message {
        Message::new(role, vec![ContentPart::text(text)])
    }

    fn request(messages: Vec<Message>) -> GenerateRequest {
        GenerateRequest {
            endpoint: "scripted".to_owned(),
            messages,
            ..GenerateRequest::default()
        }
    }

    #[test]
    fn the_section_is_byte_identical_to_the_typescript_one() {
        assert_eq!(PLAN_POLICY_SECTION, typescript_section());
        assert_eq!(PLAN_POLICY_SECTION.split("\n\n").count(), 6);
    }

    #[test]
    fn the_policy_section_is_dshs_and_it_goes_in_after_the_system_messages_a_request_opens_with() {
        assert!(PLAN_POLICY_SECTION.starts_with(
            "You are in plan mode. Stay in plan mode until the user approves your plan through exit_plan_mode"
        ));
        assert!(PLAN_POLICY_SECTION.contains("Do not edit or write files, change configuration"));
        assert!(
            PLAN_POLICY_SECTION
                .contains("those tools remain listed only to keep the request shape stable")
        );
        assert!(PLAN_POLICY_SECTION.contains(
            "call exit_plan_mode with the complete plan markdown, starting with a # title."
        ));
        let system = text(Role::System, "be careful");
        let user = text(Role::User, "plan the change");
        let planned = with_plan_policy(request(vec![system.clone(), user.clone()]));
        assert_eq!(planned.messages.len(), 3);
        assert_eq!(planned.messages[0], system);
        assert_eq!(planned.messages[1], text(Role::System, PLAN_POLICY_SECTION));
        assert_eq!(planned.messages[2], user);
        assert_eq!(
            with_plan_policy(request(vec![user.clone()])).messages[0].role,
            Role::System,
            "with no system prompt it opens the request"
        );
        // Two leading system messages: the section goes after both; a later one stays where it was.
        let late = text(Role::System, "late");
        let planned = with_policy_section(
            request(vec![
                system.clone(),
                system.clone(),
                user.clone(),
                late.clone(),
            ]),
            "section",
        );
        assert_eq!(
            planned.messages,
            vec![
                system.clone(),
                system,
                text(Role::System, "section"),
                user,
                late
            ]
        );
        assert_eq!(
            with_policy_section(request(Vec::new()), "only").messages,
            vec![text(Role::System, "only")]
        );
    }

    #[test]
    fn the_section_is_written_as_the_wire_writes_a_system_message() {
        let planned = with_plan_policy(request(Vec::new()));
        assert_eq!(
            serde_json::to_value(&planned.messages[0]).unwrap(),
            serde_json::json!({ "role": "system", "content": [{ "type": "text", "text": PLAN_POLICY_SECTION }] })
        );
    }
}
