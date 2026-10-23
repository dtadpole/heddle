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
    buffer.len() >= FRAME_MAGIC.len() && buffer[..FRAME_MAGIC.len()] == FRAME_MAGIC
}

/// Whether a buffer is **meant** to be frames, including one cut off inside the magic.
///
/// A file torn after one byte begins with `0x28`; a reader that only knew the whole magic read that
/// byte as a plain line `(` — an event nobody wrote. A plain transcript starts with `{` or whitespace,
/// so any non-empty prefix of the magic is unambiguous.
pub fn looks_compressed(buffer: &[u8]) -> bool {
    if buffer.is_empty() {
        return false;
    }
    let length = FRAME_MAGIC.len().min(buffer.len());
    buffer[..length] == FRAME_MAGIC[..length]
}

/// Where the frame starting at `start` ends, or `None` when it is incomplete or malformed.
///
/// A zstd frame does not record its own length, so this walks the header (RFC 8878 §3.1.1: descriptor,
/// optional window descriptor, dictionary id, content size) and then the block chain to the block
/// marked last, plus the 4-byte checksum when the descriptor declares one. Anything unexpected ends the
/// walk with `None` rather than panicking: a torn tail is a normal thing to find in an appended file.
pub fn frame_end(buffer: &[u8], start: usize) -> Option<usize> {
    if start + 4 > buffer.len() || buffer[start..start + 4] != FRAME_MAGIC {
        return None;
    }
    let mut cursor = start + 4;
    if cursor + 1 > buffer.len() {
        return None;
    }
    let descriptor = buffer[cursor];
    cursor += 1;

    let content_size_flag = descriptor >> 6;
    let single_segment = (descriptor & 0x20) != 0;
    let checksum = (descriptor & 0x04) != 0;
    let dictionary_flag = descriptor & 0x03;

    if !single_segment {
        cursor += 1; // Window_Descriptor
    }
    // Dictionary_ID length by its two-bit flag: 0, 1, 2, 4 bytes.
    cursor += [0usize, 1, 2, 4][usize::from(dictionary_flag)];
    // Content_Size length: one byte only in a single-segment frame with flag 0; otherwise 0, 2, 4, 8.
    let content_size_bytes = if content_size_flag == 0 {
        usize::from(single_segment)
    } else {
        [0usize, 2, 4, 8][usize::from(content_size_flag)]
    };
    cursor += content_size_bytes;
    if cursor > buffer.len() {
        return None;
    }

    loop {
        if cursor + 3 > buffer.len() {
            return None;
        }
        let header = u32::from(buffer[cursor])
            | (u32::from(buffer[cursor + 1]) << 8)
            | (u32::from(buffer[cursor + 2]) << 16);
        cursor += 3;
        let last_block = (header & 0x01) != 0;
        let block_type = (header >> 1) & 0x03;
        let block_size = header >> 3;
        if block_type == 3 {
            return None; // reserved
        }
        // An RLE block carries one byte whatever its declared size says.
        let payload = if block_type == 1 {
            1
        } else {
            block_size as usize
        };
        cursor += payload;
        if cursor > buffer.len() {
            return None;
        }
        if last_block {
            break;
        }
    }

    if checksum {
        cursor += 4;
    }
    if cursor > buffer.len() {
        None
    } else {
        Some(cursor)
    }
}

/// Every complete frame in a buffer, in order, stopping at the first byte that does not begin one.
pub fn split_frames(buffer: &[u8]) -> Vec<Frame> {
    let mut frames = Vec::new();
    let mut start = 0usize;
    while start < buffer.len() {
        let Some(end) = frame_end(buffer, start) else {
            break;
        };
        if end <= start {
            break;
        }
        frames.push(Frame { start, end });
        start = end;
    }
    frames
}

