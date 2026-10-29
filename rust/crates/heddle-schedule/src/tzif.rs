//! The system time-zone database, read without a dependency: a TZif (v1, v2, v3) reader, the POSIX `TZ` rule in
//! its footer for instants after the last transition, and the lookup of a zone name in the database directory.
//!
//! The TypeScript build asks `Intl` (ICU's copy of the IANA data); this port reads the same IANA data from the
//! operating system's compiled files, `/usr/share/zoneinfo` unless `TZDIR` names another directory. A name is matched
//! against the directory listing **case-insensitively**, segment by segment, and answered in the database's own
//! spelling, so `asia/shanghai` is `Asia/Shanghai`, as `Intl` answers it. The `posix/` and `right/` trees some systems
//! ship are not zone names (`Intl` refuses them), and a file that is not TZif is not a zone.
//!
//! RFC 8536 is the reference: before the first transition the first time type applies; after the last one, the
//! footer's rule does, when there is one.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use crate::time::{days_from_civil, days_in_month, is_leap_year, year_of_epoch_day};

/// One zone's compiled data: transitions (seconds since the epoch, ascending), the type each starts, each type's
/// UTC offset in seconds, and the footer rule.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TimeZoneData {
    transitions: Vec<i64>,
    indices: Vec<usize>,
    offsets: Vec<i64>,
    footer: Option<PosixTz>,
}

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, count: usize) -> Result<&'a [u8], String> {
        let end = self
            .at
            .checked_add(count)
            .filter(|end| *end <= self.bytes.len())
            .ok_or_else(|| "the TZif data is truncated".to_owned())?;
        let slice = &self.bytes[self.at..end];
        self.at = end;
        Ok(slice)
    }

    fn u32(&mut self) -> Result<usize, String> {
        let bytes = self.take(4)?;
        Ok(u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize)
    }

    fn i32(&mut self) -> Result<i64, String> {
        let bytes = self.take(4)?;
        Ok(i64::from(i32::from_be_bytes([
            bytes[0], bytes[1], bytes[2], bytes[3],
        ])))
    }

    fn i64(&mut self) -> Result<i64, String> {
        let bytes = self.take(8)?;
        let mut array = [0u8; 8];
        array.copy_from_slice(bytes);
        Ok(i64::from_be_bytes(array))
    }
}

/// The six counts of a TZif header, in file order.
struct Header {
    version: u8,
    isutcnt: usize,
    isstdcnt: usize,
    leapcnt: usize,
    timecnt: usize,
    typecnt: usize,
    charcnt: usize,
}

fn header(reader: &mut Reader<'_>) -> Result<Header, String> {
    if reader.take(4)? != b"TZif" {
        return Err("not a TZif file".to_owned());
    }
    let version = reader.take(1)?[0];
    reader.take(15)?;
    Ok(Header {
        version,
        isutcnt: reader.u32()?,
        isstdcnt: reader.u32()?,
        leapcnt: reader.u32()?,
        timecnt: reader.u32()?,
        typecnt: reader.u32()?,
        charcnt: reader.u32()?,
    })
}

impl TimeZoneData {
    /// Parse a TZif file. The 64-bit block of a version 2 or 3 file is read in preference to the 32-bit one.
    pub fn parse(bytes: &[u8]) -> Result<Self, String> {
        let mut reader = Reader { bytes, at: 0 };
        let first = header(&mut reader)?;
        let wide = first.version >= b'2';
        if wide {
            let skip = first.timecnt * 5
                + first.typecnt * 6
                + first.charcnt
                + first.leapcnt * 8
                + first.isstdcnt
                + first.isutcnt;
            reader.take(skip)?;
            let second = header(&mut reader)?;
            Self::block(&mut reader, &second, true)
        } else {
            Self::block(&mut reader, &first, false)
        }
    }

    fn block(reader: &mut Reader<'_>, header: &Header, wide: bool) -> Result<Self, String> {
        if header.typecnt == 0 {
            return Err("a TZif block declares no time types".to_owned());
        }
        let mut transitions = Vec::with_capacity(header.timecnt);
        for _ in 0..header.timecnt {
            transitions.push(if wide { reader.i64()? } else { reader.i32()? });
        }
        let indices: Vec<usize> = reader
            .take(header.timecnt)?
            .iter()
            .map(|index| usize::from(*index))
            .collect();
        if indices.iter().any(|index| *index >= header.typecnt) {
            return Err("a transition names a time type that does not exist".to_owned());
        }
        let mut offsets = Vec::with_capacity(header.typecnt);
        for _ in 0..header.typecnt {
            offsets.push(reader.i32()?);
            reader.take(2)?;
        }
        reader.take(header.charcnt)?;
        reader.take(header.leapcnt * if wide { 12 } else { 8 })?;
        reader.take(header.isstdcnt + header.isutcnt)?;
        let footer = if wide {
            let rest = &reader.bytes[reader.at..];
            match rest.strip_prefix(b"\n") {
                Some(text) => {
                    let end = text.iter().position(|byte| *byte == b'\n').unwrap_or(text.len());
                    let rule = std::str::from_utf8(&text[..end])
                        .map_err(|_| "the TZif footer is not text".to_owned())?;
                    if rule.is_empty() {
                        None
                    } else {
                        Some(PosixTz::parse(rule)?)
                    }
                }
                None => None,
            }
        } else {
            None
        };
        Ok(Self {
            transitions,
            indices,
            offsets,
            footer,
        })
    }

