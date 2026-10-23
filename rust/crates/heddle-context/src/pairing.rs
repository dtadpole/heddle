//! Tool-pair repair over the messages a request will carry.
//!
//! A port of `src/context/pairing.ts`. A provider refuses a request whose assistant tool-call
//! message is not followed by one tool message per call, and a turn stopped between a call and its
//! answer leaves exactly that shape in the log. This is the **repair** for a log already written
//! that way, so an affected session can answer again instead of failing every request.

use std::borrow::Cow;

/// What a call with no answer anywhere in the list is answered with.
pub const INTERRUPTED_ANSWER: &str =
    "error (INTERRUPTED): the turn ended before this call answered";

/// Return the messages with every assistant tool call followed by its answer, in call order.
///
/// A real answer is **moved** into place, not replaced, so a steering message between a call and
/// its result keeps the result; a call with no answer gets [`INTERRUPTED_ANSWER`]; an answer whose
/// call is absent, and a duplicate answer, are dropped. An already-valid list is returned borrowed.
pub fn repair_tool_pairing(messages: &[crate::types::Message]) -> Cow<'_, [crate::types::Message]> {
    let _ = messages;
    todo!("repair_tool_pairing")
}
