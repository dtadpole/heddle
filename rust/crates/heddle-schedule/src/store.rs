//! Where reminders are kept (`src/schedule/store.ts`): one whole-unit JSON file in DSH's storage-domain shape,
//!
//! ```json
//! {"unit":{"name":"schedule","version":1},"global":null,"tables":{"tasks":{"<id>":<row>}}}
//! ```
//!
//! A row is `{sessionId, record, status, lastDelivery?, deliveryHistory?}`, decoded strictly. **An absent file is
//! an empty store** and a corrupt one **refuses to open**; **every write is atomic** (a temp file beside the target,
//! fsynced, then renamed); and **memory follows the disk** — a write that fails leaves the table as it was.

use std::fmt;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::{Map, Value};

use crate::errors::ScheduleLogError;
use crate::js;
use crate::rules::{ScheduleRecord, decode_schedule_record};
use crate::time::{format_instant, is_utc_instant, parse_instant};

/// What one delivery acknowledged: the occurrence, when it landed, and the message that carried it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeliveryReceipt {
    /// The occurrence delivered.
    pub scheduled_at: String,
    /// When the delivery was acknowledged.
    pub delivered_at: String,
    /// The message that carried it.
    pub message_id: String,
}

impl DeliveryReceipt {
    /// `{scheduledAt, deliveredAt, messageId}`.
    pub fn to_map(&self) -> Map<String, Value> {
        let mut map = Map::new();
        map.insert("scheduledAt".into(), Value::from(self.scheduled_at.clone()));
        map.insert("deliveredAt".into(), Value::from(self.delivered_at.clone()));
        map.insert("messageId".into(), Value::from(self.message_id.clone()));
        map
    }
}

/// A retained delivery: the receipt plus the prompt as it was delivered.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeliveryRecord {
    /// The receipt.
    pub receipt: DeliveryReceipt,
    /// The prompt as delivered.
    pub prompt: Option<String>,
}

impl DeliveryRecord {
    /// `{scheduledAt, deliveredAt, messageId, prompt?}`.
    pub fn to_value(&self) -> Value {
        let mut map = self.receipt.to_map();
        if let Some(prompt) = &self.prompt {
            map.insert("prompt".into(), Value::from(prompt.clone()));
        }
        Value::Object(map)
    }
}

/// A task's retained deliveries, oldest first, and whether earlier ones are gone.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeliveryHistory {
    /// Oldest first.
    pub records: Vec<DeliveryRecord>,
    /// Whether deliveries before these are unavailable.
    pub earlier_records_unavailable: bool,
    /// Whether retention removed some.
    pub earlier_records_pruned: Option<bool>,
}

impl DeliveryHistory {
    /// The history a new task starts with.
    pub fn empty() -> Self {
        Self {
            records: Vec::new(),
            earlier_records_unavailable: false,
            earlier_records_pruned: None,
        }
    }

    /// `{records, earlierRecordsUnavailable, earlierRecordsPruned?}`.
    pub fn to_value(&self) -> Value {
        let mut map = Map::new();
        map.insert(
            "records".into(),
            Value::Array(self.records.iter().map(DeliveryRecord::to_value).collect()),
        );
        map.insert(
            "earlierRecordsUnavailable".into(),
            Value::from(self.earlier_records_unavailable),
        );
        if let Some(pruned) = self.earlier_records_pruned {
            map.insert("earlierRecordsPruned".into(), Value::from(pruned));
        }
        Value::Object(map)
    }
}

/// Whether a task can still come due.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TaskStatus {
    /// It has a target.
    Active,
    /// A delivered one-shot, or an exhausted recurring task.
    Inactive,
}

impl TaskStatus {
    /// `active` or `inactive`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Inactive => "inactive",
        }
    }
}

/// One stored task: the record, the session it belongs to, its status, and its deliveries.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScheduleTask {
    /// The session the reminder belongs to.
    pub session_id: String,
    /// The record.
    pub record: ScheduleRecord,
    /// Active or inactive.
    pub status: TaskStatus,
    /// The last acknowledged delivery.
    pub last_delivery: Option<DeliveryReceipt>,
    /// The retained deliveries.
    pub delivery_history: Option<DeliveryHistory>,
}

