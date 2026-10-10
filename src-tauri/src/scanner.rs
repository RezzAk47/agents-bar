//! The incremental transcript reader. Rust owns every byte read from the transcript folders; the page owns the meaning.
//!
//! Split (decided once, documented in the README): this file walks the folders, keeps per-file offsets, splits lines
//! (4 MB line cap with skip that survives across calls, a half-written last line waits), detects replaced or truncated
//! files, and "slims" each record to the fields the page uses. All parsing into states, steps, tokens and percent is
//! TypeScript (src/core/transcripts.ts), the single source of truth, tested with the same fixtures
//! (tests/fixtures/transcripts -> tests/fixtures/slim).
//! Transcripts are only ever opened for reading, symlinks (files and folders) are not followed, and only regular files are
//! opened (a FIFO or device named like a transcript is ignored, never waited on).
//!
//! What crosses into the page, exactly: timestamps and record types, tool names and ids, token counts, the lines of agent
//! replies that start with `PROGRESS`, for Codex ONE text per file (the first user prompt that is not injected context, at
//! most 200 characters), and per Claude subagent the `description` and `agentType` of its `.meta.json`. Nothing else from
//! any message body, tool input or tool output.

use std::collections::HashMap;
use std::fs::{self, Metadata};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{json, Map, Value};

pub const LOOKBACK_MS: i64 = 24 * 3600 * 1000;
pub const MAX_FILES: usize = 300; // per tool: only the newest transcripts inside the lookback
pub const MAX_LINE: usize = 4 * 1024 * 1024; // a single line longer than this is skipped, so memory stays bounded
pub const FILE_BUDGET: u64 = 4 * 1024 * 1024; // raw bytes read from one file per call; the rest comes with the next call
pub const CALL_BUDGET: u64 = 8 * 1024 * 1024; // raw bytes read in all files per call
pub const MAX_WALK_ENTRIES: usize = 200_000; // a runaway folder tree never keeps the walk busy
const HEAD_BYTES: usize = 64;
const META_MAX: u64 = 64 * 1024;
const PROGRESS_KEEP: usize = 400; // characters kept after the PROGRESS marker of a report line
const TITLE_KEEP: usize = 200; // the one Codex prompt text that is sent, in characters
const META_KEEP: usize = 400;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Claude,
    Codex,
}

/// What is remembered of one transcript between calls.
struct FileState {
    kind: Kind,
    ino: u64,
    head: Vec<u8>,
    offset: u64,
    mtime_ms: i64,
    size: u64,
    meta_mtime: Option<i64>,
    /// Inside a line longer than MAX_LINE: everything up to the next newline is being thrown away (`offset` already counts it).
    skipping: bool,
    /// The Codex prompt text has been sent for this file.
    title_sent: bool,
}

#[derive(Clone, Debug)]
struct Known {
    path: PathBuf,
    kind: Kind,
    mtime_ms: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileOut {
    pub path: String,
    pub kind: Kind,
    pub mtime_ms: f64,
    pub reset: bool,
    pub records: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meta: Option<Option<Value>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownOut {
    pub path: String,
    pub kind: Kind,
    pub mtime_ms: f64,
}

#[derive(Serialize)]
pub struct Reply {
    pub files: Vec<FileOut>,
    pub known: Vec<KnownOut>,
    /// True while a pass is incomplete: the call budget ran out before every file was read to its end. The page must not
    /// judge states (or finishes) from an incomplete pass. A giant line being skipped across calls does not hold a pass open.
    pub more: bool,
}

pub struct Scanner {
    claude_root: PathBuf,
    codex_root: PathBuf,
    known: Vec<Known>,
    states: HashMap<PathBuf, FileState>,
    walked: bool,
    pub file_budget: u64,
    pub call_budget: u64,
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn mtime_of(m: &Metadata) -> i64 {
    m.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(unix)]
fn ino_of(m: &Metadata) -> u64 {
    use std::os::unix::fs::MetadataExt;
    m.ino()
}
#[cfg(not(unix))]
fn ino_of(_m: &Metadata) -> u64 {
    0 // Windows: replacement is caught by the head bytes and the size instead
}

/// A real directory (not a link to one), looked at without following links.
fn is_real_dir(p: &Path) -> bool {
    fs::symlink_metadata(p).map(|m| m.is_dir()).unwrap_or(false)
}

/// A folder that is not there (or is not a folder) is simply empty; any other error (access denied, an I/O hiccup, a
/// sharing violation) may pass in a moment, so the folder is noted in `failed` and keeps what it held at the last walk.
fn read_dir_noting(dir: &Path, failed: &mut Vec<PathBuf>) -> Option<fs::ReadDir> {
    match fs::read_dir(dir) {
        Ok(rd) => Some(rd),
        Err(e) => {
            if e.kind() != std::io::ErrorKind::NotFound && !dir.is_file() {
                failed.push(dir.to_path_buf());
            }
            None
        }
    }
}

fn sub_dirs(dir: &Path, budget: &mut usize, failed: &mut Vec<PathBuf>) -> Vec<PathBuf> {
    let Some(rd) = read_dir_noting(dir, failed) else {
        return vec![];
    };
    let mut out = vec![];
    for e in rd.flatten() {
        if *budget == 0 {
            break;
        }
        *budget -= 1;
        if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            out.push(e.path()); // file_type() of a DirEntry does not follow links: a symlinked folder is not a dir here
        }
    }
    out
}

fn files_in(
    dir: &Path,
    prefix: &str,
    budget: &mut usize,
    now: i64,
    out: &mut Vec<Known>,
    kind: Kind,
    failed: &mut Vec<PathBuf>,
) {
    if !is_real_dir(dir) {
        return; // a symlinked `subagents` folder (or a missing one) is not read
    }
    let Some(rd) = read_dir_noting(dir, failed) else {
        return;
    };
    for e in rd.flatten() {
        if *budget == 0 {
            break;
        }
        *budget -= 1;
        let name = e.file_name();
        let Some(name) = name.to_str() else { continue };
        if !name.starts_with(prefix) || !name.ends_with(".jsonl") {
            continue;
        }
        let Ok(m) = fs::symlink_metadata(e.path()) else {
            continue;
        };
        if !m.is_file() {
            continue; // a symlink, FIFO or anything odd is not read
        }
        let mt = mtime_of(&m);
        if now - mt <= LOOKBACK_MS {
            out.push(Known {
                path: e.path(),
                kind,
                mtime_ms: mt,
            });
        }
    }
}

fn cap_newest(mut v: Vec<Known>) -> Vec<Known> {
    v.sort_by(|a, b| {
        b.mtime_ms
            .cmp(&a.mtime_ms)
            .then_with(|| a.path.cmp(&b.path))
    });
    v.truncate(MAX_FILES);
    v
}

impl Scanner {
    pub fn new(claude_root: PathBuf, codex_root: PathBuf) -> Scanner {
        Scanner {
            claude_root,
            codex_root,
            known: vec![],
            states: HashMap::new(),
            walked: false,
            file_budget: FILE_BUDGET,
            call_budget: CALL_BUDGET,
        }
    }

    /// The full folder walk (the costly part): claude `<root>/*/*/subagents/agent-*.jsonl`, codex `<root>/*/*/*/rollout-*.jsonl`.
    fn discover(&mut self, now: i64) {
        let mut budget = MAX_WALK_ENTRIES;
        let mut failed: Vec<PathBuf> = vec![];
        let mut claude = vec![];
        for project in sub_dirs(&self.claude_root, &mut budget, &mut failed) {
            for session in sub_dirs(&project, &mut budget, &mut failed) {
                files_in(
                    &session.join("subagents"),
                    "agent-",
                    &mut budget,
                    now,
                    &mut claude,
                    Kind::Claude,
                    &mut failed,
                );
            }
        }
        let mut codex = vec![];
        for y in sub_dirs(&self.codex_root, &mut budget, &mut failed) {
            for m in sub_dirs(&y, &mut budget, &mut failed) {
                for d in sub_dirs(&m, &mut budget, &mut failed) {
                    files_in(
                        &d,
                        "rollout-",
                        &mut budget,
                        now,
                        &mut codex,
                        Kind::Codex,
                        &mut failed,
                    );
                }
            }
        }
        // a folder that could not be read for a moment keeps the files it held at the last walk, until the next walk
        for old in &self.known {
            if failed.iter().any(|f| old.path.starts_with(f)) {
                match old.kind {
                    Kind::Claude => claude.push(old.clone()),
                    Kind::Codex => codex.push(old.clone()),
                }
            }
        }
        let mut all = cap_newest(codex);
        all.extend(cap_newest(claude));
        self.known = all;
        self.walked = true;
    }

    /// Paths the page may ask to reveal: only what this scanner found.
    pub fn is_known(&self, path: &str) -> bool {
        self.known.iter().any(|k| k.path.to_str() == Some(path))
    }

    /// One call. `rediscover` runs the folder walk; otherwise only the known files are looked at (one stat each).
    pub fn scan(&mut self, now: i64, rediscover: bool) -> Reply {
        if rediscover || !self.walked {
            self.discover(now);
        }
        let mut files = vec![];
        let mut more = false;
        let mut spent: u64 = 0;
        let mut gone = vec![];
        let known = self.known.clone();
        for k in &known {
            let m = match fs::symlink_metadata(&k.path) {
                Ok(m) => m,
                // only a file that is really not there is gone; access denied or a sharing violation (a virus scanner, an
                // indexer) lasts a moment, and the file must not vanish from the list or be read again from the start
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    gone.push(k.path.clone());
                    continue;
                }
                Err(_) => continue,
            };
            if !m.is_file() {
                gone.push(k.path.clone());
                continue;
            }
            if now - mtime_of(&m) > LOOKBACK_MS {
                continue;
            }
            if spent >= self.call_budget {
                more = true; // this file is not even looked at in this call
                continue;
            }
            if let Some((out, used, partial)) = self.read_file(k, &m) {
                spent += used;
                more |= partial;
                if let Some(o) = out {
                    files.push(o);
                }
            }
        }
        if !gone.is_empty() {
            self.known.retain(|k| !gone.contains(&k.path));
            for g in &gone {
                self.states.remove(g);
            }
        }
        // forget the state of files that are no longer known
        let live: std::collections::HashSet<&PathBuf> =
            self.known.iter().map(|k| &k.path).collect();
        self.states.retain(|p, _| live.contains(p));
        let known_out = self
            .known
            .iter()
            .map(|k| KnownOut {
                path: k.path.to_string_lossy().into_owned(),
                kind: k.kind,
                mtime_ms: k.mtime_ms as f64,
            })
            .collect();
        Reply {
            files,
            known: known_out,
            more,
        }
    }

    /// Reads what is new in one file. Returns (output if anything changed, raw bytes read, a pass-holding remainder).
    fn read_file(&mut self, k: &Known, m: &Metadata) -> Option<(Option<FileOut>, u64, bool)> {
        let mtime = mtime_of(m);
        let size = m.len();
        let ino = ino_of(m);
        let meta_mtime_now = if k.kind == Kind::Claude {
            meta_mtime(&k.path)
        } else {
            None
        };
        let st = self.states.get(&k.path);
        let meta_changed =
            k.kind == Kind::Claude && st.map(|s| s.meta_mtime) != Some(meta_mtime_now);
        if let Some(s) = st {
            if s.offset == size
                && s.mtime_ms == mtime
                && s.size == size
                && s.ino == ino
                && !meta_changed
            {
                return Some((None, 0, false)); // nothing new: one stat was all it cost
            }
        }
        let mut f = crate::files::open_regular(&k.path, false).ok()?;
        let mut head = vec![0u8; HEAD_BYTES.min(size as usize)];
        f.read_exact(&mut head).ok()?;
        let reset = match st {
            None => true,
            Some(s) => {
                s.ino != ino
                    || s.kind != k.kind
                    || size < s.offset
                    || s.head != head
                        && s.head.len() <= head.len()
                        && s.head[..] != head[..s.head.len()]
            }
        };
        let (start, skipping, title_sent) = if reset {
            (0, false, false)
        } else {
            st.map(|s| (s.offset, s.skipping, s.title_sent))
                .unwrap_or((0, false, false))
        };
        f.seek(SeekFrom::Start(start)).ok()?;
        let mut run = Run {
            offset: start,
            skipping,
            title_sent,
            budget: self.file_budget,
        };
        let out = read_lines(f, k.kind, &mut run);
        let changed = reset
            || !out.records.is_empty()
            || st.map(|s| s.mtime_ms != mtime).unwrap_or(true)
            || meta_changed;
        let hold = out.budget_hit && !run.skipping; // a skip in progress produces nothing until the line ends: it does not hold a pass open
        self.states.insert(
            k.path.clone(),
            FileState {
                kind: k.kind,
                ino,
                head: head.clone(),
                offset: run.offset,
                mtime_ms: if out.budget_hit { -1 } else { mtime },
                size: if out.budget_hit { 0 } else { size },
                meta_mtime: meta_mtime_now,
                skipping: run.skipping,
                title_sent: run.title_sent,
            },
        );
        let meta = if meta_changed || reset {
            match if k.kind == Kind::Claude {
                read_meta(&k.path)
            } else {
                MetaRead::Unchanged
            } {
                MetaRead::Value(v) => Some(Some(v)),
                MetaRead::Missing => Some(None),
                MetaRead::Unchanged => None,
            }
        } else {
            None
        };
        let file_out = changed.then(|| FileOut {
            path: k.path.to_string_lossy().into_owned(),
            kind: k.kind,
            mtime_ms: mtime as f64,
            reset,
            records: out.records,
            meta,
        });
        Some((file_out, out.used, hold))
    }
}

enum MetaRead {
    Value(Value),
    Missing,
    Unchanged,
}

fn meta_path(p: &Path) -> PathBuf {
    p.with_extension("meta.json")
}

fn meta_mtime(p: &Path) -> Option<i64> {
    fs::symlink_metadata(meta_path(p))
        .ok()
        .filter(|m| m.is_file())
        .map(|m| mtime_of(&m))
}

/// How the Mac code shows a `.meta.json` value: strings as they are, null as nothing, other JSON values as their text
/// (Python prints True/False; objects and lists are their JSON text here, where Python prints its own repr).
fn meta_text(v: &Value) -> Option<Value> {
    let t = match v {
        Value::Null => return None,
        Value::String(s) => s.clone(),
        Value::Bool(true) => "True".to_string(),
        Value::Bool(false) => "False".to_string(),
        other => other.to_string(),
    };
    Some(Value::String(t.chars().take(META_KEEP).collect()))
}

/// The sibling `.meta.json`, only the two fields the page uses; a missing, huge, odd or non-regular file is "no meta".
fn read_meta(p: &Path) -> MetaRead {
    let mp = meta_path(p);
    let Ok(m) = fs::symlink_metadata(&mp) else {
        return MetaRead::Missing;
    };
    if !m.is_file() || m.len() > META_MAX {
        return MetaRead::Missing;
    }
    let Ok(mut f) = crate::files::open_regular(&mp, false) else {
        return MetaRead::Missing;
    };
    let mut text = String::new();
    if (&mut f)
        .take(META_MAX + 1)
        .read_to_string(&mut text)
        .is_err()
    {
        return MetaRead::Missing;
    }
    match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(o)) => {
            let mut out = Map::new();
            for key in ["agentType", "description"] {
                if let Some(v) = o.get(key).and_then(meta_text) {
                    out.insert(key.into(), v);
                }
            }
            MetaRead::Value(Value::Object(out))
        }
        _ => MetaRead::Missing,
    }
}

