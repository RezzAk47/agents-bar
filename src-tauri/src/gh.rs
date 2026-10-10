//! GitHub through the logged-in `gh` CLI, and only through these fixed argument shapes:
//!   gh api user --jq .login
//!   gh repo list --limit N --json <one of two fixed field lists>
//!   gh run list --repo OWNER/NAME --limit 1 --json status,conclusion
//! No shell is involved (the program is started directly with an argument list), names are validated before they reach an
//! argument, every call has a timeout, and output is capped. The page never supplies a program, a flag or a URL.

use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub const CALL_TIMEOUT: Duration = Duration::from_secs(10);
pub const MAX_OUTPUT: usize = 8 * 1024 * 1024;
pub const FIELDS: &str =
    "name,description,primaryLanguage,stargazerCount,pushedAt,url,isPrivate,isFork,isArchived";
pub const EXTRA_FIELDS: &str = "name,description,primaryLanguage,stargazerCount,pushedAt,url,isPrivate,isFork,isArchived,issues,pullRequests";

pub const MISSING: &str = "GH_MISSING";
pub const NOT_LOGGED_IN: &str = "GH_NOT_LOGGED_IN";
pub const RATE_LIMIT: &str = "GH_RATE_LIMIT";
pub const TIMEOUT: &str = "GH_TIMEOUT";

/// GitHub owner / login: letters, digits, hyphen and underscore (Enterprise Managed User logins look like `name_company`),
/// 1 to 39 characters, starting with a letter or digit, no `--`, no trailing hyphen. Never a `.`, `/`, space or `@`.
pub fn valid_owner(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= 39
        && b[0].is_ascii_alphanumeric()
        && b[b.len() - 1] != b'-'
        && !s.contains("--")
        && b.iter()
            .all(|c| c.is_ascii_alphanumeric() || *c == b'-' || *c == b'_')
}

/// Repository name: letters, digits, dot, underscore, hyphen, 1 to 100 characters; not "." or "..", never starting with a hyphen.
pub fn valid_repo(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= 100
        && s != "."
        && s != ".."
        && b[0] != b'-'
        && b.iter()
            .all(|c| c.is_ascii_alphanumeric() || matches!(*c, b'.' | b'_' | b'-'))
}

/// ("owner", "name") from "owner/name", or None.
pub fn split_slug(slug: &str) -> Option<(&str, &str)> {
    let (o, r) = slug.split_once('/')?;
    (valid_owner(o) && valid_repo(r)).then_some((o, r))
}

/// The only URL the app opens for a repository: built here from validated names.
pub fn repo_url(slug: &str) -> Option<String> {
    split_slug(slug).map(|(o, r)| format!("https://github.com/{o}/{r}"))
}

fn is_exe(p: &std::path::Path) -> bool {
    p.is_file()
}

/// AGENTSBAR_GH (tests and manual runs), else `gh` on PATH, else the usual install spots.
pub fn find_gh(env: &dyn Fn(&str) -> Option<String>) -> Option<PathBuf> {
    if let Some(p) = env("AGENTSBAR_GH").filter(|p| !p.trim().is_empty()) {
        let p = PathBuf::from(p);
        return is_exe(&p).then_some(p);
    }
    let names: &[&str] = if cfg!(windows) {
        &["gh.exe", "gh.cmd"]
    } else {
        &["gh"]
    };
    if let Some(path) = env("PATH") {
        for dir in std::env::split_paths(&path) {
            for n in names {
                let c = dir.join(n);
                if is_exe(&c) {
                    return Some(c);
                }
            }
        }
    }
    let spots: &[&str] = if cfg!(windows) {
        &[
            "C:\\Program Files\\GitHub CLI\\gh.exe",
            "C:\\Program Files (x86)\\GitHub CLI\\gh.exe",
        ]
    } else {
        &[
            "/opt/homebrew/bin/gh",
            "/usr/local/bin/gh",
            "/usr/bin/gh",
            "/home/linuxbrew/.linuxbrew/bin/gh",
        ]
    };
    spots.iter().map(PathBuf::from).find(|p| is_exe(p))
}

