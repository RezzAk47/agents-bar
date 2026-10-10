//! The only file access the webview has: four operations on a fixed set of names inside the data folder.
//! Names are validated (no separators, no `..`, only notified/settings json and their `.broken-` backups), the folder is
//! canonicalised, writes are atomic (temp file in the same folder, fsync, rename, fsync of the folder), and a symlinked
//! file keeps being a link (the real file behind it is replaced).
//!
//! Writes are also compare-and-swap: the page says which version of the file it last read (size, mtime, ctime, inode) and
//! the write is refused with `CONFLICT` when the file on disk is a different one. The check and the write happen while
//! holding the same `<file>.lock` (flock on Unix, LockFileEx on Windows), so two app instances (or an external tool that locks
//! the same file) can never both read the old file and then overwrite each other.

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// Opens a REGULAR file for reading and nothing else. A FIFO, device or directory named like a data file or transcript is
/// refused instead of blocking forever: the path is looked at first, and on Unix the open itself is O_NONBLOCK (never waits
/// for a writer) and, when `follow` is false, O_NOFOLLOW; the opened handle is checked again with fstat.
pub fn open_regular(p: &Path, follow: bool) -> std::io::Result<fs::File> {
    use std::io::{Error, ErrorKind};
    let meta = if follow {
        fs::metadata(p)?
    } else {
        fs::symlink_metadata(p)?
    };
    if !meta.is_file() {
        return Err(Error::new(ErrorKind::InvalidInput, "not a regular file"));
    }
    let mut o = fs::OpenOptions::new();
    o.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.custom_flags(libc::O_NONBLOCK | if follow { 0 } else { libc::O_NOFOLLOW });
    }
    let f = o.open(p)?;
    if !f.metadata()?.is_file() {
        return Err(Error::new(ErrorKind::InvalidInput, "not a regular file"));
    }
    Ok(f)
}

/// Files over this size are not loaded (a runaway file must not freeze the popup).
pub const MAX_READ_BYTES: u64 = 32 * 1024 * 1024;
pub const CONFLICT: &str = "CONFLICT: the file changed on disk";

#[derive(Serialize, Deserialize, Debug, PartialEq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Stamp {
    pub size: u64,
    /// Modification time in whole microseconds since the epoch. An INTEGER on purpose: fractional milliseconds (f64) do not
    /// always come back bit-identical after Rust -> JSON -> page -> JSON -> Rust, and the compare-and-swap uses exact equality.
    pub mtime_us: i64,
    /// Change time (Unix) or creation time (Windows), whole microseconds.
    pub ctime_us: i64,
    /// Inode number as text on Unix (empty where the OS does not give one cheaply).
    pub ino: String,
}

/// `^(notified|settings)(\.broken-[0-9a-z-]{1,40})?\.json$`, written out by hand (no regex crate needed).
pub fn valid_name(name: &str) -> bool {
    let rest = if let Some(r) = name.strip_prefix("notified") {
        r
    } else if let Some(r) = name.strip_prefix("settings") {
        r
    } else {
        return false;
    };
    let Some(mid) = rest.strip_suffix(".json") else {
        return false;
    };
    if mid.is_empty() {
        return true;
    }
    match mid.strip_prefix(".broken-") {
        Some(tail) => {
            !tail.is_empty()
                && tail.len() <= 40
                && tail
                    .bytes()
                    .all(|b| b.is_ascii_digit() || b.is_ascii_lowercase() || b == b'-')
        }
        None => false,
    }
}

/// The path of a data file, or an error. Never returns a path outside `dir`.
pub fn resolve(dir: &Path, name: &str) -> Result<PathBuf, String> {
    if !valid_name(name) {
        return Err(format!("not an allowed file name: {name:?}"));
    }
    // canonicalise the folder when it exists (it may be a symlink the user made); a missing folder is created on write
    let base = match dir.canonicalize() {
        Ok(c) => c,
        Err(_) => dir.to_path_buf(),
    };
    let p = base.join(name);
    if p.parent() != Some(base.as_path()) {
        return Err("path escapes the data folder".into());
    }
    Ok(p)
}

/// What a write will replace, after the symlink policy has been applied (see `plan_target`).
#[derive(Debug)]
struct Target {
    /// The file that gets replaced: `dir/name` itself, or the regular file a link points to.
    path: PathBuf,
    /// Where the temp file may be created: the data folder, or the target's folder when the target is on another filesystem.
    temp_dir: PathBuf,
    /// Identity of the validated target (device, inode) for the check right before the rename; None = it does not exist yet.
    identity: Option<(u64, u64)>,
}

#[cfg(unix)]
fn identity_of(m: &fs::Metadata) -> (u64, u64) {
    use std::os::unix::fs::MetadataExt;
    (m.dev(), m.ino())
}
#[cfg(not(unix))]
fn identity_of(m: &fs::Metadata) -> (u64, u64) {
    (m.len(), 0) // no stable file id in std on this OS: the size and the type checks are what is left
}

#[cfg(unix)]
fn owned_by_me(m: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    // SAFETY: geteuid has no preconditions and cannot fail.
    m.uid() == unsafe { libc::geteuid() }
}
#[cfg(not(unix))]
fn owned_by_me(_m: &fs::Metadata) -> bool {
    true // ownership is not available in std on this OS; the content check below is the guard
}

/// Is this what the app itself would have written (or nothing yet) for this kind of file?
/// notified*.json: an object with a "notified" list; settings*.json: an object; empty (or only white space) is fine too.
fn is_app_content(name: &str, bytes: &[u8]) -> bool {
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF][..]).unwrap_or(bytes);
    let Ok(text) = std::str::from_utf8(bytes) else {
        return false;
    };
    if text.trim().is_empty() {
        return true;
    }
    match serde_json::from_str::<serde_json::Value>(text) {
        Ok(serde_json::Value::Object(o)) => {
            !name.starts_with("notified") || o.get("ids").is_some_and(|t| t.is_object())
        }
        _ => false,
    }
}