/// The mutable position of one read: where the next unread byte is, whether a giant line is being skipped, whether the
/// Codex title was already sent, and how many raw bytes may still be read.
pub struct Run {
    pub offset: u64,
    pub skipping: bool,
    pub title_sent: bool,
    pub budget: u64,
}

pub struct ReadOut {
    pub records: Vec<Value>,
    pub used: u64,
    /// The budget ended the read (more may be waiting in the file).
    pub budget_hit: bool,
}

/// Complete lines from `run.offset` on. A line still being written (no newline yet, not valid JSON) is left for the next
/// call; a line longer than MAX_LINE is skipped without holding it in memory, and the skip is counted against the budget
/// and remembered in `run.skipping`, so a huge file without newlines costs O(budget) per call, not a full re-read.
pub fn read_lines<R: Read>(src: R, kind: Kind, run: &mut Run) -> ReadOut {
    let mut r = BufReader::with_capacity(256 * 1024, src);
    let mut out = ReadOut {
        records: vec![],
        used: 0,
        budget_hit: false,
    };
    let mut buf: Vec<u8> = Vec::new();
    loop {
        if out.used >= run.budget {
            out.budget_hit = true;
            return out;
        }
        if run.skipping {
            // throw away up to the next newline, 64 KB at a time
            buf.clear();
            match (&mut r).take(1 << 16).read_until(b'\n', &mut buf) {
                Ok(0) | Err(_) => return out, // end of file: still inside the giant line, look again next time
                Ok(n) => {
                    run.offset += n as u64;
                    out.used += n as u64;
                    if buf.ends_with(b"\n") {
                        run.skipping = false;
                    }
                }
            }
            continue;
        }
        buf.clear();
        let n = match (&mut r)
            .take(MAX_LINE as u64 + 1)
            .read_until(b'\n', &mut buf)
        {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        let complete = buf.ends_with(b"\n");
        if n > MAX_LINE && !complete {
            run.offset += n as u64; // an enormous line: its first MAX_LINE bytes are dropped, the rest is skipped as it is read
            out.used += n as u64;
            run.skipping = true;
            continue;
        }
        match serde_json::from_str::<Value>(&String::from_utf8_lossy(&buf)) {
            Ok(v) => {
                run.offset += n as u64;
                out.used += n as u64;
                if v.is_object() {
                    out.records.push(slim(kind, &v, &mut run.title_sent));
                }
            }
            Err(_) => {
                if !complete {
                    break; // half-written last line: wait for the rest
                }
                // not JSON, or nested deeper than serde_json's recursion limit: skip this line, never the whole file
                run.offset += n as u64;
                out.used += n as u64;
            }
        }
    }
    out
}

// ---- slimming: the same record shape, only the fields transcripts.ts reads --------------------------------------

fn s<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

fn cut(text: &str, n: usize) -> String {
    text.chars().take(n).collect()
}

fn is_report_prefix(c: char) -> bool {
    matches!(c, ' ' | '\t' | '>' | '*' | '_' | '`' | '-')
}

/// The report lines of a text, exactly the ones the page's matcher would accept: a line (split on `\n` only) whose text before
/// the first `PROGRESS` is nothing but `[ \t>*_`-]`. Only `PROGRESS...` (at most PROGRESS_KEEP characters) is kept, so
/// neither a long prefix nor a long answer can hide or leak anything.
fn progress_lines(text: &str) -> String {
    let mut out: Vec<String> = vec![];
    for line in text.split('\n') {
        let Some(at) = line.find("PROGRESS") else {
            continue;
        };
        if line[..at].chars().all(is_report_prefix) {
            out.push(cut(&line[at..], PROGRESS_KEEP));
        }
    }
    out.join("\n")
}

fn copy(into: &mut Map<String, Value>, from: &Value, keys: &[&str]) {
    for k in keys {
        if let Some(v) = from.get(*k) {
            into.insert((*k).into(), v.clone());
        }
    }
}

fn usage_of(u: &Value) -> Option<Value> {
    if !u.is_object() {
        return None;
    }
    let mut o = Map::new();
    copy(
        &mut o,
        u,
        &[
            "input_tokens",
            "output_tokens",
            "cache_creation_input_tokens",
            "cache_read_input_tokens",
        ],
    );
    Some(Value::Object(o))
}

fn slim_claude(d: &Value) -> Value {
    let mut o = Map::new();
    copy(&mut o, d, &["timestamp", "type", "requestId"]);
    let ty = s(d, "type");
    if ty == Some("assistant") || ty == Some("user") {
        if let Some(msg) = d.get("message").filter(|m| m.is_object()) {
            let mut m = Map::new();
            copy(&mut m, msg, &["id"]);
            if ty == Some("assistant") {
                if let Some(u) = msg.get("usage").and_then(usage_of) {
                    m.insert("usage".into(), u);
                }
            }
            if let Some(Value::Array(blocks)) = msg.get("content") {
                let mut out = vec![];
                for b in blocks.iter().filter(|b| b.is_object()) {
                    let bt = s(b, "type");
                    let mut nb = Map::new();
                    copy(&mut nb, b, &["type"]);
                    match bt {
                        Some("text") if ty == Some("assistant") => {
                            if let Some(t) = s(b, "text") {
                                nb.insert("text".into(), Value::String(progress_lines(t)));
                            }
                        }
                        Some("tool_use") => {
                            if let Some(n) = b.get("name").filter(|v| v.is_string()) {
                                nb.insert("name".into(), n.clone());
                            }
                            if let Some(i) = b.get("id").filter(|v| v.is_string()) {
                                nb.insert("id".into(), i.clone());
                            }
                        }
                        Some("tool_result") => {
                            if let Some(i) = b.get("tool_use_id").filter(|v| v.is_string()) {
                                nb.insert("tool_use_id".into(), i.clone());
                            }
                        }
                        _ => {}
                    }
                    out.push(Value::Object(nb));
                }
                m.insert("content".into(), Value::Array(out));
            }
            o.insert("message".into(), Value::Object(m));
        }
    }
    Value::Object(o)
}

/// Codex puts AGENTS.md and environment context in as user messages; they are not the prompt (same rule as the page).
fn injected(text: &str) -> bool {
    text.starts_with('<') || text.starts_with("# AGENTS.md") || text.contains("<INSTRUCTIONS>")
}

/// One line of text from anything: control characters become spaces, white space collapses, at most `n` characters.
fn one_line(text: &str, n: usize) -> String {
    let spaced: String = text
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    cut(&spaced.split_whitespace().collect::<Vec<_>>().join(" "), n)
}

/// A truthy non-string value stands in as `true`: the page only asks "is there a name", Python-style (`"" [] {} 0 null false` are none).
fn truthy_marker(v: &Value) -> Option<Value> {
    match v {
        Value::String(_) => Some(v.clone()),
        Value::Null | Value::Bool(false) => None,
        Value::Number(n) if n.as_f64() == Some(0.0) => None,
        Value::Array(a) if a.is_empty() => None,
        Value::Object(o) if o.is_empty() => None,
        _ => Some(Value::Bool(true)),
    }
}

fn slim_codex(d: &Value, title_sent: &mut bool) -> Value {
    let mut o = Map::new();
    copy(&mut o, d, &["timestamp", "type"]);
    if let Some(p) = d.get("payload").filter(|p| p.is_object()) {
        let mut np = Map::new();
        copy(&mut np, p, &["type", "role"]);
        if let Some(v) = p.get("call_id").filter(|v| v.is_string()) {
            np.insert("call_id".into(), v.clone());
        }
        if let Some(v) = p.get("name").and_then(truthy_marker) {
            np.insert("name".into(), v);
        }
        if let Some(a) = p.get("action").filter(|a| a.is_object()) {
            if let Some(t) = a.get("type").filter(|t| t.is_string()) {
                np.insert("action".into(), json!({ "type": t }));
            }
        }
        if let Some(total) = p
            .get("info")
            .and_then(|i| i.get("total_token_usage"))
            .and_then(|t| {
                if !t.is_object() {
                    return None;
                }
                let mut o = Map::new();
                copy(
                    &mut o,
                    t,
                    &[
                        "input_tokens",
                        "output_tokens",
                        "cached_input_tokens",
                        "cache_write_input_tokens",
                    ],
                );
                Some(Value::Object(o))
            })
        {
            np.insert("info".into(), json!({ "total_token_usage": total }));
        }
        if s(d, "type") == Some("response_item") && s(p, "type") == Some("message") {
            if let Some(Value::Array(blocks)) = p.get("content") {
                let role = s(p, "role");
                let mut out = vec![];
                for b in blocks.iter().filter(|b| b.is_object()) {
                    let mut nb = Map::new();
                    if let Some(t) = s(b, "text") {
                        if role == Some("assistant") {
                            nb.insert("text".into(), Value::String(progress_lines(t)));
                        } else if role == Some("user") && !*title_sent {
                            let trimmed = t.trim();
                            if !trimmed.is_empty() && !injected(trimmed) {
                                *title_sent = true; // the first real prompt, once per file; later turns are never sent
                                nb.insert(
                                    "text".into(),
                                    Value::String(one_line(trimmed, TITLE_KEEP)),
                                );
                            }
                        }
                    }
                    out.push(Value::Object(nb));
                }
                np.insert("content".into(), Value::Array(out));
            }
        }
        o.insert("payload".into(), Value::Object(np));
    }
    Value::Object(o)
}

pub fn slim(kind: Kind, d: &Value, title_sent: &mut bool) -> Value {
    match kind {
        Kind::Claude => slim_claude(d),
        Kind::Codex => slim_codex(d, title_sent),
    }
}

/// Transcript roots: AGENTSBAR_CLAUDE_DIR / AGENTSBAR_CODEX_DIR override the per-OS defaults
/// (`<home>/.claude/projects` and `<home>/.codex/sessions`; home is USERPROFILE on Windows, HOME elsewhere).
pub fn roots(env: &dyn Fn(&str) -> Option<String>, home: &str) -> (PathBuf, PathBuf) {
    let pick = |name: &str, rel: &[&str]| -> PathBuf {
        match env(name).filter(|v| !v.trim().is_empty()) {
            Some(v) => PathBuf::from(v),
            None => rel.iter().fold(PathBuf::from(home), |p, part| p.join(part)),
        }
    };
    (
        pick("AGENTSBAR_CLAUDE_DIR", &[".claude", "projects"]),
        pick("AGENTSBAR_CODEX_DIR", &[".codex", "sessions"]),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;

    /// Test helper with the old shape: (records, new offset, bytes used, budget hit).
    fn read_lines_t<R: Read>(
        src: R,
        offset: u64,
        kind: Kind,
        budget: u64,
    ) -> (Vec<Value>, u64, u64, bool) {
        let mut run = Run {
            offset,
            skipping: false,
            title_sent: false,
            budget,
        };
        let o = read_lines(src, kind, &mut run);
        (o.records, run.offset, o.used, o.budget_hit)
    }
    use std::io::{Cursor, Write};

    fn line(ts: i64, extra: &str) -> String {
        format!(
            "{{\"type\":\"assistant\",\"timestamp\":\"2026-01-01T00:00:{:02}Z\"{extra}}}\n",
            ts % 60
        )
    }

    fn claude_dir(root: &Path, project: &str, session: &str, name: &str, body: &str) -> PathBuf {
        let d = root.join(project).join(session).join("subagents");
        fs::create_dir_all(&d).unwrap();
        let p = d.join(name);
        fs::write(&p, body).unwrap();
        p
    }

    fn set_mtime(p: &Path, ms_ago: i64) {
        let t = SystemTime::now() - std::time::Duration::from_millis(ms_ago as u64);
        File::options()
            .write(true)
            .open(p)
            .unwrap()
            .set_modified(t)
            .unwrap();
    }

    // ---- line splitting -------------------------------------------------------------------------------------------

    #[test]
    fn complete_lines_are_read_and_a_half_written_last_line_waits() {
        let text = format!(
            "{}{}{{\"type\":\"assistant\",\"timest",
            line(1, ""),
            line(2, "")
        );
        let (recs, off, _, more) =
            read_lines_t(Cursor::new(text.as_bytes()), 0, Kind::Claude, u64::MAX);
        assert_eq!(recs.len(), 2);
        assert_eq!(off as usize, line(1, "").len() * 2);
        assert!(!more);
        // the rest arrives: read from the saved offset
        let full = format!("{text}amp\":\"2026-01-01T00:00:03Z\"}}\n");
        let (recs2, off2, _, _) = read_lines_t(
            Cursor::new(&full.as_bytes()[off as usize..]),
            off,
            Kind::Claude,
            u64::MAX,
        );
        assert_eq!(recs2.len(), 1);
        assert_eq!(off2 as usize, full.len());
    }

    #[test]
    fn bad_complete_lines_and_non_objects_are_skipped_not_fatal() {
        let text = format!("not json\n[]\n5\n\n{}", line(1, ""));
        let (recs, off, _, _) =
            read_lines_t(Cursor::new(text.as_bytes()), 0, Kind::Claude, u64::MAX);
        assert_eq!(recs.len(), 1);
        assert_eq!(off as usize, text.len());
    }

    #[test]
    fn an_enormous_line_is_skipped_without_being_held_and_the_next_line_is_read() {
        let mut text = String::from("{\"type\":\"user\",\"x\":\"");
        text.push_str(&"y".repeat(MAX_LINE + 100_000));
        text.push_str("\"}\n");
        text.push_str(&line(5, ""));
        let (recs, off, _, _) =
            read_lines_t(Cursor::new(text.as_bytes()), 0, Kind::Claude, u64::MAX);
        assert_eq!(recs.len(), 1, "only the normal line after the giant one");
        assert_eq!(off as usize, text.len());
    }

    #[test]
    fn an_enormous_line_still_being_written_is_skipped_across_calls_and_resumes_after_its_newline()
    {
        let mut text = line(1, "");
        let first = text.len();
        text.push_str(&"z".repeat(MAX_LINE + 10)); // no newline yet
        let mut run = Run {
            offset: 0,
            skipping: false,
            title_sent: false,
            budget: u64::MAX,
        };
        let o = read_lines(Cursor::new(text.as_bytes()), Kind::Claude, &mut run);
        assert_eq!(o.records.len(), 1);
        assert!(run.skipping, "inside the giant line");
        assert_eq!(
            run.offset as usize,
            text.len(),
            "its bytes are already counted: they are never read twice"
        );
        // the rest of the line and a normal line arrive
        let more = format!("zzzz\n{}", line(2, ""));
        let o2 = read_lines(Cursor::new(more.as_bytes()), Kind::Claude, &mut run);
        assert!(!run.skipping);
        assert_eq!(o2.records.len(), 1);
        let _ = first;
    }

    #[test]
    fn a_line_of_exactly_the_cap_is_still_read() {
        let pad = MAX_LINE - 40;
        let l = format!("{{\"type\":\"user\",\"p\":\"{}\"}}\n", "a".repeat(pad - 30));
        assert!(l.len() <= MAX_LINE);
        let (recs, _, _, _) = read_lines_t(Cursor::new(l.as_bytes()), 0, Kind::Claude, u64::MAX);
        assert_eq!(recs.len(), 1);
    }

    #[test]
    fn invalid_utf8_is_replaced_not_fatal() {
        let mut b = b"{\"type\":\"user\",\"timestamp\":\"2026-01-01T00:00:01Z\",\"x\":\"".to_vec();
        b.extend_from_slice(&[0xff, 0xfe]);
        b.extend_from_slice(b"\"}\n");
        let (recs, _, _, _) = read_lines_t(Cursor::new(b), 0, Kind::Claude, u64::MAX);
        assert_eq!(recs.len(), 1);
    }

    #[test]
    fn the_per_call_budget_stops_early_and_resumes_exactly() {
        let text: String = (0..50).map(|i| line(i, "")).collect();
        let (a, off, used, more) = read_lines_t(Cursor::new(text.as_bytes()), 0, Kind::Claude, 500);
        assert!(more && used >= 500 && a.len() < 50);
        let (b, end, _, more2) = read_lines_t(
            Cursor::new(&text.as_bytes()[off as usize..]),
            off,
            Kind::Claude,
            u64::MAX,
        );
        assert!(!more2);
        assert_eq!(a.len() + b.len(), 50);
        assert_eq!(end as usize, text.len());
    }

    // ---- slimming -------------------------------------------------------------------------------------------------

    #[test]
    fn slim_claude_keeps_only_what_the_page_reads() {
        let d: Value = serde_json::from_str(r#"{"type":"assistant","timestamp":"t","requestId":"r","cwd":"/private/path","message":{"id":"m","model":"x","usage":{"input_tokens":1,"output_tokens":2,"service_tier":"s"},"content":[{"type":"text","text":"secret prose\nPROGRESS: 40% - ok\nmore secret"},{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"SECRET"}}]}}"#).unwrap();
        let s = slim(Kind::Claude, &d, &mut false);
        let text = s.to_string();
        assert!(
            !text.contains("SECRET")
                && !text.contains("secret")
                && !text.contains("/private/path")
                && !text.contains("service_tier")
        );
        assert_eq!(s["message"]["content"][0]["text"], "PROGRESS: 40% - ok");
        assert_eq!(s["message"]["content"][1]["name"], "Bash");
        assert_eq!(s["message"]["usage"]["output_tokens"], 2);
        assert_eq!(s["requestId"], "r");
    }

    #[test]
    fn slim_codex_drops_arguments_and_outputs() {
        let d: Value = serde_json::from_str(r#"{"timestamp":"t","type":"response_item","payload":{"type":"function_call","call_id":"c","name":"shell","arguments":"{\"cmd\":\"SECRET\"}","output":"SECRET"}}"#).unwrap();
        let s = slim(Kind::Codex, &d, &mut false).to_string();
        assert!(!s.contains("SECRET"));
        assert!(s.contains("\"call_id\":\"c\"") && s.contains("shell"));
        let u: Value = serde_json::from_str(r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"text":"x <INSTRUCTIONS> y"}]}}"#).unwrap();
        assert_eq!(
            slim(Kind::Codex, &u, &mut false)["payload"]["content"][0],
            json!({}),
            "injected context is never sent"
        );
    }

    /// The fixtures in tests/fixtures/transcripts are slimmed here and compared with tests/fixtures/slim; the TypeScript suite
    /// feeds both versions through the same parser and expects identical results (tests/fixtures.test.ts).
    /// Refresh the committed output with: UPDATE_SLIM=1 cargo test slim_golden
    #[test]
    fn slim_golden() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures");
        let out_dir = root.join("slim");
        fs::create_dir_all(&out_dir).unwrap();
        let mut n = 0;
        for e in fs::read_dir(root.join("transcripts")).unwrap().flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            let kind = if name.starts_with("codex") {
                Kind::Codex
            } else {
                Kind::Claude
            };
            let bytes = fs::read(e.path()).unwrap();
            assert!(!bytes.contains(&b'\r'), "{name}: fixtures must be LF files (see .gitattributes); a CRLF checkout changes every offset");
            let (recs, _, _, _) = read_lines_t(Cursor::new(bytes), 0, kind, u64::MAX);
            let got: String = recs.iter().map(|r| r.to_string() + "\n").collect();
            let target = out_dir.join(&name);
            if std::env::var("UPDATE_SLIM").is_ok() {
                fs::write(&target, &got).unwrap();
            } else {
                assert_eq!(
                    String::from_utf8(fs::read(&target).unwrap_or_default()).unwrap(),
                    got,
                    "{name}: run UPDATE_SLIM=1 cargo test slim_golden"
                );
            }
            n += 1;
        }
        assert!(n >= 8);
    }

    // ---- the scanner ------------------------------------------------------------------------------------------------

    #[test]
    fn roots_follow_the_overrides_then_the_os_defaults() {
        let none = |_: &str| None;
        assert_eq!(
            roots(&none, "/home/a"),
            (
                PathBuf::from("/home/a/.claude/projects"),
                PathBuf::from("/home/a/.codex/sessions")
            )
        );
        let env = |k: &str| match k {
            "AGENTSBAR_CLAUDE_DIR" => Some("/x/c".to_string()),
            "AGENTSBAR_CODEX_DIR" => Some("  ".to_string()),
            _ => None,
        };
        assert_eq!(
            roots(&env, "/h"),
            (PathBuf::from("/x/c"), PathBuf::from("/h/.codex/sessions"))
        );
        let win = roots(&none, "C:\\Users\\Ann");
        assert!(
            win.0.to_string_lossy().contains(".claude")
                && win.1.to_string_lossy().contains(".codex")
        );
    }

    #[test]
    fn discovery_finds_both_tools_applies_lookback_and_caps_at_300_newest() {
        let d = tempfile::tempdir().unwrap();
        let (cl, cx) = (d.path().join("claude"), d.path().join("codex"));
        for i in 0..320 {
            let p = claude_dir(
                &cl,
                "-proj",
                "s1",
                &format!("agent-{i:03}.jsonl"),
                &line(1, ""),
            );
            set_mtime(&p, 1000 + i as i64 * 1000); // agent-000 is the newest
        }
        let old = claude_dir(&cl, "-proj", "s1", "agent-old.jsonl", &line(1, ""));
        set_mtime(&old, LOOKBACK_MS + 60_000);
        let cxd = cx.join("2026/10/07");
        fs::create_dir_all(&cxd).unwrap();
        fs::write(cxd.join("rollout-a.jsonl"), line(1, "")).unwrap();
        fs::write(cxd.join("other.jsonl"), line(1, "")).unwrap();
        fs::write(cx.join("2026/rollout-too-shallow.jsonl"), line(1, "")).unwrap();
        let mut s = Scanner::new(cl, cx);
        let r = s.scan(now_ms(), true);
        let claude: Vec<_> = r.known.iter().filter(|k| k.kind == Kind::Claude).collect();
        assert_eq!(claude.len(), MAX_FILES);
        assert!(
            claude.iter().any(|k| k.path.ends_with("agent-000.jsonl"))
                && !claude.iter().any(|k| k.path.ends_with("agent-319.jsonl"))
        );
        assert!(!r.known.iter().any(|k| k.path.contains("agent-old")));
        let codex: Vec<_> = r.known.iter().filter(|k| k.kind == Kind::Codex).collect();
        assert_eq!(codex.len(), 1);
        assert!(codex[0].path.ends_with("rollout-a.jsonl"));
        assert_eq!(r.files.len(), 301);
        assert!(r.files.iter().all(|f| f.reset));
    }

    #[test]
    fn warm_rescans_return_only_changed_files_and_only_the_new_bytes() {
        let d = tempfile::tempdir().unwrap();
        let cl = d.path().join("c");
        let a = claude_dir(
            &cl,
            "-p",
            "s",
            "agent-a.jsonl",
            &format!("{}{}", line(1, ""), line(2, "")),
        );
        let b = claude_dir(&cl, "-p", "s", "agent-b.jsonl", &line(1, ""));
        let mut s = Scanner::new(cl, d.path().join("none"));
        let r1 = s.scan(now_ms(), true);
        assert_eq!(r1.files.len(), 2);
        let again = s.scan(now_ms(), false);
        assert!(
            again.files.is_empty(),
            "nothing changed: no files, no records"
        );
        let mut f = File::options().append(true).open(&a).unwrap();
        f.write_all(line(3, "").as_bytes()).unwrap();
        drop(f);
        let r2 = s.scan(now_ms(), false);
        assert_eq!(r2.files.len(), 1);
        assert!(r2.files[0].path.ends_with("agent-a.jsonl") && !r2.files[0].reset);
        assert_eq!(r2.files[0].records.len(), 1, "only the appended line");
        let _ = b;
    }

    #[test]
    fn a_new_file_is_found_by_the_next_walk_not_by_a_light_tick() {
        let d = tempfile::tempdir().unwrap();
        let cl = d.path().join("c");
        claude_dir(&cl, "-p", "s", "agent-a.jsonl", &line(1, ""));
        let mut s = Scanner::new(cl.clone(), d.path().join("none"));
        s.scan(now_ms(), true);
        claude_dir(&cl, "-p", "s", "agent-new.jsonl", &line(1, ""));
        assert_eq!(s.scan(now_ms(), false).known.len(), 1);
        assert_eq!(s.scan(now_ms(), true).known.len(), 2);
    }

    #[test]
    fn a_replaced_file_starts_over_even_when_it_is_larger() {
        let d = tempfile::tempdir().unwrap();
        let cl = d.path().join("c");
        let p = claude_dir(
            &cl,
            "-p",
            "s",
            "agent-a.jsonl",
            &format!("{}{}", line(1, ",\"k\":\"first file head\""), line(2, "")),
        );
        let mut s = Scanner::new(cl, d.path().join("none"));
        s.scan(now_ms(), true);
        // same path, different content (rename-over: a new file with a different head), bigger
        let tmp = p.with_extension("tmp");
        fs::write(
            &tmp,
            format!(
                "{}{}{}",
                line(9, ",\"k\":\"another head altogether\""),
                line(10, ""),
                line(11, "")
            ),
        )
        .unwrap();
        #[cfg(unix)]
        let old_ino = ino_of(&fs::metadata(&p).unwrap());
        #[cfg(unix)]
        assert_ne!(
            old_ino,
            ino_of(&fs::metadata(&tmp).unwrap()),
            "the replacement was made while the old file was alive"
        );
        fs::rename(&tmp, &p).unwrap();
        // whether or not a file system reuses inode numbers (Windows has none), the new head and size reveal the replacement
        let r = s.scan(now_ms(), false);
        assert_eq!(r.files.len(), 1);
        assert!(
            r.files[0].reset,
            "a replaced file must reset the page's state"
        );
        assert_eq!(r.files[0].records.len(), 3);
    }

    #[test]
    fn the_same_inode_rewritten_with_other_content_is_caught_by_the_head_bytes() {
        let d = tempfile::tempdir().unwrap();
        let cl = d.path().join("c");
        let p = claude_dir(
            &cl,
            "-p",
            "s",
            "agent-a.jsonl",
            &format!(
                "{}{}",
                line(1, ",\"k\":\"first file head, quite long\""),
                line(2, "")
            ),
        );
        let mut s = Scanner::new(cl, d.path().join("none"));
        s.scan(now_ms(), true);
        let new = format!(
            "{}{}{}",
            line(7, ",\"k\":\"rewritten in place, a different head\""),
            line(8, ""),
            line(9, "")
        );
        fs::write(&p, new).unwrap(); // truncate + write in place: the inode is the same, only the head bytes differ
        let r = s.scan(now_ms(), false);
        assert!(r.files[0].reset);
        assert_eq!(r.files[0].records.len(), 3);
    }

    #[test]
    fn a_truncated_file_resets() {
        let d = tempfile::tempdir().unwrap();
        let cl = d.path().join("c");
        let p = claude_dir(
            &cl,
            "-p",
            "s",
            "agent-a.jsonl",
            &(0..10).map(|i| line(i, "")).collect::<String>(),
        );
        let mut s = Scanner::new(cl, d.path().join("none"));
        s.scan(now_ms(), true);
        fs::write(&p, line(1, "")).unwrap();
        let r = s.scan(now_ms(), false);
        assert!(r.files[0].reset && r.files[0].records.len() == 1);
    }

    #[test]
    fn meta_json_is_sent_when_it_changes_and_only_the_two_fields() {
        let d = tempfile::tempdir().unwrap();
        let cl = d.path().join("c");
        let p = claude_dir(&cl, "-p", "s", "agent-a.jsonl", &line(1, ""));
        fs::write(
            p.with_extension("meta.json"),
            r#"{"agentType":"explorer","description":"Look around","secret":"S"}"#,
        )
        .unwrap();
        let mut s = Scanner::new(cl, d.path().join("none"));
        let r = s.scan(now_ms(), true);
        let meta = r.files[0].meta.clone().unwrap().unwrap();
        assert_eq!(
            meta,
            json!({"agentType":"explorer","description":"Look around"})
        );
        assert!(s.scan(now_ms(), false).files.is_empty());
        fs::write(p.with_extension("meta.json"), "not json").unwrap();
        set_mtime(&p.with_extension("meta.json"), 60_000);
        let again = s.scan(now_ms(), false);
        assert_eq!(again.files[0].meta, Some(None));
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_never_followed() {
        let d = tempfile::tempdir().unwrap();
        let cl = d.path().join("c");
        let real = claude_dir(&cl, "-p", "s", "agent-real.jsonl", &line(1, ""));
        let outside = d.path().join("outside.jsonl");
        fs::write(&outside, line(1, "")).unwrap();
        std::os::unix::fs::symlink(&outside, real.with_file_name("agent-link.jsonl")).unwrap();
        let other = d.path().join("elsewhere");
        fs::create_dir_all(other.join("s/subagents")).unwrap();
        fs::write(other.join("s/subagents/agent-x.jsonl"), line(1, "")).unwrap();
        std::os::unix::fs::symlink(&other, cl.join("-linkedproject")).unwrap();
        let mut s = Scanner::new(cl, d.path().join("none"));
        let r = s.scan(now_ms(), true);
        assert_eq!(r.known.len(), 1);
        assert!(r.known[0].path.ends_with("agent-real.jsonl"));
    }

    #[test]
    fn only_scanned_files_can_be_revealed() {
        let d = tempfile::tempdir().unwrap();
        let cl = d.path().join("c");
        let p = claude_dir(&cl, "-p", "s", "agent-a.jsonl", &line(1, ""));
        let mut s = Scanner::new(cl, d.path().join("none"));
        s.scan(now_ms(), true);
        assert!(s.is_known(p.to_str().unwrap()));
        assert!(!s.is_known("/etc/passwd"));
        assert!(!s.is_known(&format!(
            "{}/../agent-a.jsonl",
            p.parent().unwrap().display()
        )));
    }

    #[test]
    fn a_vanished_file_leaves_the_known_list() {
        let d = tempfile::tempdir().unwrap();
        let cl = d.path().join("c");
        let p = claude_dir(&cl, "-p", "s", "agent-a.jsonl", &line(1, ""));
        let mut s = Scanner::new(cl, d.path().join("none"));
        s.scan(now_ms(), true);
        fs::remove_file(&p).unwrap();
        assert!(s.scan(now_ms(), false).known.is_empty());
    }

    /// A file a virus scanner or indexer holds for a moment (Windows: access denied / sharing violation) is not a file that is
    /// gone. On Unix the same error is made with a folder that cannot be searched.
    #[cfg(unix)]
    #[test]
    fn a_file_that_cannot_be_looked_at_for_a_moment_stays_known() {
        use std::os::unix::fs::PermissionsExt;
        let d = tempfile::tempdir().unwrap();
        let cl = d.path().join("c");
        let p = claude_dir(&cl, "-p", "s", "agent-a.jsonl", &line(1, ""));
        let mut s = Scanner::new(cl, d.path().join("none"));
        assert_eq!(s.scan(now_ms(), true).known.len(), 1);
        let dir = p.parent().unwrap().to_path_buf();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o000)).unwrap();
        if fs::symlink_metadata(&p).is_ok() {
            fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
            return; // running as root: the error cannot be made
        }
        let during = s.scan(now_ms(), false);
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(during.known.len(), 1, "a momentary error is not 'gone'");
        let after = s.scan(now_ms(), false);
        assert_eq!(after.known.len(), 1);
        assert!(
            after.files.is_empty(),
            "and it is not read from the start again"
        );
    }

    /// A folder that cannot be read for a moment (access denied, an I/O hiccup) keeps its files until the next walk instead of
    /// emptying the list.
    #[cfg(unix)]
    #[test]
    fn a_folder_that_cannot_be_read_for_a_moment_keeps_its_files_across_a_walk() {
        use std::os::unix::fs::PermissionsExt;
        let d = tempfile::tempdir().unwrap();
        let cl = d.path().join("c");
        let p = claude_dir(&cl, "-p", "s", "agent-a.jsonl", &line(1, ""));
        claude_dir(&cl, "-q", "s", "agent-b.jsonl", &line(1, ""));
        let mut s = Scanner::new(cl.clone(), d.path().join("none"));
        assert_eq!(s.scan(now_ms(), true).known.len(), 2);
        for victim in [cl.clone(), cl.join("-p")] {
            fs::set_permissions(&victim, fs::Permissions::from_mode(0o000)).unwrap();
            if fs::read_dir(&victim).is_ok() {
                fs::set_permissions(&victim, fs::Permissions::from_mode(0o755)).unwrap();
                return; // running as root: the error cannot be made
            }
            let during = s.scan(now_ms(), true);
            fs::set_permissions(&victim, fs::Permissions::from_mode(0o755)).unwrap();
            assert_eq!(
                during.known.len(),
                2,
                "{}: nothing dropped",
                victim.display()
            );
        }
        // a folder that is really gone still empties
        fs::remove_dir_all(p.parent().unwrap().parent().unwrap().parent().unwrap()).unwrap();
        assert_eq!(s.scan(now_ms(), true).known.len(), 1);
    }

    #[test]
    fn windows_line_endings_read_like_unix_ones() {
        let body = format!("{}{}", line(1, ""), line(2, "")).replace('\n', "\r\n");
        let (recs, off, _, _) = read_lines_t(
            Cursor::new(body.clone().into_bytes()),
            0,
            Kind::Claude,
            u64::MAX,
        );
        assert_eq!(recs.len(), 2);
        assert_eq!(off as usize, body.len());
    }

    #[test]
    fn a_big_cold_scan_is_read_in_bounded_calls() {
        let d = tempfile::tempdir().unwrap();
        let cl = d.path().join("c");
        let body: String = (0..2000)
            .map(|i| line(i, &format!(",\"pad\":\"{}\"", "p".repeat(4000))))
            .collect(); // ~8 MB per file
        for i in 0..8 {
            claude_dir(&cl, "-p", "s", &format!("agent-{i}.jsonl"), &body);
        }
        let mut s = Scanner::new(cl, d.path().join("none"));
        let mut calls = 0;
        let mut total = 0;
        loop {
            let r = s.scan(now_ms(), calls == 0);
            total += r.files.iter().map(|f| f.records.len()).sum::<usize>();
            calls += 1;
            if !r.more || calls > 20 {
                break;
            }
        }
        assert_eq!(total, 8 * 2000, "every record arrives exactly once");
        assert!(
            calls >= 2,
            "64 MB of transcripts do not fit one call budget"
        );
    }

    #[cfg(unix)]
    fn max_rss_mb() -> f64 {
        let mut u: libc::rusage = unsafe { std::mem::zeroed() };
        unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut u) };
        let raw = u.ru_maxrss as f64;
        if cfg!(target_os = "macos") {
            raw / 1048576.0
        } else {
            raw / 1024.0
        }
    }

    /// Perf with 300 synthetic transcripts (200 Claude + 100 Codex, ~400 records each): cold scan, warm rescan, one appended file.
    /// Run: cargo test --release perf_300 -- --ignored --nocapture   (PERF_OUT=file also writes the cold reply as JSON)
    #[cfg(unix)]
    #[test]
    #[ignore]
    fn perf_300_transcripts() {
        let d = tempfile::tempdir().unwrap();
        let (cl, cx) = (d.path().join("c"), d.path().join("x"));
        let rec = |ts: usize, n: usize| {
            format!("{{\"type\":\"assistant\",\"timestamp\":\"2026-01-01T00:{:02}:{:02}Z\",\"message\":{{\"id\":\"m{n}\",\"usage\":{{\"input_tokens\":10,\"output_tokens\":{n}}},\"content\":[{{\"type\":\"text\",\"text\":\"{}\"}},{{\"type\":\"tool_use\",\"id\":\"t{n}\",\"name\":\"Bash\",\"input\":{{\"command\":\"{}\"}}}}]}}}}\n", ts / 60 % 60, ts % 60, "w".repeat(300), "c".repeat(200))
        };
        for i in 0..200 {
            let body: String = (0..400).map(|n| rec(n, n)).collect();
            claude_dir(&cl, "-p", "s", &format!("agent-{i}.jsonl"), &body);
        }
        let cxd = cx.join("2026/10/07");
        fs::create_dir_all(&cxd).unwrap();
        for i in 0..100 {
            let body: String = (0..400).map(|n| format!("{{\"timestamp\":\"2026-01-01T00:00:{:02}Z\",\"type\":\"response_item\",\"payload\":{{\"type\":\"function_call\",\"call_id\":\"c{n}\",\"name\":\"shell\",\"arguments\":\"{}\"}}}}\n", n % 60, "a".repeat(400))).collect();
            fs::write(cxd.join(format!("rollout-{i}.jsonl")), body).unwrap();
        }
        let bytes: u64 = fs::read_dir(cl.join("-p/s/subagents"))
            .unwrap()
            .flatten()
            .map(|e| e.metadata().unwrap().len())
            .sum();
        let mut s = Scanner::new(cl.clone(), cx);
        let t = std::time::Instant::now();
        let mut cold = s.scan(now_ms(), true);
        let mut rounds = 1;
        let mut all: Vec<FileOut> = std::mem::take(&mut cold.files);
        while cold.more {
            cold = s.scan(now_ms(), false);
            all.extend(std::mem::take(&mut cold.files));
            rounds += 1;
        }
        let cold_ms = t.elapsed().as_secs_f64() * 1000.0;
        let ipc = serde_json::to_string(&all).unwrap().len();
        let t = std::time::Instant::now();
        let warm = s.scan(now_ms(), false);
        let warm_ms = t.elapsed().as_secs_f64() * 1000.0;
        let t = std::time::Instant::now();
        let walk = s.scan(now_ms(), true);
        let walk_ms = t.elapsed().as_secs_f64() * 1000.0;
        let mut f = File::options()
            .append(true)
            .open(cl.join("-p/s/subagents/agent-7.jsonl"))
            .unwrap();
        f.write_all(rec(5, 999).as_bytes()).unwrap();
        drop(f);
        let t = std::time::Instant::now();
        let one = s.scan(now_ms(), false);
        let one_ms = t.elapsed().as_secs_f64() * 1000.0;
        eprintln!(
            "PERF files=300 claude_bytes={} ({} MB all)",
            bytes,
            bytes / 1048576
        );
        eprintln!(
            "PERF cold scan {:.0} ms in {} call(s), {} files, slim IPC payload {:.1} MB",
            cold_ms,
            rounds,
            all.len(),
            ipc as f64 / 1048576.0
        );
        eprintln!(
            "PERF warm rescan (stat only) {:.2} ms, {} files returned",
            warm_ms,
            warm.files.len()
        );
        eprintln!(
            "PERF folder walk + stat {:.2} ms, {} files returned",
            walk_ms,
            walk.files.len()
        );
        eprintln!(
            "PERF one appended file {:.2} ms, {} file(s), {} record(s)",
            one_ms,
            one.files.len(),
            one.files.first().map(|f| f.records.len()).unwrap_or(0)
        );
        eprintln!("PERF peak RSS of the test process {:.0} MB", max_rss_mb());
        if let Ok(path) = std::env::var("PERF_OUT") {
            let known: Vec<_> = s.scan(now_ms(), false).known;
            fs::write(
                path,
                serde_json::to_string(
                    &serde_json::json!({ "files": all, "known": known, "more": false }),
                )
                .unwrap(),
            )
            .unwrap();
        }
    }
}

