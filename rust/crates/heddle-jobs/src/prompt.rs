//! DSH's `tool:jobs` prompt section on the way to the adapter (`withJobsSection` in `src/jobs/tools.ts`).
//!
//! DSH registers the section with its system-prompt service whenever the job tools are loaded
//! (`dsh-tool-jobs/lib/index.js:257-261`) and joins sections with a blank line (`dsh-system-prompt`). Heddle composes
//! no sections, so the jobs row adds the text where DSH's lands, at the end of the system prompt (the request's first
//! `system` message), through the `model/request` hook, the one seam through which a row reaches what the adapter is
//! sent. The session log keeps the request as the loop built it.

use std::sync::Arc;

use heddle_llm::service::HooksId;
use heddle_llm::{
    ContentPart, GenerateRequest, Message, ModelError, ModelHooks, ModelService, Role,
};

use crate::tools::JOBS_PROMPT_SECTION;

/// The request with the section at the end of its system prompt, when it offers `job_output`.
///
/// A request without the job tools (a probe, a title, a profile without the row) is returned as it came, and a request
/// that already carries the section is not given it twice. With no system message, the section becomes one.
pub fn with_jobs_section(mut request: GenerateRequest) -> GenerateRequest {
    if !request.tools.iter().any(|tool| tool.name == "job_output") {
        return request;
    }
    let Some(index) = request
        .messages
        .iter()
        .position(|message| message.role == Role::System)
    else {
        request.messages.insert(
            0,
            Message::new(Role::System, vec![ContentPart::text(JOBS_PROMPT_SECTION)]),
        );
        return request;
    };
    let system = &mut request.messages[index];
    let carries = system.content.iter().any(
        |part| matches!(part, ContentPart::Text { text } if text.contains(JOBS_PROMPT_SECTION)),
    );
    if carries {
        return request;
    }
    let last = system
        .content
        .iter()
        .rposition(|part| matches!(part, ContentPart::Text { .. }));
    match last.map(|at| &mut system.content[at]) {
        Some(ContentPart::Text { text }) => {
            text.push_str("\n\n");
            text.push_str(JOBS_PROMPT_SECTION);
        }
        _ => system.content.push(ContentPart::text(JOBS_PROMPT_SECTION)),
    }
    request
}

/// The `model/request` hook that applies [`with_jobs_section`] to what every later hook answers.
pub struct JobsPromptSection;

impl ModelHooks for JobsPromptSection {
    fn request(
        &self,
        _service: &ModelService,
        _request: &GenerateRequest,
        next: &mut dyn FnMut() -> Result<GenerateRequest, ModelError>,
    ) -> Result<GenerateRequest, ModelError> {
        next().map(with_jobs_section)
    }
}

/// The hook registered on a model service; dropping it removes the hook (the row's teardown).
pub struct PromptSectionHooks {
    service: Arc<ModelService>,
    id: HooksId,
}

impl Drop for PromptSectionHooks {
    fn drop(&mut self) {
        self.service.remove_hooks(self.id);
    }
}

