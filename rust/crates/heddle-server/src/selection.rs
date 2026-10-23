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
    todo!()
}

/// The reasoning level: the request's, then the session's record; empty strings are absence.
pub fn resolve_turn_effort<'a>(
    requested: Option<&'a str>,
    recorded: Option<&'a str>,
) -> Option<&'a str> {
    todo!()
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

/// The selection a session's record carries. A record without an endpoint names no selection at all,
/// because an endpoint is what makes a model or a level meaningful.
pub fn session_request_selection(meta: Option<&SessionMeta>) -> SessionSelection {
    todo!()
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
    todo!()
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
    todo!()
}