/// Tests for the review findings (cold start, privacy, giant lines, special files, symlinked folders, markers).
#[cfg(test)]
mod review_tests {
    use super::*;
    use std::fs::File;
    use std::io::{Cursor, Write};

    fn sub(root: &Path, name: &str) -> PathBuf {
        let d = root
            .join("claude")
            .join("proj")
            .join("sess")
            .join("subagents");
        fs::create_dir_all(&d).unwrap();
        d.join(name)
    }
    fn nrec(r: &Reply) -> usize {
        r.files.iter().map(|f| f.records.len()).sum()
    }
    fn line(i: usize) -> String {
        format!("{{\"type\":\"assistant\",\"timestamp\":\"2026-10-08T01:00:{:02}Z\",\"message\":{{\"id\":\"m{i}\"}}}}\n", i % 60)
    }
    fn fresh(p: &Path) {
        let t = SystemTime::now() - std::time::Duration::from_secs(5);
        File::options()
            .write(true)
            .open(p)
            .unwrap()
            .set_modified(t)
            .unwrap();
    }

    // ---- 1: a cold start is one incomplete pass until every file is read ------------------------------------------

    #[test]
    fn a_big_cold_start_is_incomplete_until_the_last_file_is_read() {
        let d = tempfile::tempdir().unwrap();
        // 12 files stand in for 12 x 40 MB: the budgets are scaled down by the same factor (4 KB per call vs 8 MB)
        let body: String = (0..400).map(line).collect(); // ~30 KB
        for i in 0..12 {
            let p = sub(d.path(), &format!("agent-{i:02}.jsonl"));
            fs::write(&p, &body).unwrap();
            fresh(&p);
        }
        let mut sc = Scanner::new(d.path().join("claude"), d.path().join("codex"));
        sc.file_budget = 4 * 1024;
        sc.call_budget = 8 * 1024;
        let mut calls = 0;
        let mut total = 0;
        let mut more_flags = vec![];
        loop {
            let r = sc.scan(now_ms(), calls == 0);
            total += nrec(&r);
            more_flags.push(r.more);
            calls += 1;
            if !r.more || calls > 500 {
                break;
            }
        }
        assert!(calls > 5, "a big start takes many calls ({calls})");
        assert!(
            more_flags[..more_flags.len() - 1].iter().all(|m| *m),
            "every call before the last says more = true"
        );
        assert!(!more_flags.last().unwrap());
        assert_eq!(total, 12 * 400, "every record exactly once");
        assert!(
            !sc.scan(now_ms(), false).more,
            "a settled pass stays complete"
        );
    }

