//! Runs the real scanner over two folders and prints every reply it gives until a call has nothing new, as JSON.
//! Used by scripts/canary.mjs (privacy check of what crosses to the page) and for manual differential runs.
//! Usage: cargo run --example scan -- <claudeDir> <codexDir> [nowMs]
use agents_bar_lib::scanner::{now_ms, Scanner};
use std::path::PathBuf;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    if a.len() < 3 {
        eprintln!("usage: scan <claudeDir> <codexDir> [nowMs]");
        std::process::exit(2);
    }
    let now: i64 = a.get(3).and_then(|v| v.parse().ok()).unwrap_or_else(now_ms);
    let mut s = Scanner::new(PathBuf::from(&a[1]), PathBuf::from(&a[2]));
    let mut replies = vec![];
    for i in 0..400 {
        let r = s.scan(now, i == 0);
        let settled = !r.more && r.files.is_empty() && i > 0;
        replies.push(serde_json::to_value(&r).expect("serialise"));
        if settled {
            break; // nothing left to read: a giant line being skipped is finished and what follows it has been read
        }
    }
    println!("{}", serde_json::to_string(&replies).expect("serialise"));
}
