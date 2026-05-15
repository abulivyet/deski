// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use std::sync::Mutex;

use serde_json::json;
use tauri::{
    menu::{CheckMenuItem, IsMenuItem, MenuItem, PredefinedMenuItem, Submenu},
    Emitter, Manager, Wry,
};
use tauri_plugin_opener::OpenerExt;

#[cfg(desktop)]
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};

#[cfg(desktop)]
fn show_main_window(app: &tauri::AppHandle) {
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    if let Err(e) = win.show() {
        eprintln!("[Deski] window show failed: {e}");
        return;
    }
    let _ = win.set_focus();
}

#[cfg(desktop)]
fn hide_main_window(app: &tauri::AppHandle) {
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    if let Err(e) = win.hide() {
        eprintln!("[Deski] window hide failed: {e}");
    }
}

#[cfg(desktop)]
fn toggle_main_window(app: &tauri::AppHandle) {
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    let visible = win.is_visible().unwrap_or(true);
    if visible {
        hide_main_window(app);
    } else {
        show_main_window(app);
    }
}

#[cfg(desktop)]
fn quit_app(app: &tauri::AppHandle) {
    app.exit(0);
}

/// Native context menu root (submenu so items work on all platforms including macOS).
struct PetContextMenu {
    root: Submenu<Wry>,
    autostart: Option<CheckMenuItem<Wry>>,
    always_on_top: CheckMenuItem<Wry>,
    click_through: CheckMenuItem<Wry>,
    click_through_enabled: Mutex<bool>,
    pet_size: PetSizeMenu,
    pet_opacity: PetOpacityMenu,
}

#[cfg(desktop)]
struct ManagedTray {
    _tray: TrayIcon<Wry>,
    click_through: CheckMenuItem<Wry>,
}

fn sync_click_through_menu_checks(app: &tauri::AppHandle, enabled: bool) {
    let ctx = app.state::<PetContextMenu>();
    let _ = ctx.click_through.set_checked(enabled);
    #[cfg(desktop)]
    if let Some(tray) = app.try_state::<ManagedTray>() {
        let _ = tray.click_through.set_checked(enabled);
    }
}

fn apply_click_through(app: &tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let win = app
        .get_webview_window("main")
        .ok_or_else(|| "webview window `main` not found".to_string())?;
    win.set_ignore_cursor_events(enabled)
        .map_err(|e| e.to_string())?;
    let ctx = app.state::<PetContextMenu>();
    if let Ok(mut state) = ctx.click_through_enabled.lock() {
        *state = enabled;
    }
    sync_click_through_menu_checks(app, enabled);
    let r = app.emit("window-click-through", json!({ "enabled": enabled }));
    eprintln!("[Deski] emit window-click-through: {r:?}");
    Ok(())
}

