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
    match frame_extent(buffer, start) {
        FrameExtent::End(end) => Some(end),
        FrameExtent::Short | FrameExtent::Malformed => None,
    }
}

/// Where one frame ends, or why it does not ([`frame_extent`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameExtent {
    /// The frame ends here.
    End(usize),
    /// The bytes stop inside a frame that is well formed so far: a torn tail, or a head not read far enough yet.
    Short,
    /// Not a frame: no magic where one must start, or a reserved block type.
    Malformed,
}

/// [`frame_end`] with its two `None`s apart, as `frameExtent` in `src/session/transcript.ts`: the header check
/// ([`judge_log_header`]) reads a torn first frame as a crash heddle repairs, and a malformed one as a file that is not
/// a log.
pub fn frame_extent(buffer: &[u8], start: usize) -> FrameExtent {
    let magic = FRAME_MAGIC.len().min(buffer.len().saturating_sub(start));
    if magic == 0 {
        return FrameExtent::Short;
    }
    if buffer[start..start + magic] != FRAME_MAGIC[..magic] {
        return FrameExtent::Malformed;
    }
    if magic < FRAME_MAGIC.len() {
        return FrameExtent::Short;
    }
    let mut cursor = start + 4;
    if cursor + 1 > buffer.len() {
        return FrameExtent::Short;
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
        return FrameExtent::Short;
    }

    loop {
        if cursor + 3 > buffer.len() {
            return FrameExtent::Short;
        }
        let header = u32::from(buffer[cursor])
            | (u32::from(buffer[cursor + 1]) << 8)
            | (u32::from(buffer[cursor + 2]) << 16);
        cursor += 3;
        let last_block = (header & 0x01) != 0;
        let block_type = (header >> 1) & 0x03;
        let block_size = header >> 3;
        if block_type == 3 {
            return FrameExtent::Malformed; // reserved
        }
        // An RLE block carries one byte whatever its declared size says.
        let payload = if block_type == 1 {
            1
        } else {
            block_size as usize
        };
        cursor += payload;
        if cursor > buffer.len() {
            return FrameExtent::Short;
        }
        if last_block {
            break;
        }
    }

    if checksum {
        cursor += 4;
    }
    if cursor > buffer.len() {
        FrameExtent::Short
    } else {
        FrameExtent::End(cursor)
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

/// What a log's first record says about whether the log can be read at all (`LogHeader` in
/// `src/session/transcript.ts`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LogHeader {
    /// A first record that is a session event, or nothing to judge yet: an empty file, or a first frame torn by a
    /// crash, which the store has always read as an empty session and cut back on the next write.
    Readable,
    /// The first record does not decode, is not JSON, or is not a session event; the reason says which.
    Unreadable(&'static str),
    /// The bytes given end before the first record does; read further and ask again.
    Incomplete,
}

/// Judge a log by its **first record**, the way DSH's JSONL backend judges a session by its header before it lists
/// it (`judgeLogHeader` in `src/session/transcript.ts`, word for word in its reasons).
///
/// DSH (dsh-session-persistence-jsonl README: "Unreadable or unsupported headers, including corrupt Zstandard header
/// frames, are omitted from discovery and `list()`") reads only the header frame (`readFirstZstdLine`,
/// lib/index.js:3378-3409): a frame that fails validation is corruption (:3403), a first line that is not JSON or not a
/// header is no header (`readGenerationHeader`, :3150-3156 and :3170), and `listArtifacts` leaves both out
/// (:3114-3127). A heddle log has no separate header line; its first record is the first event, judged with the shape
/// [`SessionEvent::from_line`](crate::SessionEvent::from_line) requires of every line. An empty file and a torn first
/// frame read as an empty session, as [`decode_transcript`] reads them.
pub fn judge_log_header(head: &[u8], at_end: bool) -> LogHeader {
    if looks_compressed(head) {
        let end = match frame_extent(head, 0) {
            FrameExtent::End(end) => end,
            FrameExtent::Short if at_end => return LogHeader::Readable,
            FrameExtent::Short => return LogHeader::Incomplete,
            FrameExtent::Malformed => {
                return LogHeader::Unreadable("its first zstd frame is malformed");
            }
        };
        let Some(text) = decode_frame(&head[..end]) else {
            return LogHeader::Unreadable("its first zstd frame does not decode");
        };
        return judge_first_line(text.split('\n').find(|line| !line.is_empty()).unwrap_or(""));
    }
    let start = head.iter().take_while(|byte| **byte == b'\n').count();
    if start == head.len() {
        return if at_end {
            LogHeader::Readable
        } else {
            LogHeader::Incomplete
        };
    }
    let newline = head[start..].iter().position(|byte| *byte == b'\n');
    if newline.is_none() && !at_end {
        return LogHeader::Incomplete;
    }
    let line = &head[start..newline.map_or(head.len(), |at| start + at)];
    judge_first_line(&String::from_utf8_lossy(line))
}

/// The first record's verdict: valid JSON, and a session event ([`is_event_record`]).
fn judge_first_line(line: &str) -> LogHeader {
    match serde_json::from_str::<serde_json::Value>(line) {
        Err(_) => LogHeader::Unreadable("its first record is not valid JSON"),
        Ok(record) if is_event_record(&record) => LogHeader::Readable,
        Ok(_) => LogHeader::Unreadable("its first record is not a session event"),
    }
}

/// Whether a parsed line has the shape every event the store writes has: a whole-number `seq`, a string `at` and a
/// string `type` — what [`SessionEvent::from_line`](crate::SessionEvent::from_line) requires.
pub fn is_event_record(record: &serde_json::Value) -> bool {
    record
        .get("seq")
        .and_then(serde_json::Value::as_u64)
        .is_some()
        && record.get("at").is_some_and(serde_json::Value::is_string)
        && record.get("type").is_some_and(serde_json::Value::is_string)
}

/// One whole frame that decoded, and its lines.
#[derive(Debug, Clone)]
struct ReadFrame {
    start: usize,
    end: usize,
    lines: Vec<String>,
}

/// A framed transcript read past the torn frames in its middle ([`recover_transcript`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecoveredTranscript {
    /// The lines of every frame kept, in order.
    pub lines: Vec<String>,
    /// The byte range of every frame kept, in order: the file a repair writes is these ranges, joined.
    pub kept: Vec<Frame>,
    /// The byte ranges left out, in order: each torn frame stepped over (with any frame its failed write left whole),
    /// and a torn tail.
    pub dropped: Vec<Frame>,
}

/// The lines of one frame's text, empty lines dropped, as [`decode_transcript`] splits them.
fn frame_lines(text: &str) -> Vec<String> {
    text.split('\n')
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect()
}

/// The whole, decodable frames from `start` on, and where the walk stopped.
fn walk_frames(buffer: &[u8], start: usize) -> (Vec<ReadFrame>, usize) {
    let mut frames = Vec::new();
    let mut cursor = start;
    while cursor < buffer.len() {
        let Some(end) = frame_end(buffer, cursor) else {
            break;
        };
        if end <= cursor {
            break;
        }
        let Some(text) = decode_frame(&buffer[cursor..end]) else {
            break;
        };
        frames.push(ReadFrame {
            start: cursor,
            end,
            lines: frame_lines(&text),
        });
        cursor = end;
    }
    (frames, cursor)
}

/// A line's `seq` when it is a session event ([`is_event_record`]), else `None`.
fn seq_of(line: &str) -> Option<u64> {
    let record = serde_json::from_str::<serde_json::Value>(line).ok()?;
    if !is_event_record(&record) {
        return None;
    }
    record.get("seq").and_then(serde_json::Value::as_u64)
}

/// The first place after `from` where whole frames start again: a frame magic whose frame walks whole, decodes (its
/// content checksum holds) and holds only session events, then every whole frame after it. `(start, frames, end)`.
fn resync(buffer: &[u8], from: usize) -> Option<(usize, Vec<ReadFrame>, usize)> {
    let mut at = from + 1;
    while at + FRAME_MAGIC.len() <= buffer.len() {
        let found = buffer[at..]
            .windows(FRAME_MAGIC.len())
            .position(|window| window == FRAME_MAGIC)?;
        let start = at + found;
        at = start + 1;
        let Some(end) = frame_end(buffer, start) else {
            continue;
        };
        let Some(text) = decode_frame(&buffer[start..end]) else {
            continue;
        };
        let lines = frame_lines(&text);
        if lines.is_empty() || !lines.iter().all(|line| seq_of(line).is_some()) {
            continue;
        }
        let (rest, stopped) = walk_frames(buffer, end);
        let mut frames = vec![ReadFrame { start, end, lines }];
        frames.extend(rest);
        return Some((start, frames, stopped));
    }
    None
}

/// Read a framed transcript **past a torn frame in its middle**, when whole frames follow it (#221); `None` when there
/// is nothing to step over — the log is whole, plain text, or torn only at its tail, which the store cuts as it always
/// has (J155). `recoverTranscript` in `src/session/transcript.ts`, keeping and dropping the same bytes.
///
/// A tear in the middle is what an append that failed part-way left before the rollback existed ([`crate::append`]):
/// its partial frame, then everything the process appended after the disk had room again. Cutting at the tear, right
/// for a crash, threw those turns away. Here the walk stops at the tear as before, then looks for the next frame magic
/// whose frame walks whole, decodes with its content checksum, and holds only session events, and goes on from there. A
/// false start is not a practical risk: four magic bytes, a frame header and block chain that walk to an end, a 32-bit
/// checksum over the content, and JSON lines with a whole-number `seq`, a string `at` and a string `type` must all hold
/// at once.
///
/// The sequence must also join. The writer never counted the event whose frame tore, so the first event after the tear
/// carries that event's seq, `s`, and the last event kept before it must be `s - 1`. A batch write (a fork's seed, the
/// turn closers) that tore part-way may have left its first frames whole; they carry `s`, `s + 1`, … and were never
/// counted either, so they are dropped with the torn frame. When the seqs do not join that way, the walk does not step
/// over that tear: from there on the bytes are a torn tail, as before.
pub fn recover_transcript(buffer: &[u8]) -> Option<RecoveredTranscript> {
    if !looks_compressed(buffer) {
        return None;
    }
    let (mut kept, mut cursor) = walk_frames(buffer, 0);
    let mut dropped = Vec::new();
    while cursor < buffer.len() {
        let Some((start, frames, end)) = resync(buffer, cursor) else {
            break;
        };
        let Some(resumed) = frames
            .first()
            .and_then(|frame| frame.lines.first())
            .and_then(|line| seq_of(line))
        else {
            break;
        };
        let mut orphans = kept.len();
        while orphans > 0 {
            let frame = &kept[orphans - 1];
            if frame.lines.is_empty()
                || !frame
                    .lines
                    .iter()
                    .all(|line| seq_of(line).is_some_and(|seq| seq >= resumed))
            {
                break;
            }
            orphans -= 1;
        }
        let consecutive = kept[orphans..]
            .iter()
            .flat_map(|frame| frame.lines.iter().map(|line| seq_of(line)))
            .enumerate()
            .all(|(index, seq)| seq == Some(resumed + index as u64));
        let last = (orphans > 0)
            .then(|| kept[orphans - 1].lines.last().and_then(|line| seq_of(line)))
            .flatten();
        let joins = if orphans == 0 {
            resumed == 0
        } else {
            resumed > 0 && last == Some(resumed - 1)
        };
        if !(joins && consecutive) {
            break;
        }
        let from = if orphans < kept.len() {
            kept[orphans].start
        } else {
            cursor
        };
        dropped.push(Frame {
            start: from,
            end: start,
        });
        kept.truncate(orphans);
        kept.extend(frames);
        cursor = end;
    }
    if dropped.is_empty() {
        return None;
    }
    if cursor < buffer.len() {
        dropped.push(Frame {
            start: cursor,
            end: buffer.len(),
        });
    }
    Some(RecoveredTranscript {
        lines: kept.iter().flat_map(|frame| frame.lines.clone()).collect(),
        kept: kept
            .iter()
            .map(|frame| Frame {
                start: frame.start,
                end: frame.end,
            })
            .collect(),
        dropped,
    })
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

/// Reading past a torn frame in the middle (#221), the same cases as `test/session-append-rollback.test.ts`.
#[cfg(test)]
mod recover_tests {
    use super::*;

    fn event(seq: u64, text: &str) -> Vec<u8> {
        encode_frame(&format!(
            "{{\"seq\":{seq},\"at\":\"2026-11-01T00:00:00.000Z\",\"type\":\"note\",\"text\":\"{text}\"}}\n"
        ))
    }

    fn joined(parts: &[&[u8]]) -> Vec<u8> {
        parts.concat()
    }

    fn texts(lines: &[String]) -> Vec<String> {
        lines
            .iter()
            .map(|line| {
                serde_json::from_str::<serde_json::Value>(line).unwrap()["text"]
                    .as_str()
                    .unwrap()
                    .to_owned()
            })
            .collect()
    }

    #[test]
    fn a_torn_frame_followed_by_whole_frames_is_stepped_over_and_they_are_kept() {
        let (e0, e1, torn) = (event(0, "t1"), event(1, "t2"), event(2, "t4 never saved"));
        let (e2, e3) = (event(2, "t6"), event(3, "t6 answer"));
        let half = &torn[..torn.len() / 2];
        let buffer = joined(&[&e0, &e1, half, &e2, &e3]);
        assert!(decode_transcript(&buffer).torn);
        let recovered = recover_transcript(&buffer).expect("whole frames follow the tear");
        assert_eq!(texts(&recovered.lines), ["t1", "t2", "t6", "t6 answer"]);
        let at = e0.len() + e1.len();
        assert_eq!(
            recovered.dropped,
            vec![Frame {
                start: at,
                end: at + half.len()
            }]
        );
        let kept: Vec<u8> = recovered
            .kept
            .iter()
            .flat_map(|frame| buffer[frame.start..frame.end].to_vec())
            .collect();
        assert_eq!(
            kept,
            joined(&[&e0, &e1, &e2, &e3]),
            "every frame kept is copied as it was"
        );
    }

    #[test]
    fn a_torn_tail_alone_is_left_to_the_cut() {
        let (e0, e1) = (event(0, "t1"), event(1, "t2"));
        let buffer = joined(&[&e0, &e1[..e1.len() - 3]]);
        assert!(
            recover_transcript(&buffer).is_none(),
            "J155: the store cuts it"
        );
        assert!(
            recover_transcript(&joined(&[&e0, &e1])).is_none(),
            "a whole log has nothing to step over"
        );
    }

    #[test]
    fn the_whole_frames_a_failed_batch_left_before_its_tear_are_dropped_with_it() {
        let (e0, e1) = (event(0, "t1"), event(1, "t2"));
        let (orphan, torn) = (event(2, "closer one"), event(3, "closer two"));
        let (e2, e3) = (event(2, "t6"), event(3, "t6 answer"));
        let half = &torn[..torn.len() / 2];
        let buffer = joined(&[&e0, &e1, &orphan, half, &e2, &e3]);
        let recovered = recover_transcript(&buffer).unwrap();
        assert_eq!(texts(&recovered.lines), ["t1", "t2", "t6", "t6 answer"]);
        let at = e0.len() + e1.len();
        assert_eq!(
            recovered.dropped,
            vec![Frame {
                start: at,
                end: at + orphan.len() + half.len()
            }]
        );
    }

    #[test]
    fn frames_whose_seqs_do_not_join_are_not_stepped_onto() {
        let (e0, e1, torn) = (event(0, "t1"), event(1, "t2"), event(2, "lost"));
        let stray = event(7, "from elsewhere");
        let buffer = joined(&[&e0, &e1, &torn[..torn.len() / 2], &stray]);
        assert!(
            recover_transcript(&buffer).is_none(),
            "the tear stays a tail, cut as before"
        );
    }

    #[test]
    fn a_magic_inside_the_torn_bytes_is_not_taken_for_a_frame() {
        let (e0, torn) = (event(0, "t1"), event(1, "lost"));
        let mut garbage = torn[..torn.len() / 2].to_vec();
        garbage.extend_from_slice(&FRAME_MAGIC);
        garbage.extend_from_slice(b"\x24\x00\x00\x01not a frame at all");
        let e1 = event(1, "t6");
        let buffer = joined(&[&e0, &garbage, &e1]);
        let recovered = recover_transcript(&buffer).unwrap();
        assert_eq!(texts(&recovered.lines), ["t1", "t6"]);
        assert_eq!(
            recovered.dropped[0].end - recovered.dropped[0].start,
            garbage.len()
        );
    }

    #[test]
    fn a_tear_after_the_last_run_is_dropped_as_a_tail() {
        let (e0, torn, e1, tail) = (
            event(0, "t1"),
            event(1, "lost"),
            event(1, "t6"),
            event(2, "cut"),
        );
        let buffer = joined(&[&e0, &torn[..10], &e1, &tail[..tail.len() - 2]]);
        let recovered = recover_transcript(&buffer).unwrap();
        assert_eq!(texts(&recovered.lines), ["t1", "t6"]);
        assert_eq!(recovered.dropped.len(), 2);
        assert_eq!(recovered.dropped[1].end, buffer.len());
    }
}
