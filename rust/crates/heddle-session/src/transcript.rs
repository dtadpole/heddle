//! The transcript's on-disk format: **one zstd frame per event**, appended.
//!
//! Ported from `src/session/transcript.ts`, modelled on DSH's `session.v4.jsonl.zstd`. Three measured
//! facts decide the code:
//!
//! 1. **A decoder that reads one frame and stops cannot be handed the file.** Node's did exactly that,
//!    so the reader walks the frames itself ([`split_frames`]) and decodes each one. The Rust port keeps
//!    the walk because the walk is also what finds a torn tail.
//! 2. **Appending a frame leaves every earlier byte identical.** That is the property the format is for,
//!    and `70-workspaces-sessions` asserts it by comparing the prefix before and after a turn.
//! 3. **A torn tail costs the last frame and nothing else.** The walk stops at the first incomplete frame
//!    and reports how many bytes were read whole, which is what the store cuts the file back to.
//!
//! A plain-JSONL transcript (the v1 format) is read forever and never rewritten into frames.

/// The four bytes every zstd frame begins with (`0xFD2FB528` little-endian).
pub const FRAME_MAGIC: [u8; 4] = [0x28, 0xb5, 0x2f, 0xfd];

/// One frame's byte range inside a transcript: `start..end`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Frame {
    pub start: usize,
    pub end: usize,
}

/// How a transcript's bytes were stored.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TranscriptFormat {
    /// One zstd frame per event (`*.v2.jsonl.zstd`).
    ZstdFrames,
    /// Plain JSON lines (`*.jsonl`, `session.jsonl`).
    PlainText,
}

impl TranscriptFormat {
    /// The name the TypeScript build reports: `zstd-frames` or `plain-text`.
    pub fn as_str(self) -> &'static str {
        match self {
            TranscriptFormat::ZstdFrames => "zstd-frames",
            TranscriptFormat::PlainText => "plain-text",
        }
    }
}

/// What a transcript file held, and how it was read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodedTranscript {
    /// The non-empty lines that survived, in order. A torn final frame is simply absent.
    pub lines: Vec<String>,
    pub format: TranscriptFormat,
    /// Complete frames found by the walk; 0 for a plain file.
    pub frames: usize,
    /// True when a trailing byte range was not a complete, decodable frame and was left out.
    pub torn: bool,
    /// How many bytes were read whole — what a repair truncates the file to before appending.
    pub readable_bytes: usize,
}

/// Whether a buffer begins with the whole four-byte frame magic.
pub fn is_compressed(buffer: &[u8]) -> bool {
    todo!()
}

/// Whether a buffer is **meant** to be frames, including one cut off inside the magic.
///
/// A file torn after one byte begins with `0x28`; a reader that only knew the whole magic read that
/// byte as a plain line `(` — an event nobody wrote. A plain transcript starts with `{` or whitespace,
/// so any non-empty prefix of the magic is unambiguous.
pub fn looks_compressed(buffer: &[u8]) -> bool {
    todo!()
}

/// Where the frame starting at `start` ends, or `None` when it is incomplete or malformed.
///
/// A zstd frame does not record its own length, so this walks the header (RFC 8878 §3.1.1: descriptor,
/// optional window descriptor, dictionary id, content size) and then the block chain to the block
/// marked last, plus the 4-byte checksum when the descriptor declares one. Anything unexpected ends the
/// walk with `None` rather than panicking: a torn tail is a normal thing to find in an appended file.
pub fn frame_end(buffer: &[u8], start: usize) -> Option<usize> {
    todo!("port: transcript.ts frameEnd, byte for byte")
}

/// Every complete frame in a buffer, in order, stopping at the first byte that does not begin one.
pub fn split_frames(buffer: &[u8]) -> Vec<Frame> {
    todo!()
}

/// One event line, compressed as one frame with a content checksum (zstd level 3, `checksumFlag = 1`).
///
/// `line` is the event's JSON **with** its trailing `\n`, as the store appends it.
pub fn encode_frame(line: &str) -> Vec<u8> {
    todo!("port: zstd::bulk::Compressor with CParameter::ChecksumFlag(true)")
}

/// Read a transcript's bytes, whichever format they are in.
///
/// Plain text: split on `\n`, empty lines dropped, never torn. Frames: each complete frame decoded and
/// split the same way; a frame that walks whole but does not decode ends the readable record at its
/// start (`torn = true`), because everything before it already decoded.
pub fn decode_transcript(buffer: &[u8]) -> DecodedTranscript {
    todo!()
}
