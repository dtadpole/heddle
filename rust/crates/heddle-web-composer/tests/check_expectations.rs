//! The four 80-web-ui checks' API expectations, judged over a real listener **behind a door double**.
//!
//! The checks are browsers and a binary; this pins the part they read from the routes, so a change fails in the
//! crate rather than in a check hours later. Since D-039 the composer mounts three routes and the server owns the
//! other three the checks read (`/api/status`, steer, stop), so the app here is the surface as the binary will
//! serve it: the server's core routes, the composer's [`heddle_web_composer::router`] merged after them, the 404
//! fallback, and the server's door — fence, token decision, cross-site write rule, `401` — around everything.
//! `support` documents where each piece of the double is read from.
//!
//! The first test is the 13 expectations with the page's cookie. The others judge what the door adds, which is the
//! merge risk the lane cannot see until `heddle web` boots: that the composer's routes answer *behind* the door
//! rather than around it, and that nothing the composer mounts collides with the server's routes.

mod support;

use std::sync::Arc;

use serde_json::{Value, json};
use support::{
    CROSS_SITE_WRITE_REFUSAL, Host, LAUNCH_TOKEN, SERVER_CORE_ROUTES, SESSION, STALE_COOKIE,
    UNKNOWN, authed, listen, merge_mounted, send, served, served_composer, server_core,
    session_cookie,
};

