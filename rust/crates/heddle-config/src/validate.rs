//! Validation without starting anything: `heddle config --validate`.
//!
//! Ported from `src/config/validate.ts`. The claim is narrow: **a bad configuration fails where it is
//! written**, naming the row and the field. Starting a tree to discover a typo means the failure arrives
//! as a component that started but misbehaved, or not at all — and neither names the field.
//!
//! The TypeScript build imported each row's module to find its schema. The Rust binary has no modules;
//! a row names a built-in or an outside component (`rust/ULTIMATE_GOAL.md`, part 0), so where a schema
//! comes from is a [`ComponentCatalog`] the binary assembles — its built-ins, and outside components'
//! declared schemas — and this module only walks the rows and reports.

use std::collections::BTreeMap;
use std::path::Path;

use serde::Serialize;

use crate::compose::EntryRow;
use crate::env::Env;
use crate::error::ConfigError;
use crate::layer::NamedLayer;
use crate::schema::Schema;

/// What a catalog knows about the component a row names.
#[derive(Clone, Debug, PartialEq)]
pub enum SchemaLookup {
    /// The component's configuration schema.
    Schema(Box<Schema>),
    /// The component exists and declares no schema — not a problem, because a component may take no
    /// configuration, and calling it one would fail correct trees.
    NoSchema,
    /// The row names nothing the catalog can find; the string says why, for the problem
    /// `{label}: cannot resolve the component '{name}' — {why}`.
    Unresolvable(String),
}

/// Where component schemas come from. The binary implements it over its built-ins and the outside
/// components a profile declares; a test implements it with a [`StaticCatalog`].
pub trait ComponentCatalog {
    /// What is known about the component `row` names. `anchor` is the directory relative names resolve
    /// against ([`crate::anchor_dir`]), or `None` when every layer was supplied in memory.
    fn lookup(&self, row: &EntryRow, anchor: Option<&Path>) -> SchemaLookup;
}

/// A catalog that answers from a fixed table of names, for tests and for a binary with only built-ins.
/// A row's `name` is looked up exactly as written.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct StaticCatalog {
    entries: BTreeMap<String, Option<Schema>>,
}

impl StaticCatalog {
    /// An empty catalog, in which every name is unresolvable.
    pub fn new() -> Self {
        Self::default()
    }

    /// This catalog with `name` known, declaring `schema` (or none).
    pub fn with(mut self, name: impl Into<String>, schema: Option<Schema>) -> Self {
        self.entries.insert(name.into(), schema);
        self
    }
}

impl ComponentCatalog for StaticCatalog {
    fn lookup(&self, row: &EntryRow, _anchor: Option<&Path>) -> SchemaLookup {
        match self.entries.get(&row.name) {
            Some(Some(schema)) => SchemaLookup::Schema(Box::new(schema.clone())),
            Some(None) => SchemaLookup::NoSchema,
            None => SchemaLookup::Unresolvable("not a known component".to_string()),
        }
    }
}

/// The outcome of a validation pass. Serializes as `heddle config --validate --json` prints it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct ValidationResult {
    /// Every composed row, disabled ones included.
    pub rows: usize,
    /// Rows whose configuration was checked against a schema.
    pub checked: usize,
    /// Every problem, each starting with the row's label (its `id`, else its `name`).
    pub problems: Vec<String>,
}

/// Compose `layers` and check every enabled row's `config` (an absent one as `{}`) against the schema
/// `catalog` gives for it.
///
/// A row whose component cannot be resolved is a problem; a component with no schema is skipped and not
/// counted as checked; every schema problem is reported as `{label}: {problem}`. A composition that
/// fails is the `Err`, exactly as `compose` reports it — validation does not soften it into a problem.
pub fn validate_rows(
    layers: &[NamedLayer],
    env: &Env,
    catalog: &dyn ComponentCatalog,
) -> Result<ValidationResult, ConfigError> {
    let _ = (layers, env, catalog);
    todo!("heddle-config: validate_rows")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_static_catalog_tells_known_from_unknown() {
        let catalog = StaticCatalog::new()
            .with("alpha", Some(Schema::default()))
            .with("plain", None);
        let row = |name: &str| EntryRow {
            name: name.into(),
            ..EntryRow::default()
        };
        assert_eq!(
            catalog.lookup(&row("alpha"), None),
            SchemaLookup::Schema(Box::default())
        );
        assert_eq!(catalog.lookup(&row("plain"), None), SchemaLookup::NoSchema);
        assert!(matches!(
            catalog.lookup(&row("nowhere"), None),
            SchemaLookup::Unresolvable(_)
        ));
    }
}