    /// The UTC offset (local minus UTC) at an instant, in seconds.
    pub fn offset_at(&self, seconds: i64) -> i64 {
        let Some(first) = self.transitions.first() else {
            return match &self.footer {
                Some(footer) => footer.offset_at(seconds),
                None => self.offsets[0],
            };
        };
        if seconds < *first {
            return self.offsets[0];
        }
        let index = self.transitions.partition_point(|at| *at <= seconds) - 1;
        if index + 1 == self.transitions.len()
            && let Some(footer) = &self.footer
        {
            return footer.offset_at(seconds);
        }
        self.offsets[self.indices[index]]
    }
}

/// A date a POSIX rule names in each year.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RuleDate {
    /// `Jn`: day 1-365, February 29 never counted.
    Julian(i64),
    /// `n`: day 0-365, February 29 counted.
    Ordinal(i64),
    /// `Mm.w.d`: weekday `d` (0 Sunday) of week `w` (5 the last) of month `m`.
    Month { month: u32, week: i64, weekday: i64 },
}

impl RuleDate {
    /// The epoch day this rule names in `year`.
    fn epoch_day(self, year: i64) -> i64 {
        let january = days_from_civil(year, 1, 1);
        match self {
            Self::Julian(day) => {
                january + day - 1 + i64::from(is_leap_year(year) && day >= 60)
            }
            Self::Ordinal(day) => january + day,
            Self::Month {
                month,
                week,
                weekday,
            } => {
                let first = days_from_civil(year, month, 1);
                let first_weekday = (first + 4).rem_euclid(7);
                let mut day = 1 + (weekday - first_weekday).rem_euclid(7) + (week - 1) * 7;
                let last = i64::from(days_in_month(year, month));
                while day > last {
                    day -= 7;
                }
                first + day - 1
            }
        }
    }
}

/// The daylight-saving half of a POSIX rule.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct DstRule {
    offset: i64,
    start: (RuleDate, i64),
    end: (RuleDate, i64),
}

/// A POSIX `TZ` rule, as a TZif footer carries it: a standard offset and an optional daylight-saving rule.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PosixTz {
    standard: i64,
    dst: Option<DstRule>,
}

struct RuleParser<'a> {
    text: &'a [u8],
    at: usize,
}

impl RuleParser<'_> {
    fn peek(&self) -> Option<u8> {
        self.text.get(self.at).copied()
    }

    fn done(&self) -> bool {
        self.at >= self.text.len()
    }

    fn name(&mut self) -> Result<(), String> {
        if self.peek() == Some(b'<') {
            let close = self.text[self.at..]
                .iter()
                .position(|byte| *byte == b'>')
                .ok_or_else(|| "an unterminated quoted zone abbreviation".to_owned())?;
            self.at += close + 1;
            return Ok(());
        }
        let start = self.at;
        while self.peek().is_some_and(|byte| byte.is_ascii_alphabetic()) {
            self.at += 1;
        }
        if self.at == start {
            return Err("a POSIX TZ rule needs a zone abbreviation".to_owned());
        }
        Ok(())
    }

    fn number(&mut self) -> Result<i64, String> {
        let start = self.at;
        while self.peek().is_some_and(|byte| byte.is_ascii_digit()) {
            self.at += 1;
        }
        std::str::from_utf8(&self.text[start..self.at])
            .ok()
            .and_then(|digits| digits.parse::<i64>().ok())
            .ok_or_else(|| "a POSIX TZ rule needs a number".to_owned())
    }

    /// `[+-]hh[:mm[:ss]]` in seconds.
    fn clock(&mut self) -> Result<i64, String> {
        let sign = match self.peek() {
            Some(b'-') => {
                self.at += 1;
                -1
            }
            Some(b'+') => {
                self.at += 1;
                1
            }
            _ => 1,
        };
        let mut seconds = self.number()? * 3600;
        for scale in [60, 1] {
            if self.peek() != Some(b':') {
                break;
            }
            self.at += 1;
            seconds += self.number()? * scale;
        }
        Ok(sign * seconds)
    }

    fn date(&mut self) -> Result<RuleDate, String> {
        match self.peek() {
            Some(b'J') => {
                self.at += 1;
                Ok(RuleDate::Julian(self.number()?))
            }
            Some(b'M') => {
                self.at += 1;
                let month = self.number()?;
                self.expect(b'.')?;
                let week = self.number()?;
                self.expect(b'.')?;
                let weekday = self.number()?;
                if !(1..=12).contains(&month) || !(1..=5).contains(&week) || !(0..=6).contains(&weekday) {
                    return Err("a POSIX TZ month rule is out of range".to_owned());
                }
                Ok(RuleDate::Month {
                    month: month as u32,
                    week,
                    weekday,
                })
            }
            _ => Ok(RuleDate::Ordinal(self.number()?)),
        }
    }

    fn expect(&mut self, byte: u8) -> Result<(), String> {
        if self.peek() == Some(byte) {
            self.at += 1;
            Ok(())
        } else {
            Err(format!("a POSIX TZ rule expected '{}'", byte as char))
        }
    }

    fn transition(&mut self) -> Result<(RuleDate, i64), String> {
        let date = self.date()?;
        let time = if self.peek() == Some(b'/') {
            self.at += 1;
            self.clock()?
        } else {
            7200
        };
        Ok((date, time))
    }
}