    #[test]
    fn a_giant_line_being_skipped_does_not_hold_a_pass_open() {
        let d = tempfile::tempdir().unwrap();
        let p = sub(d.path(), "agent-big.jsonl");
        let mut f = File::create(&p).unwrap();
        f.write_all(line(1).as_bytes()).unwrap();
        f.write_all(b"{\"x\":\"").unwrap();
        for _ in 0..(3 * MAX_LINE / (1 << 20) + 2) {
            f.write_all(&vec![b'A'; 1 << 20]).unwrap();
        }
        drop(f);
        fresh(&p);
        let mut sc = Scanner::new(d.path().join("claude"), d.path().join("codex"));
        let r = sc.scan(now_ms(), true);
        assert_eq!(nrec(&r), 1);
        // a few calls later the pass is complete although the line is still unfinished
        let mut r = sc.scan(now_ms(), false);
        for _ in 0..10 {
            if !r.more {
                break;
            }
            r = sc.scan(now_ms(), false);
        }
        assert!(!r.more);
    }

    // ---- 3: a huge file without newlines costs O(budget) per call and is never re-read ------------------------------

    #[cfg(unix)] // a 1 GB hole is free on Unix file systems; NTFS would allocate and zero it
    #[test]
    fn a_sparse_gigabyte_without_newlines_is_skipped_a_budget_at_a_time_and_never_re_read() {
        let d = tempfile::tempdir().unwrap();
        let p = sub(d.path(), "agent-sparse.jsonl");
        let f = File::create(&p).unwrap();
        f.set_len(1 << 30).unwrap(); // 1 GB of zeros, no newline anywhere
        drop(f);
        fresh(&p);
        let mut sc = Scanner::new(d.path().join("claude"), d.path().join("codex"));
        let t = std::time::Instant::now();
        let r = sc.scan(now_ms(), true);
        let first = t.elapsed();
        assert_eq!(nrec(&r), 0);
        // each call reads about FILE_BUDGET (+ the one block that crosses it), not the file
        let st = sc.states.values().next().unwrap();
        assert!(st.skipping);
        assert!(
            st.offset >= FILE_BUDGET && st.offset <= FILE_BUDGET + MAX_LINE as u64 + (1 << 16),
            "offset {}",
            st.offset
        );
        let before = st.offset;
        let t = std::time::Instant::now();
        sc.scan(now_ms(), false);
        let second = t.elapsed();
        let after = sc.states.values().next().unwrap().offset;
        assert!(
            after > before && after - before <= FILE_BUDGET + (1 << 16),
            "progress {} per call",
            after - before
        );
        assert!(
            first < std::time::Duration::from_secs(5) && second < std::time::Duration::from_secs(5),
            "{first:?} {second:?}"
        );
    }