/// Register [`JobsPromptSection`] on `service`, for as long as the answer is held.
pub fn attach_prompt_section(service: &Arc<ModelService>) -> PromptSectionHooks {
    let id = service.add_hooks(Arc::new(JobsPromptSection));
    PromptSectionHooks {
        service: Arc::clone(service),
        id,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use heddle_llm::ToolSpec;

    fn tool(name: &str) -> ToolSpec {
        ToolSpec {
            name: name.to_owned(),
            description: String::new(),
            parameters: serde_json::json!({ "type": "object" }),
        }
    }

    fn request(messages: Vec<Message>, tools: Vec<ToolSpec>) -> GenerateRequest {
        GenerateRequest {
            endpoint: "e".to_owned(),
            messages,
            tools,
            ..GenerateRequest::default()
        }
    }

    fn text(message: &Message) -> String {
        message
            .content
            .iter()
            .filter_map(|part| match part {
                ContentPart::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect()
    }

    fn system(words: &str) -> Message {
        Message::new(Role::System, vec![ContentPart::text(words)])
    }

    fn user(words: &str) -> Message {
        Message::new(Role::User, vec![ContentPart::text(words)])
    }

    #[test]
    fn the_section_is_dsh_s_text() {
        assert!(JOBS_PROMPT_SECTION.starts_with("Track every background job id you start."));
        assert!(JOBS_PROMPT_SECTION.ends_with("and job_kill jobs that stopped mattering."));
    }

    #[test]
    fn a_request_without_the_job_tools_is_untouched() {
        let plain = request(
            vec![system("You are heddle."), user("hi")],
            vec![tool("bash")],
        );
        assert_eq!(with_jobs_section(plain.clone()), plain);
        let bare = request(vec![system("You are heddle.")], Vec::new());
        assert_eq!(with_jobs_section(bare.clone()), bare);
    }

    #[test]
    fn the_section_ends_the_system_prompt_once() {
        let added = with_jobs_section(request(
            vec![system("You are heddle."), user("hi")],
            vec![tool("bash"), tool("job_output")],
        ));
        assert_eq!(
            text(&added.messages[0]),
            format!("You are heddle.\n\n{JOBS_PROMPT_SECTION}")
        );
        assert_eq!(added.messages[1], user("hi"));
        assert_eq!(with_jobs_section(added.clone()), added, "not given twice");
    }

    #[test]
    fn only_the_first_system_message_carries_it() {
        let added = with_jobs_section(request(
            vec![system("prompt"), system("a runtime note"), user("hi")],
            vec![tool("job_output")],
        ));
        assert_eq!(text(&added.messages[1]), "a runtime note");
        assert_eq!(
            text(&added.messages[0]),
            format!("prompt\n\n{JOBS_PROMPT_SECTION}")
        );
    }

    #[test]
    fn with_no_system_message_the_section_becomes_one() {
        let added = with_jobs_section(request(vec![user("hi")], vec![tool("job_output")]));
        assert_eq!(added.messages.len(), 2);
        assert_eq!(added.messages[0].role, Role::System);
        assert_eq!(text(&added.messages[0]), JOBS_PROMPT_SECTION);
    }

    /// Registered before the section's hook, so outside it: it sees what the section's hook answers.
    struct Recorder(std::sync::Mutex<Vec<GenerateRequest>>);

    impl ModelHooks for Recorder {
        fn request(
            &self,
            _service: &ModelService,
            _request: &GenerateRequest,
            next: &mut dyn FnMut() -> Result<GenerateRequest, ModelError>,
        ) -> Result<GenerateRequest, ModelError> {
            let answered = next()?;
            self.0.lock().unwrap().push(answered.clone());
            Ok(answered)
        }
    }

    #[test]
    fn the_hook_applies_it_on_the_service_and_its_removal_restores_the_request() {
        let service = Arc::new(
            ModelService::new(vec![heddle_llm::EndpointConfig {
                name: "e".into(),
                kind: heddle_llm::EndpointKind::Scripted,
                base_url: "/nonexistent/script.json".into(),
                model: Some("scripted".into()),
                ..heddle_llm::EndpointConfig::default()
            }])
            .expect("a scripted service"),
        );
        let recorder = Arc::new(Recorder(std::sync::Mutex::new(Vec::new())));
        service.add_hooks(Arc::clone(&recorder) as Arc<dyn ModelHooks>);
        let hooks = attach_prompt_section(&service);
        let loop_built = request(vec![user("hi")], vec![tool("job_output")]);
        drop(
            service
                .stream(loop_built.clone())
                .expect("the request reaches the adapter"),
        );
        drop(hooks);
        drop(
            service
                .stream(loop_built.clone())
                .expect("the request reaches the adapter"),
        );
        let seen = recorder.0.lock().unwrap().clone();
        assert_eq!(seen.len(), 2);
        assert_eq!(text(&seen[0].messages[0]), JOBS_PROMPT_SECTION);
        assert_eq!(
            seen[1], loop_built,
            "without the hook, the request is the loop's"
        );
    }
}