/// Decides what a write replaces.
///  * `dir/name` missing or a regular file: that path (a hard link is replaced by a new file, never written through).
///  * `dir/name` a symlink: followed ONLY when the target exists, is a regular file, is owned by the current user (Unix) and
///    holds nothing or valid app JSON of this kind. Dangling links, directories, devices, fifos, other people's files and
///    any non-app file are refused with a named error and nothing is written.
fn plan_target(p: &Path, name: &str) -> Result<Target, String> {
    let base = p.parent().ok_or("no folder for the file")?.to_path_buf();
    let base_dev = fs::metadata(&base).ok().map(|m| identity_of(&m).0);
    let meta = match fs::symlink_metadata(p) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Target {
                path: p.to_path_buf(),
                temp_dir: base,
                identity: None,
            })
        }
        Err(e) => return Err(format!("cannot look at {name}: {e}")),
    };
    if meta.file_type().is_symlink() {
        let real = p.canonicalize().map_err(|_| {
            format!("{name} is a link to a file that does not exist; nothing was written")
        })?;
        let tm = fs::metadata(&real)
            .map_err(|e| format!("cannot look at the file {name} links to: {e}"))?;
        if !tm.is_file() {
            return Err(format!(
                "{name} is a link to something that is not a regular file; nothing was written"
            ));
        }
        if !owned_by_me(&tm) {
            return Err(format!(
                "{name} is a link to a file that belongs to another user; nothing was written"
            ));
        }
        if tm.len() > MAX_READ_BYTES {
            return Err(format!(
                "{name} is a link to a file larger than {} MB; nothing was written",
                MAX_READ_BYTES / 1024 / 1024
            ));
        }
        let bytes = open_regular(&real, true)
            .and_then(|f| {
                let mut b = Vec::new();
                f.take(MAX_READ_BYTES + 1).read_to_end(&mut b).map(|_| b)
            })
            .map_err(|e| format!("cannot read the file {name} links to: {e}"))?;
        if !is_app_content(name, &bytes) {
            return Err(format!("{name} is a link to a file that is not a Agents Bar data file; nothing was written"));
        }
        let parent = real
            .parent()
            .ok_or("no folder for the linked file")?
            .to_path_buf();
        let target_dev = fs::metadata(&parent).ok().map(|m| identity_of(&m).0);
        // the temp file goes in the data folder when that is the same filesystem; in the linked file's folder otherwise
        let temp_dir = if base_dev.is_some() && base_dev == target_dev {
            base
        } else {
            parent
        };
        return Ok(Target {
            path: real,
            temp_dir,
            identity: Some(identity_of(&tm)),
        });
    }
    if meta.is_file() {
        return Ok(Target {
            path: p.to_path_buf(),
            temp_dir: base,
            identity: Some(identity_of(&meta)),
        });
    }
    Err(format!("{name} is not a regular file; nothing was written"))
}

/// Right before the rename: the target must still be the very file that was validated (same device and inode, still a regular
/// file, not swapped for a link in the meantime).
fn still_same(t: &Target) -> Result<(), String> {
    match (fs::symlink_metadata(&t.path), t.identity) {
        (Ok(m), Some(id)) if m.is_file() && identity_of(&m) == id => Ok(()),
        (Err(e), None) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        (Ok(m), None) if m.is_file() => Ok(()), // created by someone else meanwhile: the compare-and-swap decides
        _ => Err("the file changed while it was being written; nothing was written".into()),
    }
}

/// Whole microseconds since the epoch (negative before it).
fn us(t: std::io::Result<std::time::SystemTime>) -> i64 {
    match t {
        Ok(t) => match t.duration_since(UNIX_EPOCH) {
            Ok(d) => d.as_micros() as i64,
            Err(e) => -(e.duration().as_micros() as i64),
        },
        Err(_) => 0,
    }
}

fn stamp_of(m: &fs::Metadata) -> Stamp {
    #[cfg(unix)]
    let (ctime_us, ino) = {
        use std::os::unix::fs::MetadataExt;
        (
            m.ctime() * 1_000_000 + m.ctime_nsec() / 1000,
            m.ino().to_string(),
        )
    };
    #[cfg(not(unix))]
    let (ctime_us, ino) = (us(m.created()), String::new());
    Stamp {
        size: m.len(),
        mtime_us: us(m.modified()),
        ctime_us,
        ino,
    }
}

pub const NOT_UTF8: &str =
    "is not UTF-8 text; if you saved it as UTF-16 (some Windows editors do) save it again as UTF-8";

/// The file as text. A UTF-8 byte order mark is dropped from the returned text (the file itself is not touched).
pub fn read(dir: &Path, name: &str) -> Result<Option<String>, String> {
    let p = resolve(dir, name)?;
    match fs::metadata(&p) {
        Ok(m) if !m.is_file() => {
            return Err(format!("{name} is not a regular file; it is not read"))
        }
        Ok(m) if m.len() > MAX_READ_BYTES => {
            return Err(format!(
                "{name} is larger than {} MB; it is not loaded",
                MAX_READ_BYTES / 1024 / 1024
            ));
        }
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("cannot read {name}: {e}")),
    }
    let mut bytes = Vec::new();
    match open_regular(&p, true).and_then(|f| f.take(MAX_READ_BYTES + 1).read_to_end(&mut bytes)) {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("cannot read {name}: {e}")),
    }
    if bytes.len() as u64 > MAX_READ_BYTES {
        return Err(format!(
            "{name} is larger than {} MB; it is not loaded",
            MAX_READ_BYTES / 1024 / 1024
        ));
    }
    let slice = bytes
        .strip_prefix(&[0xEF, 0xBB, 0xBF][..])
        .unwrap_or(&bytes);
    String::from_utf8(slice.to_vec())
        .map(Some)
        .map_err(|_| format!("{name} {NOT_UTF8}"))
}

pub fn stat(dir: &Path, name: &str) -> Result<Option<Stamp>, String> {
    let p = resolve(dir, name)?;
    match fs::metadata(&p) {
        Ok(m) => Ok(Some(stamp_of(&m))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("cannot stat {name}: {e}")),
    }
}