/// One event line, compressed as one frame with a content checksum (zstd level 3, `checksumFlag = 1`).
///
/// `line` is the event's JSON **with** its trailing `\n`, as the store appends it.
pub fn encode_frame(line: &str) -> Vec<u8> {
    let mut compressor = zstd::bulk::Compressor::new(3)
        .expect("a zstd compressor at level 3 is always constructible");
    compressor
        .set_parameter(zstd::zstd_safe::CParameter::ChecksumFlag(true))
        .expect("the zstd checksum parameter is always settable");
    compressor
        .compress(line.as_bytes())
        .expect("compressing a single event line cannot fail")
}

/// Decode one whole frame's payload as UTF-8, as Node's `toString('utf8')` would.
fn decode_frame(frame: &[u8]) -> Option<String> {
    let bytes = zstd::stream::decode_all(frame).ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// Read a transcript's bytes, whichever format they are in.
///
/// Plain text: split on `\n`, empty lines dropped, never torn. Frames: each complete frame decoded and
/// split the same way; a frame that walks whole but does not decode ends the readable record at its
/// start (`torn = true`), because everything before it already decoded.
pub fn decode_transcript(buffer: &[u8]) -> DecodedTranscript {
    if !looks_compressed(buffer) {
        let text = String::from_utf8_lossy(buffer);
        return DecodedTranscript {
            lines: text
                .split('\n')
                .filter(|line| !line.is_empty())
                .map(str::to_string)
                .collect(),
            format: TranscriptFormat::PlainText,
            frames: 0,
            torn: false,
            readable_bytes: buffer.len(),
        };
    }

    let frames = split_frames(buffer);
    let mut lines = Vec::new();
    let mut consumed = 0usize;
    for frame in &frames {
        let some = decode_frame(&buffer[frame.start..frame.end]);
        let Some(text) = some else {
            // A frame that cannot be decoded ends the readable record rather than failing the whole
            // file: everything before it already decoded.
            return DecodedTranscript {
                lines,
                format: TranscriptFormat::ZstdFrames,
                frames: frames.len(),
                torn: true,
                readable_bytes: frame.start,
            };
        };
        lines.extend(
            text.split('\n')
                .filter(|line| !line.is_empty())
                .map(str::to_string),
        );
        consumed = frame.end;
    }
    DecodedTranscript {
        lines,
        format: TranscriptFormat::ZstdFrames,
        frames: frames.len(),
        torn: consumed != buffer.len(),
        readable_bytes: consumed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn one_frame(text: &str) -> Vec<u8> {
        encode_frame(&format!("{text}\n"))
    }

    #[test]
    fn a_frame_starts_with_the_magic_and_carries_a_checksum() {
        let frame =
            one_frame(r#"{"seq":0,"at":"2026-10-22T18:17:41.123Z","type":"session/created"}"#);
        assert!(is_compressed(&frame));
        // The frame header sits after the magic; bit 2 of the descriptor is the checksum flag.
        let descriptor = frame[4];
        assert_eq!(
            descriptor & 0x04,
            0x04,
            "the frame declares a content checksum"
        );
        assert_eq!(frame_end(&frame, 0), Some(frame.len()));
    }

    #[test]
    fn a_frame_encoded_here_decodes_back_to_its_line() {
        let line = r#"{"seq":1,"at":"2026-10-22T18:17:41.123Z","type":"message","message":{"role":"user"}}"#;
        let frame = encode_frame(&format!("{line}\n"));
        let decoded = decode_transcript(&frame);
        assert_eq!(decoded.format, TranscriptFormat::ZstdFrames);
        assert_eq!(decoded.frames, 1);
        assert_eq!(decoded.lines, vec![line.to_string()]);
        assert!(!decoded.torn);
        assert_eq!(decoded.readable_bytes, frame.len());
    }

    #[test]
    fn a_walk_finds_every_frame_of_a_multi_frame_buffer() {
        let first = one_frame(r#"{"seq":0,"type":"a"}"#);
        let second = one_frame(r#"{"seq":1,"type":"b"}"#);
        let third = one_frame(r#"{"seq":2,"type":"c"}"#);
        let mut buffer = Vec::new();
        buffer.extend_from_slice(&first);
        buffer.extend_from_slice(&second);
        buffer.extend_from_slice(&third);

        let frames = split_frames(&buffer);
        assert_eq!(frames.len(), 3);
        assert_eq!(
            frames[0],
            Frame {
                start: 0,
                end: first.len()
            }
        );
        assert_eq!(
            frames[1],
            Frame {
                start: first.len(),
                end: first.len() + second.len()
            }
        );
        assert_eq!(
            frames[2],
            Frame {
                start: first.len() + second.len(),
                end: buffer.len()
            }
        );

        let decoded = decode_transcript(&buffer);
        assert_eq!(decoded.lines.len(), 3);
        assert_eq!(decoded.frames, 3);
        assert!(!decoded.torn);
        assert_eq!(decoded.readable_bytes, buffer.len());
    }

    #[test]
    fn a_frame_torn_by_one_byte_costs_only_that_frame() {
        let first = one_frame(r#"{"seq":0,"type":"a"}"#);
        let second = one_frame(r#"{"seq":1,"type":"b"}"#);
        let mut buffer = Vec::new();
        buffer.extend_from_slice(&first);
        buffer.extend_from_slice(&second);
        buffer.truncate(buffer.len() - 1);

        let frames = split_frames(&buffer);
        assert_eq!(frames.len(), 1, "the half frame is not walked");
        let decoded = decode_transcript(&buffer);
        assert_eq!(decoded.lines, vec![r#"{"seq":0,"type":"a"}"#.to_string()]);
        assert!(decoded.torn);
        assert_eq!(decoded.readable_bytes, first.len());
    }

    #[test]
    fn a_file_torn_inside_the_magic_is_not_read_as_plain_text() {
        let buffer = FRAME_MAGIC[..2].to_vec();
        assert!(!is_compressed(&buffer));
        assert!(looks_compressed(&buffer));
        let decoded = decode_transcript(&buffer);
        assert_eq!(decoded.format, TranscriptFormat::ZstdFrames);
        assert!(
            decoded.lines.is_empty(),
            "no event is invented from the magic"
        );
        assert!(decoded.torn);
        assert_eq!(decoded.readable_bytes, 0);
    }

    #[test]
    fn a_file_torn_in_the_middle_of_a_block_reads_nothing_from_it() {
        let frame =
            one_frame(r#"{"seq":0,"type":"a long enough event that its block is not tiny"}"#);
        let buffer = frame[..frame.len() / 2].to_vec();
        assert!(looks_compressed(&buffer));
        assert!(split_frames(&buffer).is_empty());
        let decoded = decode_transcript(&buffer);
        assert!(decoded.torn);
        assert_eq!(decoded.readable_bytes, 0);
    }

    #[test]
    fn a_plain_transcript_is_read_and_never_torn() {
        let buffer = b"{\"seq\":0,\"type\":\"a\"}\n\n{\"seq\":1,\"type\":\"b\"}\n".to_vec();
        assert!(!looks_compressed(&buffer));
        let decoded = decode_transcript(&buffer);
        assert_eq!(decoded.format, TranscriptFormat::PlainText);
        assert_eq!(decoded.frames, 0);
        assert_eq!(
            decoded.lines.len(),
            2,
            "the empty line between them is dropped"
        );
        assert!(!decoded.torn);
        assert_eq!(decoded.readable_bytes, buffer.len());
        assert_eq!(decoded.format.as_str(), "plain-text");
    }

    #[test]
    fn an_empty_buffer_is_an_empty_plain_transcript() {
        let decoded = decode_transcript(&[]);
        assert_eq!(decoded.format, TranscriptFormat::PlainText);
        assert!(decoded.lines.is_empty());
        assert!(!decoded.torn);
        assert_eq!(decoded.readable_bytes, 0);
    }

    #[test]
    fn a_line_of_multi_byte_text_survives_the_round_trip() {
        let line = r#"{"text":"remember the word loom — 项目 😀"}"#;
        let frame = encode_frame(&format!("{line}\n"));
        let decoded = decode_transcript(&frame);
        assert_eq!(decoded.lines, vec![line.to_string()]);
    }
}
