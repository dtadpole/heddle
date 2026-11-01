//! The bounded output ring behind one job: chunks at absolute UTF-8 byte offsets, head eviction that never moves an
//! assigned offset, and non-consuming reads from any offset.
//!
//! A port of `src/jobs/ring.ts`, which is DSH's `OutputRing` (`dsh-jobs-local/lib/index.js:163-265`). `total`
//! counts every byte ever appended and is the offset the next chunk starts at; `earliest` is the offset of the oldest
//! byte still held and only ever advances. A read below `earliest` is not an error: it answers what is left with
//! `lossy: true`.

use serde::Serialize;

/// Where a chunk came from. `log` is producer narration for observers; the model never reads it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum JobChannel {
    Stdout,
    Stderr,
    Log,
}

/// How a producer labels one appended chunk.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct AppendOptions {
    pub channel: Option<JobChannel>,
    /// Bytes before this chunk were lost on the producer's side.
    pub gap_before: Option<bool>,
}

impl AppendOptions {
    /// A chunk on `channel`.
    pub fn channel(channel: JobChannel) -> Self {
        Self {
            channel: Some(channel),
            gap_before: None,
        }
    }
}

/// One chunk as a reader receives it: a fresh copy, never the ring's own record. Serialized as `{at, text,
/// channel?, gapBefore?}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobChunk {
    /// Absolute UTF-8 byte offset of the chunk's first byte.
    pub at: u64,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel: Option<JobChannel>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gap_before: Option<bool>,
}

/// A read from an offset: the chunks overlapping `[from, total)`, the resume offset, and whether bytes were evicted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RingRead {
    pub chunks: Vec<JobChunk>,
    pub next: u64,
    pub lossy: bool,
}

#[derive(Debug, Clone)]
struct StoredChunk {
    at: u64,
    text: String,
    channel: Option<JobChannel>,
    gap_before: Option<bool>,
}

impl StoredChunk {
    fn bytes(&self) -> u64 {
        self.text.len() as u64
    }
}

/// The UTF-8-safe tail of `text` no longer than `max_bytes`: the cut advances past continuation bytes, so the
/// surviving text never starts inside a code point (DSH's `utf8Tail`). Answers the tail and its byte length.
pub fn utf8_tail(text: &str, max_bytes: usize) -> (&str, usize) {
    let raw = text.as_bytes();
    let mut start = raw.len().saturating_sub(max_bytes);
    while start < raw.len() && (raw[start] & 0xc0) == 0x80 {
        start += 1;
    }
    let tail = &text[start..];
    (tail, tail.len())
}

/// The ring.
#[derive(Debug, Clone, Default)]
pub struct OutputRing {
    chunks: std::collections::VecDeque<StoredChunk>,
    /// Sum of the retained chunks' byte lengths.
    retained_bytes: u64,
    /// Total UTF-8 bytes ever appended: the offset the next chunk starts at.
    pub total: u64,
    /// Offset of the oldest retained byte; equals `total` when nothing is retained.
    pub earliest: u64,
}

impl OutputRing {
    /// An empty ring.
    pub fn new() -> Self {
        Self::default()
    }

    /// Append one chunk and trim the head to `cap`. Answers false for an empty chunk, which changes nothing and
    /// wakes no observer.
    pub fn append(&mut self, text: &str, options: AppendOptions, cap: u64) -> bool {
        if text.is_empty() {
            return false;
        }
        let bytes = text.len() as u64;
        self.chunks.push_back(StoredChunk {
            at: self.total,
            text: text.to_owned(),
            channel: options.channel,
            gap_before: options.gap_before,
        });
        self.total += bytes;
        self.retained_bytes += bytes;
        self.trim(cap);
        true
    }

    /// Drop whole head chunks until the ring fits `cap`; a single oversized chunk keeps only its UTF-8-safe tail,
    /// marked `gapBefore`.
    pub fn trim(&mut self, cap: u64) {
        while self.retained_bytes > cap && self.chunks.len() > 1 {
            let Some(dropped) = self.chunks.pop_front() else {
                break;
            };
            self.retained_bytes -= dropped.bytes();
        }
        if self.chunks.len() == 1 {
            let single = &mut self.chunks[0];
            if single.bytes() > cap {
                let before = single.bytes();
                let cut = usize::try_from(cap).unwrap_or(usize::MAX);
                let (tail, tail_bytes) = utf8_tail(&single.text, cut);
                let tail = tail.to_owned();
                single.at += before - tail_bytes as u64;
                single.text = tail;
                single.gap_before = Some(true);
                self.retained_bytes = tail_bytes as u64;
            }
        }
        self.earliest = self.chunks.front().map_or(self.total, |chunk| chunk.at);
    }

