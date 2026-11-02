//! A process that wrote sessions leaves none of their writer locks behind when it ends (#248).
//!
//! The Rust build released a session's `<id>.lock` only in `Drop for SessionStore`, which no exit ran: a server stopped
//! by SIGTERM returned through its graceful close with the store still held by its spawned tasks, and the command line
//! returned from `main` with the store in the boot's services. Every lock file stayed on disk naming a dead pid (the
//! live 3097 store: 926 lock files, 782 naming dead pids), and once that pid named another process the session refused
//! every write. The TypeScript build lets go in its `exit` handler; DSH's flock dies with its holder
//! (dsh-session-persistence-jsonl lib/index.js:692-716, release :724-734).
//!
//! These run the real binary, the one this package builds, or the one `HEDDLE_BIN` names (how the red was judged on the
//! binary before the fix), against a scratch home with the scripted endpoint, as verifier 70 does.

#![cfg(unix)]

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// The binary under test: `HEDDLE_BIN` when set, else this package's own.
fn binary() -> PathBuf {
    match std::env::var("HEDDLE_BIN") {
        Ok(bin) if !bin.is_empty() => PathBuf::from(bin),
        _ => PathBuf::from(env!("CARGO_BIN_EXE_heddle")),
    }
}

/// The repository root, from this crate's directory.
fn repository() -> PathBuf {
    let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    path.pop(); // crates
    path.pop(); // rust
    path.pop(); // the repository root
    path
}

/// A scratch home with the scripted endpoint and a working folder, removed when it goes.
struct Home {
    home: PathBuf,
    work: PathBuf,
    config: PathBuf,
}

impl Home {
    fn new(label: &str) -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or(0);
        let home = std::env::temp_dir().join(format!(
            "heddle-locks-at-exit-{label}-{}-{}-{nanos}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let work = home.join("work");
        std::fs::create_dir_all(&work).unwrap();
        let script = home.join("script.json");
        std::fs::write(&script, r#"{"steps":[{"text":"a remembered answer"}]}"#).unwrap();
        let config = home.join("heddle.json");
        std::fs::write(
            &config,
            serde_json::json!({
                "default": "scripted",
                "endpoints": [{"name": "scripted", "kind": "scripted", "baseUrl": script, "model": "scripted"}],
            })
            .to_string(),
        )
        .unwrap();
        Home { home, work, config }
    }

    /// A command running the binary in this home: `--config <repository>/cordis.yml --session-root <home>/sessions`.
    fn command(&self, args: &[&str]) -> Command {
        let mut command = Command::new(binary());
        command
            .arg("--config")
            .arg(repository().join("cordis.yml"))
            .arg("--session-root")
            .arg(self.home.join("sessions"))
            .args(args)
            .current_dir(&self.work)
            .env("HEDDLE_HOME", &self.home)
            .env("HEDDLE_CONFIG", &self.config)
            .env("HOME", &self.home)
            .env("NO_COLOR", "1")
            .stdin(Stdio::null());
        command
    }

    /// Run the command line to its end: (exit code, stdout, stderr).
    fn run(&self, args: &[&str]) -> (Option<i32>, String, String) {
        let output = self.command(args).output().expect("the binary runs");
        (
            output.status.code(),
            String::from_utf8_lossy(&output.stdout).into_owned(),
            String::from_utf8_lossy(&output.stderr).into_owned(),
        )
    }

    /// A new session in the working folder, made by the command line: its id.
    fn new_session(&self) -> String {
        let work = self.work.to_string_lossy().into_owned();
        let (code, stdout, stderr) = self.run(&["session", "new", &work, "--json"]);
        assert_eq!(code, Some(0), "the session was created\n{stdout}{stderr}");
        let made: serde_json::Value =
            serde_json::from_str(stdout.trim()).expect("--json prints one object");
        made["session"].as_str().expect("it has an id").to_string()
    }

    /// Every lock file under the session root, with its text.
    fn locks(&self) -> Vec<(PathBuf, String)> {
        fn walk(dir: &Path, found: &mut Vec<(PathBuf, String)>) {
            let Ok(entries) = std::fs::read_dir(dir) else {
                return;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    walk(&path, found);
                } else if path
                    .extension()
                    .is_some_and(|extension| extension == "lock")
                {
                    found.push((
                        path.clone(),
                        std::fs::read_to_string(&path).unwrap_or_default(),
                    ));
                }
            }
        }
        let mut found = Vec::new();
        walk(&self.home.join("sessions"), &mut found);
        found
    }

    /// The number of session logs under the session root.
    fn logs(&self) -> usize {
        fn walk(dir: &Path) -> usize {
            let Ok(entries) = std::fs::read_dir(dir) else {
                return 0;
            };
            entries
                .flatten()
                .map(|entry| {
                    let path = entry.path();
                    if path.is_dir() {
                        walk(&path)
                    } else {
                        usize::from(path.to_string_lossy().ends_with(".v2.jsonl.zstd"))
                    }
                })
                .sum()
        }
        walk(&self.home.join("sessions"))
    }
}

impl Drop for Home {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.home);
    }
}