fn read_capped(mut r: impl Read) -> Vec<u8> {
    let mut out = Vec::new();
    let mut buf = [0u8; 16 * 1024];
    loop {
        match r.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if out.len() < MAX_OUTPUT {
                    let take = n.min(MAX_OUTPUT - out.len());
                    out.extend_from_slice(&buf[..take]);
                } // beyond the cap the pipe is still drained so gh never blocks
            }
        }
    }
    out
}

fn classify(stderr: &str) -> String {
    let low = stderr.to_lowercase();
    if low.contains("gh auth login")
        || low.contains("not logged in")
        || low.contains("authentication")
        || low.contains("http 401")
    {
        return NOT_LOGGED_IN.into();
    }
    if low.contains("rate limit") || low.contains("http 403") && low.contains("api rate") {
        return RATE_LIMIT.into();
    }
    let first: String = stderr
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("gh failed")
        .chars()
        .filter(|c| !c.is_control())
        .take(120)
        .collect();
    format!("GH_FAILED:{first}")
}

/// Runs gh with exactly `args`, a timeout and capped output.
pub fn run(gh: &PathBuf, args: &[&str], timeout: Duration) -> Result<String, String> {
    let mut cmd = Command::new(gh);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("NO_COLOR", "1");
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0); // gh and everything it starts share one group, so a timeout can end all of it
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0000_0200 | 0x0800_0000); // CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW
    }
    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            MISSING.to_string()
        } else {
            format!("GH_FAILED:{e}")
        }
    })?;
    let out = child.stdout.take().map(reader);
    let err = child.stderr.take().map(reader);
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st,
            Ok(None) => {
                if start.elapsed() >= timeout {
                    kill_tree(&mut child);
                    let _ = child.wait();
                    let _ = collect(out); // the pipes are closed now: reap the reader threads
                    let _ = collect(err);
                    return Err(TIMEOUT.into());
                }
                std::thread::sleep(Duration::from_millis(15));
            }
            Err(e) => return Err(format!("GH_FAILED:{e}")),
        }
    };
    kill_group_leftovers(&child); // a helper gh left behind must not keep the pipes (or the machine) busy
    let stdout = collect(out);
    let stderr = collect(err);
    if !status.success() {
        return Err(classify(&String::from_utf8_lossy(&stderr)));
    }
    String::from_utf8(stdout).map_err(|_| "GH_FAILED:gh sent text that is not UTF-8".to_string())
}

/// Reads one pipe on its own thread; the result comes back over a channel so a stuck pipe can be given up on.
fn reader(r: impl Read + Send + 'static) -> std::sync::mpsc::Receiver<Vec<u8>> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(read_capped(r));
    });
    rx
}

fn collect(rx: Option<std::sync::mpsc::Receiver<Vec<u8>>>) -> Vec<u8> {
    rx.and_then(|r| r.recv_timeout(Duration::from_secs(2)).ok())
        .unwrap_or_default()
}

/// Ends gh and every process it started: the whole process group on Unix, `taskkill /T` (the process tree) on Windows.
fn kill_tree(child: &mut std::process::Child) {
    #[cfg(unix)]
    {
        unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL) };
    }
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/T", "/F", "/PID", &child.id().to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
}

/// After gh itself has exited: whatever is still in its group is killed (Unix; on Windows the tree is gone with its parent job end).
fn kill_group_leftovers(child: &std::process::Child) {
    #[cfg(unix)]
    {
        unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL) };
    }
    #[cfg(not(unix))]
    {
        let _ = child;
    }
}

pub fn user(gh: &PathBuf, t: Duration) -> Result<String, String> {
    run(gh, &["api", "user", "--jq", ".login"], t)
}

pub fn repo_list(gh: &PathBuf, fields: &str, limit: u32, t: Duration) -> Result<String, String> {
    if fields != FIELDS && fields != EXTRA_FIELDS {
        return Err("GH_FAILED:unknown field list".into());
    }
    if !(1..=100).contains(&limit) {
        return Err("GH_FAILED:bad limit".into());
    }
    run(
        gh,
        &[
            "repo",
            "list",
            "--limit",
            &limit.to_string(),
            "--json",
            fields,
        ],
        t,
    )
}