/// Is this a failure that a Windows virus scanner, indexer or the other program holding the file open causes for a moment?
pub fn is_transient(e: &std::io::Error) -> bool {
    if e.kind() == std::io::ErrorKind::PermissionDenied {
        return true;
    }
    // 5 ACCESS_DENIED, 32 sharing violation, 33 lock violation
    matches!(e.raw_os_error(), Some(5) | Some(32) | Some(33)) && cfg!(windows)
}

pub const RETRY_DELAYS_MS: [u64; 5] = [20, 50, 100, 200, 400];

/// Runs `op`, retrying after each delay while it fails with a transient error. `sleep` is injectable for tests.
pub fn retry_transient<T>(
    mut op: impl FnMut() -> std::io::Result<T>,
    delays_ms: &[u64],
    mut sleep: impl FnMut(Duration),
) -> std::io::Result<T> {
    let mut i = 0;
    loop {
        match op() {
            Ok(v) => return Ok(v),
            Err(e) if is_transient(&e) && i < delays_ms.len() => {
                sleep(Duration::from_millis(delays_ms[i]));
                i += 1;
            }
            Err(e) => return Err(e),
        }
    }
}

/// Holds `<real file>.lock` exclusively until dropped. Waits up to 5 s.
/// A folder we cannot create the lock in just means "no lock": the compare-and-swap still protects the write.
struct Lock(Option<fs::File>);

impl Lock {
    fn take(target: &Path) -> Lock {
        let lock_path = PathBuf::from(format!("{}.lock", target.display()));
        let mut o = fs::OpenOptions::new();
        o.create(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            o.custom_flags(libc::O_NONBLOCK); // a FIFO planted as the lock file must not block the open
        }
        let Ok(f) = o.open(&lock_path) else {
            return Lock(None);
        };
        if !f.metadata().map(|m| m.is_file()).unwrap_or(false) {
            return Lock(None);
        }
        let t0 = std::time::Instant::now();
        loop {
            match f.try_lock() {
                Ok(()) => return Lock(Some(f)),
                Err(fs::TryLockError::WouldBlock) if t0.elapsed() < Duration::from_secs(5) => {
                    std::thread::sleep(Duration::from_millis(5))
                }
                Err(_) => return Lock(None),
            }
        }
    }
}

impl Drop for Lock {
    fn drop(&mut self) {
        if let Some(f) = &self.0 {
            let _ = f.unlock();
        }
    }
}

