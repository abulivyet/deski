// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use tauri::{
    menu::{MenuItem, PredefinedMenuItem, Submenu},
    Emitter, Manager, Wry,
};

/// Native context menu root (submenu so items work on all platforms including macOS).
struct PetContextMenu(Submenu<Wry>);

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn show_context_menu(app: tauri::AppHandle, x: f64, y: f64) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "webview window `main` not found".to_string())?;
    let menu = app.state::<PetContextMenu>();
    window
        .popup_menu_at(&menu.0, tauri::LogicalPosition::new(x, y))
        .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let waving = MenuItem::with_id(app, "waving", "挥手", true, None::<&str>)?;
            let running = MenuItem::with_id(app, "running", "奔跑", true, None::<&str>)?;
            let review = MenuItem::with_id(app, "review", "审视", true, None::<&str>)?;
            let failed = MenuItem::with_id(app, "failed", "失败", true, None::<&str>)?;
            let sep_before_change = PredefinedMenuItem::separator(app)?;
            let change_pet = MenuItem::with_id(app, "change-pet", "更换宠物", true, None::<&str>)?;
            let sep_before_quit = PredefinedMenuItem::separator(app)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;

            let submenu = Submenu::with_id_and_items(
                app,
                "pet-context-root",
                " ",
                true,
                &[
                    &waving,
                    &running,
                    &review,
                    &failed,
                    &sep_before_change,
                    &change_pet,
                    &sep_before_quit,
                    &quit,
                ],
            )?;

            app.manage(PetContextMenu(submenu));

            #[cfg(debug_assertions)]
            if let Some(win) = app.get_webview_window("main") {
                win.open_devtools();
            }

            Ok(())
        })
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            eprintln!("[Deski] native menu activated: id={id:?}");
            match id {
                "quit" => std::process::exit(0),
                _ => {
                    let r = app.emit("menu-action", id.to_string());
                    eprintln!("[Deski] emit menu-action (broadcast): {r:?}");
                }
            }
        })
        .invoke_handler(tauri::generate_handler![greet, show_context_menu])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