pub fn run_list(gh: &PathBuf, slug: &str, t: Duration) -> Result<String, String> {
    let (o, r) = split_slug(slug).ok_or_else(|| "GH_FAILED:bad repository name".to_string())?;
    let repo = format!("{o}/{r}");
    run(
        gh,
        &[
            "run",
            "list",
            "--repo",
            &repo,
            "--limit",
            "1",
            "--json",
            "status,conclusion",
        ],
        t,
    )
}

#[cfg(test)]
mod name_tests {
    use super::*;

    #[test]
    fn names_are_validated() {
        for ok in [
            "me/tool",
            "a-b/c.d_e",
            "A1/x",
            "name_company/repo",
            "a_b-c/x",
            "9lives/x",
        ] {
            assert!(split_slug(ok).is_some(), "{ok}");
        }
        for bad in [
            "",
            "me",
            "me/",
            "/tool",
            "-me/tool",
            "me/-tool",
            "_me/tool",
            "me--x/tool",
            "me-/tool",
            "me.x/tool",
            "me@x/tool",
            "me x/tool",
            "a/b/c",
            "me/\u{e9}",
            "me/..",
            "me/.",
            "me/to ol",
            "me/tool/extra",
            "me/tool;rm",
            "me/$(x)",
            "m e/tool",
            "me/to\nol",
            "--repo/x",
            &format!("{}/x", "a".repeat(40)),
            &format!("me/{}", "r".repeat(101)),
            "me/to\u{e9}l",
        ] {
            assert!(split_slug(bad).is_none(), "{bad:?}");
        }
        assert_eq!(
            repo_url("me/tool").as_deref(),
            Some("https://github.com/me/tool")
        );
        assert_eq!(repo_url("me/tool?x=1"), None);
    }

    #[test]
    fn a_missing_gh_is_reported_as_missing_on_every_os() {
        let nowhere = std::env::temp_dir().join("agents-bar-no-such-gh-binary");
        assert_eq!(user(&nowhere, Duration::from_secs(2)).unwrap_err(), MISSING);
    }