impl PosixTz {
    /// Parse a rule such as `PST8PDT,M3.2.0,M11.1.0` or `<+0545>-5:45`.
    pub fn parse(rule: &str) -> Result<Self, String> {
        let mut parser = RuleParser {
            text: rule.as_bytes(),
            at: 0,
        };
        parser.name()?;
        // POSIX offsets are west of Greenwich; a UTC offset is east.
        let standard = -parser.clock()?;
        if parser.done() {
            return Ok(Self {
                standard,
                dst: None,
            });
        }
        parser.name()?;
        let offset = if parser.done() || parser.peek() == Some(b',') {
            standard + 3600
        } else {
            -parser.clock()?
        };
        let (start, end) = if parser.peek() == Some(b',') {
            parser.at += 1;
            let start = parser.transition()?;
            parser.expect(b',')?;
            let end = parser.transition()?;
            (start, end)
        } else {
            // POSIX leaves the default to the implementation; tzcode's is the United States rule.
            (
                (
                    RuleDate::Month {
                        month: 3,
                        week: 2,
                        weekday: 0,
                    },
                    7200,
                ),
                (
                    RuleDate::Month {
                        month: 11,
                        week: 1,
                        weekday: 0,
                    },
                    7200,
                ),
            )
        };
        if !parser.done() {
            return Err(format!("trailing text in the POSIX TZ rule {rule:?}"));
        }
        Ok(Self {
            standard,
            dst: Some(DstRule { offset, start, end }),
        })
    }

    /// The UTC offset at an instant under this rule, in seconds.
    pub fn offset_at(&self, seconds: i64) -> i64 {
        let Some(dst) = self.dst else {
            return self.standard;
        };
        let year = year_of_epoch_day((seconds + self.standard).div_euclid(86_400));
        // The start is written in standard time and the end in daylight time.
        let start = dst.start.0.epoch_day(year) * 86_400 + dst.start.1 - self.standard;
        let end = dst.end.0.epoch_day(year) * 86_400 + dst.end.1 - dst.offset;
        let daylight = if start < end {
            start <= seconds && seconds < end
        } else {
            !(end <= seconds && seconds < start)
        };
        if daylight { dst.offset } else { self.standard }
    }
}