    #[test]
    fn a_skip_finishes_across_calls_and_the_line_after_it_is_read() {
        let d = tempfile::tempdir().unwrap();
        let p = sub(d.path(), "agent-bl.jsonl");
        let mut f = File::create(&p).unwrap();
        f.write_all(line(1).as_bytes()).unwrap();
        f.write_all(b"{\"type\":\"assistant\",\"x\":\"").unwrap();
        for _ in 0..12 {
            f.write_all(&vec![b'A'; 1 << 20]).unwrap(); // 12 MB line
        }
        f.write_all(b"\"}\n").unwrap();
        f.write_all(line(2).as_bytes()).unwrap();
        drop(f);
        fresh(&p);
        let mut sc = Scanner::new(d.path().join("claude"), d.path().join("codex"));
        sc.file_budget = 2 * 1024 * 1024; // small budget: the skip needs several calls
        let mut got = 0;
        let mut calls = 0;
        loop {
            let r = sc.scan(now_ms(), calls == 0);
            got += nrec(&r);
            calls += 1;
            if got >= 2 || calls > 40 {
                break;
            }
        }
        assert_eq!(
            got, 2,
            "the record before and the record after the 12 MB line, nothing else"
        );
        assert!(calls >= 4, "the skip took {calls} calls");
        assert!(!sc.states.values().next().unwrap().skipping);
    }

