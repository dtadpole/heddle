/**
 * The name a downloaded session log is filed under.
 *
 * DSH puts `Download session log` in its session header, so the download is part of the session-management surface
 * this repository is matching. A download needs a filename, and the only free text that can go into one is the
 * session's title — which a person types, so it can hold a slash, a quote, a newline or a colon that a filesystem or a
 * header will object to. This turns it into something safe, and falls back to the id when there is no title worth
 * using.
 */
export function logFileName(title: string | undefined, id: string): string {
  const source = (title ?? '').trim().length > 0 ? title!.trim() : id
  /**
   * Keep letters, digits, spaces, and a small set of separators; replace everything else with a dash. This is
   * deliberately conservative: a filename is a boundary that a person's text should not be able to cross, and
   * `Content-Disposition` is a header where a quote or a newline is a real hazard.
   */
  const safe = source
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .replace(/^[.\s-]+|[.\s-]+$/g, '')
  return `${safe.length > 0 ? safe : id}.jsonl`
}
