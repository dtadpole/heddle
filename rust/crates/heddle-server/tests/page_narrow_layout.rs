//! The page this binary serves collapses its sidebar to the rail below 1024 pixels, as DSH's does.
//!
//! The binary embeds `src/server/page.html` (`page::PAGE_SOURCE`), so the layout a phone-width window gets from the
//! Rust server is the one written there. Without the breakpoint the sidebar kept most of a 390-pixel window and pushed
//! the composer off the screen (live-testing draft developer-ten-9); DSH collapses below 1024 pixels
//! (`dsh-client-ui-layout`, `SIDEBAR_AUTO_COLLAPSE = 1024`) and lets the toggle open the panel there until it is
//! toggled back or the window crosses the breakpoint. The behaviour is judged in a browser by
//! `_verifiers_/80-web-ui/check-narrow-layout.mjs` and executed by `test/page-narrow-layout.test.ts`; this test is the
//! removal detector on the build that embeds the page, since there is no script engine here.

use heddle_server::page::PAGE_SOURCE;

/// The body of a top-level page function, from its signature to its closing brace.
fn function_source(signature: &str) -> &'static str {
    let start = PAGE_SOURCE
        .find(signature)
        .unwrap_or_else(|| panic!("the page has {signature}"));
    let from_start = &PAGE_SOURCE[start..];
    let end = from_start
        .find("\n}\n")
        .unwrap_or_else(|| panic!("{signature} ends at a closing brace on its own line"));
    &from_start[..end + 2]
}

#[test]
fn the_breakpoint_is_dshs_1024_pixels() {
    assert!(PAGE_SOURCE.contains("const SIDEBAR_AUTO_COLLAPSE_PX = 1024\n"));
}

#[test]
fn narrow_means_the_rail_unless_opened_and_wide_means_the_preference() {
    let rule = function_source(
        "function sidebarCollapsedFor(viewportWidth, wideCollapsed, narrowExpanded) {",
    );
    assert!(
        rule.contains(
            "return viewportWidth < SIDEBAR_AUTO_COLLAPSE_PX ? !narrowExpanded : wideCollapsed"
        ),
        "{rule}"
    );
}

#[test]
fn the_toggle_and_the_open_gestures_go_through_the_two_facts() {
    let toggle = function_source("function toggleSidebarCollapse() {");
    assert!(
        toggle.contains("if (sidebarNarrow()) sidebarNarrowExpanded = !sidebarNarrowExpanded"),
        "{toggle}"
    );
    assert!(
        toggle.contains("else sidebarWideCollapsed = !sidebarWideCollapsed"),
        "{toggle}"
    );
    let open = function_source("function openSidebar() {");
    assert!(
        open.contains("if (sidebarNarrow()) sidebarNarrowExpanded = true"),
        "{open}"
    );
    assert!(
        !PAGE_SOURCE.contains("setSidebarCollapsed(!sidebarCollapsed())"),
        "no gesture flips the painted state directly any more"
    );
}

#[test]
fn crossing_the_breakpoint_forgets_the_narrow_opening_and_a_visit_starts_from_the_rule() {
    let resize = PAGE_SOURCE
        .find("let sidebarWasNarrow = sidebarNarrow()")
        .map(|start| &PAGE_SOURCE[start..start + 400])
        .expect("the page remembers which side of the breakpoint it is on");
    assert!(resize.contains("sidebarNarrowExpanded = false"), "{resize}");
    assert!(
        PAGE_SOURCE.contains("\npaintSidebarCollapse()\n"),
        "the first paint follows the rule"
    );
}
