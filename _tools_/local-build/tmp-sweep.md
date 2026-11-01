---
title: TMPDIR sweep
created: 2026-10-29T14:25:54Z
modified: 2026-10-31T12:45:00Z
level: L2
version: 1.2.0
description: What tmp-sweep removes from the user TMPDIR after a gate, what it keeps, and why. It covers the seven kinds of leftovers, the two-hour age, live browser profiles, the line of what TMPDIR still holds, and the npm and uv cache sizes it reports but never removes.
status: unverified
grounded_in:
  - source: 'coordinator request 2026-10-31 12:14Z: sweep testers'' Chrome profiles (hd*-live-profile*, *-chrome-profile*; 99 hd5-live-profile-* folders held 4.1 GB) and print TMPDIR''s five largest entries'
  - source: 'tool-developer, 2026-10-31 12:30Z: 30,018 hidden .com.google.Chrome.XXXXXX files held 5.3 GiB in TMPDIR, unmatched by com.google.Chrome*; their manifests name Google Docs Offline and Chrome Web Store Payments, the default apps a fresh profile downloads'
  - source: 'coordinator request 2026-10-31 04:02Z: the coordinator cleared the npm cache (2 GB) to stay above 20 GiB; report the npm and uv cache sizes, not delete them'
  - source: 'coordinator request 2026-10-29: the user TMPDIR held 41,000 entries (16,000 heddle-* test dirs, 24,000 com.google.Chrome*, hd-*-browser-* profiles of 130 MB); add a tmp-sweep seats run after a gate'
---

# TMPDIR sweep

Tests and browser runs leave scratch entries in the user TMPDIR (`/var/folders/.../T`). On 29 October it held
41,000 entries. Run `_tools_/local-build/tmp-sweep` after a gate. It removes seven kinds of entry once they are
older than two hours:
- `heddle-*`: unit, server and verifier scratch folders;
- `hd-*-browser-*`: browser profiles from seats' own runs, about 130 MB each;
- `hd*-live-profile*` and `*-chrome-profile*`: testers' Chrome profiles. On 31 October, 99 `hd5-live-profile-*`
  folders held 4.1 GB;
- `scoped_dir*` and `com.google.Chrome*`: what Chrome itself leaves;
- `.com.google.Chrome*`: Chrome's hidden download files.

The hidden files are Chrome's default apps, Google Docs Offline and Chrome Web Store Payments. A fresh profile
downloads them in its first seconds, to the user TMPDIR whatever `$TMPDIR` says. A browser killed before the install
finishes leaves the download behind, and the checks that SIGKILL their browser added about 1,800 an hour. On
31 October 30,018 of them held 5.3 GiB. browser-use now starts Chrome with `--disable-default-apps`, so new ones
should stop. The kind stays for browsers started some other way.

It keeps two kinds:
- **Young entries.** An entry's age is the newest mtime of the entry and its direct children, so a folder still
  being written is young.
- **Live entries.** An entry named on a running process's command line is kept, such as a browser's
  `--user-data-dir`.

After the sweep it prints one line of what the folder still holds: its total, its entry count and its five largest
entries, folders and files alike. A leak of one large entry shows in the list. A leak of many small ones, like the
hidden Chrome files, shows as a total far above the five, and a count in the tens of thousands:

```
tmp-sweep: /var/folders/.../T holds 5.5 GiB in 37981 entries; largest: 12 MiB dsh-workspace-changes-cDMkGg, ...
```

One `du -k -d 1` sizes the folders and the total, and lstat sizes the files, since macOS `du` cannot combine
`-a` with `-d`. It took 3 s on 38,000 entries. When du prints no total, the line says `sizes unknown (du failed)`.

It also reports two caches by size, and never removes anything in them:
- the **npm cache**, `$npm_config_cache` or `~/.npm`;
- the **uv cache**, `$UV_CACHE_DIR`, or `uv` under `$XDG_CACHE_HOME` or `~/.cache`.

On 31 October they held 347 MiB and 2.1 GiB. Clearing one is the coordinator's call (`npm cache clean --force`,
`uv cache prune`), since every seat would refill it.

`--dry-run` lists only, `--age-minutes n` changes the age, `--dir` sweeps another folder, and `--no-caches` skips
the cache sizes. It exits 0, or 1
when an entry could not be removed (the first ten errors are printed), or 64 on a usage error.

The sweep treats the symptom. The cause is code that never removes its scratch folder: a test should remove
it in an `after` hook or a `finally`, so that a failing test removes it too.