#[test]
fn a_command_line_turn_leaves_no_lock_when_it_exits_whether_it_succeeds_or_fails() {
    let home = Home::new("cli");

    // A new session with a turn.
    let (code, stdout, stderr) = home.run(&["--turn", "remember the word loom"]);
    assert_eq!(code, Some(0), "the turn ran\n{stdout}{stderr}");
    assert_eq!(home.logs(), 1, "it wrote a session");
    assert_eq!(home.locks(), vec![], "and left no lock behind");

    // A made session, resumed with a turn.
    let id = home.new_session();
    assert_eq!(
        home.locks(),
        vec![],
        "making a session leaves no lock behind"
    );
    let (code, stdout, stderr) = home.run(&["--resume", &id, "--turn", "and again"]);
    assert_eq!(code, Some(0), "the resumed turn ran\n{stdout}{stderr}");
    assert_eq!(home.locks(), vec![], "a resumed turn leaves no lock behind");

    // A turn that fails after it wrote the prompt: the script cannot be read, so the run exits 1.
    std::fs::remove_file(home.home.join("script.json")).unwrap();
    let (code, stdout, stderr) = home.run(&["--resume", &id, "--turn", "this one fails"]);
    assert_ne!(code, Some(0), "the turn failed\n{stdout}{stderr}");
    assert_eq!(
        home.locks(),
        vec![],
        "a failed turn leaves no lock behind either"
    );
}

/// A running `heddle web`, its output collected as it comes.
struct Server {
    child: Child,
    port: u16,
    token: String,
    output: Arc<Mutex<String>>,
}

impl Server {
    fn start(home: &Home) -> Self {
        let mut child = home
            .command(&["web", "--host", "127.0.0.1", "--port", "0"])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("the server starts");
        let output = Arc::new(Mutex::new(String::new()));
        for stream in [
            Box::new(child.stdout.take().unwrap()) as Box<dyn Read + Send>,
            Box::new(child.stderr.take().unwrap()) as Box<dyn Read + Send>,
        ] {
            let output = Arc::clone(&output);
            std::thread::spawn(move || {
                for line in BufReader::new(stream).lines().map_while(Result::ok) {
                    output.lock().unwrap().push_str(&format!("{line}\n"));
                }
            });
        }
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let text = output.lock().unwrap().clone();
            if let Some(url) = text
                .lines()
                .find_map(|line| line.strip_prefix("heddle web: http://127.0.0.1:"))
            {
                let (port, rest) = url.split_once('/').expect("a URL with a path");
                let token = rest
                    .split_once("token=")
                    .map(|(_, token)| token)
                    .unwrap_or("");
                return Server {
                    child,
                    port: port.parse().expect("a port"),
                    token: token.to_string(),
                    output,
                };
            }
            assert!(
                Instant::now() < deadline,
                "the server printed no URL within 30 s\n{text}"
            );
            assert!(
                child.try_wait().unwrap().is_none(),
                "the server exited before it served\n{text}"
            );
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    fn pid(&self) -> u32 {
        self.child.id()
    }

    /// One HTTP/1.1 exchange, read to its end.
    fn http(&self, request: String) -> String {
        let mut stream = TcpStream::connect(("127.0.0.1", self.port)).expect("the server answers");
        stream
            .set_read_timeout(Some(Duration::from_secs(60)))
            .unwrap();
        stream.write_all(request.as_bytes()).unwrap();
        let mut response = Vec::new();
        let _ = stream.read_to_end(&mut response);
        String::from_utf8_lossy(&response).into_owned()
    }

    /// The cookie the handshake sets.
    fn cookie(&self) -> String {
        let response = self.http(format!(
            "GET /?token={} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n",
            self.token, self.port
        ));
        response
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("set-cookie")
                    .then(|| value.trim().split(';').next().unwrap_or("").to_string())
            })
            .unwrap_or_else(|| panic!("the handshake sets a cookie\n{response}"))
    }

    /// A turn in a session, through `/api/turn`: the whole stream.
    fn turn(&self, cookie: &str, session: &str) -> String {
        let body =
            serde_json::json!({"session": session, "prompt": "remember the word loom"}).to_string();
        self.http(format!(
            "POST /api/turn HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nCookie: {cookie}\r\nContent-Type: application/json\r\n\
             Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
            self.port,
            body.len()
        ))
    }

    /// Send a signal, as a service manager or a person at the terminal stops a server, and wait for the exit.
    fn stop(&mut self, signal: &str) -> Option<i32> {
        let sent = Command::new("kill")
            .arg(format!("-{signal}"))
            .arg(self.pid().to_string())
            .status()
            .expect("kill runs");
        assert!(sent.success(), "the signal was sent");
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                return status.code();
            }
            assert!(
                Instant::now() < deadline,
                "the server did not exit within 30 s of {signal}\n{}",
                self.output.lock().unwrap()
            );
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Make `count` sessions, have the server write each with a turn, check it holds their locks, stop it with `signal`,
/// and check that no lock is left.
fn a_stopped_server_leaves_no_lock(signal: &str, count: usize) {
    let home = Home::new(&signal.to_lowercase());
    // Made by the command line, whose own exit is judged above; the server then writes each one.
    let ids: Vec<String> = (0..count).map(|_| home.new_session()).collect();
    let mut server = Server::start(&home);
    let cookie = server.cookie();
    for id in &ids {
        let stream = server.turn(&cookie, id);
        assert!(
            stream.contains("event: done"),
            "the server's turn in {id} ran\n{stream}"
        );
    }
    let held = home.locks();
    assert_eq!(
        held.len(),
        count,
        "the server holds a lock on each session it wrote\n{held:?}"
    );
    for (path, text) in &held {
        assert_eq!(
            text.split_ascii_whitespace().next(),
            Some(server.pid().to_string().as_str()),
            "{} names the server",
            path.display()
        );
    }
    let code = server.stop(signal);
    assert_eq!(
        home.locks(),
        vec![],
        "a server stopped by SIG{signal} leaves no lock behind (it exited {code:?})\n{}",
        server.output.lock().unwrap()
    );
}

#[test]
fn a_server_stopped_by_sigterm_leaves_no_lock_on_the_sessions_it_wrote() {
    a_stopped_server_leaves_no_lock("TERM", 3);
}

#[test]
fn a_server_stopped_by_sigint_leaves_no_lock_on_the_sessions_it_wrote() {
    a_stopped_server_leaves_no_lock("INT", 1);
}