    /// Windows only (runs on CI): a `.cmd` stands in for gh, so the spawn, the pipes and the output cap are exercised there too.
    #[cfg(windows)]
    #[test]
    fn a_cmd_script_can_stand_in_for_gh_on_windows() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("gh.cmd");
        std::fs::write(&p, "@echo off\r\necho [{\"status\":\"completed\"}]\r\n").unwrap();
        let out = run_list(&p, "me/tool", CALL_TIMEOUT).unwrap();
        assert_eq!(out.trim(), "[{\"status\":\"completed\"}]");
        assert!(run_list(&p, "me/tool; calc", CALL_TIMEOUT).is_err());
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    /// A fake gh: a shell script that records its arguments (one per line) in `args.log` and answers by the first words.
    fn fake(dir: &std::path::Path, body: &str) -> PathBuf {
        let p = dir.join("gh");
        let log = dir.join("args.log");
        std::fs::write(
            &p,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$@\" >> '{}'\nprintf -- '--\\n' >> '{}'\n{}\n",
                log.display(),
                log.display(),
                body
            ),
        )
        .unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        p
    }

    #[test]
    fn fixed_argument_shapes_and_no_shell() {
        let d = tempfile::tempdir().unwrap();
        let gh = fake(d.path(), "echo '[]'");
        run_list(&gh, "me/tool", CALL_TIMEOUT).unwrap();
        repo_list(&gh, EXTRA_FIELDS, 50, CALL_TIMEOUT).unwrap();
        user(&gh, CALL_TIMEOUT).unwrap();
        let log = std::fs::read_to_string(d.path().join("args.log")).unwrap();
        let calls: Vec<Vec<&str>> = log
            .split("--\n")
            .filter(|c| !c.is_empty())
            .map(|c| c.lines().collect())
            .collect();
        assert_eq!(
            calls[0],
            [
                "run",
                "list",
                "--repo",
                "me/tool",
                "--limit",
                "1",
                "--json",
                "status,conclusion"
            ]
        );
        assert_eq!(
            calls[1],
            ["repo", "list", "--limit", "50", "--json", EXTRA_FIELDS]
        );
        assert_eq!(calls[2], ["api", "user", "--jq", ".login"]);
        // a hostile name never reaches gh
        assert!(run_list(&gh, "me/tool; touch pwned", CALL_TIMEOUT).is_err());
        assert!(repo_list(&gh, "name;touch pwned", 5, CALL_TIMEOUT).is_err());
        assert!(repo_list(&gh, FIELDS, 0, CALL_TIMEOUT).is_err());
        assert!(repo_list(&gh, FIELDS, 101, CALL_TIMEOUT).is_err());
        assert!(!d.path().join("pwned").exists());
    }

    #[test]
    fn errors_are_classified() {
        let d = tempfile::tempdir().unwrap();
        let t = Duration::from_secs(5);
        let gh = fake(
            d.path(),
            "echo 'To get started with GitHub CLI, please run:  gh auth login' >&2; exit 4",
        );
        assert_eq!(user(&gh, t).unwrap_err(), NOT_LOGGED_IN);
        let gh = fake(
            d.path(),
            "echo 'API rate limit exceeded for user' >&2; exit 1",
        );
        assert_eq!(user(&gh, t).unwrap_err(), RATE_LIMIT);
        let gh = fake(d.path(), "echo 'something odd happened' >&2; exit 1");
        assert_eq!(
            user(&gh, t).unwrap_err(),
            "GH_FAILED:something odd happened"
        );
        assert_eq!(user(&d.path().join("nope"), t).unwrap_err(), MISSING);
    }

    #[test]
    fn a_hung_call_times_out_and_is_killed() {
        let d = tempfile::tempdir().unwrap();
        let gh = fake(d.path(), "sleep 30");
        let t0 = Instant::now();
        assert_eq!(user(&gh, Duration::from_millis(300)).unwrap_err(), TIMEOUT);
        assert!(t0.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn a_timeout_ends_the_grandchildren_too() {
        let d = tempfile::tempdir().unwrap();
        let pidfile = d.path().join("pid");
        let gh = fake(
            d.path(),
            &format!("sleep 30 &\necho $! > '{}'\nwait", pidfile.display()),
        );
        assert_eq!(user(&gh, Duration::from_millis(400)).unwrap_err(), TIMEOUT);
        let pid: i32 = std::fs::read_to_string(&pidfile)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        let mut alive = true;
        for _ in 0..40 {
            alive = unsafe { libc::kill(pid, 0) } == 0;
            if !alive {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(!alive, "the grandchild sleep {pid} must be dead");
    }

    #[test]
    fn a_helper_left_holding_the_pipe_after_gh_exits_does_not_hang_the_call() {
        let d = tempfile::tempdir().unwrap();
        let gh = fake(d.path(), "sleep 30 &\necho done");
        let t0 = Instant::now();
        let out = user(&gh, Duration::from_secs(5)).unwrap();
        assert_eq!(out.trim(), "done");
        assert!(t0.elapsed() < Duration::from_secs(4), "{:?}", t0.elapsed());
    }

    #[test]
    fn output_is_capped_and_the_pipe_is_drained() {
        let d = tempfile::tempdir().unwrap();
        let gh = fake(
            d.path(),
            "yes 0123456789012345678901234567890123456789 | head -c 12000000",
        );
        let out = user(&gh, Duration::from_secs(20)).unwrap();
        assert_eq!(out.len(), MAX_OUTPUT);
    }

    #[test]
    fn finding_gh_honours_the_override() {
        let d = tempfile::tempdir().unwrap();
        let gh = fake(d.path(), "true");
        let env = |k: &str| (k == "AGENTSBAR_GH").then(|| gh.display().to_string());
        assert_eq!(find_gh(&env), Some(gh.clone()));
        let missing = |k: &str| (k == "AGENTSBAR_GH").then(|| "/nonexistent/gh".to_string());
        assert_eq!(find_gh(&missing), None);
    }
}
