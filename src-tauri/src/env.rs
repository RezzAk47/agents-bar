//! Environment access, in one place so it can be tested with injected values.

use crate::datadir::Os;

/// The test overrides: where settings live, where the transcripts are, which `gh` to run. A user's environment can leak them
/// into a normal run (or a hostile parent process can set them), so release builds ignore them unless the run itself
/// says it is a test run with AGENTSBAR_TEST=1. Debug builds (development, CI) honour them.
pub const GATED: [&str; 4] = [
    "AGENTSBAR_DATA_DIR",
    "AGENTSBAR_CLAUDE_DIR",
    "AGENTSBAR_CODEX_DIR",
    "AGENTSBAR_GH",
];

/// Is `name` readable given the build kind and the value of AGENTSBAR_TEST?
pub fn allowed(name: &str, debug_build: bool, test_flag: Option<&str>) -> bool {
    !GATED.contains(&name) || debug_build || test_flag == Some("1")
}

/// The process environment with the gate applied.
pub fn var(name: &str) -> Option<String> {
    if !allowed(
        name,
        cfg!(debug_assertions),
        std::env::var("AGENTSBAR_TEST").ok().as_deref(),
    ) {
        return None;
    }
    std::env::var(name).ok()
}

/// The home folder: USERPROFILE on Windows (Node's homedir() does the same; HOME can be set by Git Bash or MSYS to a path
/// the rest of the tools do not use), HOME elsewhere, with the other as the fallback. No home folder is an error: guessing
/// "." would put the data folder under whatever the current directory happens to be.
pub fn home_dir(os: Os, env: &dyn Fn(&str) -> Option<String>) -> Result<String, String> {
    let non_empty = |n: &str| env(n).filter(|v| !v.trim().is_empty());
    let (first, second) = if os == Os::Windows {
        ("USERPROFILE", "HOME")
    } else {
        ("HOME", "USERPROFILE")
    };
    non_empty(first)
        .or_else(|| non_empty(second))
        .ok_or_else(|| {
            format!(
                "Agents Bar could not find your home folder ({first} and {second} are not set), so it cannot tell where to keep its data. Set {first} and start it again."
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_overrides_are_ignored_in_a_release_build_unless_the_run_is_a_test_run() {
        for n in GATED {
            assert!(!allowed(n, false, None), "{n}");
            assert!(!allowed(n, false, Some("0")), "{n}");
            assert!(!allowed(n, false, Some("true")), "{n}");
            assert!(allowed(n, false, Some("1")), "{n}");
            assert!(allowed(n, true, None), "{n}");
        }
        // everything else is always readable
        for n in [
            "HOME",
            "APPDATA",
            "XDG_DATA_HOME",
            "PATH",
            "AGENTSBAR_NO_NOTIFICATIONS",
            "AGENTSBAR_TEST",
        ] {
            assert!(allowed(n, false, None), "{n}");
        }
    }

    #[test]
    fn the_home_folder_follows_the_platform() {
        let env = |pairs: &'static [(&'static str, &'static str)]| {
            move |k: &str| {
                pairs
                    .iter()
                    .find(|(n, _)| *n == k)
                    .map(|(_, v)| v.to_string())
            }
        };
        let both = env(&[
            ("HOME", "/c/Users/git-home"),
            ("USERPROFILE", "C:\\Users\\Ann"),
        ]);
        assert_eq!(
            home_dir(Os::Windows, &both).unwrap(),
            "C:\\Users\\Ann",
            "Windows prefers USERPROFILE"
        );
        assert_eq!(home_dir(Os::Linux, &both).unwrap(), "/c/Users/git-home");
        assert_eq!(home_dir(Os::Mac, &both).unwrap(), "/c/Users/git-home");
        assert_eq!(
            home_dir(Os::Windows, &env(&[("HOME", "/h")])).unwrap(),
            "/h"
        );
        assert_eq!(
            home_dir(Os::Linux, &env(&[("USERPROFILE", "C:\\U")])).unwrap(),
            "C:\\U"
        );
        for os in [Os::Linux, Os::Mac, Os::Windows] {
            let blank = home_dir(os, &env(&[("HOME", "  ")]));
            assert!(blank.is_err(), "blank HOME is no home folder");
            assert!(blank.unwrap_err().contains("home folder"));
            assert!(
                home_dir(os, &env(&[])).is_err(),
                "no home folder is an error, not \".\""
            );
        }
    }
}
