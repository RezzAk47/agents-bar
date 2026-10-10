//! Where notified.json and settings.json live. Pure: the OS and the environment are passed in, so every OS is tested on any OS.

use std::path::PathBuf;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Os {
    Mac,
    Windows,
    Linux,
}

impl Os {
    pub fn current() -> Os {
        if cfg!(target_os = "macos") {
            Os::Mac
        } else if cfg!(target_os = "windows") {
            Os::Windows
        } else {
            Os::Linux
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Os::Mac => "macos",
            Os::Windows => "windows",
            Os::Linux => "linux",
        }
    }
}

/// `base` + separator + `rest`, without doubling the separator when `base` already ends with one ("/", "C:\\", "C:/").
fn join(base: &str, rest: &str, os: Os) -> String {
    let seps: &[char] = if os == Os::Windows {
        &['\\', '/']
    } else {
        &['/']
    };
    let sep = if os == Os::Windows { '\\' } else { '/' };
    format!("{}{sep}{rest}", base.trim_end_matches(seps))
}

fn is_absolute(p: &str, os: Os) -> bool {
    match os {
        Os::Windows => {
            let b = p.as_bytes();
            (b.len() >= 3
                && b[0].is_ascii_alphabetic()
                && b[1] == b':'
                && (b[2] == b'\\' || b[2] == b'/'))
                || p.starts_with("\\\\")
        }
        _ => p.starts_with('/'),
    }
}

/// 1. AGENTSBAR_DATA_DIR (every test and manual run sets it)
/// 2. macOS ~/Library/Application Support/AgentsBarCross, Windows %APPDATA%\AgentsBarCross,
///    Linux ${XDG_DATA_HOME:-~/.local/share}/AgentsBarCross (an XDG_DATA_HOME that is not absolute is ignored).
pub fn default_data_dir(os: Os, env: &dyn Fn(&str) -> Option<String>, home: &str) -> PathBuf {
    if let Some(o) = env("AGENTSBAR_DATA_DIR") {
        if !o.trim().is_empty() {
            return PathBuf::from(o);
        }
    }
    let s = match os {
        Os::Mac => join(home, "Library/Application Support/AgentsBarCross", os),
        Os::Windows => {
            let appdata = env("APPDATA")
                .filter(|a| !a.trim().is_empty())
                .unwrap_or_else(|| join(home, "AppData\\Roaming", os));
            join(&appdata, "AgentsBarCross", os)
        }
        Os::Linux => {
            let base = match env("XDG_DATA_HOME") {
                Some(x) if is_absolute(&x, Os::Linux) => x,
                _ => join(home, ".local/share", os),
            };
            join(&base, "AgentsBarCross", os)
        }
    };
    PathBuf::from(s)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let m: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        move |k| m.get(k).cloned()
    }

    #[test]
    fn mac() {
        assert_eq!(
            default_data_dir(Os::Mac, &env(&[]), "/Users/ann"),
            PathBuf::from("/Users/ann/Library/Application Support/AgentsBarCross")
        );
    }

    #[test]
    fn windows_uses_appdata_then_profile() {
        let e = env(&[("APPDATA", "C:\\Users\\Ann\\AppData\\Roaming")]);
        assert_eq!(
            default_data_dir(Os::Windows, &e, "C:\\Users\\Ann"),
            PathBuf::from("C:\\Users\\Ann\\AppData\\Roaming\\AgentsBarCross")
        );
        let e = env(&[("APPDATA", "C:\\Users\\Ann\\AppData\\Roaming\\")]);
        assert_eq!(
            default_data_dir(Os::Windows, &e, "C:\\Users\\Ann"),
            PathBuf::from("C:\\Users\\Ann\\AppData\\Roaming\\AgentsBarCross")
        );
        assert_eq!(
            default_data_dir(Os::Windows, &env(&[]), "C:\\Users\\Ann"),
            PathBuf::from("C:\\Users\\Ann\\AppData\\Roaming\\AgentsBarCross")
        );
    }

    #[test]
    fn a_bare_drive_or_root_home_does_not_double_the_separator() {
        assert_eq!(
            default_data_dir(Os::Windows, &env(&[]), "C:\\"),
            PathBuf::from("C:\\AppData\\Roaming\\AgentsBarCross")
        );
        assert_eq!(
            default_data_dir(Os::Windows, &env(&[]), "C:/"),
            PathBuf::from("C:\\AppData\\Roaming\\AgentsBarCross")
        );
        assert_eq!(
            default_data_dir(Os::Windows, &env(&[("APPDATA", "D:\\")]), "C:\\"),
            PathBuf::from("D:\\AgentsBarCross")
        );
        assert_eq!(
            default_data_dir(Os::Linux, &env(&[]), "/"),
            PathBuf::from("/.local/share/AgentsBarCross")
        );
        assert_eq!(
            default_data_dir(Os::Mac, &env(&[]), "/"),
            PathBuf::from("/Library/Application Support/AgentsBarCross")
        );
        assert_eq!(
            default_data_dir(Os::Linux, &env(&[("XDG_DATA_HOME", "/")]), "/h"),
            PathBuf::from("/AgentsBarCross")
        );
    }

    #[test]
    fn linux_uses_xdg_when_absolute() {
        assert_eq!(
            default_data_dir(Os::Linux, &env(&[]), "/home/ann"),
            PathBuf::from("/home/ann/.local/share/AgentsBarCross")
        );
        assert_eq!(
            default_data_dir(
                Os::Linux,
                &env(&[("XDG_DATA_HOME", "/data/xdg")]),
                "/home/ann"
            ),
            PathBuf::from("/data/xdg/AgentsBarCross")
        );
        assert_eq!(
            default_data_dir(
                Os::Linux,
                &env(&[("XDG_DATA_HOME", "relative/dir")]),
                "/home/ann"
            ),
            PathBuf::from("/home/ann/.local/share/AgentsBarCross")
        );
        assert_eq!(
            default_data_dir(Os::Linux, &env(&[("XDG_DATA_HOME", "")]), "/home/ann/"),
            PathBuf::from("/home/ann/.local/share/AgentsBarCross")
        );
    }

    #[test]
    fn override_wins_everywhere() {
        for os in [Os::Mac, Os::Windows, Os::Linux] {
            assert_eq!(
                default_data_dir(os, &env(&[("AGENTSBAR_DATA_DIR", "/tmp/x")]), "/h"),
                PathBuf::from("/tmp/x")
            );
        }
        assert_eq!(
            default_data_dir(Os::Linux, &env(&[("AGENTSBAR_DATA_DIR", "  ")]), "/h"),
            PathBuf::from("/h/.local/share/AgentsBarCross")
        );
    }
}
