//! The plugin inventory: port of `src/config/plugin-inventory.ts`, which follows DSH's
//! `dsh-host-plugin-inventory` (`pluginInventory/list`, `readPluginInventory`).
//!
//! A read-only point-in-time view of the configured rows: one entry per non-group row, in row order, with
//! the row's module name **as the layer wrote it**, whether it is enabled, and the phase its entry is in.
//! Nothing here starts, stops or installs anything. DSH reports `managementAvailable: true` only when a
//! plugin manager is loaded, and heddle has none, so the key is absent, as DSH leaves it absent.
//!
//! The module name is the declared one rather than what the loader resolved it to: a relative name stays
//! `./alpha.ts`, so the inventory never adds a host path the configuration did not already hold. An
//! absolute name the layer wrote is reported as written, because the configuration chose it.

use serde::Serialize;

use crate::compose::ComposedRow;

/// An entry's lifecycle as the inventory reports it: DSH's `PluginFiberPhase`. A disposed entry, and a row
/// with no entry at all, have no phase (`null`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PluginFiberPhase {
    /// Waiting for a service it injects.
    Pending,
    /// Starting.
    Loading,
    /// Started.
    Active,
    /// Its start refused.
    Failed,
    /// Stopping.
    Unloading,
}

/// One non-group row: DSH's `PluginInventoryEntry`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInventoryEntry {
    /// The entry's id in the loader's tree.
    pub entry_id: String,
    /// The row's `name`, as the layer wrote it.
    pub module_name: String,
    /// Whether the row is enabled: `false` for a disabled (or removed) row.
    pub enabled: bool,
    /// The entry's phase, or `None` (`null`) when it has no live entry.
    pub fiber_phase: Option<PluginFiberPhase>,
}

/// The inventory: DSH's `PluginInventorySnapshot`, without the agent-preset compositions or the package
/// display metadata, neither of which this build has.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInventorySnapshot {
    /// `Some(true)` only where a plugin manager can change the profile; absent otherwise.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub management_available: Option<bool>,
    /// The non-group rows, in row order.
    pub entries: Vec<PluginInventoryEntry>,
}

/// The inventory of a loaded tree.
///
/// `rows` are the composed rows; `loaded` is the loader's entries, one per **enabled** row in row order,
/// each with its id and phase. A disabled row gets no entry from the loader, so it is listed disabled
/// with no phase under its `id` (else its `name`). A group row is consumed like any other row and then
/// left out, as DSH leaves group entries out.
pub fn plugin_inventory(
    rows: &[ComposedRow],
    loaded: &[(String, Option<PluginFiberPhase>)],
) -> PluginInventorySnapshot {
    let mut loaded = loaded.iter();
    let mut entries = Vec::new();
    for composed in rows {
        let row = &composed.row;
        let enabled = row.disabled != Some(true);
        let entry = if enabled { loaded.next() } else { None };
        if row.group == Some(true) {
            continue;
        }
        entries.push(PluginInventoryEntry {
            entry_id: entry
                .map(|(id, _)| id.clone())
                .unwrap_or_else(|| row.label().to_owned()),
            module_name: row.name.clone(),
            enabled,
            fiber_phase: entry.and_then(|(_, phase)| *phase),
        });
    }
    PluginInventorySnapshot {
        management_available: None,
        entries,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compose::EntryRow;
    use serde_json::json;

    fn row(id: Option<&str>, name: &str, disabled: bool, group: bool) -> ComposedRow {
        ComposedRow {
            row: EntryRow {
                id: id.map(str::to_owned),
                name: name.to_owned(),
                disabled: disabled.then_some(true),
                group: group.then_some(true),
                ..EntryRow::default()
            },
            position: 0,
            fields: Vec::new(),
        }
    }

    #[test]
    fn every_non_group_row_is_listed_in_order_with_its_declared_name_and_phase() {
        let rows = vec![
            row(Some("session"), "./src/plugins/session.ts", false, false),
            row(Some("goal-tool"), "./src/plugins/goal-tool.ts", true, false),
            row(Some("bundle"), "./bundle.ts", false, true),
            row(Some("todo-tool"), "/opt/plugins/todo-tool.ts", false, false),
            row(None, "model", false, false),
        ];
        let loaded = vec![
            ("session".to_owned(), Some(PluginFiberPhase::Active)),
            ("bundle".to_owned(), Some(PluginFiberPhase::Active)),
            ("todo-tool".to_owned(), Some(PluginFiberPhase::Failed)),
            ("model".to_owned(), None),
        ];
        let snapshot = plugin_inventory(&rows, &loaded);
        assert_eq!(
            serde_json::to_value(&snapshot).unwrap(),
            json!({
                "entries": [
                    {"entryId": "session", "moduleName": "./src/plugins/session.ts", "enabled": true, "fiberPhase": "active"},
                    {"entryId": "goal-tool", "moduleName": "./src/plugins/goal-tool.ts", "enabled": false, "fiberPhase": null},
                    {"entryId": "todo-tool", "moduleName": "/opt/plugins/todo-tool.ts", "enabled": true, "fiberPhase": "failed"},
                    {"entryId": "model", "moduleName": "model", "enabled": true, "fiberPhase": null},
                ]
            }),
            "a disabled row has no phase, a group row is left out, and no managementAvailable key is invented"
        );
    }

    #[test]
    fn every_phase_is_spelled_as_dsh_spells_it() {
        let phases = [
            PluginFiberPhase::Pending,
            PluginFiberPhase::Loading,
            PluginFiberPhase::Active,
            PluginFiberPhase::Failed,
            PluginFiberPhase::Unloading,
        ];
        let spelled: Vec<_> = phases
            .iter()
            .map(|phase| serde_json::to_value(phase).unwrap())
            .collect();
        assert_eq!(
            spelled,
            vec![
                json!("pending"),
                json!("loading"),
                json!("active"),
                json!("failed"),
                json!("unloading")
            ]
        );
    }
}
