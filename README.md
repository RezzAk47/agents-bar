# Agents Bar

[![CI](https://github.com/RezzAk47/agents-bar/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/RezzAk47/agents-bar/actions/workflows/ci.yml)
![Platforms: Windows, Linux, macOS](https://img.shields.io/badge/platforms-Windows%20%7C%20Linux%20%7C%20macOS-informational)
![Version 0.1.1](https://img.shields.io/badge/version-0.1.1-blue)
[![License: PolyForm Noncommercial 1.0.0](https://img.shields.io/badge/license-PolyForm%20Noncommercial%201.0.0-orange)](LICENSE)

**See your running and finished AI coding agents, and your GitHub CI, right in your tray.**

Agents Bar is a small tray / menu-bar app for Windows, Linux and macOS. It watches your AI coding agents' local transcript
files and shows each agent's progress, time left, steps and tokens, notifies you when one finishes, and lists your GitHub
repositories with their CI status. Built with Tauri 2 (Rust) and Preact.

| Running and recent | GitHub and needs attention | Settings |
|---|---|---|
| <img src="docs/running-recent-light.png" width="260" alt="Agents Bar popup in light mode with running and recent agents"> | <img src="docs/github-dark.png" width="260" alt="Agents Bar popup in dark mode with the GitHub section and a needs-attention banner"> | <img src="docs/settings-light.png" width="260" alt="Agents Bar settings pane in light mode"> |

<sub>Screenshots use made-up agents and repos. More in the [gallery](docs/GALLERY.md).</sub>

## Features

- Running and Recent cards: Running, Done or Stalled, with a progress ring, steps and tokens, or both.
- Progress from the agent's own `PROGRESS: 40% - note` lines, otherwise an estimate from similar finished agents, plus time left.
- Tray glance text such as `63%` for one running agent or `2 · 33%` for two (next to the icon on macOS), and a tooltip on every OS
  such as `2 running (average 33%) · 1 finished`.
- An agent past its usual time says by how much, such as `7m 40s over usual (~4m 00s)`.
- A notification when an agent finishes, and a Today list.
- GitHub section: issues, PRs and the latest CI result per repo, with a "Needs attention" banner for failing CI or too many open PRs,
  and an `All repositories on github.com/<login>` (or `+N more`) link at the end.
- Light and dark, 5 colour themes, four layouts (Cards, Glass, Solid, Compact), start at login.

## Download

Installers will be on the [Releases](https://github.com/RezzAk47/agents-bar/releases) page (coming soon). Until then,
[build from source](#build-from-source).

The builds are not code-signed, so Windows SmartScreen and macOS Gatekeeper will warn the first time you open the app.

## Platform support

| | Windows | Linux | macOS |
|---|---|---|---|
| Installer (when released) | `.exe` (NSIS), x64 | `.deb` and `.AppImage`, x86_64 | `.dmg`, Apple silicon and Intel |
| CI build and tests | Passing | Passing | Passing |
| Installer smoke test (installs and starts) | Passing | Passing | Passing |
| Tested by hand | Not yet | Not yet | Yes |
| Text next to the tray icon | Tooltip only | Tooltip only | Yes |
| Open the popup | Click the tray icon | Tray menu, "Show Agents Bar" | Click the menu-bar icon |

On Linux under Wayland the popup opens wherever your desktop puts it; GNOME needs the AppIndicator extension. Details in
[docs/DETAILS.md](docs/DETAILS.md#differences-from-the-mac-bars-and-known-limits).

## Privacy

| What | Details |
|---|---|
| Reads | The session and transcript files that supported AI coding tools keep in hidden folders in your home directory, read-only (last 24 hours). |
| Shows | Only timestamps, token counts, tool names, task titles, `PROGRESS` lines and the first prompt of a session (cut to 200 characters). Replies, code and tool output never reach the window; a test checks this. |
| Network | None of its own: it never contacts any AI coding tool's servers. The GitHub section runs your logged-in `gh` CLI with fixed commands. |
| Stores | `settings.json` and `notified.json` in the app's data folder on your computer. Transcripts are never changed. |
| Never | No analytics, no telemetry, no account, nothing sent to the author. |

Full detail: [docs/DETAILS.md](docs/DETAILS.md#what-the-page-receives-privacy). Agents Bar is an independent project, not
affiliated with or endorsed by the makers of the supported tools.

## Build from source

Needs Node 24+, Rust 1.90 or newer, and the [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) for your
system (on Linux: WebKitGTK 4.1 and an AppIndicator library, see `.github/workflows/ci.yml`). The GitHub section needs the
[GitHub CLI](https://cli.github.com/) (`gh auth login`); the rest works without it.

```sh
git clone https://github.com/RezzAk47/agents-bar.git
cd agents-bar
npm ci --ignore-scripts
npm run tauri build          # installer for this OS, in src-tauri/target/release/bundle
npm run tauri dev            # or run it in development mode
```

Build with `npm run tauri build` (or `tauri dev`), not a plain `cargo build`: a plain cargo build does not embed the page and
the window stays blank.

Tests:

```sh
npm test && npx tsc --noEmit
(cd src-tauri && cargo test --locked && cargo clippy --all-targets -- -D warnings)
```

More checks (UI smoke test, screenshots, privacy canary, performance) are listed in [docs/DETAILS.md](docs/DETAILS.md#all-checks).

## Status

Early (v0.1.1). Developed and used on macOS. CI passes on Windows, Linux and macOS, and the installers install and start in an
automated test on all three, but nobody has used the Windows or Linux builds by hand yet. Known limits and differences from
the Mac app are in [docs/DETAILS.md](docs/DETAILS.md#differences-from-the-mac-bars-and-known-limits).

## Credits

Based on [CLI-Usage](https://github.com/nimaansari/CLI-Usage) by Nima Ansari (MIT). His licence notice is in
[NOTICE-CLI-Usage.md](NOTICE-CLI-Usage.md). Thank you, Nima.

Third-party components and trademark notes: [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) (full licence texts in
[THIRD-PARTY-LICENSES.txt](THIRD-PARTY-LICENSES.txt)).

## License

Free for personal and other non-commercial use. It may not be sold or used commercially. Licensed under the
[PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0/); see [LICENSE](LICENSE).

The portions that come from [CLI-Usage](https://github.com/nimaansari/CLI-Usage) by Nima Ansari stay under its MIT License
(see [NOTICE-CLI-Usage.md](NOTICE-CLI-Usage.md)).

Versions published before 2026-10-12 were released under the MIT License.

## Contact

Questions or a security problem: rzk.karimi@gmail.com (see [SECURITY.md](SECURITY.md)).