impl ScheduleTask {
    /// A new active task with an empty history, as create writes it.
    pub fn new(session_id: impl Into<String>, record: ScheduleRecord) -> Self {
        Self {
            session_id: session_id.into(),
            record,
            status: TaskStatus::Active,
            last_delivery: None,
            delivery_history: Some(DeliveryHistory::empty()),
        }
    }

    /// One row in its stored key order: sessionId, record, status, lastDelivery, deliveryHistory.
    pub fn to_value(&self) -> Value {
        let mut map = Map::new();
        map.insert("sessionId".into(), Value::from(self.session_id.clone()));
        map.insert("record".into(), self.record.to_value());
        map.insert("status".into(), Value::from(self.status.as_str()));
        if let Some(receipt) = &self.last_delivery {
            map.insert("lastDelivery".into(), Value::Object(receipt.to_map()));
        }
        if let Some(history) = &self.delivery_history {
            map.insert("deliveryHistory".into(), history.to_value());
        }
        Value::Object(map)
    }
}

/// The store's file refused to open. The message names the file and the first thing wrong with it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScheduleStoreError {
    /// The file.
    pub file: PathBuf,
    /// What is wrong.
    pub detail: String,
}

impl fmt::Display for ScheduleStoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "schedule: {} is not a valid schedule store: {}",
            self.file.display(),
            self.detail
        )
    }
}

impl std::error::Error for ScheduleStoreError {}

/// `<heddle home>/schedule.json`.
pub fn default_schedule_file(heddle_home: &Path) -> PathBuf {
    heddle_home.join("schedule.json")
}

fn only_keys(
    map: &Map<String, Value>,
    allowed: &[&str],
    what: &str,
) -> Result<(), ScheduleLogError> {
    for key in map.keys() {
        if !allowed.contains(&key.as_str()) {
            return Err(ScheduleLogError::new(format!(
                "{what} has an unknown key {}",
                js::json_string(key)
            )));
        }
    }
    Ok(())
}

/// A canonical millisecond UTC instant, never year 0000.
fn instant(value: Option<&Value>, what: &str) -> Result<String, ScheduleLogError> {
    match value.and_then(Value::as_str) {
        Some(text)
            if is_utc_instant(text)
                && parse_instant(text).is_some_and(|epoch| format_instant(epoch) == text) =>
        {
            Ok(text.to_owned())
        }
        _ => Err(ScheduleLogError::new(format!(
            "{what} must be a canonical four-digit-year UTC calendar instant"
        ))),
    }
}

fn message_id(value: Option<&Value>, what: &str) -> Result<String, ScheduleLogError> {
    match value.and_then(Value::as_str) {
        Some(text) if !text.is_empty() && js::trim(text) == text => Ok(text.to_owned()),
        _ => Err(ScheduleLogError::new(format!(
            "{what} must be a non-empty trimmed string"
        ))),
    }
}

fn decode_receipt_fields(
    map: &Map<String, Value>,
    what: &str,
) -> Result<DeliveryReceipt, ScheduleLogError> {
    Ok(DeliveryReceipt {
        scheduled_at: instant(map.get("scheduledAt"), &format!("{what}.scheduledAt"))?,
        delivered_at: instant(map.get("deliveredAt"), &format!("{what}.deliveredAt"))?,
        message_id: message_id(map.get("messageId"), &format!("{what}.messageId"))?,
    })
}

fn decode_receipt(value: &Value, what: &str) -> Result<DeliveryReceipt, ScheduleLogError> {
    let Some(map) = value.as_object() else {
        return Err(ScheduleLogError::new(format!("{what} must be an object")));
    };
    only_keys(map, &["scheduledAt", "deliveredAt", "messageId"], what)?;
    decode_receipt_fields(map, what)
}

