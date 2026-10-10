fn main() {
    // Only these commands exist for the webview; each one needs an explicit permission in capabilities/default.json.
    let app = tauri_build::AppManifest::new().commands(&[
        "app_info",
        "fs_read",
        "fs_stat",
        "fs_write",
        "fs_move_aside",
        "set_tray_label",
        "hide_popup",
        "quit_app",
        "scan_transcripts",
        "gh_user",
        "gh_repo_list",
        "gh_run_list",
        "reveal_transcript",
        "open_repo",
        "notify",
    ]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(app))
        .expect("tauri build failed");
}