    /// The retained chunks overlapping `[from, total)`, as fresh copies. Never moves anything.
    pub fn read_from(&self, from: u64) -> RingRead {
        let chunks = self
            .chunks
            .iter()
            .filter(|chunk| chunk.at + chunk.bytes() > from)
            .map(|chunk| JobChunk {
                at: chunk.at,
                text: chunk.text.clone(),
                channel: chunk.channel,
                gap_before: chunk.gap_before,
            })
            .collect();
        RingRead {
            chunks,
            next: self.total,
            lossy: from < self.earliest,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chunk(at: u64, text: &str, channel: Option<JobChannel>, gap: Option<bool>) -> JobChunk {
        JobChunk {
            at,
            text: text.into(),
            channel,
            gap_before: gap,
        }
    }

    #[test]
    fn the_ring_keeps_absolute_utf8_byte_offsets_across_appends() {
        let mut ring = OutputRing::new();
        ring.append("ab", AppendOptions::channel(JobChannel::Stdout), 100);
        ring.append("é", AppendOptions::channel(JobChannel::Stderr), 100);
        ring.append("c", AppendOptions::default(), 100);
        assert_eq!(ring.total, 5, "\"é\" is two bytes");
        assert_eq!(
            ring.read_from(0).chunks,
            [
                chunk(0, "ab", Some(JobChannel::Stdout), None),
                chunk(2, "é", Some(JobChannel::Stderr), None),
                chunk(4, "c", None, None),
            ]
        );
        assert_eq!(
            ring.read_from(3)
                .chunks
                .iter()
                .map(|chunk| chunk.at)
                .collect::<Vec<_>>(),
            [2, 4],
            "a chunk overlapping the offset is returned whole"
        );
        assert!(ring.read_from(5).chunks.is_empty());
        assert_eq!(ring.read_from(5).next, 5);
        assert!(
            !ring.append("", AppendOptions::default(), 100),
            "an empty chunk changes nothing"
        );
        assert_eq!(
            serde_json::to_string(&ring.read_from(0).chunks).unwrap(),
            r#"[{"at":0,"text":"ab","channel":"stdout"},{"at":2,"text":"é","channel":"stderr"},{"at":4,"text":"c"}]"#
        );
    }

    #[test]
    fn the_ring_drops_whole_head_chunks_past_its_cap_and_a_read_below_earliest_is_lossy() {
        let mut ring = OutputRing::new();
        ring.append("aaaa", AppendOptions::default(), 10);
        ring.append("bbbb", AppendOptions::default(), 10);
        ring.append("cccc", AppendOptions::default(), 10);
        assert_eq!(ring.total, 12);
        assert_eq!(
            ring.earliest, 4,
            "the oldest whole chunk went; offsets did not move"
        );
        let read = ring.read_from(0);
        assert!(read.lossy);
        assert_eq!(
            read.chunks
                .iter()
                .map(|chunk| (chunk.at, chunk.text.as_str()))
                .collect::<Vec<_>>(),
            [(4, "bbbb"), (8, "cccc")]
        );
        assert!(!ring.read_from(4).lossy);
    }

    #[test]
    fn an_oversized_chunk_keeps_a_utf8_safe_tail_marked_gap_before() {
        let mut ring = OutputRing::new();
        ring.append("xé€", AppendOptions::default(), 4);
        // x(1) é(2) €(3) = 6 bytes; the last 4 bytes start inside "é", so the cut moves to "€" (3 bytes).
        assert_eq!(ring.read_from(0).chunks, [chunk(3, "€", None, Some(true))]);
        assert_eq!(ring.earliest, 3);
        assert_eq!(ring.total, 6);
        assert_eq!(utf8_tail("héllo", 4), ("llo", 3));
    }
}
