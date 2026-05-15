// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use std::sync::Mutex;

use serde_json::json;
use tauri::{
    menu::{CheckMenuItem, IsMenuItem, MenuItem, PredefinedMenuItem, Submenu},
    Emitter, Manager, Wry,
};
use tauri_plugin_opener::OpenerExt;

/// Native context menu root (submenu so items work on all platforms including macOS).
struct PetContextMenu {
    root: Submenu<Wry>,
    autostart: Option<CheckMenuItem<Wry>>,
    pet_size: PetSizeMenu,
}

struct PetSizeMenu {
    small: CheckMenuItem<Wry>,
    normal: CheckMenuItem<Wry>,
    large: CheckMenuItem<Wry>,
    xlarge: CheckMenuItem<Wry>,
    selection: Mutex<String>,
}

impl PetSizeMenu {
    fn new(app: &tauri::App) -> tauri::Result<Self> {
        Ok(Self {
            small: CheckMenuItem::with_id(app, "pet-size-small", "小 75%", true, false, None::<&str>)?,
            normal: CheckMenuItem::with_id(app, "pet-size-normal", "默认 100%", true, true, None::<&str>)?,
            large: CheckMenuItem::with_id(app, "pet-size-large", "大 125%", true, false, None::<&str>)?,
            xlarge: CheckMenuItem::with_id(app, "pet-size-xlarge", "超大 150%", true, false, None::<&str>)?,
            selection: Mutex::new("normal".to_string()),
        })
    }

    fn sync_checks(&self) {
        let key = self.selection.lock().map(|g| g.clone()).unwrap_or_else(|_| "normal".to_string());
        let _ = self.small.set_checked(key == "small");
        let _ = self.normal.set_checked(key == "normal");
        let _ = self.large.set_checked(key == "large");
        let _ = self.xlarge.set_checked(key == "xlarge");
    }

    /// 与前端启动时 localStorage 对齐勾选，不触发 `pet-size` 事件。
    fn apply_key_only(&self, key: &str) {
        if !matches!(key, "small" | "normal" | "large" | "xlarge") {
            return;
        }
        if let Ok(mut sel) = self.selection.lock() {
            *sel = key.to_string();
        }
        self.sync_checks();
    }

