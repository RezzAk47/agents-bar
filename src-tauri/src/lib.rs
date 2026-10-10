//! Agents Bar: the Tauri shell. A tray icon (menu bar on macOS, notification area on Windows, indicator on Linux) and one
//! frameless, always-on-top popup that hosts the page in ../dist. Everything about agents is in the page; this side owns
//! the OS: the tray, the window, the data folder, the transcript reader and the gh calls.

mod datadir;
mod env;
pub mod files;
pub mod gh;
mod position;
pub mod scanner;
mod sleep;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, Rect as TauriRect, State,
    WebviewWindow, WindowEvent,
};

use datadir::Os;
use position::{
    fallback_corner, popup_height_logical, popup_position, popup_width_logical, usable_icon, Rect,
};

const MARGIN: i32 = 8;

struct AppState {
    data_dir: PathBuf,
    /// When the popup last hid itself because it lost focus: the tray click that caused the blur must not re-open it.
    blurred_at: Mutex<Option<Instant>>,
    /// The tray icon rectangle of the last click (physical pixels), when the OS tells us.
    last_icon: Mutex<Option<Rect>>,
    tray: Mutex<Option<TrayIcon>>,
    scanner: Arc<Mutex<scanner::Scanner>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    platform: &'static str,
    data_dir: String,
    no_notifications: bool,
    tray_note: Option<&'static str>,
}

fn env_var(name: &str) -> Option<String> {
    env::var(name)
}

fn home_dir() -> String {
    env::home_dir(Os::current(), &env_var)
}

#[tauri::command]
fn app_info(state: State<AppState>) -> AppInfo {
    let os = Os::current();
    AppInfo {
        platform: os.name(),
        data_dir: state.data_dir.display().to_string(),
        no_notifications: env_var("AGENTSBAR_NO_NOTIFICATIONS").is_some(),
        tray_note: if os == Os::Linux {
            Some("Linux: tray icons cannot report clicks, so open Agents Bar from the tray icon's menu (Show Agents Bar). The window opens at the top right of the screen. On GNOME the AppIndicator extension is required.")
        } else {
            None
        },
    }
}

/// Runs a file operation on its own thread and gives up after `limit`, so nothing a file does can freeze the tray or the popup.
fn off_main_for<T: Send + 'static>(
    limit: Duration,
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(f());
    });
    rx.recv_timeout(limit)
        .unwrap_or_else(|_| Err("the file did not answer in time".into()))
}

fn off_main<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    off_main_for(Duration::from_secs(5), f)
}

#[tauri::command]
async fn fs_read(state: State<'_, AppState>, name: String) -> Result<Option<String>, String> {
    let dir = state.data_dir.clone();
    off_main(move || files::read(&dir, &name))
}

#[tauri::command]
async fn fs_stat(state: State<'_, AppState>, name: String) -> Result<Option<files::Stamp>, String> {
    let dir = state.data_dir.clone();
    off_main(move || files::stat(&dir, &name))
}

#[tauri::command]
async fn fs_write(
    state: State<'_, AppState>,
    name: String,
    text: String,
    check: bool,
    expected: Option<files::Stamp>,
) -> Result<(), String> {
    let dir = state.data_dir.clone();
    off_main(move || {
        files::write(
            &dir,
            &name,
            &text,
            if check { Some(expected) } else { None },
        )
    })
}

#[tauri::command]
async fn fs_move_aside(
    state: State<'_, AppState>,
    name: String,
    backup_name: String,
) -> Result<String, String> {
    let dir = state.data_dir.clone();
    off_main(move || files::move_aside(&dir, &name, &backup_name))
}

#[tauri::command]
fn set_tray_label(state: State<AppState>, label: String) {
    let label: String = label
        .chars()
        .filter(|c| !c.is_control())
        .take(120)
        .collect();
    if let Some(tray) = state.tray.lock().unwrap().as_ref() {
        eprintln!("agents-bar: tray label: {label}");
        let _ = tray.set_tooltip(Some(&label));
        #[cfg(target_os = "macos")]
        let _ = tray.set_title(Some(&label));
    }
}