fn decode_history(value: &Value) -> Result<DeliveryHistory, ScheduleLogError> {
    let Some(map) = value.as_object() else {
        return Err(ScheduleLogError::new("deliveryHistory must be an object"));
    };
    only_keys(
        map,
        &[
            "records",
            "earlierRecordsUnavailable",
            "earlierRecordsPruned",
        ],
        "deliveryHistory",
    )?;
    let Some(entries) = map.get("records").and_then(Value::as_array) else {
        return Err(ScheduleLogError::new(
            "deliveryHistory.records must be an array",
        ));
    };
    let mut records = Vec::with_capacity(entries.len());
    for (index, entry) in entries.iter().enumerate() {
        let what = format!("deliveryHistory.records[{index}]");
        let Some(entry) = entry.as_object() else {
            return Err(ScheduleLogError::new(format!("{what} must be an object")));
        };
        only_keys(
            entry,
            &["scheduledAt", "deliveredAt", "messageId", "prompt"],
            &what,
        )?;
        let receipt = decode_receipt_fields(entry, &what)?;
        let prompt = match entry.get("prompt") {
            None => None,
            Some(Value::String(prompt)) => Some(prompt.clone()),
            Some(_) => {
                return Err(ScheduleLogError::new(format!(
                    "{what}.prompt must be a string"
                )));
            }
        };
        records.push(DeliveryRecord { receipt, prompt });
    }
    let Some(unavailable) = map
        .get("earlierRecordsUnavailable")
        .and_then(Value::as_bool)
    else {
        return Err(ScheduleLogError::new(
            "deliveryHistory.earlierRecordsUnavailable must be a boolean",
        ));
    };
    let pruned = match map.get("earlierRecordsPruned") {
        None => None,
        Some(Value::Bool(pruned)) => Some(*pruned),
        Some(_) => {
            return Err(ScheduleLogError::new(
                "deliveryHistory.earlierRecordsPruned must be a boolean",
            ));
        }
    };
    let mut seen = std::collections::HashSet::new();
    if !records
        .iter()
        .all(|record| seen.insert(record.receipt.message_id.clone()))
    {
        return Err(ScheduleLogError::new(
            "Delivery history message identities must be unique within a task",
        ));
    }
    Ok(DeliveryHistory {
        records,
        earlier_records_unavailable: unavailable,
        earlier_records_pruned: pruned,
    })
}

/// Decode one stored row strictly, with DSH's refinements (SVC:1678-1689, 1997-2007).
pub fn decode_task(key: &str, value: &Value) -> Result<ScheduleTask, ScheduleLogError> {
    let what = format!("task {}", js::json_string(key));
    let Some(map) = value.as_object() else {
        return Err(ScheduleLogError::new(format!("{what} must be an object")));
    };
    only_keys(
        map,
        &[
            "sessionId",
            "record",
            "status",
            "lastDelivery",
            "deliveryHistory",
        ],
        &what,
    )?;
    let session_id = match map.get("sessionId").and_then(Value::as_str) {
        Some(id) if !id.is_empty() => id.to_owned(),
        _ => {
            return Err(ScheduleLogError::new(format!(
                "{what} needs a non-empty sessionId"
            )));
        }
    };
    let record = decode_schedule_record(map.get("record").unwrap_or(&Value::Null))?;
    let status = match map.get("status") {
        None => TaskStatus::Active,
        Some(Value::String(status)) if status == "active" => TaskStatus::Active,
        Some(Value::String(status)) if status == "inactive" => TaskStatus::Inactive,
        Some(_) => {
            return Err(ScheduleLogError::new(format!(
                "{what} status must be active or inactive"
            )));
        }
    };
    let last_delivery = map
        .get("lastDelivery")
        .map(|value| decode_receipt(value, "lastDelivery"))
        .transpose()?;
    let delivery_history = map.get("deliveryHistory").map(decode_history).transpose()?;
    if let Some(history) = &delivery_history {
        let matches = match history.records.last() {
            None => last_delivery.is_none(),
            Some(latest) => last_delivery.as_ref() == Some(&latest.receipt),
        };
        if !matches {
            return Err(ScheduleLogError::new(
                "Last delivery must match the latest saved delivery receipt",
            ));
        }
    }
    if key != record.id {
        return Err(ScheduleLogError::new(format!(
            "stored task key \"{key}\" differs from record id \"{}\"",
            record.id
        )));
    }
    Ok(ScheduleTask {
        session_id,
        record,
        status,
        last_delivery,
        delivery_history,
    })
}