fn toggle_click_through(app: &tauri::AppHandle) {
    let ctx = app.state::<PetContextMenu>();
    let before = ctx
        .click_through_enabled
        .lock()
        .map(|g| *g)
        .unwrap_or(false);
    let want = !before;
    if let Err(e) = apply_click_through(app, want) {
        eprintln!("[Deski] set click-through failed: {e}");
        let _ = apply_click_through(app, before);
    }
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

struct PetOpacityMenu {
    full: CheckMenuItem<Wry>,
    high: CheckMenuItem<Wry>,
    mid: CheckMenuItem<Wry>,
    low: CheckMenuItem<Wry>,
    selection: Mutex<String>,
}

impl PetOpacityMenu {
    fn new(app: &tauri::App) -> tauri::Result<Self> {
        Ok(Self {
            full: CheckMenuItem::with_id(app, "opacity-full", "不透明 100%", true, true, None::<&str>)?,
            high: CheckMenuItem::with_id(app, "opacity-high", "较透明 85%", true, false, None::<&str>)?,
            mid: CheckMenuItem::with_id(app, "opacity-mid", "半透明 70%", true, false, None::<&str>)?,
            low: CheckMenuItem::with_id(app, "opacity-low", "很透明 55%", true, false, None::<&str>)?,
            selection: Mutex::new("full".to_string()),
        })
    }

    fn sync_checks(&self) {
        let key = self
            .selection
            .lock()
            .map(|g| g.clone())
            .unwrap_or_else(|_| "full".to_string());
        let _ = self.full.set_checked(key == "full");
        let _ = self.high.set_checked(key == "high");
        let _ = self.mid.set_checked(key == "mid");
        let _ = self.low.set_checked(key == "low");
    }

    fn apply_key_only(&self, key: &str) {
        if !matches!(key, "full" | "high" | "mid" | "low") {
            return;
        }
        if let Ok(mut sel) = self.selection.lock() {
            *sel = key.to_string();
        }
        self.sync_checks();
    }

    fn on_user_pick(&self, key: &str, app: &tauri::AppHandle) {
        if !matches!(key, "full" | "high" | "mid" | "low") {
            return;
        }
        if let Ok(mut sel) = self.selection.lock() {
            *sel = key.to_string();
        }
        self.sync_checks();
        let value = match key {
            "full" => 1.0_f64,
            "high" => 0.85,
            "mid" => 0.7,
            "low" => 0.55,
            _ => return,
        };
        let r = app.emit("pet-opacity", json!({ "key": key, "value": value }));
        eprintln!("[Deski] emit pet-opacity: {r:?}");
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
fn sync_pet_opacity_menu_selection(app: tauri::AppHandle, key: String) -> Result<(), String> {
    let ctx = app.state::<PetContextMenu>();
    ctx.pet_opacity.apply_key_only(&key);
    Ok(())
}

#[tauri::command]
fn sync_always_on_top_menu_selection(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let ctx = app.state::<PetContextMenu>();
    let _ = ctx.always_on_top.set_checked(enabled);
    Ok(())
}

#[tauri::command]
fn sync_click_through_menu_selection(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    if let Ok(mut state) = app.state::<PetContextMenu>().click_through_enabled.lock() {
        *state = enabled;
    }
    sync_click_through_menu_checks(&app, enabled);
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
    ctx.pet_opacity.sync_checks();
    if let Ok(on_top) = window.is_always_on_top() {
        let _ = ctx.always_on_top.set_checked(on_top);
    }
    let click_through = ctx
        .click_through_enabled
        .lock()
        .map(|g| *g)
        .unwrap_or(false);
    sync_click_through_menu_checks(&app, click_through);
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

    #[cfg(desktop)]
    {
        builder = builder.on_tray_icon_event(|app, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_main_window(app);
            }
        });
    }

    builder
        .setup(|app| {
            let waving = MenuItem::with_id(app, "waving", "挥手", true, None::<&str>)?;
            let running = MenuItem::with_id(app, "running", "奔跑", true, None::<&str>)?;
            let review = MenuItem::with_id(app, "review", "审视", true, None::<&str>)?;
            let failed = MenuItem::with_id(app, "failed", "失败", true, None::<&str>)?;
            let demo_menu = Submenu::with_id_and_items(
                app,
                "demo-menu",
                "互动演示",
                true,
                &[&waving, &running, &review, &failed],
            )?;

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

            let pet_opacity = PetOpacityMenu::new(app)?;
            let pet_opacity_menu = Submenu::with_id_and_items(
                app,
                "pet-opacity-menu",
                "透明度",
                true,
                &[
                    &pet_opacity.full,
                    &pet_opacity.high,
                    &pet_opacity.mid,
                    &pet_opacity.low,
                ],
            )?;

            let always_on_top = CheckMenuItem::with_id(
                app,
                "always-on-top",
                "置顶",
                true,
                true,
                None::<&str>,
            )?;
            let click_through = CheckMenuItem::with_id(
                app,
                "click-through",
                "鼠标穿透",
                true,
                false,
                None::<&str>,
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

            let sep_after_pet = PredefinedMenuItem::separator(app)?;
            let sep_after_appearance = PredefinedMenuItem::separator(app)?;
            let sep_before_demo = PredefinedMenuItem::separator(app)?;
            let sep_before_quit = PredefinedMenuItem::separator(app)?;
            let about = MenuItem::with_id(app, "about", "关于", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;

            let mut items: Vec<&dyn IsMenuItem<Wry>> = vec![
                &change_pet,
                &open_petdex,
                &sep_after_pet,
                &pet_size_menu,
                &pet_opacity_menu,
                &sep_after_appearance,
                &always_on_top,
                &click_through,
            ];
            if let Some(ref a) = autostart {
                items.push(a);
            }
            items.push(&sep_before_demo);
            items.push(&demo_menu);
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
                always_on_top,
                click_through,
                click_through_enabled: Mutex::new(false),
                pet_size,
                pet_opacity,
            });

            #[cfg(desktop)]
            {
                use tauri::menu::Menu;

                let tray_show =
                    MenuItem::with_id(app, "tray-show", "显示桌宠", true, None::<&str>)?;
                let tray_hide =
                    MenuItem::with_id(app, "tray-hide", "隐藏桌宠", true, None::<&str>)?;
                let tray_click_through = CheckMenuItem::with_id(
                    app,
                    "tray-click-through",
                    "鼠标穿透",
                    true,
                    false,
                    None::<&str>,
                )?;
                let tray_sep = PredefinedMenuItem::separator(app)?;
                let tray_quit = MenuItem::with_id(app, "tray-quit", "退出", true, None::<&str>)?;
                let tray_menu = Menu::with_items(
                    app,
                    &[&tray_show, &tray_hide, &tray_click_through, &tray_sep, &tray_quit],
                )?;

                let tray_icon = app
                    .default_window_icon()
                    .cloned()
                    .ok_or_else(|| "default window icon not found (tray)".to_string())?;

                let tray = TrayIconBuilder::with_id("deski-tray")
                    .icon(tray_icon)
                    .tooltip("Deski")
                    .menu(&tray_menu)
                    .show_menu_on_left_click(false)
                    .build(app)?;

                app.manage(ManagedTray {
                    _tray: tray,
                    click_through: tray_click_through,
                });
            }

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
                "quit" | "tray-quit" => quit_app(app),
                "tray-show" => show_main_window(app),
                "tray-hide" => hide_main_window(app),
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
                "always-on-top" => {
                    let ctx = app.state::<PetContextMenu>();
                    let Some(win) = app.get_webview_window("main") else {
                        return;
                    };
                    let before = win.is_always_on_top().unwrap_or(true);
                    let want = !before;
                    match win.set_always_on_top(want) {
                        Ok(()) => {
                            let _ = ctx.always_on_top.set_checked(want);
                            let r = app.emit("window-always-on-top", json!({ "enabled": want }));
                            eprintln!("[Deski] emit window-always-on-top: {r:?}");
                        }
                        Err(e) => {
                            eprintln!("[Deski] set always on top failed: {e}");
                            let _ = ctx.always_on_top.set_checked(before);
                        }
                    }
                }
                "click-through" | "tray-click-through" => toggle_click_through(app),
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
                "opacity-full" | "opacity-high" | "opacity-mid" | "opacity-low" => {
                    let key = id.trim_start_matches("opacity-");
                    let ctx = app.state::<PetContextMenu>();
                    ctx.pet_opacity.on_user_pick(key, app);
                }
                _ => {
                    let r = app.emit("menu-action", id.to_string());
                    eprintln!("[Deski] emit menu-action (broadcast): {r:?}");
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            show_context_menu,
            sync_pet_size_menu_selection,
            sync_pet_opacity_menu_selection,
            sync_always_on_top_menu_selection,
            sync_click_through_menu_selection,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