#[tokio::test]
async fn the_four_checks_api_expectations_hold_behind_the_door() {
    let (address, server) = listen(served_composer()).await;

    // composer: the access chip reads the deployment mode and the root after the page boots (the server's route).
    let status = authed(address, "GET", "/api/status", None).await;
    assert_eq!(status.status, 200);
    assert_eq!(status.header("cache-control"), Some("no-store"));
    assert_eq!(
        status.json(),
        json!({"sandbox": {"mode": "workspace-write"}, "cwd": "/tmp/workspace"})
    );
    assert!(
        !status.body.contains("\n  "),
        "status is compact, as JSON.stringify without an indent: {}",
        status.body
    );

    // context-view: no session is refused, an unknown one is not invented, a known one carries the composition.
    let missing = authed(address, "GET", "/api/context", None).await;
    assert_eq!(missing.status, 400);
    assert_eq!(missing.json()["error"], "a session is required");
    let unknown = authed(
        address,
        "GET",
        &format!("/api/context?session={UNKNOWN}"),
        None,
    )
    .await;
    assert_eq!(unknown.status, 404);
    assert_eq!(unknown.json()["error"], format!("no session {UNKNOWN}"));
    let composed = authed(
        address,
        "GET",
        &format!("/api/context?session={SESSION}"),
        None,
    )
    .await;
    assert_eq!(composed.status, 200);
    let report = composed.json();
    assert_eq!(report["session"], SESSION);
    assert_eq!(report["instructions"], json!(["/tmp/workspace/AGENTS.md"]));
    assert_eq!(report["estimatedTokens"], 120);
    assert_eq!(report["contextWindow"], 128_000);
    assert_eq!(report["thresholdTokens"], 100_000);
    assert_eq!(report["surface"], json!({"nodes": [], "replacements": []}));
    assert_eq!(
        report["endpoint"],
        Value::Null,
        "an unasked endpoint is null"
    );
    assert!(report["compacted"].is_boolean());
    assert!(composed.body.contains("\n  "), "the context view is pretty");

    // model-switcher: the list, and the switch validated in the TypeScript order.
    let endpoints = authed(address, "GET", "/api/endpoints", None).await;
    assert_eq!(endpoints.status, 200);
    let listing = endpoints.json();
    assert_eq!(listing["default"], "scripted");
    assert_eq!(listing["endpoints"][0]["name"], "scripted");
    assert!(endpoints.body.contains("\n  "), "the list is pretty");

    let malformed = authed(
        address,
        "POST",
        "/api/sessions/not-a-session/model",
        Some(r#"{"endpoint":"scripted"}"#),
    )
    .await;
    assert_eq!(malformed.status, 400);
    assert_eq!(malformed.json()["error"], "not a session id");
    let unconfigured = authed(
        address,
        "POST",
        &format!("/api/sessions/{SESSION}/model"),
        Some(r#"{"endpoint":"nope"}"#),
    )
    .await;
    assert_eq!(unconfigured.status, 400);
    assert!(
        unconfigured.json()["error"]
            .as_str()
            .expect("a sentence")
            .starts_with("no endpoint named 'nope'")
    );
    let undeclared = authed(
        address,
        "POST",
        &format!("/api/sessions/{SESSION}/model"),
        Some(r#"{"endpoint":"scripted","model":"nope"}"#),
    )
    .await;
    assert_eq!(undeclared.status, 400);
    assert_eq!(undeclared.json()["error"], "no model named 'nope'");
    let switched = authed(
        address,
        "POST",
        &format!("/api/sessions/{SESSION}/model"),
        Some(r#"{"endpoint":"scripted"}"#),
    )
    .await;
    assert_eq!(switched.status, 200);
    assert_eq!(switched.json()["endpoint"], "scripted");

    // composer: a steer's refusals, with the prompt decided before what is running (the server's route).
    let steer_malformed = authed(
        address,
        "POST",
        "/api/sessions/not-a-session/steer",
        Some(r#"{"prompt":"x"}"#),
    )
    .await;
    assert_eq!(steer_malformed.status, 400);
    assert_eq!(steer_malformed.json()["error"], "not a session id");
    let steer_blank = authed(
        address,
        "POST",
        &format!("/api/sessions/{UNKNOWN}/steer"),
        Some(r#"{"prompt":"   "}"#),
    )
    .await;
    assert_eq!(steer_blank.status, 400);
    assert_eq!(steer_blank.json()["error"], "a prompt is required");
    let steer_unavailable = authed(
        address,
        "POST",
        &format!("/api/sessions/{UNKNOWN}/steer"),
        Some(r#"{"prompt":"nobody is running"}"#),
    )
    .await;
    assert_eq!(steer_unavailable.status, 409);
    assert_eq!(
        steer_unavailable.json()["code"],
        "session/steer-unavailable"
    );

    // composer: stopping answers what it stopped, and zero is not an error (the server's route).
    let stopped = authed(
        address,
        "POST",
        &format!("/api/sessions/{UNKNOWN}/stop"),
        None,
    )
    .await;
    assert_eq!(stopped.status, 200);
    assert_eq!(stopped.json(), json!({"stopped": 0, "session": UNKNOWN}));

    server.abort();
}

#[tokio::test]
async fn the_query_token_the_runtime_context_check_sends_opens_the_door_and_the_routes_ignore_it() {
    // check-runtime-context adds `?token=<launch token>` to every request instead of a cookie. The door accepts it,
    // and the composer's own query reading must not trip on the extra key: `/api/context` reads `session`,
    // `endpoint` and `model`, and a stricter extractor would answer 400 here.
    let (address, server) = listen(served_composer()).await;

    let composed = send(
        address,
        "GET",
        &format!("/api/context?session={SESSION}&token={LAUNCH_TOKEN}"),
        &[],
        None,
    )
    .await;
    assert_eq!(composed.status, 200, "{}", composed.body);
    assert_eq!(composed.json()["session"], SESSION);

    let switched = send(
        address,
        "POST",
        &format!("/api/sessions/{SESSION}/model?token={LAUNCH_TOKEN}"),
        &[],
        Some(r#"{"endpoint":"scripted"}"#),
    )
    .await;
    assert_eq!(switched.status, 200, "{}", switched.body);

    let wrong = send(
        address,
        "GET",
        "/api/endpoints?token=not-the-launch-token",
        &[],
        None,
    )
    .await;
    assert_eq!(wrong.status, 401, "a wrong token is not a credential");
    assert_eq!(wrong.body, "unauthorized\n");

    server.abort();
}

#[tokio::test]
async fn the_fence_refuses_before_any_composer_route_or_credential_is_judged() {
    let (address, server) = listen(served_composer()).await;
    let port = address.port();

    // A foreign Host is refused even with a valid cookie: the fence runs before any secret is compared.
    let foreign_host = send(
        address,
        "GET",
        "/api/endpoints",
        &[("Host", format!("evil.example:{port}")), session_cookie()],
        None,
    )
    .await;
    assert_eq!(foreign_host.status, 403);
    assert_eq!(
        foreign_host.body,
        format!("refused: Host evil.example:{port} is not loopback\n")
    );
    assert_eq!(foreign_host.header("content-type"), Some("text/plain"));

    // An Origin that is not a URL — what a sandboxed frame sends.
    let null_origin = send(
        address,
        "POST",
        &format!("/api/sessions/{SESSION}/model"),
        &[("Origin", "null".to_owned()), session_cookie()],
        Some(r#"{"endpoint":"scripted"}"#),
    )
    .await;
    assert_eq!(null_origin.status, 403);
    assert_eq!(null_origin.body, "refused: Origin null is not a URL\n");

    // A page on another site.
    let foreign_origin = send(
        address,
        "GET",
        &format!("/api/context?session={SESSION}"),
        &[
            ("Origin", "https://evil.example".to_owned()),
            session_cookie(),
        ],
        None,
    )
    .await;
    assert_eq!(foreign_origin.status, 403);
    assert_eq!(
        foreign_origin.body,
        "refused: Origin https://evil.example is not this machine\n"
    );

    // A loopback origin on another port is this machine — the owner's token gate — and passes to the route.
    let gate = send(
        address,
        "GET",
        "/api/endpoints",
        &[
            ("Origin", "http://127.0.0.1:1".to_owned()),
            session_cookie(),
        ],
        None,
    )
    .await;
    assert_eq!(gate.status, 200, "{}", gate.body);

    server.abort();
}

#[tokio::test]
async fn an_unauthenticated_request_gets_the_doors_401_not_the_routes_own_refusal() {
    // Without the door, `GET /api/context` with no session is the route's `400 a session is required`. Behind it,
    // the request never reaches the route: a page that lost its cookie reads `401`, which is what tells it to
    // re-authenticate rather than show a validation error.
    let (address, server) = listen(served_composer()).await;
    for (method, path, body) in [
        ("GET", "/api/context".to_owned(), None),
        ("GET", format!("/api/context?session={SESSION}"), None),
        ("GET", "/api/endpoints".to_owned(), None),
        (
            "POST",
            format!("/api/sessions/{SESSION}/model"),
            Some(r#"{"endpoint":"scripted"}"#),
        ),
        ("GET", "/api/status".to_owned(), None),
    ] {
        let answer = send(address, method, &path, &[], body).await;
        assert_eq!(answer.status, 401, "{method} {path}: {}", answer.body);
        assert_eq!(answer.body, "unauthorized\n", "{method} {path}");
        assert_eq!(answer.header("content-type"), Some("text/plain"));
    }
    server.abort();
}

#[tokio::test]
async fn a_state_changing_request_with_a_stale_cookie_is_the_cross_site_refusal() {
    let (address, server) = listen(served_composer()).await;
    let stale = ("Cookie", format!("{}={STALE_COOKIE}", support::COOKIE_NAME));

    // A switch that offered a cookie the server does not verify: 403 with the server's sentence, not 401.
    let switch = send(
        address,
        "POST",
        &format!("/api/sessions/{SESSION}/model"),
        std::slice::from_ref(&stale),
        Some(r#"{"endpoint":"scripted"}"#),
    )
    .await;
    assert_eq!(switch.status, 403);
    assert_eq!(switch.body, CROSS_SITE_WRITE_REFUSAL);

    // A read with the same stale cookie is only unauthorized: reading changes nothing.
    let read = send(
        address,
        "GET",
        "/api/endpoints",
        std::slice::from_ref(&stale),
        None,
    )
    .await;
    assert_eq!(read.status, 401);
    assert_eq!(read.body, "unauthorized\n");

    // `authorize` checks the cookie first and the token second: a stale cookie beside the launch token passes.
    let rescued = send(
        address,
        "POST",
        &format!("/api/sessions/{SESSION}/model?token={LAUNCH_TOKEN}"),
        &[stale],
        Some(r#"{"endpoint":"scripted"}"#),
    )
    .await;
    assert_eq!(rescued.status, 200, "{}", rescued.body);

    server.abort();
}

#[tokio::test]
async fn the_fallback_is_inside_the_door_and_a_wrong_method_is_404_not_405() {
    let (address, server) = listen(served_composer()).await;

    let unclaimed = authed(address, "GET", "/api/no-such-route", None).await;
    assert_eq!(unclaimed.status, 404);
    assert_eq!(unclaimed.body, "not found\n");
    assert_eq!(unclaimed.header("content-type"), Some("text/plain"));

    // web.ts has no method table, so a composer path asked with the wrong method is the same plain 404. axum's
    // default would be 405 from the composer's own method router; the server's method fallback must reach the
    // routes merged into it, which is exactly what a mounted router could get wrong.
    for (method, path) in [
        ("GET", format!("/api/sessions/{SESSION}/model")),
        ("POST", "/api/context".to_owned()),
        ("DELETE", "/api/endpoints".to_owned()),
    ] {
        let answer = authed(address, method, &path, None).await;
        assert_eq!(answer.status, 404, "{method} {path}: {}", answer.body);
        assert_eq!(answer.body, "not found\n", "{method} {path}");
    }

    // And the fallback is behind the door: without a credential an unclaimed /api path is 401, not 404.
    let unauthenticated = send(address, "GET", "/api/no-such-route", &[], None).await;
    assert_eq!(unauthenticated.status, 401);

    server.abort();
}

#[tokio::test]
async fn the_composer_mounts_beside_the_servers_routes_and_a_collision_is_a_start_up_error() {
    // The composer's advertised routes and the server's are disjoint — the condition `mount_router` enforces.
    for route in heddle_web_composer::ROUTES {
        assert!(
            !SERVER_CORE_ROUTES.contains(route),
            "{route:?} is claimed by both the composer and the server"
        );
    }
    // And the three D-039 gave to the server are the server's, so the double's core is not inventing routes.
    for route in [
        ("GET", "/api/status"),
        ("POST", "/api/sessions/{id}/steer"),
        ("POST", "/api/sessions/{id}/stop"),
    ] {
        assert!(
            SERVER_CORE_ROUTES.contains(&route),
            "{route:?} should be a server core route"
        );
    }

    let host = Arc::new(Host);
    assert!(
        served(
            server_core(Arc::clone(&host)),
            heddle_web_composer::router(Arc::clone(&host))
        )
        .is_ok(),
        "the composer mounts beside the server's core routes"
    );

    // The guard is real: had the composer kept `/api/status` (the pre-D-039 router), the mount would fail.
    let pre_d039 = heddle_web_composer::router(Arc::clone(&host))
        .merge(heddle_web_composer::status::routes(Arc::clone(&host)));
    let collision = merge_mounted(server_core(Arc::clone(&host)), pre_d039, "a mounted router")
        .expect_err("a router that claims /api/status again does not mount");
    assert!(
        collision.contains("/api/status"),
        "the start-up error names the route: {collision}"
    );
}
