//! Which endpoint, model and reasoning level a turn runs with — `resolveTurnEndpoint`,
//! `resolveTurnEffort`, `sessionRequestSelection` and the `model/request` waterfall listener of
//! `src/server/web.ts`, as pure functions.
//!
//! The order **is** the rule, so it is judged without a socket: what the request names wins, then what the
//! session recorded, then the server's default (`heddle web --endpoint`), then the configuration's
//! nomination. An empty string is absence, not a name.

use crate::services::{ModelService, SessionMeta};

/// The four places an endpoint name can come from, highest first.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct EndpointSources<'a> {
    pub requested: Option<&'a str>,
    pub recorded: Option<&'a str>,
    pub server_default: Option<&'a str>,
    pub service_default: Option<&'a str>,
}

/// The first non-empty name in [`EndpointSources`] order.
pub fn resolve_turn_endpoint<'a>(sources: &EndpointSources<'a>) -> Option<&'a str> {
    [
        sources.requested,
        sources.recorded,
        sources.server_default,
        sources.service_default,
    ]
    .into_iter()
    .flatten()
    .find(|candidate| !candidate.is_empty())
}

/// The reasoning level: the request's, then the session's record; empty strings are absence.
pub fn resolve_turn_effort<'a>(
    requested: Option<&'a str>,
    recorded: Option<&'a str>,
) -> Option<&'a str> {
    [requested, recorded]
        .into_iter()
        .flatten()
        .find(|candidate| !candidate.is_empty())
}

/// How a session is run, as recorded in its meta.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSelection {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
}

impl SessionSelection {
    /// The selection with no endpoint: no choice at all.
    pub fn empty() -> Self {
        Self::default()
    }

    /// Whether this selection names an endpoint.
    pub fn is_empty(&self) -> bool {
        self.endpoint.as_deref().is_none_or(str::is_empty)
    }
}

/// The selection a session's record carries. A record without an endpoint names no selection at all,
/// because an endpoint is what makes a model or a level meaningful.
pub fn session_request_selection(meta: Option<&SessionMeta>) -> SessionSelection {
    let Some(meta) = meta else {
        return SessionSelection::empty();
    };
    let Some(endpoint) = meta.endpoint.clone() else {
        return SessionSelection::empty();
    };
    SessionSelection {
        endpoint: Some(endpoint),
        model: meta.model.clone(),
        reasoning_effort: meta.reasoning_effort.clone(),
    }
}

/// What one model request is addressed to, as far as the selection rule is concerned.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RequestSelection {
    pub endpoint: String,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
}

/// The running-turn rule: a turn's **next** model call is answered by the session's current record.
///
/// The record wins only where it can be enforced: when it names no endpoint, or one the model service does
/// not have, the request is returned unchanged. Otherwise the endpoint is the record's, the model is the
/// record's (or none, which means the endpoint's configured model), and the level is the record's only when
/// the model service declares it for that endpoint and model; a level that cannot be enforced is dropped
/// rather than kept from the previous selection.
///
/// The binary registers this as the `model/request` waterfall listener while the server runs.
pub fn running_turn_selection(
    current: &RequestSelection,
    recorded: &SessionSelection,
    models: &dyn ModelService,
) -> RequestSelection {
    let Some(endpoint) = recorded.endpoint.as_deref().filter(|name| !name.is_empty()) else {
        return current.clone();
    };
    if !models.has(endpoint) {
        return current.clone();
    }
    let model = recorded.model.clone();
    let enforceable = recorded
        .reasoning_effort
        .as_deref()
        .filter(|effort| !effort.is_empty())
        .filter(|effort| models.declares_level(endpoint, model.as_deref(), effort))
        .map(str::to_owned);
    RequestSelection {
        endpoint: endpoint.to_owned(),
        model,
        reasoning_effort: enforceable,
    }
}

/// The model and level a turn runs with, given the endpoint it resolved to.
///
/// A model belongs to the endpoint that offered it: when the request names a **different** endpoint than
/// the record, the record's model and level are not inherited. The level is then filtered through the
/// model service: one it does not declare for the endpoint and model is dropped (the route that a browser
/// writes through refuses instead; a turn filters).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TurnSelection {
    pub endpoint: String,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
}