/// Decode a whole unit document; any violation is a [`ScheduleLogError`] naming it.
pub fn decode_unit(text: &str) -> Result<Vec<ScheduleTask>, ScheduleLogError> {
    let parsed: Value = serde_json::from_str(text)
        .map_err(|error| ScheduleLogError::new(format!("the file is not JSON ({error})")))?;
    let Some(unit_document) = parsed.as_object() else {
        return Err(ScheduleLogError::new("the unit must be an object"));
    };
    only_keys(unit_document, &["unit", "global", "tables"], "the unit")?;
    let unit = unit_document.get("unit").and_then(Value::as_object);
    let named = unit.is_some_and(|unit| {
        unit.get("name").and_then(Value::as_str) == Some("schedule")
            && unit
                .get("version")
                .is_some_and(|version| js::number_equals(version, 1))
    });
    let Some(unit) = unit.filter(|_| named) else {
        return Err(ScheduleLogError::new(
            "unit must be {\"name\":\"schedule\",\"version\":1}",
        ));
    };
    only_keys(unit, &["name", "version"], "unit")?;
    if unit_document.get("global") != Some(&Value::Null) {
        return Err(ScheduleLogError::new("global must be null"));
    }
    let Some(tables) = unit_document.get("tables").and_then(Value::as_object) else {
        return Err(ScheduleLogError::new("tables must be an object"));
    };
    only_keys(tables, &["tasks"], "tables")?;
    let empty = Map::new();
    let tasks = match tables.get("tasks") {
        None | Some(Value::Null) => &empty,
        Some(Value::Object(tasks)) => tasks,
        Some(_) => return Err(ScheduleLogError::new("tables.tasks must be an object")),
    };
    tasks
        .iter()
        .map(|(key, row)| decode_task(key, row))
        .collect()
}

/// The whole unit document for a table, in storage order: `JSON.stringify(unit, null, 2)` and a newline.
pub fn encode_unit(tasks: &[ScheduleTask]) -> String {
    let mut rows = Map::new();
    for task in tasks {
        rows.insert(task.record.id.clone(), task.to_value());
    }
    let mut tables = Map::new();
    tables.insert("tasks".into(), Value::Object(rows));
    let mut unit = Map::new();
    unit.insert("name".into(), Value::from("schedule"));
    unit.insert("version".into(), Value::from(1));
    let mut document = Map::new();
    document.insert("unit".into(), Value::Object(unit));
    document.insert("global".into(), Value::Null);
    document.insert("tables".into(), Value::Object(tables));
    let mut text =
        serde_json::to_string_pretty(&Value::Object(document)).expect("a unit serializes");
    text.push('\n');
    text
}