    // ---- 4: special files never block ----------------------------------------------------------------------------------

    #[cfg(unix)]
    fn mkfifo(p: &Path) {
        let c = std::ffi::CString::new(p.to_str().unwrap()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
    }

    #[cfg(unix)]
    #[test]
    fn a_fifo_named_like_a_transcript_or_its_meta_is_ignored_not_waited_on() {
        let d = tempfile::tempdir().unwrap();
        let real = sub(d.path(), "agent-real.jsonl");
        fs::write(&real, line(1)).unwrap();
        fresh(&real);
        mkfifo(&real.with_file_name("agent-fifo.jsonl"));
        mkfifo(&real.with_extension("meta.json")); // a FIFO as the meta file of a real transcript
        let mut sc = Scanner::new(d.path().join("claude"), d.path().join("codex"));
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let r = sc.scan(now_ms(), true);
            tx.send((r.known.len(), r.files.len())).ok();
        });
        let got = rx
            .recv_timeout(std::time::Duration::from_secs(10))
            .expect("the scan must not hang on a FIFO");
        assert_eq!(got, (1, 1));
    }

    #[cfg(unix)]
    #[test]
    fn open_regular_refuses_a_fifo_a_directory_and_a_link_when_not_following() {
        let d = tempfile::tempdir().unwrap();
        let fifo = d.path().join("f");
        mkfifo(&fifo);
        let t = std::time::Instant::now();
        assert!(crate::files::open_regular(&fifo, true).is_err());
        assert!(crate::files::open_regular(&fifo, false).is_err());
        assert!(t.elapsed() < std::time::Duration::from_secs(2));
        assert!(crate::files::open_regular(d.path(), true).is_err());
        let real = d.path().join("r");
        fs::write(&real, "x").unwrap();
        let link = d.path().join("l");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert!(
            crate::files::open_regular(&link, false).is_err(),
            "transcripts are never read through a link"
        );
        assert!(
            crate::files::open_regular(&link, true).is_ok(),
            "a data file may be a validated link"
        );
    }

    // ---- 6: a symlinked folder is not followed --------------------------------------------------------------------

    #[cfg(unix)]
    #[test]
    fn a_symlinked_subagents_folder_is_not_read() {
        let d = tempfile::tempdir().unwrap();
        let outside = d.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("agent-x.jsonl"), line(1)).unwrap();
        fresh(&outside.join("agent-x.jsonl"));
        let session = d.path().join("claude/proj/sess");
        fs::create_dir_all(&session).unwrap();
        std::os::unix::fs::symlink(&outside, session.join("subagents")).unwrap();
        let mut sc = Scanner::new(d.path().join("claude"), d.path().join("codex"));
        assert!(sc.scan(now_ms(), true).known.is_empty());
        // a codex day folder that is a link
        let cx = d.path().join("codex/2026/10");
        fs::create_dir_all(&cx).unwrap();
        fs::write(outside.join("rollout-x.jsonl"), line(1)).unwrap();
        fresh(&outside.join("rollout-x.jsonl"));
        std::os::unix::fs::symlink(&outside, cx.join("08")).unwrap();
        assert!(sc.scan(now_ms(), true).known.is_empty());
    }

    // ---- 7: PROGRESS markers behind a long prefix ----------------------------------------------------------------------

    #[test]
    fn a_progress_marker_behind_a_long_prefix_is_kept_and_other_text_never() {
        let long_ok = format!("{}PROGRESS: 55% - far right", " ".repeat(900));
        assert_eq!(progress_lines(&long_ok), "PROGRESS: 55% - far right");
        let quoted = format!("{}PROGRESS: 40% - x", "> ".repeat(300));
        assert_eq!(progress_lines(&quoted), "PROGRESS: 40% - x");
        assert_eq!(
            progress_lines("we made PROGRESS: 40% today"),
            "",
            "text before the marker means it is not a report line"
        );
        assert_eq!(
            progress_lines("a\nPROGRESS: 1%\nsecret\r\nPROGRESS: 2%\rPROGRESS: 3%"),
            "PROGRESS: 1%\nPROGRESS: 2%\rPROGRESS: 3%"
        );
        let huge = format!("PROGRESS: 9% - {}", "n".repeat(100_000));
        assert!(progress_lines(&huge).chars().count() <= PROGRESS_KEEP);
        let text = format!(
            "{}\nPROGRESS: 70% - ok\n{}",
            "x".repeat(1_000_000),
            "y".repeat(1_000_000)
        );
        assert_eq!(
            progress_lines(&text),
            "PROGRESS: 70% - ok",
            "a long answer costs nothing"
        );
    }

    // ---- 2: privacy canary: nothing but the allowed fields crosses ----------------------------------------------------

    const CANARY: &str = "CANARY-9f3c";

    fn canary_tree(root: &Path) {
        // Claude: prompt, assistant prose, tool inputs and results, paths, a progress line with surrounding prose
        let p = sub(root, "agent-c.jsonl");
        let rec = |v: Value| v.to_string() + "\n";
        let mut body = String::new();
        body += &rec(
            json!({"type":"user","timestamp":"2026-10-08T01:00:00Z","cwd":format!("/{CANARY}/cwd"),"message":{"role":"user","content":[{"type":"text","text":format!("prompt {CANARY}-prompt")}]}}),
        );
        body += &rec(
            json!({"type":"assistant","timestamp":"2026-10-08T01:00:01Z","message":{"id":"m1","content":[
            {"type":"text","text":format!("prose {CANARY}-prose\nPROGRESS: 40% - shown note\nmore {CANARY}-more")},
            {"type":"tool_use","id":"t1","name":"Bash","input":{"command":format!("echo {CANARY}-input")}}]}}),
        );
        body += &rec(
            json!({"type":"user","timestamp":"2026-10-08T01:00:02Z","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":format!("out {CANARY}-output")}]},"toolUseResult":format!("{CANARY}-tur")}),
        );
        fs::write(&p, body).unwrap();
        fs::write(p.with_extension("meta.json"), json!({"agentType":"explorer","description":"Visible task","prompt":format!("{CANARY}-metaprompt")}).to_string()).unwrap();
        fresh(&p);
        // Codex: injected context, first real prompt (long: canary beyond 200 chars), later turns, replies, outputs
        let cxd = root.join("codex/2026/10/08");
        fs::create_dir_all(&cxd).unwrap();
        let first = format!(
            "Fix the checkout test {}{CANARY}-late-in-first-prompt",
            "word ".repeat(60)
        );
        let mut cx = String::new();
        let item = |t: Value| {
            json!({"timestamp":"2026-10-08T01:00:00Z","type":"response_item","payload":t})
                .to_string()
                + "\n"
        };
        cx += &json!({"timestamp":"2026-10-08T01:00:00Z","type":"event_msg","payload":{"type":"task_started"}}).to_string();
        cx += "\n";
        cx += &item(
            json!({"type":"message","role":"user","content":[{"type":"input_text","text":format!("# AGENTS.md instructions {CANARY}-agents")}]}),
        );
        cx += &item(
            json!({"type":"message","role":"user","content":[{"type":"input_text","text":format!("<environment_context>{CANARY}-env</environment_context>")}]}),
        );
        cx += &item(
            json!({"type":"message","role":"user","content":[{"type":"input_text","text":first}]}),
        );
        cx += &item(
            json!({"type":"function_call","name":"shell","call_id":"c1","arguments":format!("{{\"cmd\":\"{CANARY}-args\"}}")}),
        );
        cx += &item(
            json!({"type":"function_call_output","call_id":"c1","output":format!("{CANARY}-codex-output")}),
        );
        cx += &item(
            json!({"type":"message","role":"assistant","content":[{"type":"output_text","text":format!("reply {CANARY}-reply\nPROGRESS: 60% - codex note")}]}),
        );
        cx += &item(
            json!({"type":"message","role":"user","content":[{"type":"input_text","text":format!("second turn {CANARY}-turn2")}]}),
        );
        cx += &json!({"timestamp":"2026-10-08T01:00:01Z","type":"turn_context","payload":{"cwd":format!("/{CANARY}/work"),"model":format!("{CANARY}-model")}}).to_string();
        cx += "\n";
        let cp = cxd.join("rollout-c.jsonl");
        fs::write(&cp, cx).unwrap();
        fresh(&cp);
    }

    #[test]
    fn privacy_canary_nothing_from_message_bodies_crosses_for_claude_and_codex() {
        let d = tempfile::tempdir().unwrap();
        canary_tree(d.path());
        let mut sc = Scanner::new(d.path().join("claude"), d.path().join("codex"));
        let reply = sc.scan(now_ms(), true);
        let payload = serde_json::to_string(&reply).unwrap();
        // the file paths of the test tree contain no canary; only content does
        assert!(
            !payload.contains(CANARY),
            "a canary string crossed: {}",
            payload
                .split(CANARY)
                .next()
                .unwrap()
                .chars()
                .rev()
                .take(80)
                .collect::<String>()
                .chars()
                .rev()
                .collect::<String>()
        );
        // what must cross is there
        assert!(
            payload.contains("PROGRESS: 40% - shown note")
                && payload.contains("PROGRESS: 60% - codex note")
        );
        assert!(payload.contains("Fix the checkout test"));
        assert!(payload.contains("Visible task") && payload.contains("explorer"));
        // the Codex prompt text is sent once and at most 200 characters
        let texts: Vec<&str> = reply
            .files
            .iter()
            .filter(|f| f.kind == Kind::Codex)
            .flat_map(|f| f.records.iter())
            .filter_map(|r| r["payload"]["content"].as_array())
            .flatten()
            .filter_map(|b| b["text"].as_str())
            .filter(|t| !t.starts_with("PROGRESS"))
            .collect();
        assert_eq!(texts.len(), 1, "{texts:?}");
        assert!(texts[0].chars().count() <= TITLE_KEEP);
    }

    #[test]
    fn the_codex_title_is_sent_once_per_file_even_across_calls() {
        let d = tempfile::tempdir().unwrap();
        let cxd = d.path().join("codex/2026/10/08");
        fs::create_dir_all(&cxd).unwrap();
        let cp = cxd.join("rollout-t.jsonl");
        let msg = |t: &str| {
            json!({"timestamp":"2026-10-08T01:00:00Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":t}]}}).to_string() + "\n"
        };
        fs::write(&cp, msg("First real prompt")).unwrap();
        fresh(&cp);
        let mut sc = Scanner::new(d.path().join("claude"), d.path().join("codex"));
        let r1 = sc.scan(now_ms(), true);
        assert_eq!(
            r1.files[0].records[0]["payload"]["content"][0]["text"],
            "First real prompt"
        );
        let mut f = fs::OpenOptions::new().append(true).open(&cp).unwrap();
        f.write_all(msg("Second turn text").as_bytes()).unwrap();
        drop(f);
        let r2 = sc.scan(now_ms(), false);
        assert_eq!(r2.files[0].records[0]["payload"]["content"][0], json!({}));
        assert!(!serde_json::to_string(&r2).unwrap().contains("Second turn"));
    }

    // ---- 8: Mac-parity details of the slimmer ------------------------------------------------------------------------

    #[test]
    fn meta_values_that_are_not_strings_show_like_the_mac() {
        assert_eq!(meta_text(&json!(5)), Some(json!("5")));
        assert_eq!(meta_text(&json!(true)), Some(json!("True")));
        assert_eq!(meta_text(&json!(null)), None);
        assert_eq!(meta_text(&json!("ok")), Some(json!("ok")));
        assert_eq!(meta_text(&json!([1, 2])), Some(json!("[1,2]")));
    }

    #[test]
    fn a_non_string_codex_name_still_counts_as_a_name_like_python() {
        let mk = |name: Value| json!({"type":"response_item","payload":{"type":"function_call","name":name,"action":{"type":"exec"}}});
        let name = |v: Value| {
            slim(Kind::Codex, &mk(v), &mut false)["payload"]
                .get("name")
                .cloned()
        };
        assert_eq!(name(json!("shell")), Some(json!("shell")));
        assert_eq!(name(json!(5)), Some(json!(true)));
        assert_eq!(name(json!([1])), Some(json!(true)));
        for falsy in [
            json!(null),
            json!(0),
            json!(false),
            json!(""),
            json!([]),
            json!({}),
        ] {
            let got = name(falsy.clone());
            assert!(got.is_none() || got == Some(json!("")), "{falsy}: {got:?}");
        }
    }

    #[test]
    fn a_codex_prompt_after_thousands_of_leading_spaces_is_trimmed_before_cutting() {
        let d = json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"text":format!("{}   Real\tprompt\u{0}here", " ".repeat(5000))}]}});
        let mut sent = false;
        let s = slim(Kind::Codex, &d, &mut sent);
        assert_eq!(s["payload"]["content"][0]["text"], "Real prompt here");
        assert!(sent);
    }

    // ---- C: a line nested thousands deep is skipped, not fatal --------------------------------------------------------

    #[test]
    fn a_line_nested_five_thousand_deep_is_skipped_and_the_two_records_around_it_are_read() {
        let deep = format!(
            "{{\"type\":\"assistant\",\"x\":{}{}}}\n",
            "[".repeat(5000),
            "]".repeat(5000)
        );
        let text = format!("{}{}{}", line(1), deep, line(2));
        let mut run = Run {
            offset: 0,
            skipping: false,
            title_sent: false,
            budget: u64::MAX,
        };
        let o = read_lines(Cursor::new(text.as_bytes()), Kind::Claude, &mut run);
        assert_eq!(o.records.len(), 2);
        assert_eq!(run.offset as usize, text.len());
        let deeper = format!(
            "{}{}{}",
            line(1),
            "{\"a\":".repeat(100_000) + "1" + &"}".repeat(100_000) + "\n",
            line(2)
        );
        let o = read_lines(
            Cursor::new(deeper.as_bytes()),
            Kind::Claude,
            &mut Run {
                offset: 0,
                skipping: false,
                title_sent: false,
                budget: u64::MAX,
            },
        );
        assert_eq!(o.records.len(), 2, "no stack overflow, no lost agent");
    }
}