/// The whole ladder of `handleTurn`: endpoint by [`resolve_turn_endpoint`], then model and level as
/// [`TurnSelection`] describes. `None` when no endpoint is named anywhere.
pub fn turn_selection(
    requested_endpoint: Option<&str>,
    requested_model: Option<&str>,
    requested_effort: Option<&str>,
    recorded: &SessionSelection,
    server_default: Option<&str>,
    models: &dyn ModelService,
) -> Option<TurnSelection> {
    let requested_endpoint = requested_endpoint.filter(|name| !name.is_empty());
    let service_default = models.default_endpoint();
    let endpoint = resolve_turn_endpoint(&EndpointSources {
        requested: requested_endpoint,
        recorded: recorded.endpoint.as_deref(),
        server_default,
        service_default: service_default.as_deref(),
    })?;
    let same_endpoint =
        requested_endpoint.is_none() || requested_endpoint == recorded.endpoint.as_deref();
    let model = requested_model
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .or_else(|| {
            same_endpoint
                .then(|| recorded.model.clone())
                .flatten()
                .filter(|name| !name.is_empty())
        });
    let wanted_effort = resolve_turn_effort(
        requested_effort,
        same_endpoint
            .then_some(recorded.reasoning_effort.as_deref())
            .flatten(),
    );
    let reasoning_effort = wanted_effort
        .filter(|effort| models.declares_level(endpoint, model.as_deref(), effort))
        .map(str::to_owned);
    Some(TurnSelection {
        endpoint: endpoint.to_owned(),
        model,
        reasoning_effort,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A model service double: the configured endpoints and the levels they declare.
    #[derive(Default)]
    struct Models {
        names: Vec<String>,
        default: Option<String>,
        levels: Vec<(String, Option<String>, String)>,
    }

    impl Models {
        fn named(names: &[&str]) -> Self {
            Models {
                names: names.iter().map(|name| (*name).to_owned()).collect(),
                ..Models::default()
            }
        }

        fn declaring(mut self, endpoint: &str, model: Option<&str>, level: &str) -> Self {
            self.levels.push((
                endpoint.to_owned(),
                model.map(str::to_owned),
                level.to_owned(),
            ));
            self
        }
    }

    impl ModelService for Models {
        fn names(&self) -> Vec<String> {
            self.names.clone()
        }

        fn default_endpoint(&self) -> Option<String> {
            self.default.clone()
        }

        fn declares_level(&self, endpoint: &str, model: Option<&str>, effort: &str) -> bool {
            self.levels
                .iter()
                .any(|(e, m, l)| e == endpoint && m.as_deref() == model && l == effort)
        }
    }

    fn recorded(
        endpoint: Option<&str>,
        model: Option<&str>,
        effort: Option<&str>,
    ) -> SessionSelection {
        SessionSelection {
            endpoint: endpoint.map(str::to_owned),
            model: model.map(str::to_owned),
            reasoning_effort: effort.map(str::to_owned),
        }
    }

    #[test]
    fn the_endpoint_ladder_is_request_record_server_then_service() {
        let all = EndpointSources {
            requested: Some("requested"),
            recorded: Some("recorded"),
            server_default: Some("server"),
            service_default: Some("service"),
        };
        assert_eq!(resolve_turn_endpoint(&all), Some("requested"));
        let without_request = EndpointSources {
            requested: None,
            ..all
        };
        assert_eq!(resolve_turn_endpoint(&without_request), Some("recorded"));
        let only_server = EndpointSources {
            requested: None,
            recorded: None,
            server_default: Some("server"),
            service_default: Some("service"),
        };
        assert_eq!(resolve_turn_endpoint(&only_server), Some("server"));
        let only_service = EndpointSources {
            requested: None,
            recorded: None,
            server_default: None,
            service_default: Some("service"),
        };
        assert_eq!(resolve_turn_endpoint(&only_service), Some("service"));
        assert_eq!(resolve_turn_endpoint(&EndpointSources::default()), None);
    }

    #[test]
    fn an_empty_name_is_absence_at_every_level() {
        let sources = EndpointSources {
            requested: Some(""),
            recorded: Some(""),
            server_default: Some("server"),
            service_default: Some(""),
        };
        assert_eq!(resolve_turn_endpoint(&sources), Some("server"));
    }

    #[test]
    fn the_effort_ladder_is_request_then_record() {
        assert_eq!(resolve_turn_effort(Some("high"), Some("low")), Some("high"));
        assert_eq!(resolve_turn_effort(None, Some("low")), Some("low"));
        assert_eq!(resolve_turn_effort(Some(""), Some("low")), Some("low"));
        assert_eq!(resolve_turn_effort(Some(""), Some("")), None);
        assert_eq!(resolve_turn_effort(None, None), None);
    }

    #[test]
    fn a_record_without_an_endpoint_names_no_selection() {
        assert_eq!(session_request_selection(None), SessionSelection::default());
        let mut meta = SessionMeta {
            id: "session-x".into(),
            model: Some("m".into()),
            reasoning_effort: Some("high".into()),
            ..SessionMeta::default()
        };
        assert_eq!(
            session_request_selection(Some(&meta)),
            SessionSelection::default()
        );
        meta.endpoint = Some("double".into());
        assert_eq!(
            session_request_selection(Some(&meta)),
            SessionSelection {
                endpoint: Some("double".into()),
                model: Some("m".into()),
                reasoning_effort: Some("high".into()),
            }
        );
    }

    #[test]
    fn the_running_rule_moves_a_next_call_to_the_recorded_endpoint() {
        let models = Models::named(&["double", "other"])
            .declaring("double", Some("fast"), "high")
            .declaring("double", Some("fast"), "low");
        let current = RequestSelection {
            endpoint: "other".into(),
            model: Some("slow".into()),
            reasoning_effort: Some("medium".into()),
        };
        assert_eq!(
            running_turn_selection(
                &current,
                &recorded(Some("double"), Some("fast"), Some("high")),
                &models
            ),
            RequestSelection {
                endpoint: "double".into(),
                model: Some("fast".into()),
                reasoning_effort: Some("high".into()),
            }
        );
    }

    #[test]
    fn the_running_rule_drops_a_level_it_cannot_enforce() {
        let models = Models::named(&["double"]);
        let current = RequestSelection {
            endpoint: "double".into(),
            model: None,
            reasoning_effort: Some("high".into()),
        };
        // The record names a level the model does not declare: the endpoint still moves, the level is
        // dropped rather than kept from the previous selection.
        let moved = running_turn_selection(
            &current,
            &recorded(Some("double"), None, Some("xhigh")),
            &models,
        );
        assert_eq!(moved.endpoint, "double");
        assert_eq!(moved.model, None);
        assert_eq!(moved.reasoning_effort, None);
    }

    #[test]
    fn the_running_rule_leaves_an_unenforceable_record_alone() {
        let models = Models::named(&["double"]);
        let current = RequestSelection {
            endpoint: "double".into(),
            model: Some("fast".into()),
            reasoning_effort: Some("high".into()),
        };
        assert_eq!(
            running_turn_selection(&current, &SessionSelection::default(), &models),
            current
        );
        assert_eq!(
            running_turn_selection(&current, &recorded(Some("gone"), None, None), &models),
            current
        );
    }

    #[test]
    fn a_turn_uses_the_request_then_the_record_then_the_defaults() {
        let models = Models {
            names: vec!["double".into(), "other".into()],
            default: Some("other".into()),
            levels: vec![("double".into(), Some("fast".into()), "high".into())],
        };
        // The request names everything.
        assert_eq!(
            turn_selection(
                Some("double"),
                Some("fast"),
                Some("high"),
                &SessionSelection::default(),
                None,
                &models
            ),
            Some(TurnSelection {
                endpoint: "double".into(),
                model: Some("fast".into()),
                reasoning_effort: Some("high".into()),
            })
        );
        // Nothing named: the configuration's nomination.
        assert_eq!(
            turn_selection(
                None,
                None,
                None,
                &SessionSelection::default(),
                None,
                &models
            ),
            Some(TurnSelection {
                endpoint: "other".into(),
                model: None,
                reasoning_effort: None,
            })
        );
        // The record fills in what the request left out.
        assert_eq!(
            turn_selection(
                None,
                None,
                Some("high"),
                &recorded(Some("double"), Some("fast"), Some("high")),
                None,
                &models
            ),
            Some(TurnSelection {
                endpoint: "double".into(),
                model: Some("fast".into()),
                reasoning_effort: Some("high".into()),
            })
        );
        // No endpoint anywhere.
        let bare = Models::default();
        assert_eq!(
            turn_selection(None, None, None, &SessionSelection::default(), None, &bare),
            None
        );
    }

    #[test]
    fn a_different_endpoint_does_not_inherit_the_records_model_or_level() {
        let models = Models::named(&["double", "other"])
            .declaring("double", Some("fast"), "high")
            .declaring("other", Some("fast"), "high");
        // The request points at `other`; the record's `fast`/`high` belong to `double`.
        assert_eq!(
            turn_selection(
                Some("other"),
                None,
                None,
                &recorded(Some("double"), Some("fast"), Some("high")),
                None,
                &models
            ),
            Some(TurnSelection {
                endpoint: "other".into(),
                model: None,
                reasoning_effort: None,
            })
        );
        // The same endpoint inherits both.
        assert_eq!(
            turn_selection(
                None,
                None,
                None,
                &recorded(Some("double"), Some("fast"), Some("high")),
                None,
                &models
            )
            .unwrap()
            .model
            .as_deref(),
            Some("fast")
        );
    }

    #[test]
    fn a_turn_filters_an_undeclared_level_instead_of_refusing() {
        let models = Models::named(&["double"]);
        let selection = turn_selection(
            Some("double"),
            None,
            Some("xhigh"),
            &SessionSelection::default(),
            None,
            &models,
        )
        .unwrap();
        assert_eq!(selection.reasoning_effort, None);
    }
}
