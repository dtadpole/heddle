//! The one error type the store-backed operations return.

use crate::budget::BudgetError;
use crate::store::StoreError;

/// Why a context operation could not complete.
///
/// A refused compaction and a summariser that failed are **not** errors: both are recorded in the log
/// as `compaction/failed` and reported in a [`crate::CompactionOutcome`], because the conversation goes on
/// either way. What is here is what stops the operation.
#[derive(Debug, thiserror::Error)]
pub enum ContextError {
    /// The budget could not be resolved: no window anywhere, or a retained tail at or above the trigger.
    #[error(transparent)]
    Budget(#[from] BudgetError),
    /// The session store failed to read or append, or refused a replacement it could not fold.
    #[error(transparent)]
    Store(#[from] StoreError),
    /// A plan was asked of a measurement taken over a different surface than the one in the log.
    #[error("compaction: the measurement is of a different surface than the one on disk")]
    SurfaceMismatch,
}
