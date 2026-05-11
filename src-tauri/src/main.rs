// Hide console window on Windows release builds
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    ue_master_lib::run();
}
