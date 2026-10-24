//! Node's POSIX `path.extname` and `path.basename`, exactly.
//!
//! The renderer decision (`code.ts`), the image-type table (`attachments.ts`) and the upload name (`uploads.ts`) all
//! read an extension or a leaf with Node's rules, and those rules differ from `std::path` at the edges that matter
//! here: Node's `extname("file.")` is `"."` where `Path::extension` gives `Some("")`, and `extname("..foo")` is
//! `".foo"`. A renderer that disagreed about an edge would pick a different renderer than the TypeScript build for
//! the same file, so the algorithm is ported rather than approximated.

/// The extension of the last segment, with its dot — Node's `path.posix.extname`.
///
/// Empty when the segment has no dot, when its only dot leads it (`.bashrc`), and for `..`.
pub(crate) fn extname(path: &str) -> &str {
    let bytes = path.as_bytes();
    let mut start_dot: Option<usize> = None;
    let mut start_part = 0usize;
    let mut end: Option<usize> = None;
    let mut matched_slash = true;
    // 0: no non-dot seen before the last dot yet; 1: a dot run; -1: a non-dot character precedes the last dot.
    let mut pre_dot_state = 0i8;
    for index in (0..bytes.len()).rev() {
        let byte = bytes[index];
        if byte == b'/' {
            if !matched_slash {
                start_part = index + 1;
                break;
            }
            continue;
        }
        if end.is_none() {
            matched_slash = false;
            end = Some(index + 1);
        }
        if byte == b'.' {
            if start_dot.is_none() {
                start_dot = Some(index);
            } else if pre_dot_state != 1 {
                pre_dot_state = 1;
            }
        } else if start_dot.is_some() {
            pre_dot_state = -1;
        }
    }
    match (start_dot, end) {
        (Some(dot), Some(end))
            if pre_dot_state != 0
                && !(pre_dot_state == 1 && dot + 1 == end && dot == start_part + 1) =>
        {
            &path[dot..end]
        }
        _ => "",
    }
}

/// The last segment, with trailing separators ignored — Node's `path.posix.basename` without a suffix.
pub(crate) fn basename(path: &str) -> &str {
    let trimmed = path.trim_end_matches('/');
    match trimmed.rfind('/') {
        Some(at) => &trimmed[at + 1..],
        None => trimmed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extname_matches_node_on_ordinary_names() {
        assert_eq!(extname("/a/b/index.ts"), ".ts");
        assert_eq!(extname("archive.tar.gz"), ".gz");
        assert_eq!(extname("README.MD"), ".MD");
        assert_eq!(extname("/a/b.c/Makefile"), "");
    }

    #[test]
    fn extname_matches_node_at_the_edges() {
        // Each value is what Node 24 answers for `path.posix.extname`.
        assert_eq!(extname(".bashrc"), "");
        assert_eq!(extname("/home/me/.bashrc"), "");
        assert_eq!(extname(".."), "");
        assert_eq!(extname("."), "");
        assert_eq!(extname("file."), ".");
        assert_eq!(extname("..foo"), ".foo");
        assert_eq!(extname("a.txt/"), ".txt");
        assert_eq!(extname(""), "");
        assert_eq!(extname("/"), "");
    }

    #[test]
    fn basename_takes_the_last_segment() {
        assert_eq!(basename("/a/b/c.txt"), "c.txt");
        assert_eq!(basename("/a/b/"), "b");
        assert_eq!(basename("c.txt"), "c.txt");
        assert_eq!(basename("/"), "");
        assert_eq!(basename(""), "");
    }
}
