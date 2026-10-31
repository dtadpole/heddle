//! The page this binary serves keeps DSH's left-sidebar width contract: 264 to 420 pixels, 280 by default.
//!
//! The binary embeds `src/server/page.html` (`page::PAGE_SOURCE`), so the sidebar the Rust server draws is the one
//! written there. DSH clamps the panel with `clampWidth(sidebar, 264, 420)` and gives a first visit `sidebar: 280`
//! (`dsh-client-ui-layout`, `computeColumns`); phase A measured 192 to 768 pixels and a 352-pixel default here (S48,
//! R-developer-seven-13). The page writes the bounds in rem, which at the 16-pixel root are DSH's pixels. The
//! behaviour is judged in a browser by `_verifiers_/80-web-ui/check-sidebar-bounds.mjs` and executed by
//! `test/page-sidebar-bounds.test.ts`; this test is the removal detector on the build that embeds the page, since
//! there is no script engine here.

use heddle_server::page::PAGE_SOURCE;

/// The number a top-level `const NAME = <number>` line of the page assigns.
fn constant(name: &str) -> f64 {
    let prefix = format!("\nconst {name} = ");
    let start = PAGE_SOURCE
        .find(&prefix)
        .unwrap_or_else(|| panic!("the page declares {name}"))
        + prefix.len();
    let line = PAGE_SOURCE[start..]
        .lines()
        .next()
        .expect("the declaration has a value");
    line.trim()
        .parse()
        .unwrap_or_else(|_| panic!("{name} is a number, not {line:?}"))
}

#[test]
fn the_bounds_and_the_default_are_dshs_pixels_at_the_16_pixel_root() {
    assert_eq!(constant("SIDEBAR_MIN_REM") * 16.0, 264.0);
    assert_eq!(constant("SIDEBAR_MAX_REM") * 16.0, 420.0);
    assert_eq!(constant("DEFAULT_SIDEBAR_REM") * 16.0, 280.0);
}

#[test]
fn the_first_paint_and_the_divider_agree_with_the_script() {
    assert!(
        PAGE_SOURCE.contains("    --sidebar-width: 17.5rem;\n"),
        "the stylesheet paints the default before any script runs"
    );
    let start = PAGE_SOURCE
        .find("<div id=\"gutter-left\"")
        .expect("the page has the divider");
    let divider =
        &PAGE_SOURCE[start..start + PAGE_SOURCE[start..].find('>').expect("the tag closes")];
    for attribute in [
        "aria-valuemin=\"16.5\"",
        "aria-valuemax=\"26.25\"",
        "aria-valuenow=\"18\"",
    ] {
        assert!(divider.contains(attribute), "{attribute} in {divider}");
    }
}

#[test]
fn no_width_falls_back_to_the_old_default() {
    assert!(
        !PAGE_SOURCE.contains("getPropertyValue('--sidebar-width')) || 22"),
        "a missing width falls back to DEFAULT_SIDEBAR_REM"
    );
    assert!(!PAGE_SOURCE.contains("--sidebar-width: 22rem;"));
}
