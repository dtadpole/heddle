//! Stopping a command means stopping everything it started.
//!
//! The shell a tool launches (`/bin/sh -c …`, wrapped or not in a kernel runner) forks the command's own processes.
//! Signalling only the shell re-parents them to init, and they keep running after a Stop or a timeout: live-testing
//! draft developer-five-5 watched `sleep 37` outlive its Stop on both builds, and the TypeScript turn wait for it.
//! DSH spawns each child detached, as the leader of its own process group, and signals the group
//! (`dsh-subprocess-local`: `signalChildGroup` sends the signal to `-child.pid`). A launcher here starts its child the
//! same way (`process_group(0)`; `detached: true` in the TypeScript twin, `src/sandbox/process-group.ts`) and stops
//! it with [`kill_process_group`].

use std::io;

/// Send `SIGKILL` to every process in the group that `leader` leads.
///
/// `leader` is the pid of a child started as the leader of its own process group. The two values that cannot be
/// such a leader are refused rather than signalled, because `kill(-pid)` gives them a meaning nobody wants here: 0
/// is the caller's own group, and 1 is every process the caller may signal. A group that has already gone (`ESRCH`)
/// is success, since the caller only wanted it gone.
///
/// # Errors
///
/// `InvalidInput` for a pid of 0, 1 or beyond the platform's range; otherwise the operating system's refusal, such
/// as `EPERM` for a group the server may not signal.
#[cfg(unix)]
pub fn kill_process_group(leader: u32) -> io::Result<()> {
    use rustix::process::{Pid, Signal};

    let raw = i32::try_from(leader).map_err(|_| refused(leader))?;
    if raw <= 1 {
        return Err(refused(leader));
    }
    let group = Pid::from_raw(raw).ok_or_else(|| refused(leader))?;
    match rustix::process::kill_process_group(group, Signal::KILL) {
        Ok(()) | Err(rustix::io::Errno::SRCH) => Ok(()),
        Err(errno) => Err(errno.into()),
    }
}

/// Process groups are a Unix facility; elsewhere there is no group to signal, and the caller keeps its own fallback.
///
/// # Errors
///
/// Always `Unsupported`.
#[cfg(not(unix))]
pub fn kill_process_group(_leader: u32) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "process groups are a Unix facility",
    ))
}

#[cfg(unix)]
fn refused(leader: u32) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidInput,
        format!(
            "refusing to signal process group {leader}: it cannot lead a group a launcher started"
        ),
    )
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    /// Whether `pid` still names a live process (a zombie counts until its parent reaps it).
    fn alive(pid: i32) -> bool {
        let Some(pid) = rustix::process::Pid::from_raw(pid) else {
            return false;
        };
        rustix::process::test_kill_process(pid).is_ok()
    }

    #[test]
    fn the_two_pids_that_would_reach_every_process_are_refused() {
        for leader in [0, 1, u32::MAX] {
            let error = kill_process_group(leader).expect_err("refused");
            assert_eq!(
                error.kind(),
                io::ErrorKind::InvalidInput,
                "{leader}: {error}"
            );
        }
    }

    #[test]
    fn a_group_that_has_already_gone_is_not_an_error() {
        let mut child = Command::new("/bin/sh")
            .args(["-c", "exit 0"])
            .process_group(0)
            .spawn()
            .expect("a shell");
        let leader = child.id();
        child.wait().expect("it exits");
        kill_process_group(leader).expect("an empty group is already stopped");
    }

    #[test]
    fn killing_the_group_stops_the_shell_and_the_command_it_started() {
        // The shell starts a background `sleep`, prints its pid, and waits: the shape of `sleep 37; echo late`
        // that a Stop used to leave running, with the child's pid in hand to look for afterwards.
        let mut shell = Command::new("/bin/sh")
            .args(["-c", "sleep 41 & echo $!; wait"])
            .stdout(Stdio::piped())
            .process_group(0)
            .spawn()
            .expect("a shell");
        let mut line = String::new();
        BufReader::new(shell.stdout.take().expect("piped"))
            .read_line(&mut line)
            .expect("the child's pid");
        let child: i32 = line.trim().parse().expect("a pid");
        assert!(alive(child), "the command runs before the stop");

        kill_process_group(shell.id()).expect("the group is signalled");

        let status = shell.wait().expect("the shell ends");
        assert!(
            !status.success(),
            "the shell was killed, not finished: {status}"
        );
        let deadline = Instant::now() + Duration::from_secs(5);
        while alive(child) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(!alive(child), "the command the shell started is gone too");
    }
}
