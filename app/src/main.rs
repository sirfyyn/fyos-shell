// Unter Windows ohne Konsolenfenster
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    fyos_shell_lib::run();
}