#[tauri::command]
fn hide_popup(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

/// Text for a notification: no control characters, and none of `<`, `>`, `&` (some Linux notification daemons render markup).
pub fn notification_text(text: &str, max: usize) -> String {
    let kept: String = text
        .chars()
        .filter(|c| !matches!(c, '<' | '>' | '&'))
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    kept.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(max)
        .collect()
}

/// Shows an OS notification from Rust, so the page learns about a real failure (permission denied, no daemon, ...) and the
/// queue can retry. With AGENTSBAR_NO_NOTIFICATIONS nothing is sent and the call succeeds. Honest limit: the notification
/// plugin reports whether the OS API accepted the notification, not whether the user saw it.
#[tauri::command]
async fn notify(app: AppHandle, title: String, body: String) -> Result<(), String> {
    if env_var("AGENTSBAR_NO_NOTIFICATIONS").is_some() {
        return Ok(());
    }
    use tauri_plugin_notification::{NotificationExt, PermissionState};
    let n = app.notification();
    let mut state = n.permission_state().map_err(|e| e.to_string())?;
    if state == PermissionState::Prompt || state == PermissionState::PromptWithRationale {
        state = n.request_permission().map_err(|e| e.to_string())?;
    }
    if state != PermissionState::Granted {
        return Err("notifications are not allowed for this app".into());
    }
    n.builder()
        .title(notification_text(&title, 120))
        .body(notification_text(&body, 300))
        .show()
        .map_err(|e| e.to_string())
}

/// Reads what is new in the transcript folders (bounded, incremental). Off the main thread: a cold scan reads files.
#[tauri::command]
async fn scan_transcripts(
    state: State<'_, AppState>,
    rediscover: bool,
) -> Result<scanner::Reply, String> {
    let scanner = Arc::clone(&state.scanner);
    tauri::async_runtime::spawn_blocking(move || {
        scanner
            .lock()
            .map(|mut s| s.scan(scanner::now_ms(), rediscover))
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn gh_path() -> Result<PathBuf, String> {
    gh::find_gh(&env_var).ok_or_else(|| gh::MISSING.to_string())
}

async fn gh_job<F: FnOnce(PathBuf) -> Result<String, String> + Send + 'static>(
    f: F,
) -> Result<String, String> {
    let path = gh_path()?;
    tauri::async_runtime::spawn_blocking(move || f(path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn gh_user() -> Result<String, String> {
    gh_job(|p| gh::user(&p, gh::CALL_TIMEOUT)).await
}

#[tauri::command]
async fn gh_repo_list(fields: String, limit: u32) -> Result<String, String> {
    gh_job(move |p| gh::repo_list(&p, &fields, limit, gh::CALL_TIMEOUT)).await
}

#[tauri::command]
async fn gh_run_list(slug: String) -> Result<String, String> {
    gh_job(move |p| gh::run_list(&p, &slug, gh::CALL_TIMEOUT)).await
}

/// Shows a transcript in the file manager, but only a file this app's own scanner found.
#[tauri::command]
fn reveal_transcript(app: AppHandle, state: State<AppState>, path: String) -> Result<(), String> {
    let real = state
        .scanner
        .lock()
        .map_err(|e| e.to_string())?
        .known_path(&path);
    let Some(real) = real else {
        return Err("that file is not one of the scanned transcripts".into());
    };
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .reveal_item_in_dir(&real)
        .map_err(|e| e.to_string())
}

/// Opens https://github.com/<owner>/<repo>, built here from validated names (never a URL from the page).
#[tauri::command]
fn open_repo(app: AppHandle, slug: String) -> Result<(), String> {
    let url = gh::repo_url(&slug).ok_or_else(|| "not a valid repository name".to_string())?;
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

fn to_rect(r: &TauriRect, scale: f64) -> Rect {
    let p = r.position.to_physical::<i32>(scale);
    let s = r.size.to_physical::<u32>(scale);
    Rect {
        x: p.x,
        y: p.y,
        w: s.width as i32,
        h: s.height as i32,
    }
}

/// Work area (screen minus menu bar and taskbar) of the monitor that holds the point, else the primary monitor.
fn work_area(app: &AppHandle, around: Option<Rect>) -> Rect {
    let monitor = around
        .and_then(|r| {
            app.monitor_from_point((r.x + r.w / 2) as f64, (r.y + r.h / 2) as f64)
                .ok()
                .flatten()
        })
        .or_else(|| app.primary_monitor().ok().flatten());
    match monitor {
        Some(m) => {
            let a = m.work_area();
            Rect {
                x: a.position.x,
                y: a.position.y,
                w: a.size.width as i32,
                h: a.size.height as i32,
            }
        }
        None => Rect {
            x: 0,
            y: 0,
            w: 1280,
            h: 720,
        },
    }
}

/// Sizes the popup for the screen it will be on (640 high, less on a short work area, never under 320) and puts it next to
/// the tray icon, or in the corner nearest the OS convention when the icon position is unknown or empty.
fn size_and_place(app: &AppHandle, win: &WebviewWindow, icon: Option<Rect>) {
    let icon = usable_icon(icon);
    let work = work_area(app, icon);
    let scale = win.scale_factor().unwrap_or(1.0);
    let (w, h) = (
        popup_width_logical(work.w, scale, MARGIN),
        popup_height_logical(work.h, scale, MARGIN),
    );
    let _ = win.set_size(LogicalSize::new(w as f64, h as f64));
    let size = win
        .outer_size()
        .map(|s| (s.width as i32, s.height as i32))
        .unwrap_or(((w as f64 * scale) as i32, (h as f64 * scale) as i32));
    let margin = (MARGIN as f64 * scale).round() as i32;
    let (x, y) = popup_position(
        icon,
        work,
        size.0,
        size.1,
        margin,
        fallback_corner(Os::current() == Os::Windows),
    );
    let _ = win.set_position(PhysicalPosition::new(x, y));
}

fn place_and_show(app: &AppHandle, win: &WebviewWindow, icon: Option<Rect>) {
    size_and_place(app, win, icon);
    let _ = win.show();
    let _ = win.set_focus();
    // mixed-DPI setups: the window may have moved to a screen with another scale factor, which changes its physical size
    size_and_place(app, win, icon);
    let _ = app.emit("popup-shown", ());
}

fn toggle_popup(app: &AppHandle, icon: Option<Rect>) {
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    let state = app.state::<AppState>();
    if win.is_visible().unwrap_or(false) {
        let _ = win.hide();
        return;
    }
    if let Some(t) = *state.blurred_at.lock().unwrap() {
        if t.elapsed() < Duration::from_millis(250) {
            return; // this click is the one that made the popup lose focus and hide
        }
    }
    let icon = icon.or(*state.last_icon.lock().unwrap());
    place_and_show(app, &win, icon);
}

/// The tray icon for Windows and Linux: mid-grey, because the panel colour is unknown (tests check its contrast on white and near-black).
const TRAY_MID: &[u8] = include_bytes!("../icons/tray-mid.png");

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show Agents Bar", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let template = Image::from_bytes(include_bytes!("../icons/tray-template.png"))?;
    let mid = Image::from_bytes(TRAY_MID)?;
    let os = Os::current();
    let mut b = TrayIconBuilder::with_id("main")
        .tooltip("Agents Bar")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                let state = app.state::<AppState>();
                let icon = *state.last_icon.lock().unwrap();
                if let Some(win) = app.get_webview_window("main") {
                    place_and_show(app, &win, icon);
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                rect,
                ..
            } = event
            {
                let app = tray.app_handle();
                let scale = app
                    .get_webview_window("main")
                    .and_then(|w| w.scale_factor().ok())
                    .unwrap_or(1.0);
                let r = to_rect(&rect, scale);
                *app.state::<AppState>().last_icon.lock().unwrap() = Some(r);
                toggle_popup(app, Some(r));
            }
        });
    b = match os {
        // macOS wants a black template image that the system tints for light and dark menu bars
        Os::Mac => b.icon(template).icon_as_template(true),
        // Windows and Linux panels can be light or dark and the app cannot tell: a mid-grey glyph reads on both
        _ => b.icon(mid),
    };
    let tray = b.build(app)?;
    *app.state::<AppState>().tray.lock().unwrap() = Some(tray);
    Ok(())
}

pub fn run() {
    let os = Os::current();
    let data_dir = datadir::default_data_dir(os, &env_var, &home_dir());
    let (claude_root, codex_root) = scanner::roots(&env_var, &home_dir());

    let mut builder = tauri::Builder::default();
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            toggle_popup(app, None);
        }));
    }
    builder
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(AppState {
            data_dir,
            blurred_at: Mutex::new(None),
            last_icon: Mutex::new(None),
            tray: Mutex::new(None),
            scanner: Arc::new(Mutex::new(scanner::Scanner::new(claude_root, codex_root))),
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            fs_read,
            fs_stat,
            fs_write,
            fs_move_aside,
            set_tray_label,
            hide_popup,
            quit_app,
            scan_transcripts,
            gh_user,
            gh_repo_list,
            gh_run_list,
            reveal_transcript,
            open_repo,
            notify
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory); // no Dock icon
            build_tray(app.handle())?;
            eprintln!(
                "agents-bar: tray icon created; data folder {}",
                app.state::<AppState>().data_dir.display()
            );
            if let Some(win) = app.get_webview_window("main") {
                let handle = app.handle().clone();
                let w = win.clone();
                win.on_window_event(move |event| {
                    if let WindowEvent::Focused(false) = event {
                        *handle.state::<AppState>().blurred_at.lock().unwrap() =
                            Some(Instant::now());
                        let _ = w.hide();
                    }
                });
            }
            // the page rescans on this 3 s beat (cheap: one stat per file when nothing changed)
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let clocks = sleep::SystemClocks::new();
                let mut detector = sleep::SleepDetector::new(sleep::HAS_TWO_CLOCKS);
                detector.observe(clocks.sample());
                loop {
                    std::thread::sleep(Duration::from_secs(3));
                    // the machine slept: tell the page when the last tick before it was, so the study timer stops there
                    if let Some(slept) = detector.observe(clocks.sample()) {
                        let _ = handle.emit("slept", slept);
                    }
                    let _ = handle.emit("tick", ());
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Agents Bar")
        .run(|_app, event| {
            // a tray app keeps running with no window
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                if code.is_none() {
                    api.prevent_exit();
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::{notification_text, off_main_for, TRAY_MID};
    use std::time::Duration;

    #[test]
    fn notification_text_has_no_markup_or_control_characters() {
        assert_eq!(
            notification_text("<b>Fix</b> & <a href=x>click</a>\n\u{7}done", 100),
            "bFix/b a href=xclick/a done"
        );
        assert_eq!(
            notification_text(&"x".repeat(500), 120).chars().count(),
            120
        );
        assert_eq!(notification_text("  a   b  ", 10), "a b");
    }

    #[test]
    fn a_stuck_file_operation_does_not_block_the_caller() {
        let started = std::time::Instant::now();
        let r: Result<u8, String> = off_main_for(Duration::from_millis(100), || {
            std::thread::sleep(Duration::from_secs(3)); // a lock wait, a slow disk
            Ok(1)
        });
        assert!(r.is_err(), "gave up instead of waiting");
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "the caller was released after the limit, not after the file"
        );
    }

    #[test]
    fn a_quick_file_operation_returns_its_value() {
        assert_eq!(
            off_main_for(Duration::from_secs(2), || Ok::<_, String>(7)),
            Ok(7)
        );
        assert_eq!(
            off_main_for::<u8>(Duration::from_secs(2), || Err("disk full".into())),
            Err("disk full".to_string())
        );
    }

    /// WCAG relative luminance of an sRGB channel triple.
    fn luminance(r: u8, g: u8, b: u8) -> f64 {
        let lin = |c: u8| {
            let c = c as f64 / 255.0;
            if c <= 0.03928 {
                c / 12.92
            } else {
                ((c + 0.055) / 1.055).powf(2.4)
            }
        };
        0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
    }

    #[test]
    fn the_windows_linux_tray_icon_is_visible_on_light_and_dark_panels() {
        let img = tauri::image::Image::from_bytes(TRAY_MID).expect("tray-mid.png decodes");
        let (mut n, mut worst_white, mut worst_dark) = (0, f64::MAX, f64::MAX);
        for px in img.rgba().chunks(4).filter(|p| p[3] >= 200) {
            let l = luminance(px[0], px[1], px[2]);
            n += 1;
            worst_white = worst_white.min((1.05) / (l + 0.05));
            worst_dark = worst_dark.min((l + 0.05) / (luminance(26, 26, 26) + 0.05));
        }
        assert!(n >= 100, "the glyph has opaque pixels (found {n})");
        assert!(
            worst_white >= 3.0,
            "contrast on a white panel is {worst_white:.2}"
        );
        assert!(
            worst_dark >= 3.0,
            "contrast on a near-black panel is {worst_dark:.2}"
        );
    }
}