/// The database directory: `TZDIR` when it names one, else `/usr/share/zoneinfo`.
pub fn zoneinfo_dir() -> PathBuf {
    match std::env::var_os("TZDIR") {
        Some(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => PathBuf::from("/usr/share/zoneinfo"),
    }
}

/// A zone found in the database: its spelling there and its data.
pub type Zone = (String, Arc<TimeZoneData>);

type Lookups = HashMap<(PathBuf, String), Option<Zone>>;

fn cache() -> &'static Mutex<Lookups> {
    static CACHE: OnceLock<Mutex<Lookups>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Look a zone name up in the database: its canonical spelling and data, or `None` when there is no such zone.
pub fn lookup(name: &str) -> Option<Zone> {
    let dir = zoneinfo_dir();
    let key = (dir.clone(), name.to_owned());
    if let Some(found) = cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(&key)
    {
        return found.clone();
    }
    let found = find(&dir, name);
    cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(key, found.clone());
    found
}

fn find(dir: &Path, name: &str) -> Option<Zone> {
    let segments: Vec<&str> = name.split('/').collect();
    let first = segments.first()?;
    if first.eq_ignore_ascii_case("posix") || first.eq_ignore_ascii_case("right") {
        return None;
    }
    let mut current = dir.to_path_buf();
    let mut spelled: Vec<String> = Vec::with_capacity(segments.len());
    for (index, segment) in segments.iter().enumerate() {
        let mut entries: Vec<String> = std::fs::read_dir(&current)
            .ok()?
            .filter_map(|entry| entry.ok())
            .filter_map(|entry| entry.file_name().into_string().ok())
            .collect();
        entries.sort();
        let entry = entries
            .iter()
            .find(|entry| entry.as_str() == *segment)
            .or_else(|| entries.iter().find(|entry| entry.eq_ignore_ascii_case(segment)))?
            .clone();
        current = current.join(&entry);
        let metadata = std::fs::metadata(&current).ok()?;
        let last = index + 1 == segments.len();
        if last && !metadata.is_file() || !last && !metadata.is_dir() {
            return None;
        }
        spelled.push(entry);
    }
    let bytes = std::fs::read(&current).ok()?;
    let data = TimeZoneData::parse(&bytes).ok()?;
    Some((spelled.join("/"), Arc::new(data)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn zone(name: &str) -> Arc<TimeZoneData> {
        lookup(name).unwrap_or_else(|| panic!("{name} is in the system database")).1
    }

    #[test]
    fn known_offsets_come_from_the_system_database() {
        // 2026-07-15T12:00:00Z and 2026-01-15T12:00:00Z.
        let july = 1_784_116_800;
        let january = 1_768_478_400;
        assert_eq!(zone("Asia/Shanghai").offset_at(july), 8 * 3600);
        assert_eq!(zone("Asia/Shanghai").offset_at(january), 8 * 3600);
        assert_eq!(zone("America/Los_Angeles").offset_at(july), -7 * 3600);
        assert_eq!(zone("America/Los_Angeles").offset_at(january), -8 * 3600);
        assert_eq!(zone("Asia/Kolkata").offset_at(july), 5 * 3600 + 1800);
        assert_eq!(zone("Australia/Lord_Howe").offset_at(january), 11 * 3600);
        assert_eq!(zone("Australia/Lord_Howe").offset_at(july), 10 * 3600 + 1800);
    }

    #[test]
    fn the_footer_rule_answers_after_the_last_transition() {
        // 2200 is past any compiled transition.
        let july = days_from_civil(2200, 7, 1) * 86_400 + 43_200;
        let january = days_from_civil(2200, 1, 15) * 86_400 + 43_200;
        assert_eq!(zone("America/Los_Angeles").offset_at(july), -7 * 3600);
        assert_eq!(zone("America/Los_Angeles").offset_at(january), -8 * 3600);
        let rule = PosixTz::parse("AEST-10AEDT,M10.1.0,M4.1.0/3").unwrap();
        assert_eq!(rule.offset_at(1_768_478_400), 11 * 3600, "January is summer in Sydney");
        assert_eq!(rule.offset_at(1_784_116_800), 10 * 3600);
        assert_eq!(PosixTz::parse("<+0545>-5:45").unwrap().offset_at(0), 5 * 3600 + 45 * 60);
        assert_eq!(
            PosixTz::parse("EST5EDT,0/0,J365/25").unwrap().offset_at(1_784_116_800),
            -4 * 3600,
            "the all-year daylight trick"
        );
    }

    #[test]
    fn before_the_first_transition_the_first_type_applies() {
        // 0001-01-01T00:00:00Z: Los Angeles' local mean time.
        assert_eq!(
            zone("America/Los_Angeles").offset_at(-62_135_596_800),
            -(7 * 3600 + 52 * 60 + 58)
        );
    }

    #[test]
    fn names_match_case_insensitively_and_answer_the_database_spelling() {
        assert_eq!(lookup("asia/shanghai").unwrap().0, "Asia/Shanghai");
        assert_eq!(lookup("AMERICA/LOS_ANGELES").unwrap().0, "America/Los_Angeles");
        assert!(lookup("Mars/Phobos").is_none());
        assert!(lookup("Asia/../Asia/Shanghai").is_none(), "no path traversal");
        assert!(lookup("Asia").is_none(), "a directory is not a zone");
    }

    #[test]
    fn a_file_that_is_not_tzif_is_refused() {
        assert!(TimeZoneData::parse(b"not a zone").is_err());
        assert!(TimeZoneData::parse(b"TZif2").is_err());
    }
}