    fn on_user_pick(&self, key: &str, app: &tauri::AppHandle) {
        if !matches!(key, "small" | "normal" | "large" | "xlarge") {
            return;
        }
        if let Ok(mut sel) = self.selection.lock() {
            *sel = key.to_string();
        }
        self.sync_checks();
        let scale = match key {
            "small" => 0.75_f64,
            "normal" => 1.0,
            "large" => 1.25,
            "xlarge" => 1.5,
            _ => return,
        };
        let r = app.emit("pet-size", json!({ "key": key, "scale": scale }));
        eprintln!("[Deski] emit pet-size: {r:?}");
    }
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn sync_pet_size_menu_selection(app: tauri::AppHandle, key: String) -> Result<(), String> {
    let ctx = app.state::<PetContextMenu>();
    ctx.pet_size.apply_key_only(&key);
    Ok(())
}

#[tauri::command]
fn show_context_menu(app: tauri::AppHandle, x: f64, y: f64) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "webview window `main` not found".to_string())?;
    let ctx = app.state::<PetContextMenu>();
    #[cfg(desktop)]
    {
        use tauri_plugin_autostart::ManagerExt;
        if let Some(item) = &ctx.autostart {
            if let Ok(enabled) = app.autolaunch().is_enabled() {
                let _ = item.set_checked(enabled);
            }
        }
    }
    ctx.pet_size.sync_checks();
    window
        .popup_menu_at(&ctx.root, tauri::LogicalPosition::new(x, y))
        .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init());

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ));
    }

    builder
        .setup(|app| {
            let waving = MenuItem::with_id(app, "waving", "挥手", true, None::<&str>)?;
            let running = MenuItem::with_id(app, "running", "奔跑", true, None::<&str>)?;
            let review = MenuItem::with_id(app, "review", "审视", true, None::<&str>)?;
            let failed = MenuItem::with_id(app, "failed", "失败", true, None::<&str>)?;
            let sep_before_change = PredefinedMenuItem::separator(app)?;
            let change_pet = MenuItem::with_id(app, "change-pet", "更换宠物", true, None::<&str>)?;
            let open_petdex = MenuItem::with_id(
                app,
                "open-petdex",
                "Petdex 桌宠图库…",
                true,
                None::<&str>,
            )?;

            let pet_size = PetSizeMenu::new(app)?;
            let pet_size_menu = Submenu::with_id_and_items(
                app,
                "pet-size-menu",
                "宠物大小",
                true,
                &[
                    &pet_size.small,
                    &pet_size.normal,
                    &pet_size.large,
                    &pet_size.xlarge,
                ],
            )?;

            let autostart: Option<CheckMenuItem<Wry>> = {
                #[cfg(desktop)]
                {
                    Some(CheckMenuItem::with_id(
                        app,
                        "autostart",
                        "开机自启",
                        true,
                        false,
                        None::<&str>,
                    )?)
                }
                #[cfg(not(desktop))]
                {
                    None
                }
            };

            
            let sep_before_quit = PredefinedMenuItem::separator(app)?;
            let about = MenuItem::with_id(app, "about", "关于", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;

            let mut items: Vec<&dyn IsMenuItem<Wry>> = vec![
                &waving,
                &running,
                &review,
                &failed,
                &sep_before_change,
                &change_pet,
                &open_petdex,
                &pet_size_menu,
            ];
            if let Some(ref a) = autostart {
                items.push(a);
            }
            items.push(&sep_before_quit);
            items.push(&about);
            items.push(&quit);

            let submenu = Submenu::with_id_and_items(
                app,
                "pet-context-root",
                " ",
                true,
                &items,
            )?;

            app.manage(PetContextMenu {
                root: submenu,
                autostart,
                pet_size,
            });

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
                "open-petdex" => {
                    if let Err(e) = app.opener().open_url("https://petdex.crafter.run/zh", None::<&str>) {
                        eprintln!("[Deski] open Petdex failed: {e}");
                    }
                }
                "about" => {
                    if let Err(e) = app
                        .opener()
                        .open_url("https://github.com/abulivyet/deski", None::<&str>)
                    {
                        eprintln!("[Deski] open About URL failed: {e}");
                    }
                }
                "autostart" => {
                    #[cfg(desktop)]
                    {
                        use tauri_plugin_autostart::ManagerExt;
                        let ctx = app.state::<PetContextMenu>();
                        let Some(menu_item) = &ctx.autostart else {
                            return;
                        };
                        let before = app.autolaunch().is_enabled().unwrap_or(false);
                        let want = !before;
                        let res = if want {
                            app.autolaunch().enable()
                        } else {
                            app.autolaunch().disable()
                        };
                        match res {
                            Ok(()) => {
                                let _ = menu_item.set_checked(want);
                            }
                            Err(e) => {
                                eprintln!("[Deski] autostart toggle failed: {e}");
                                let _ = menu_item.set_checked(before);
                            }
                        }
                    }
                }
                "pet-size-small" | "pet-size-normal" | "pet-size-large" | "pet-size-xlarge" => {
                    let key = id.trim_start_matches("pet-size-");
                    let ctx = app.state::<PetContextMenu>();
                    ctx.pet_size.on_user_pick(key, app);
                }
                _ => {
                    let r = app.emit("menu-action", id.to_string());
                    eprintln!("[Deski] emit menu-action (broadcast): {r:?}");
                }
            }
        })
        .invoke_handler(tauri::generate_handler![greet, show_context_menu, sync_pet_size_menu_selection])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