/// Write a file so a reader sees the old content or the new, never a half: temp file, fsync, rename.
fn write_atomically(file: &Path, text: &str) -> std::io::Result<()> {
    let directory = file.parent().unwrap_or(Path::new("."));
    std::fs::create_dir_all(directory)?;
    let name = file
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "schedule.json".to_owned());
    let temp = directory.join(format!(
        "{name}.{}.{}.tmp",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let written = (|| {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut handle = options.open(&temp)?;
        handle.write_all(text.as_bytes())?;
        handle.sync_all()?;
        drop(handle);
        std::fs::rename(&temp, file)
    })();
    if let Err(error) = written {
        let _ = std::fs::remove_file(&temp);
        return Err(error);
    }
    // Not every platform can fsync a directory; the rename has already landed.
    if let Ok(handle) = std::fs::File::open(directory) {
        let _ = handle.sync_all();
    }
    Ok(())
}

/// The task table over one file. Reads are served from memory; every change rewrites the whole unit.
pub struct ScheduleStore {
    file: PathBuf,
    tasks: Mutex<Vec<ScheduleTask>>,
}

impl ScheduleStore {
    /// Open the store at `file`: absent means empty, and anything unreadable is a [`ScheduleStoreError`].
    pub fn open(file: impl Into<PathBuf>) -> Result<Self, ScheduleStoreError> {
        let file = file.into();
        let refuse = |detail: String| ScheduleStoreError {
            file: file.clone(),
            detail,
        };
        let tasks = match std::fs::read_to_string(&file) {
            Ok(text) => decode_unit(&text).map_err(|error| refuse(error.message))?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(error) => return Err(refuse(error.to_string())),
        };
        Ok(Self {
            file,
            tasks: Mutex::new(tasks),
        })
    }

    /// The file.
    pub fn file(&self) -> &Path {
        &self.file
    }

    fn table(&self) -> std::sync::MutexGuard<'_, Vec<ScheduleTask>> {
        self.tasks
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Every task, in storage order.
    pub fn entries(&self) -> Vec<ScheduleTask> {
        self.table().clone()
    }

    /// One task.
    pub fn get(&self, id: &str) -> Option<ScheduleTask> {
        self.table()
            .iter()
            .find(|task| task.record.id == id)
            .cloned()
    }

    /// Insert or replace one task; a replaced task keeps its storage position.
    pub fn put(&self, id: &str, task: ScheduleTask) -> Result<(), String> {
        if id != task.record.id {
            return Err(format!(
                "stored task key \"{id}\" differs from record id \"{}\"",
                task.record.id
            ));
        }
        let mut table = self.table();
        let mut next = table.clone();
        match next.iter_mut().find(|existing| existing.record.id == id) {
            Some(existing) => *existing = task,
            None => next.push(task),
        }
        write_atomically(&self.file, &encode_unit(&next)).map_err(|error| error.to_string())?;
        *table = next;
        Ok(())
    }

    /// Remove one task; whether there was one.
    pub fn delete(&self, id: &str) -> Result<bool, String> {
        let mut table = self.table();
        if !table.iter().any(|task| task.record.id == id) {
            return Ok(false);
        }
        let next: Vec<ScheduleTask> = table
            .iter()
            .filter(|task| task.record.id != id)
            .cloned()
            .collect();
        write_atomically(&self.file, &encode_unit(&next)).map_err(|error| error.to_string())?;
        *table = next;
        Ok(true)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::rules::{create_daily_schedule_record, create_every_schedule_record};
    use serde_json::json;

    /// One test's scratch folder under the temp dir, removed when the guard drops — at the end of
    /// the test, and also when the test panics. Hold the guard for as long as anything in the folder
    /// is in use: a dropped guard lets a later write recreate the folder, and that one would leak.
    pub(crate) struct Scratch(PathBuf);

    impl std::ops::Deref for Scratch {
        type Target = Path;

        fn deref(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            // A test may stand a plain file where the folder was; remove whichever is there.
            match std::fs::symlink_metadata(&self.0) {
                Ok(metadata) if metadata.is_dir() => {
                    let _ = std::fs::remove_dir_all(&self.0);
                }
                Ok(_) => {
                    let _ = std::fs::remove_file(&self.0);
                }
                Err(_) => {}
            }
        }
    }

    pub(crate) fn scratch(label: &str) -> Scratch {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "heddle-schedule-{label}-{}-{unique}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        Scratch(dir)
    }

    /// 2026-10-29T12:00:00.000Z.
    const NOW: i64 = 1_793_275_200_000;

    fn daily() -> ScheduleRecord {
        create_daily_schedule_record(
            "schedule-a",
            &json!("Review"),
            &json!({"time": "23:00:00", "time_zone": "Asia/Shanghai"}),
            NOW,
            &json!("Daily review"),
        )
        .unwrap()
    }

    fn every() -> ScheduleRecord {
        create_every_schedule_record(
            "schedule-b",
            &json!("Ping"),
            &json!(60),
            NOW,
            &json!("Ping"),
        )
        .unwrap()
    }

    fn task(record: ScheduleRecord) -> ScheduleTask {
        ScheduleTask::new("session-1", record)
    }

    /// A fresh store file and the guard of its folder; the caller holds the guard to the end.
    fn file() -> (Scratch, PathBuf) {
        let root = scratch("store");
        let file = root.join("schedule.json");
        (root, file)
    }

    #[test]
    fn the_default_file_is_heddle_home_schedule_json() {
        assert_eq!(
            default_schedule_file(Path::new("/tmp/h")),
            PathBuf::from("/tmp/h/schedule.json")
        );
    }

    #[test]
    fn an_absent_file_is_an_empty_store_and_a_write_creates_it_in_the_exact_unit_shape() {
        let (_root, file) = file();
        let store = ScheduleStore::open(&file).unwrap();
        assert!(store.entries().is_empty());
        store.put("schedule-a", task(daily())).unwrap();
        let unit: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        let keys = |value: &Value| {
            value
                .as_object()
                .unwrap()
                .keys()
                .cloned()
                .collect::<Vec<_>>()
        };
        assert_eq!(keys(&unit), ["unit", "global", "tables"]);
        assert_eq!(unit["unit"], json!({"name": "schedule", "version": 1}));
        assert_eq!(unit["global"], Value::Null);
        assert_eq!(keys(&unit["tables"]["tasks"]), ["schedule-a"]);
        assert_eq!(
            keys(&unit["tables"]["tasks"]["schedule-a"]),
            ["sessionId", "record", "status", "deliveryHistory"]
        );
        assert_eq!(
            keys(&unit["tables"]["tasks"]["schedule-a"]["record"]),
            [
                "id",
                "kind",
                "title",
                "prompt",
                "time",
                "timeZone",
                "scheduledAt"
            ]
        );
        let names: Vec<String> = std::fs::read_dir(file.parent().unwrap())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, ["schedule.json"], "no temp file is left behind");
        assert!(std::fs::read_to_string(&file).unwrap().ends_with("}\n"));
    }

    #[test]
    fn a_store_reopened_from_its_file_reads_back_the_same_rows_in_the_same_order() {
        let (_root, file) = file();
        let store = ScheduleStore::open(&file).unwrap();
        store.put("schedule-a", task(daily())).unwrap();
        store.put("schedule-b", task(every())).unwrap();
        let receipt = DeliveryReceipt {
            scheduled_at: daily().scheduled_at,
            delivered_at: "2026-10-29T15:00:01.000Z".into(),
            message_id: "message-1".into(),
        };
        let delivered = ScheduleTask {
            status: TaskStatus::Inactive,
            last_delivery: Some(receipt.clone()),
            delivery_history: Some(DeliveryHistory {
                records: vec![DeliveryRecord {
                    receipt,
                    prompt: Some("Review".into()),
                }],
                earlier_records_unavailable: false,
                earlier_records_pruned: Some(false),
            }),
            ..task(daily())
        };
        store.put("schedule-a", delivered.clone()).unwrap();
        let reopened = ScheduleStore::open(&file).unwrap();
        assert_eq!(
            reopened.entries(),
            [delivered.clone(), task(every())],
            "a replaced row keeps its position"
        );
        assert_eq!(reopened.delete("schedule-b"), Ok(true));
        assert_eq!(reopened.delete("schedule-b"), Ok(false));
        assert_eq!(ScheduleStore::open(&file).unwrap().entries(), [delivered]);
    }

    #[test]
    fn a_row_without_a_status_reads_as_active() {
        let (_root, file) = file();
        ScheduleStore::open(&file)
            .unwrap()
            .put("schedule-a", task(daily()))
            .unwrap();
        let mut unit: Value =
            serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        unit["tables"]["tasks"]["schedule-a"]
            .as_object_mut()
            .unwrap()
            .remove("status");
        std::fs::write(&file, unit.to_string()).unwrap();
        assert_eq!(
            ScheduleStore::open(&file)
                .unwrap()
                .get("schedule-a")
                .unwrap()
                .status,
            TaskStatus::Active
        );
    }

    fn refuses(document: &str, reason: &str) {
        let (_root, file) = file();
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, document).unwrap();
        let error = ScheduleStore::open(&file)
            .err()
            .unwrap_or_else(|| panic!("refused: {reason}"))
            .to_string();
        assert!(error.contains(&file.display().to_string()), "{error}");
        assert!(error.contains(reason), "{error} should mention {reason}");
    }

    fn unit_with(rows: Value, extra: Option<(&str, Value)>) -> String {
        let mut unit = json!({"unit": {"name": "schedule", "version": 1}, "global": null, "tables": {"tasks": rows}});
        if let Some((key, value)) = extra {
            unit.as_object_mut().unwrap().insert(key.into(), value);
        }
        unit.to_string()
    }

    fn row(changes: &[(&str, Value)]) -> Value {
        let mut value = task(daily()).to_value();
        for (key, change) in changes {
            if change.is_null() && *key == "deliveryHistory" {
                value.as_object_mut().unwrap().remove(*key);
            } else {
                value
                    .as_object_mut()
                    .unwrap()
                    .insert((*key).into(), change.clone());
            }
        }
        value
    }

    #[test]
    fn a_corrupt_or_invalid_file_refuses_to_open() {
        refuses("", "not JSON");
        refuses("{\"unit\":", "not JSON");
        refuses("[]", "the unit must be an object");
        refuses(&json!({"unit": {"name": "schedule", "version": 2}, "global": null, "tables": {"tasks": {}}}).to_string(), "unit must be");
        refuses(
            &unit_with(json!({}), Some(("extra", json!(1)))),
            "unknown key \"extra\"",
        );
        refuses(
            &unit_with(json!({"schedule-x": row(&[])}), None),
            "stored task key \"schedule-x\" differs from record id \"schedule-a\"",
        );
        refuses(
            &unit_with(
                json!({"schedule-a": row(&[("sessionId", json!(""))])}),
                None,
            ),
            "non-empty sessionId",
        );
        refuses(
            &unit_with(
                json!({"schedule-a": row(&[("status", json!("paused"))])}),
                None,
            ),
            "status must be active or inactive",
        );
        refuses(
            &unit_with(
                json!({"schedule-a": row(&[("surprise", json!(true))])}),
                None,
            ),
            "unknown key \"surprise\"",
        );
        let mut untrimmed = daily().to_value();
        untrimmed["prompt"] = json!(" untrimmed");
        refuses(
            &unit_with(json!({"schedule-a": row(&[("record", untrimmed)])}), None),
            "daily prompt must be non-empty and already trimmed",
        );
        let receipt = json!({"scheduledAt": daily().scheduled_at, "deliveredAt": "2026-10-29T15:00:01.000Z", "messageId": "m"});
        refuses(
            &unit_with(
                json!({"schedule-a": row(&[("lastDelivery", receipt.clone())])}),
                None,
            ),
            "Last delivery must match the latest saved delivery receipt",
        );
        refuses(
            &unit_with(
                json!({"schedule-a": row(&[("lastDelivery", receipt.clone()), ("deliveryHistory", json!({"records": [receipt, receipt], "earlierRecordsUnavailable": false}))])}),
                None,
            ),
            "message identities must be unique",
        );
        let mut loose = receipt.clone();
        loose["deliveredAt"] = json!("2026-10-29T15:00:01Z");
        refuses(
            &unit_with(
                json!({"schedule-a": row(&[("lastDelivery", loose), ("deliveryHistory", Value::Null)])}),
                None,
            ),
            "canonical four-digit-year UTC calendar instant",
        );
    }

    #[test]
    fn a_failed_write_leaves_the_table_as_it_was() {
        let (_root, file) = file();
        let store = ScheduleStore::open(&file).unwrap();
        store.put("schedule-a", task(daily())).unwrap();
        let error = store.put("schedule-other", task(daily())).unwrap_err();
        assert!(error.contains("differs from record id"), "{error}");
        assert_eq!(store.entries(), [task(daily())]);
    }
}