/// `check`: None = no compare, Some(None) = the file must not exist, Some(Some(stamp)) = it must still be exactly that file.
pub fn write(
    dir: &Path,
    name: &str,
    text: &str,
    check: Option<Option<Stamp>>,
) -> Result<(), String> {
    let p = resolve(dir, name)?;
    fs::create_dir_all(dir).map_err(|e| format!("cannot create the data folder: {e}"))?;
    let mut target = plan_target(&p, name)?; // refuses before any file (even the lock file) is created
    #[cfg(test)]
    tests::run_before_lock_hook();
    let mut _lock = Lock::take(&target.path);
    // The plan was made before the lock: another writer (the other app instance, tick.py, an editor's save) may have replaced
    // the file since, and `still_same` would then refuse a write that is perfectly fine. Plan again while holding the lock.
    for _ in 0..3 {
        let again = plan_target(&p, name)?;
        let same_place = again.path == target.path;
        target = again;
        if same_place {
            break;
        }
        _lock = Lock::take(&target.path);
    }
    if let Some(expected) = check {
        let current = fs::metadata(&p).ok().map(|m| stamp_of(&m));
        if current != expected {
            return Err(CONFLICT.into());
        }
    }
    if let Ok(meta) = fs::metadata(&target.path) {
        if meta.permissions().readonly() {
            return Err(format!("{name} is read-only; nothing was saved"));
        }
    }
    let nanos = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = target
        .temp_dir
        .join(format!(".{name}.tmp-{}-{nanos}", std::process::id()));
    let result = (|| -> std::io::Result<()> {
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)?;
        f.write_all(text.as_bytes())?;
        f.sync_all()?;
        drop(f);
        #[cfg(unix)]
        if let Ok(meta) = fs::metadata(&target.path) {
            let _ = fs::set_permissions(&tmp, meta.permissions()); // keep the mode the user gave the file
        }
        #[cfg(windows)]
        {
            // never inherit a read-only attribute from the target: rename onto it must work
            let mut perms = fs::metadata(&tmp)?.permissions();
            #[allow(clippy::permissions_set_readonly_false)]
            perms.set_readonly(false);
            let _ = fs::set_permissions(&tmp, perms);
        }
        still_same(&target).map_err(std::io::Error::other)?;
        retry_transient(
            || fs::rename(&tmp, &target.path),
            &RETRY_DELAYS_MS,
            std::thread::sleep,
        )?;
        #[cfg(unix)]
        {
            if let Some(d) = target.path.parent().and_then(|d| fs::File::open(d).ok()) {
                let _ = d.sync_all();
            }
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result.map_err(|e| format!("could not write {name}: {e}"))
}

/// Keeps an unreadable file as a backup: renames it (or the link itself) to a UNIQUE `.broken-` name in the same folder.
/// The final name is the requested one plus a unique suffix, so nothing (not even a dangling symlink) is ever overwritten.
/// Returns the name it used.
pub fn move_aside(dir: &Path, name: &str, backup: &str) -> Result<String, String> {
    let from = resolve(dir, name)?;
    resolve(dir, backup)?;
    if !backup.contains(".broken-") {
        return Err("a backup name must contain .broken-".into());
    }
    let stem = backup.strip_suffix(".json").unwrap_or(backup);
    for n in 0..100u32 {
        let nanos = std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let unique = format!("{stem}-{:x}{n}.json", nanos & 0xffff_ffff);
        let to = dir
            .canonicalize()
            .unwrap_or_else(|_| dir.to_path_buf())
            .join(&unique);
        // symlink_metadata sees a dangling symlink too; a name that exists in any form is skipped
        if fs::symlink_metadata(&to).is_ok() {
            continue;
        }
        return fs::rename(&from, &to)
            .map(|_| unique)
            .map_err(|e| format!("could not keep a backup of {name}: {e}"));
    }
    Err("could not find an unused backup name".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    thread_local! {
        static BEFORE_LOCK: RefCell<Option<Box<dyn FnOnce()>>> = const { RefCell::new(None) };
    }
    /// Test hook: runs once, between planning a write and taking its lock (where a second writer can get in).
    pub(super) fn run_before_lock_hook() {
        if let Some(f) = BEFORE_LOCK.with(|h| h.borrow_mut().take()) {
            f();
        }
    }

    #[test]
    fn a_file_replaced_by_another_writer_after_the_plan_does_not_make_the_write_fail() {
        let d = tempfile::tempdir().unwrap();
        let data = d.path().join("data");
        write(&data, "notified.json", "{\"ids\":{}}\n", None).unwrap();
        let (dir, tmp) = (data.clone(), d.path().join("other-writer.tmp"));
        BEFORE_LOCK.with(|h| {
            *h.borrow_mut() = Some(Box::new(move || {
                // an atomic replace by someone else: a new file (new inode, new size) under the same name
                fs::write(&tmp, "{\"ids\":{\"theirs\":1}}\n").unwrap();
                fs::rename(&tmp, dir.join("notified.json")).unwrap();
            }));
        });
        write(&data, "notified.json", "{\"ids\":{\"ours\":2}}\n", None).unwrap();
        assert_eq!(
            read(&data, "notified.json").unwrap().as_deref(),
            Some("{\"ids\":{\"ours\":2}}\n")
        );
    }

    #[test]
    fn names_are_checked() {
        for ok in [
            "notified.json",
            "settings.json",
            "notified.broken-1760000000000-ab12cd.json",
            "settings.broken-1760000000000.json",
        ] {
            assert!(valid_name(ok), "{ok}");
        }
        for bad in [
            "",
            "../notified.json",
            "notified.json/",
            "a/notified.json",
            "..",
            ".",
            "notified.json.bak",
            "other.json",
            "notified.broken-.json",
            "notified.json\n",
            "C:\\x.json",
            "notified\0.json",
            "notified.broken-UPPER.json",
            "notified.broken-../x.json",
            "/etc/passwd",
            "notified.json ",
            "NOTIFIED.json",
        ] {
            assert!(!valid_name(bad), "{bad:?}");
        }
        assert!(!valid_name(&format!(
            "notified.broken-{}.json",
            "a".repeat(41)
        )));
    }

    #[test]
    fn traversal_is_refused_and_nothing_is_created() {
        let d = tempfile::tempdir().unwrap();
        let outside = d.path().join("outside.json");
        let data = d.path().join("data");
        for bad in [
            "../outside.json",
            "..\\outside.json",
            "notified.json/../../outside.json",
            "/tmp/x.json",
        ] {
            assert!(write(&data, bad, "x", None).is_err(), "{bad}");
            assert!(read(&data, bad).is_err(), "{bad}");
            assert!(stat(&data, bad).is_err(), "{bad}");
        }
        assert!(!outside.exists());
        assert!(
            !data.exists(),
            "a refused write must not even create the folder"
        );
    }

    #[test]
    fn write_read_stat_round_trip_and_no_temp_left() {
        let d = tempfile::tempdir().unwrap();
        let data = d.path().join("AgentsBarCross");
        assert_eq!(read(&data, "notified.json").unwrap(), None);
        assert_eq!(stat(&data, "notified.json").unwrap(), None);
        write(&data, "notified.json", "{\"ids\":{}}\n", None).unwrap();
        assert_eq!(
            read(&data, "notified.json").unwrap().as_deref(),
            Some("{\"ids\":{}}\n")
        );
        let s = stat(&data, "notified.json").unwrap().unwrap();
        assert_eq!(s.size, 11);
        write(&data, "notified.json", "{\"ids\":{\"a\":1}}\n", None).unwrap();
        let s2 = stat(&data, "notified.json").unwrap().unwrap();
        assert_eq!(s2.size, 16);
        let mut names: Vec<_> = fs::read_dir(&data)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        names.sort();
        assert_eq!(
            names,
            vec![
                "notified.json".to_string(),
                "notified.json.lock".to_string()
            ],
            "no temp files left (the .lock file is the one tick.py uses too)"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_to_a_valid_data_file_of_mine_is_followed_and_stays_a_link() {
        let d = tempfile::tempdir().unwrap();
        let data = d.path().join("data");
        fs::create_dir_all(&data).unwrap();
        let real = d.path().join("real.json");
        fs::write(&real, "{\"ids\":{}}").unwrap();
        std::os::unix::fs::symlink(&real, data.join("notified.json")).unwrap();
        write(&data, "notified.json", "{\"ids\":{\"a\":1}}", None).unwrap();
        assert!(fs::symlink_metadata(data.join("notified.json"))
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read_to_string(&real).unwrap(), "{\"ids\":{\"a\":1}}");
        assert_eq!(
            read(&data, "notified.json").unwrap().as_deref(),
            Some("{\"ids\":{\"a\":1}}")
        );
        // an empty file behind the link is fine too (a fresh Dropbox / iCloud placeholder)
        let empty = d.path().join("empty.json");
        fs::write(&empty, "").unwrap();
        fs::remove_file(data.join("settings.json")).ok();
        std::os::unix::fs::symlink(&empty, data.join("settings.json")).unwrap();
        write(&data, "settings.json", "{}", None).unwrap();
        assert_eq!(fs::read_to_string(&empty).unwrap(), "{}");
        // no temp file is left in either folder
        let leftovers: Vec<_> = fs::read_dir(d.path())
            .unwrap()
            .chain(fs::read_dir(&data).unwrap())
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .filter(|n| n.contains(".tmp-"))
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
    }

    /// The reviewed attack: a planted link data/notified.json -> ~/.zshrc (or any other file) must never be overwritten.
    #[cfg(unix)]
    #[test]
    fn a_planted_link_to_another_file_is_refused_and_the_victim_stays_byte_identical() {
        use std::os::unix::fs::symlink;
        let d = tempfile::tempdir().unwrap();
        let data = d.path().join("data");
        fs::create_dir_all(&data).unwrap();
        let victims: Vec<(&str, Vec<u8>)> = vec![
            ("zshrc", b"export PATH=/bin\nalias ls='ls -G'\n".to_vec()),
            ("notes.txt", b"precious".to_vec()),
            ("other.json", b"{\"hello\":\"world\"}".to_vec()), // JSON, but not a notified file
            ("list.json", b"[1,2,3]".to_vec()),
            ("binary", vec![0xff, 0xfe, 0x00, 0x01]),
        ];
        for (n, content) in &victims {
            let victim = d.path().join(n);
            fs::write(&victim, content).unwrap();
            let link = data.join("notified.json");
            let _ = fs::remove_file(&link);
            symlink(&victim, &link).unwrap();
            let e = write(&data, "notified.json", "{\"ids\":{}}", None).unwrap_err();
            assert!(
                e.contains("not a Agents Bar data file") && e.contains("nothing was written"),
                "{n}: {e}"
            );
            assert_eq!(
                &fs::read(&victim).unwrap(),
                content,
                "{n} must be untouched"
            );
            assert!(fs::symlink_metadata(&link)
                .unwrap()
                .file_type()
                .is_symlink());
            assert!(
                !data.join("notified.json.lock").exists()
                    && !d.path().join(format!("{n}.lock")).exists(),
                "no stray lock file next to the victim"
            );
        }
        // the settings kind is validated as settings: a notified-shaped file is fine for settings, a list is not
        let list = d.path().join("list.json");
        let link = data.join("settings.json");
        symlink(&list, &link).unwrap();
        assert!(write(&data, "settings.json", "{}", None).is_err());
        assert_eq!(fs::read(&list).unwrap(), b"[1,2,3]");
        // a notified link needs a "notified" list, a settings-looking object is not enough
        let obj = d.path().join("obj.json");
        fs::write(&obj, "{\"theme\":\"ocean\"}").unwrap();
        let tl = data.join("notified.json");
        fs::remove_file(&tl).unwrap();
        symlink(&obj, &tl).unwrap();
        assert!(write(&data, "notified.json", "{\"ids\":{}}", None).is_err());
        assert_eq!(fs::read_to_string(&obj).unwrap(), "{\"theme\":\"ocean\"}");
    }

    #[cfg(unix)]
    #[test]
    fn dangling_directory_device_and_fifo_links_are_refused() {
        use std::os::unix::fs::symlink;
        let d = tempfile::tempdir().unwrap();
        let data = d.path().join("data");
        fs::create_dir_all(&data).unwrap();
        let link = data.join("notified.json");
        // dangling
        symlink(d.path().join("nowhere.json"), &link).unwrap();
        assert!(write(&data, "notified.json", "x", None)
            .unwrap_err()
            .contains("does not exist"));
        assert!(
            !d.path().join("nowhere.json").exists(),
            "a dangling link is not written through"
        );
        fs::remove_file(&link).unwrap();
        // a loop
        symlink("notified.json", &link).unwrap();
        assert!(write(&data, "notified.json", "x", None).is_err());
        fs::remove_file(&link).unwrap();
        // directory
        let dd = d.path().join("somedir");
        fs::create_dir_all(&dd).unwrap();
        symlink(&dd, &link).unwrap();
        assert!(write(&data, "notified.json", "x", None)
            .unwrap_err()
            .contains("not a regular file"));
        fs::remove_file(&link).unwrap();
        // device
        symlink("/dev/null", &link).unwrap();
        assert!(write(&data, "notified.json", "x", None)
            .unwrap_err()
            .contains("not a regular file"));
        assert!(fs::metadata("/dev/null").unwrap().len() == 0);
        fs::remove_file(&link).unwrap();
        // fifo
        let fifo = d.path().join("fifo");
        assert!(std::process::Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .map(|s| s.success())
            .unwrap_or(false));
        symlink(&fifo, &link).unwrap();
        assert!(write(&data, "notified.json", "x", None)
            .unwrap_err()
            .contains("not a regular file"));
        // a directory standing where the file should be
        fs::remove_file(&link).unwrap();
        fs::create_dir_all(data.join("notified.json")).unwrap();
        assert!(write(&data, "notified.json", "x", None)
            .unwrap_err()
            .contains("not a regular file"));
    }

    #[cfg(unix)]
    #[test]
    fn a_file_of_another_user_is_refused() {
        use std::os::unix::fs::{symlink, MetadataExt};
        // a file the current user does not own: root-owned files such as /etc/hosts (cannot be created here without root)
        let hosts = Path::new("/etc/hosts");
        let Ok(m) = fs::metadata(hosts) else { return };
        // SAFETY: geteuid has no preconditions.
        if m.uid() == unsafe { libc::geteuid() } {
            return; // running as that owner: nothing to test
        }
        let d = tempfile::tempdir().unwrap();
        symlink(hosts, d.path().join("notified.json")).unwrap();
        let e = write(d.path(), "notified.json", "{\"ids\":{}}", None).unwrap_err();
        assert!(
            e.contains("another user") || e.contains("not a Agents Bar data file"),
            "{e}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_hard_link_is_replaced_not_written_through() {
        let d = tempfile::tempdir().unwrap();
        let data = d.path().join("data");
        fs::create_dir_all(&data).unwrap();
        let victim = d.path().join("victim.txt");
        fs::write(&victim, "precious").unwrap();
        fs::hard_link(&victim, data.join("notified.json")).unwrap();
        write(&data, "notified.json", "{\"ids\":{}}", None).unwrap();
        assert_eq!(
            fs::read_to_string(&victim).unwrap(),
            "precious",
            "the other name of the file is untouched"
        );
        assert_eq!(
            fs::read_to_string(data.join("notified.json")).unwrap(),
            "{\"ids\":{}}"
        );
        use std::os::unix::fs::MetadataExt;
        assert_eq!(
            fs::metadata(data.join("notified.json")).unwrap().nlink(),
            1,
            "the data file is its own file now"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_data_folder_is_followed_and_a_planted_link_inside_it_is_still_refused() {
        use std::os::unix::fs::symlink;
        let d = tempfile::tempdir().unwrap();
        let real_dir = d.path().join("elsewhere");
        fs::create_dir_all(&real_dir).unwrap();
        let data = d.path().join("data-link");
        symlink(&real_dir, &data).unwrap();
        write(&data, "notified.json", "{\"ids\":{}}", None).unwrap();
        assert_eq!(
            fs::read_to_string(real_dir.join("notified.json")).unwrap(),
            "{\"ids\":{}}"
        );
        let victim = d.path().join("zshrc");
        fs::write(&victim, "keep").unwrap();
        fs::remove_file(real_dir.join("notified.json")).unwrap();
        symlink(&victim, real_dir.join("notified.json")).unwrap();
        assert!(write(&data, "notified.json", "{\"ids\":{}}", None).is_err());
        assert_eq!(fs::read_to_string(&victim).unwrap(), "keep");
    }

    /// The target is swapped for another file between validation and the rename: refused.
    #[cfg(unix)]
    #[test]
    fn a_target_that_changes_identity_before_the_rename_is_refused() {
        let d = tempfile::tempdir().unwrap();
        let real = d.path().join("real.json");
        fs::write(&real, "{\"ids\":{}}").unwrap();
        let link = d.path().join("notified.json");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let t = plan_target(&link, "notified.json").unwrap();
        assert_eq!(t.path, real.canonicalize().unwrap());
        assert!(still_same(&t).is_ok());
        // Replace the file with a different one, as an attacker racing the app would. The replacement is created under another
        // name FIRST (the old file still exists, so its inode number cannot be reused) and then renamed over the target.
        let old_id = identity_of(&fs::metadata(&real).unwrap());
        let other = d.path().join("replacement.json");
        fs::write(&other, "{\"ids\":{}}").unwrap();
        let new_id = identity_of(&fs::metadata(&other).unwrap());
        assert_ne!(old_id, new_id, "two live files never share an identity");
        fs::rename(&other, &real).unwrap();
        assert_eq!(identity_of(&fs::metadata(&real).unwrap()), new_id);
        assert!(
            still_same(&t).is_err(),
            "the validated file was replaced by another one: refused"
        );
        let t2 = plan_target(&link, "notified.json").unwrap();
        fs::remove_file(&real).unwrap();
        std::os::unix::fs::symlink(d.path().join("elsewhere.txt"), &real).unwrap();
        assert!(still_same(&t2).is_err(), "swapped for a link: refused");
        fs::remove_file(&real).unwrap();
        assert!(still_same(&t2).is_err(), "gone: refused");
    }

    #[cfg(unix)]
    #[test]
    fn an_aside_file_is_never_written_through_a_link() {
        use std::os::unix::fs::symlink;
        let d = tempfile::tempdir().unwrap();
        let victim = d.path().join("victim.txt");
        fs::write(&victim, "precious").unwrap();
        // the data file itself is the planted link: moving it aside renames the LINK, the victim is untouched
        symlink(&victim, d.path().join("notified.json")).unwrap();
        let n = move_aside(d.path(), "notified.json", "notified.broken-1.json").unwrap();
        assert_eq!(fs::read_to_string(&victim).unwrap(), "precious");
        assert!(
            fs::symlink_metadata(d.path().join(&n))
                .unwrap()
                .file_type()
                .is_symlink(),
            "the link itself was renamed"
        );
        assert!(!d.path().join("notified.json").exists());
        // a planted link where the backup would go is skipped, not followed
        fs::write(d.path().join("notified.json"), "bad").unwrap();
        symlink(&victim, d.path().join("notified.broken-2.json")).unwrap();
        let n2 = move_aside(d.path(), "notified.json", "notified.broken-2.json").unwrap();
        assert_ne!(n2, "notified.broken-2.json");
        assert_eq!(fs::read_to_string(&victim).unwrap(), "precious");
    }

    #[test]
    fn move_aside_keeps_a_backup_under_a_unique_name_and_never_overwrites_one() {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "notified.json", "broken", None).unwrap();
        let first = move_aside(d.path(), "notified.json", "notified.broken-1-abc.json").unwrap();
        assert!(first.starts_with("notified.broken-1-abc-") && first.ends_with(".json"));
        assert!(!d.path().join("notified.json").exists());
        assert_eq!(fs::read_to_string(d.path().join(&first)).unwrap(), "broken");
        write(d.path(), "notified.json", "second", None).unwrap();
        let second = move_aside(d.path(), "notified.json", "notified.broken-1-abc.json").unwrap();
        assert_ne!(first, second);
        assert_eq!(
            fs::read_to_string(d.path().join(&first)).unwrap(),
            "broken",
            "the first backup is untouched"
        );
        assert!(
            move_aside(d.path(), "notified.json", "notified.broken-1-abc.json").is_err(),
            "source is gone now"
        );
        write(d.path(), "notified.json", "third", None).unwrap();
        assert!(move_aside(d.path(), "notified.json", "settings.json").is_err());
        assert_eq!(
            fs::read_to_string(d.path().join("notified.json")).unwrap(),
            "third"
        );
    }

    #[cfg(unix)]
    #[test]
    fn move_aside_never_overwrites_a_dangling_symlink() {
        let d = tempfile::tempdir().unwrap();
        fs::write(d.path().join("notified.json"), "bad").unwrap();
        let victim = d.path().join("nowhere");
        std::os::unix::fs::symlink(&victim, d.path().join("notified.broken-1.json")).unwrap();
        let name = move_aside(d.path(), "notified.json", "notified.broken-1.json").unwrap();
        assert_ne!(name, "notified.broken-1.json");
        assert!(
            !victim.exists(),
            "the symlink target was not created or written"
        );
        assert!(
            fs::symlink_metadata(d.path().join("notified.broken-1.json"))
                .unwrap()
                .file_type()
                .is_symlink()
        );
    }

    #[test]
    fn a_stat_changes_when_the_content_changes_even_within_one_second() {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "notified.json", "aaa", None).unwrap();
        let a = stat(d.path(), "notified.json").unwrap().unwrap();
        write(d.path(), "notified.json", "aaaa", None).unwrap();
        let b = stat(d.path(), "notified.json").unwrap().unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn invalid_utf8_is_an_error_not_a_panic() {
        let d = tempfile::tempdir().unwrap();
        fs::write(d.path().join("notified.json"), [0xff, 0xfe, 0x00]).unwrap();
        assert!(read(d.path(), "notified.json").is_err());
    }

    // ---- round 4: encoding, size, compare-and-swap, locking, read-only, retries

    #[test]
    fn a_utf8_bom_is_dropped_from_the_text_and_the_file_is_untouched() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("notified.json");
        fs::write(&p, b"\xEF\xBB\xBF{\"ids\":{}}").unwrap();
        assert_eq!(
            read(d.path(), "notified.json").unwrap().as_deref(),
            Some("{\"ids\":{}}")
        );
        assert_eq!(fs::read(&p).unwrap(), b"\xEF\xBB\xBF{\"ids\":{}}");
    }

    #[test]
    fn utf16_gives_a_clear_error() {
        let d = tempfile::tempdir().unwrap();
        let bytes: Vec<u8> = [0xFF, 0xFE]
            .into_iter()
            .chain("{\"ids\":{}}".encode_utf16().flat_map(|u| u.to_le_bytes()))
            .collect();
        fs::write(d.path().join("notified.json"), bytes).unwrap();
        let e = read(d.path(), "notified.json").unwrap_err();
        assert!(
            e.contains("not UTF-8 text")
                && e.contains("UTF-16")
                && e.contains("save it again as UTF-8"),
            "{e}"
        );
    }

    #[test]
    fn a_file_over_the_cap_is_an_error_not_a_read() {
        let d = tempfile::tempdir().unwrap();
        let f = fs::File::create(d.path().join("notified.json")).unwrap();
        f.set_len(MAX_READ_BYTES + 1).unwrap(); // sparse: instant
        let e = read(d.path(), "notified.json").unwrap_err();
        assert!(e.contains("larger than 32 MB"), "{e}");
        f.set_len(MAX_READ_BYTES).unwrap();
        assert!(
            read(d.path(), "notified.json").is_ok(),
            "exactly at the cap is still read"
        );
    }

    /// Unix: an external edit that keeps size AND mtime still changes the change time (ctime) or the inode, so the stamp differs.
    #[cfg(unix)]
    fn in_place_edit_is_noticed(p: &Path, fresh: &Stamp) {
        let mt = fs::metadata(p).unwrap().modified().unwrap();
        std::thread::sleep(Duration::from_millis(20));
        fs::write(p, "TWO").unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(p)
            .unwrap()
            .set_modified(mt)
            .unwrap();
        let after = stat(p.parent().unwrap(), "notified.json").unwrap().unwrap();
        assert_eq!((after.size, after.mtime_us), (fresh.size, fresh.mtime_us));
        assert_ne!(&after, fresh, "ctime (or inode) tells the two apart");
    }

    /// Windows has no inode and its ctime is the CREATION time, so an in-place rewrite that keeps size and mtime is a known
    /// blind spot of the stamp (it is only noticed if the size or the mtime moves; the transcripts have their own head-bytes
    /// check). What must hold: a change of size, or of mtime set explicitly, is noticed.
    #[cfg(not(unix))]
    fn in_place_edit_is_noticed(p: &Path, fresh: &Stamp) {
        fs::write(p, "TWO!").unwrap(); // other size
        let after = stat(p.parent().unwrap(), "notified.json").unwrap().unwrap();
        assert_ne!(&after, fresh, "a different size is noticed");
        let same_size = fs::File::options().write(true).open(p).unwrap();
        same_size
            .set_modified(std::time::UNIX_EPOCH + Duration::from_secs(1_000_000_000))
            .unwrap(); // other mtime, set explicitly
        drop(same_size);
        let moved = stat(p.parent().unwrap(), "notified.json").unwrap().unwrap();
        assert_ne!(
            moved.mtime_us, after.mtime_us,
            "a different mtime is noticed"
        );
    }

    #[test]
    fn compare_and_swap_refuses_when_the_file_changed() {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "notified.json", "one", Some(None)).unwrap(); // must not exist: ok
        assert_eq!(
            write(d.path(), "notified.json", "x", Some(None)).unwrap_err(),
            CONFLICT
        );
        let seen = stat(d.path(), "notified.json").unwrap().unwrap();
        write(d.path(), "notified.json", "two", Some(Some(seen.clone()))).unwrap();
        assert_eq!(
            write(d.path(), "notified.json", "three", Some(Some(seen))).unwrap_err(),
            CONFLICT,
            "the stamp is stale now"
        );
        assert_eq!(
            read(d.path(), "notified.json").unwrap().as_deref(),
            Some("two")
        );
        let fresh = stat(d.path(), "notified.json").unwrap().unwrap();
        let p = d.path().join("notified.json");
        in_place_edit_is_noticed(&p, &fresh);
        assert_eq!(
            write(d.path(), "notified.json", "four", Some(Some(fresh))).unwrap_err(),
            CONFLICT
        );
        write(d.path(), "notified.json", "five", None).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_read_only_file_is_refused_and_left_alone() {
        use std::os::unix::fs::PermissionsExt;
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "notified.json", "a", None).unwrap();
        let p = d.path().join("notified.json");
        fs::set_permissions(&p, fs::Permissions::from_mode(0o444)).unwrap();
        let e = write(d.path(), "notified.json", "b", None).unwrap_err();
        assert!(e.contains("read-only"), "{e}");
        assert_eq!(fs::read_to_string(&p).unwrap(), "a");
        assert_eq!(
            fs::metadata(&p).unwrap().permissions().mode() & 0o777,
            0o444
        );
    }

    #[test]
    fn transient_errors_are_retried_with_backoff_and_others_are_not() {
        use std::io::{Error, ErrorKind};
        let mut slept = Vec::new();
        let mut n = 0;
        let r = retry_transient(
            || {
                n += 1;
                if n < 4 {
                    Err(Error::from(ErrorKind::PermissionDenied))
                } else {
                    Ok(n)
                }
            },
            &RETRY_DELAYS_MS,
            |d| slept.push(d.as_millis() as u64),
        );
        assert_eq!(r.unwrap(), 4);
        assert_eq!(slept, vec![20, 50, 100]);
        // gives up after five retries
        let mut slept = Vec::new();
        let r: std::io::Result<()> = retry_transient(
            || Err(Error::from(ErrorKind::PermissionDenied)),
            &RETRY_DELAYS_MS,
            |d| slept.push(d.as_millis() as u64),
        );
        assert!(r.is_err());
        assert_eq!(slept, vec![20, 50, 100, 200, 400]);
        // an error that is not transient is returned at once
        let mut slept = Vec::new();
        let r: std::io::Result<()> = retry_transient(
            || Err(Error::from(ErrorKind::NotFound)),
            &RETRY_DELAYS_MS,
            |d| slept.push(d.as_millis() as u64),
        );
        assert!(r.is_err() && slept.is_empty());
        #[cfg(windows)]
        {
            assert!(is_transient(&Error::from_raw_os_error(32)));
            assert!(is_transient(&Error::from_raw_os_error(5)));
        }
    }

    // ---- stamps survive JSON exactly

    struct XorShift(u64);
    impl XorShift {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }
    }

    #[test]
    fn two_hundred_thousand_random_stamps_come_back_identical_through_json() {
        let mut r = XorShift(0x9E37_79B9_7F4A_7C15);
        for i in 0..200_000u32 {
            let stamp = Stamp {
                size: r.next() % (1u64 << 40),
                // realistic file times: 2001 .. 2100, any microsecond; also the odd far-past and far-future one
                mtime_us: if i % 1000 == 0 {
                    -((r.next() % (1 << 50)) as i64)
                } else {
                    1_000_000_000_000_000 + (r.next() % 3_000_000_000_000_000) as i64
                },
                ctime_us: 1_000_000_000_000_000 + (r.next() % 3_000_000_000_000_000) as i64,
                ino: (r.next() % (1u64 << 60)).to_string(),
            };
            let json = serde_json::to_string(&stamp).unwrap();
            let back: Stamp = serde_json::from_str(&json).unwrap();
            assert_eq!(back, stamp, "{json}");
            // the page parses it with JSON.parse (a double) and writes it back: integers below 2^53 are exact there
            assert!(
                stamp.mtime_us.unsigned_abs() < (1u64 << 53)
                    && stamp.ctime_us.unsigned_abs() < (1u64 << 53)
            );
            let via_f64 = stamp.mtime_us as f64 as i64;
            assert_eq!(via_f64, stamp.mtime_us);
        }
    }

    /// Save after save with the stamp the previous call returned (after a trip through JSON, as the page does): never a conflict.
    #[test]
    fn save_after_save_with_the_returned_stamp_never_conflicts() {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "notified.json", "{\"ids\":{}}", Some(None)).unwrap();
        let mut seen = stat(d.path(), "notified.json").unwrap();
        for i in 0..2000 {
            let seen_json = serde_json::to_string(&seen).unwrap();
            let expected: Option<Stamp> = serde_json::from_str(&seen_json).unwrap();
            write(
                d.path(),
                "notified.json",
                &format!("{{\"ids\":{{}},\"n\":{i}}}"),
                Some(expected),
            )
            .unwrap_or_else(|e| panic!("iteration {i}: {e}"));
            seen = stat(d.path(), "notified.json").unwrap();
        }
        assert_eq!(
            read(d.path(), "notified.json").unwrap().unwrap(),
            "{\"ids\":{},\"n\":1999}"
        );
    }

    // ---- special files must not block the app

    #[cfg(unix)]
    fn mkfifo(p: &Path) {
        let c = std::ffi::CString::new(p.to_str().unwrap()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
    }

    /// Runs `f` on a thread and fails (instead of hanging the test run) when it does not return in 10 s.
    #[cfg(unix)]
    fn within_10s<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> T {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(f());
        });
        rx.recv_timeout(Duration::from_secs(10))
            .expect("the call blocked on a special file")
    }

    #[cfg(unix)]
    #[test]
    fn a_fifo_named_like_a_data_file_is_refused_not_waited_on() {
        let d = tempfile::tempdir().unwrap();
        for name in ["notified.json", "settings.json"] {
            mkfifo(&d.path().join(name));
            let dir = d.path().to_path_buf();
            let e = within_10s(move || read(&dir, name)).unwrap_err();
            assert!(e.contains("not a regular file"), "{name}: {e}");
            let dir = d.path().to_path_buf();
            assert!(
                within_10s(move || stat(&dir, name)).is_ok(),
                "stat of a FIFO does not block"
            );
            let dir = d.path().to_path_buf();
            let w = within_10s(move || write(&dir, name, "{}", None)).unwrap_err();
            assert!(w.contains("not a regular file"), "{name}: {w}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_fifo_planted_as_the_lock_file_does_not_block_a_write() {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "notified.json", "{\"ids\":{}}", None).unwrap();
        let lock = d.path().join("notified.json.lock");
        fs::remove_file(&lock).ok();
        mkfifo(&lock);
        let dir = d.path().to_path_buf();
        within_10s(move || write(&dir, "notified.json", "{\"ids\":{\"a\":1}}", None)).unwrap();
        assert_eq!(
            read(d.path(), "notified.json").unwrap().as_deref(),
            Some("{\"ids\":{\"a\":1}}")
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_link_to_a_fifo_is_refused_for_reading_and_writing() {
        let d = tempfile::tempdir().unwrap();
        let fifo = d.path().join("elsewhere");
        mkfifo(&fifo);
        std::os::unix::fs::symlink(&fifo, d.path().join("notified.json")).unwrap();
        let dir = d.path().to_path_buf();
        assert!(within_10s(move || read(&dir, "notified.json")).is_err());
        let dir = d.path().to_path_buf();
        assert!(within_10s(move || write(&dir, "notified.json", "{}", None)).is_err());
    }
}
