// Agents Bar: tray app. No console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    agents_bar_lib::run();
}
